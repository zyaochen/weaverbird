import { describe, expect, it, vi } from 'vitest';
import { parseApiMessageItem, parseInboundMessage } from '../../apps/wb-bot/src/feishu/message-parser.js';
import { parseLarkMessagePayload, readSender } from '../../apps/wb-bot/src/feishu/transport.js';

const BOT = 'ou_bot';

function message(messageType: string, content: unknown, extra: Record<string, unknown> = {}) {
  return {
    message_id: 'om_1',
    chat_id: 'oc_1',
    chat_type: 'group',
    message_type: messageType,
    content: JSON.stringify(content),
    ...extra,
  };
}

describe('parseInboundMessage', () => {
  it('strips the bot mention and resolves other mentions to names', async () => {
    const parsed = await parseInboundMessage(message('text', { text: '@_user_1 帮 @_user_2 看下日志' }, {
      mentions: [
        { key: '@_user_1', name: 'wb', id: { open_id: BOT } },
        { key: '@_user_2', name: '张三', id: { open_id: 'ou_zhang' } },
      ],
    }), { botOpenId: BOT });
    expect(parsed.text.trim()).toBe('帮 @张三 看下日志');
    expect(parsed.resources).toEqual([]);
  });

  it('flattens post rich text including inline images', async () => {
    const parsed = await parseInboundMessage(message('post', {
      title: '报错',
      content: [
        [{ tag: 'text', text: '这里挂了' }, { tag: 'a', text: '链接', href: 'https://example.com' }],
        [{ tag: 'img', image_key: 'img_post_1' }],
      ],
    }), { botOpenId: BOT });
    expect(parsed.text).toContain('报错');
    expect(parsed.text).toContain('这里挂了');
    expect(parsed.text).toContain('https://example.com');
    expect(parsed.resources).toEqual([expect.objectContaining({ type: 'image', fileKey: 'img_post_1' })]);
  });

  it('returns image and file resources', async () => {
    const image = await parseInboundMessage(message('image', { image_key: 'img_1' }), { botOpenId: BOT });
    expect(image.text).toBe('![image](img_1)');
    expect(image.resources).toEqual([{ type: 'image', fileKey: 'img_1' }]);

    const file = await parseInboundMessage(message('file', { file_key: 'file_1', file_name: 'trace.log' }), { botOpenId: BOT });
    expect(file.text).toContain('file_1');
    expect(file.resources).toEqual([{ type: 'file', fileKey: 'file_1', fileName: 'trace.log' }]);
  });

  it('expands merge_forward through fetchSubMessages', async () => {
    const fetchSubMessages = vi.fn(async () => [
      { message_id: 'om_parent', msg_type: 'merge_forward', body: { content: '' } },
      { message_id: 'om_a', upper_message_id: 'om_parent', msg_type: 'text', body: { content: JSON.stringify({ text: '第一条' }) }, sender: { id: 'ou_a' }, create_time: '1700000000000' },
      { message_id: 'om_b', upper_message_id: 'om_parent', msg_type: 'text', body: { content: JSON.stringify({ text: '第二条' }) }, sender: { id: 'ou_b' }, create_time: '1700000001000' },
    ]);
    const parsed = await parseInboundMessage(message('merge_forward', {}, { message_id: 'om_parent' }), { botOpenId: BOT, fetchSubMessages });
    expect(fetchSubMessages).toHaveBeenCalledWith('om_parent');
    expect(parsed.text).toContain('第一条');
    expect(parsed.text).toContain('第二条');
  });

  it('keeps parent_id for quoted replies', async () => {
    const parsed = await parseInboundMessage(message('text', { text: '这个呢' }, { parent_id: 'om_parent' }), { botOpenId: BOT });
    expect(parsed.parentId).toBe('om_parent');
  });

  it('drops the <p> wrapper some clients put around text messages', async () => {
    const parsed = await parseInboundMessage(message('text', { text: '<p>@_user_1 他们在讨论什么</p>' }, {
      mentions: [{ key: '@_user_1', name: 'wb', id: { open_id: BOT } }],
    }), { botOpenId: BOT });
    expect(parsed.text).toBe('他们在讨论什么');
  });

  it('reads title and text of a forwarded interactive card instead of the SDK placeholder', async () => {
    const parsed = await parseInboundMessage(message('interactive', {
      title: '【告警】【已恢复】机器SSH访问异常',
      elements: [
        [{ tag: 'img', image_key: 'img_1' }, { tag: 'text', text: '事故时间: 17:31 - 18:18' }],
        [{ tag: 'text', text: '【 事故概述 】' }, { tag: 'a', href: 'https://example.com/incident/1', text: '详情' }],
      ],
    }), { botOpenId: BOT });
    expect(parsed.text).toBe('【告警】【已恢复】机器SSH访问异常\n事故时间: 17:31 - 18:18\n【 事故概述 】详情 (https://example.com/incident/1)');
  });

  it('falls back to legacy text parsing when message_type is absent', async () => {
    const parsed = await parseInboundMessage({ content: '{"text":"hello"}' }, { botOpenId: BOT });
    expect(parsed).toEqual({ text: 'hello', msgType: 'text', resources: [], parentId: undefined, mentionAll: false });
  });

  it('parses an API message item (quoted parent)', async () => {
    const parsed = await parseApiMessageItem({ message_id: 'om_p', msg_type: 'text', body: { content: JSON.stringify({ text: '原消息' }) } }, { botOpenId: BOT });
    expect(parsed.text).toBe('原消息');
  });
});

describe('readSender', () => {
  it('carries msgType, resources and parentId through the transport payload', async () => {
    const raw = parseLarkMessagePayload({
      header: { event_id: 'evt-1' },
      sender: { sender_id: { open_id: 'ou_user' } },
      message: {
        message_id: 'om_9',
        chat_id: 'oc_9',
        chat_type: 'p2p',
        parent_id: 'om_8',
        message_type: 'image',
        content: JSON.stringify({ image_key: 'img_9' }),
      },
    });
    const parsed = await readSender(raw, BOT);
    expect(parsed.openId).toBe('ou_user');
    expect(parsed.msgType).toBe('image');
    expect(parsed.resources).toEqual([{ type: 'image', fileKey: 'img_9' }]);
    expect(parsed.parentId).toBe('om_8');
  });
});
