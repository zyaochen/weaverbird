import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentAdapter, AgentRegistry, AgentRun, RunRequest } from '../../packages/core/src/index.js';
import { BindingStore } from '../../apps/wb-bot/src/binding/store.js';
import { EventHandler } from '../../apps/wb-bot/src/feishu/event-handler.js';
import { normalizeTopic } from '../../apps/wb-bot/src/feishu/topic-key.js';

let dir = '';
let cwd = '';
let store: BindingStore;

function mkDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

beforeEach(() => {
  dir = mkDir('wb-thread-topic-store-');
  cwd = mkDir('wb-thread-topic-cwd-');
  store = new BindingStore(join(dir, 'wb-bot.db'));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe('session thread context', () => {
  it('reuses the same session continuation when ingress shifts from top-level chat_id to reply root_id', async () => {
    const requests: RunRequest[] = [];
    let runCount = 0;
    const agent: AgentAdapter = {
      id: 'claude-code',
      displayName: 'Claude Code',
      async isAvailable() { return true; },
      async getCapabilities() { return {} as never; },
      run(req: RunRequest): AgentRun {
        requests.push(req);
        runCount += 1;
        const continuationToken = runCount === 1 ? 'tok-thread-root' : 'tok-thread-root-2';
        return {
          events: {
            async *[Symbol.asyncIterator]() {
              yield { type: 'done' as const, continuationToken };
            },
          },
          async stop() {},
          async waitForExit() { return true; },
        };
      },
    };
    const registry: AgentRegistry = {
      register() {},
      lookup(id: string) { return id === agent.id ? agent : null; },
      list() { return [agent]; },
      async isAvailable(id: string) { return id === agent.id ? true : null; },
    };
    const handler = new EventHandler(registry, store, {
      async replyCard() { return 'reply-1'; },
      async updateCard() {},
      async replyText() { return 'msg-1'; },
    }, cwd);

    const topLevelTopic = normalizeTopic({ chatId: 'oc_group', messageId: 'om_root', chatType: 'group' });
    const replyTopic = normalizeTopic({ chatId: 'oc_group', rootId: 'om_root', messageId: 'om_reply', chatType: 'group' });
    expect(replyTopic).toBe(topLevelTopic);

    await handler.handleMessage({
      eventId: 'evt-top-level',
      userOpenId: 'ou_user',
      threadId: topLevelTopic,
      chatId: 'oc_group',
      messageId: 'om_root',
      text: 'first request',
    });

    await handler.handleMessage({
      eventId: 'evt-reply-followup',
      userOpenId: 'ou_user',
      threadId: replyTopic,
      chatId: 'oc_group',
      rootId: 'om_root',
      messageId: 'om_reply',
      text: 'follow up in same thread',
    });

    expect(requests).toHaveLength(2);
    expect(requests[0]?.continuationToken).toBeUndefined();
    expect(requests[1]?.continuationToken).toBe('tok-thread-root');
    expect(store.getContinuation('default', 'ou_user', replyTopic, 'claude-code')).toBe('tok-thread-root-2');
  });
});
