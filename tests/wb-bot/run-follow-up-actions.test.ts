import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventHandler } from '../../apps/wb-bot/src/feishu/event-handler.js';
import { BindingStore } from '../../apps/wb-bot/src/binding/store.js';
import { DefaultAgentRegistry } from '../../packages/core/src/agent/registry.js';
import type { AgentAdapter, AgentRun, RunRequest } from '../../packages/core/src/index.js';

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wb-follow-up-'));
  vi.stubEnv('WB_DATA_DIR', dir);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function recordingAgent(prompts: string[]): AgentAdapter {
  return {
    id: 'codex',
    displayName: 'Codex',
    async isAvailable() { return true; },
    async getCapabilities() { return {} as never; },
    run(req: RunRequest): AgentRun {
      prompts.push(req.prompt);
      return {
        events: {
          async *[Symbol.asyncIterator]() {
            yield { type: 'text' as const, delta: `answer ${prompts.length}` };
            yield { type: 'done' as const, continuationToken: 'tok-1' };
          },
        },
        async stop() {},
        async waitForExit() { return true; },
      };
    },
  };
}

type Card = { body: { elements: Array<{ tag: string; columns?: Array<{ elements: Array<{ text: { content: string }; behaviors: Array<{ value: { action: string } }> }> }> }> } };

function buttons(card: Record<string, unknown>): Array<[string, string]> {
  const row = (card as Card).body.elements.find((element) => element.tag === 'column_set');
  return (row?.columns ?? []).map((column) => [column.elements[0]!.text.content, column.elements[0]!.behaviors[0]!.value.action]);
}

describe('run card follow-up buttons', () => {
  it('offers continue / retry / new session on the final card and enforces the initiator', async () => {
    const store = new BindingStore(join(dir, 'wb-bot.db'));
    const prompts: string[] = [];
    const updates: Array<{ id: string; card: Record<string, unknown> }> = [];
    let replies = 0;
    const handler = new EventHandler(new DefaultAgentRegistry([{ agent: recordingAgent(prompts), command: 'codex' }]), store, {
      async replyCard() { replies += 1; return `card-${replies}`; },
      async updateCard(id, card) { updates.push({ id, card }); },
      async replyText() { return 'text-1'; },
    }, dir);
    try {
      await handler.handleMessage({ eventId: 'e1', userOpenId: 'u1', threadId: 't1', messageId: 'om_1', text: '/agent codex fix the bug' });
      await vi.waitFor(() => expect(updates.some((update) => update.id === 'card-1' && buttons(update.card).length === 3)).toBe(true));
      const final = updates.filter((update) => update.id === 'card-1').at(-1)!;
      expect(buttons(final.card)).toEqual([['继续', 'run_continue'], ['重试', 'run_retry'], ['新会话', 'run_reset']]);

      const click = (action: string, userOpenId = 'u1', eventId = `${action}-${userOpenId}`) =>
        handler.handleCardAction({ eventId, userOpenId, threadId: 'chat', messageId: 'card-1', action });

      expect(await click('run_retry', 'u2')).toEqual({ toast: { type: 'error', content: '只有发起人可以操作这张卡' } });

      expect(await click('run_retry')).toMatchObject({ toast: { type: 'success' } });
      await vi.waitFor(() => expect(prompts).toHaveLength(2));
      expect(prompts[1]).toBe('fix the bug');
      expect(await click('run_retry', 'u1', 'again')).toEqual({ toast: { type: 'info', content: '已经处理过了' } });

      await vi.waitFor(() => expect(replies).toBe(2));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(await click('run_continue')).toMatchObject({ toast: { type: 'success' } });
      await vi.waitFor(() => expect(prompts).toHaveLength(3));
      expect(prompts[2]).toBe('继续');

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(store.getContinuation('default', 'u1', 't1', 'codex')).toBeTruthy();
      expect(await click('run_reset')).toEqual({ toast: { type: 'success', content: '已清空 codex 上下文, 下一条消息开新会话' } });
      expect(store.getContinuation('default', 'u1', 't1', 'codex')).toBeFalsy();

      expect(await handler.handleCardAction({ eventId: 'x', userOpenId: 'u1', threadId: 'chat', messageId: 'unknown-card', action: 'run_retry' }))
        .toEqual({ toast: { type: 'info', content: '这张卡的上下文已失效 (bot 重启过), 请直接发消息' } });
    } finally {
      handler.dispose();
      store.close();
    }
  });
});
