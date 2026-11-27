import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventHandler } from '../../apps/wb-bot/src/feishu/event-handler.js';
import { BindingStore } from '../../apps/wb-bot/src/binding/store.js';
import { DefaultAgentRegistry } from '../../packages/core/src/agent/registry.js';
import type { AgentAdapter, AgentRun } from '../../packages/core/src/index.js';

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wb-continuation-'));
  vi.stubEnv('WB_DATA_DIR', dir);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function agentWithOutput(text: string): AgentAdapter {
  return {
    id: 'codex',
    displayName: 'Codex',
    async isAvailable() { return true; },
    async getCapabilities() { return {} as never; },
    run(): AgentRun {
      return {
        events: {
          async *[Symbol.asyncIterator]() {
            yield { type: 'text' as const, delta: text };
            yield { type: 'done' as const };
          },
        },
        async stop() {},
        async waitForExit() { return true; },
      };
    },
  };
}

describe('EventHandler continuation cards', () => {
  it('replies the overflow of a long answer as numbered continuation cards in order', async () => {
    const store = new BindingStore(join(dir, 'wb-bot.db'));
    const replies: Array<{ to: string; card: Record<string, unknown> }> = [];
    const text = Array.from({ length: 30 }, (_, i) => `段落 ${i} ${'内容'.repeat(500)}`).join('\n\n');
    const handler = new EventHandler(new DefaultAgentRegistry([{ agent: agentWithOutput(text), command: 'codex' }]), store, {
      async replyCard(to, card) { replies.push({ to, card }); return `reply-${replies.length}`; },
      async updateCard() {},
      async replyText() { return 'text-1'; },
    }, dir);
    try {
      await handler.handleMessage({ eventId: 'e1', userOpenId: 'u1', threadId: 't1', messageId: 'om_1', text: 'write a lot' });
      await vi.waitFor(() => expect(replies.length).toBeGreaterThan(2));
      await new Promise((resolve) => setTimeout(resolve, 20));
      const continuations = replies.slice(1);
      const total = continuations.length + 1;
      expect(continuations.every((reply) => reply.to === 'om_1')).toBe(true);
      expect(continuations.map((reply) => (reply.card['header'] as { title: { content: string } }).title.content))
        .toEqual(continuations.map((_, i) => `⚡ Codex · codex · 续 ${i + 2}/${total}`));
      const joined = continuations.map((reply) => JSON.stringify(reply.card)).join('');
      expect(joined).toContain('段落 29');
    } finally {
      handler.dispose();
      store.close();
    }
  });
});
