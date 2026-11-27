import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BindingStore } from '../../apps/wb-bot/src/binding/store.js';
import { ChatModeCache, shouldReplyInThread } from '../../apps/wb-bot/src/feishu/chat-mode-cache.js';
import { EventHandler } from '../../apps/wb-bot/src/feishu/event-handler.js';
import { parseLarkMessagePayload, readSender, shouldDispatchMessageForBot } from '../../apps/wb-bot/src/feishu/transport.js';
import { DefaultAgentRegistry } from '../../packages/core/src/agent/registry.js';

function payload(message: Record<string, unknown>, senderType = 'user') {
  return parseLarkMessagePayload({
    header: { event_id: 'evt-1' },
    sender: { sender_id: { open_id: 'ou_user' }, sender_type: senderType },
    message: { message_id: 'om_1', chat_id: 'oc_1', chat_type: 'group', message_type: 'text', content: JSON.stringify({ text: 'hello' }), ...message },
  });
}

describe('require-mention gate', () => {
  const off = () => false;
  it('keeps requiring @bot by default', () => {
    expect(shouldDispatchMessageForBot(payload({}), 'ou_self')).toBe(false);
  });

  it('lets plain group messages through when the group turned the requirement off', () => {
    expect(shouldDispatchMessageForBot(payload({}), 'ou_self', off)).toBe(true);
  });

  it('still skips bot senders and messages that only @ someone else', () => {
    expect(shouldDispatchMessageForBot(payload({}, 'app'), 'ou_self', off)).toBe(false);
    expect(shouldDispatchMessageForBot(payload({ mentions: [{ key: '@_user_1', id: { open_id: 'ou_other' } }] }), 'ou_self', off)).toBe(false);
  });
});

describe('ChatModeCache', () => {
  it('detects both topic group flavours and caches per chat', async () => {
    const fetchChat = vi.fn(async (chatId: string) => (
      chatId === 'oc_topic' ? { chat_mode: 'topic' } : chatId === 'oc_thread' ? { chat_mode: 'group', group_message_type: 'thread' } : { chat_mode: 'group', group_message_type: 'chat' }
    ));
    const cache = new ChatModeCache(fetchChat);
    expect(await cache.resolve('oc_topic')).toBe('topic');
    expect(await cache.resolve('oc_thread')).toBe('topic');
    expect(await cache.resolve('oc_plain')).toBe('group');
    await cache.resolve('oc_topic');
    expect(fetchChat).toHaveBeenCalledTimes(3);
  });

  it('treats lookup failures as a normal group without caching', async () => {
    let calls = 0;
    const onError = vi.fn();
    const cache = new ChatModeCache(async () => { calls += 1; throw new Error('no scope'); }, onError);
    expect(await cache.resolve('oc_1')).toBe('group');
    expect(await cache.resolve('oc_1')).toBe('group');
    expect(calls).toBe(2);
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it('threads replies for messages already in a topic and for topic groups, never for p2p', async () => {
    const cache = { resolve: vi.fn(async (chatId: string) => (chatId === 'oc_topic' ? 'topic' as const : 'group' as const)) };
    expect(await shouldReplyInThread({ chatType: 'p2p', chatId: 'oc_topic' }, cache)).toBe(false);
    expect(await shouldReplyInThread({ chatType: 'group', chatId: 'oc_plain', threadId: 'omt_1' }, cache)).toBe(true);
    expect(await shouldReplyInThread({ chatType: 'group', chatId: 'oc_topic' }, cache)).toBe(true);
    expect(await shouldReplyInThread({ chatType: 'group', chatId: 'oc_plain' }, cache)).toBe(false);
  });
});

describe('readSender quote detection', () => {
  it('ignores the topic root as parent inside a thread but keeps real quotes', async () => {
    const inTopic = await readSender(payload({ root_id: 'om_root', parent_id: 'om_root', thread_id: 'omt_1' }), 'ou_self');
    expect(inTopic.parentId).toBeUndefined();
    expect(inTopic.larkThreadId).toBe('omt_1');
    const quoted = await readSender(payload({ root_id: 'om_root', parent_id: 'om_other', thread_id: 'omt_1' }), 'ou_self');
    expect(quoted.parentId).toBe('om_other');
    const plainReply = await readSender(payload({ root_id: 'om_root', parent_id: 'om_root' }), 'ou_self');
    expect(plainReply.parentId).toBe('om_root');
  });
});

describe('/require-mention', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wb-group-'));
    vi.stubEnv('WB_DATA_DIR', dir);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it('shows the setting to anyone but only lets group admins change it', async () => {
    const store = new BindingStore(join(dir, 'wb-bot.db'));
    const texts: string[] = [];
    const feishu = {
      async replyCard(_id: string, card: Record<string, unknown>) {
        texts.push(JSON.stringify(card));
        return 'r';
      },
      async updateCard() {},
      async replyText() { return 't'; },
    };
    const resolver = vi.fn(async (context: { userOpenId: string }) => (context.userOpenId === 'ou_admin' ? 'group_admin' as const : null));
    const handler = new EventHandler(new DefaultAgentRegistry([]), store, feishu, dir, undefined, undefined, undefined, undefined, undefined, resolver);
    const send = (id: string, userOpenId: string, text: string, chatType = 'group') =>
      handler.handleMessage({ eventId: id, userOpenId, threadId: `root:${id}`, messageId: id, text, chatId: 'oc_1', chatType });
    try {
      await send('m1', 'ou_user', '/require-mention');
      expect(texts.at(-1)).toContain('本群当前需要 @bot 才响应');
      await send('m2', 'ou_user', '/require-mention off');
      expect(texts.at(-1)).toContain('只有群主 / 群管理员可以修改');
      expect(store.getRequireMention('default', 'oc_1')).toBe(true);
      await send('m3', 'ou_admin', '/require-mention off');
      expect(texts.at(-1)).toContain('已关闭 @ 要求');
      expect(store.getRequireMention('default', 'oc_1')).toBe(false);
      expect(resolver).toHaveBeenLastCalledWith({ messageId: 'm3', userOpenId: 'ou_admin', threadId: 'oc_1' });
      await send('m4', 'ou_user', '/require-mention on', 'p2p');
      expect(texts.at(-1)).toContain('私聊不需要 @bot');
    } finally {
      handler.dispose();
      store.close();
    }
  });
});
