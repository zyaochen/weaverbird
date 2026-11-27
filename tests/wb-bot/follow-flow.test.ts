import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DefaultAgentRegistry } from '../../packages/core/src/agent/registry.js';
import type { AgentAdapter, AgentRun, RunRequest } from '../../packages/core/src/index.js';
import { BindingStore } from '../../apps/wb-bot/src/binding/store.js';
import { EventHandler } from '../../apps/wb-bot/src/feishu/event-handler.js';

let dir = '';
let store: BindingStore;

function mkTestAgent(id: string, displayName: string): AgentAdapter {
  let resolveRun: (() => void) | null = null;
  return {
    id,
    displayName,
    async isAvailable() { return true; },
    async getCapabilities() { return {} as any; },
    run(_req: RunRequest): AgentRun {
      let resolve: () => void;
      const donePromise = new Promise<void>((r) => { resolve = r; resolveRun = r; });
      return {
        events: {
          async *[Symbol.asyncIterator]() {
            await donePromise;
            yield { type: 'done' as const, continuationToken: undefined };
          },
        },
        async stop() { resolve!(); },
        async waitForExit() { return true; },
      };
    },
    get _resolveRun() { return resolveRun; },
  } as AgentAdapter & { _resolveRun: (() => void) | null };
}

function mkTimedAgent(id: string, displayName: string, delayMs: number): AgentAdapter {
  return {
    id,
    displayName,
    async isAvailable() { return true; },
    async getCapabilities() { return {} as any; },
    run(_req: RunRequest): AgentRun {
      return {
        events: {
          async *[Symbol.asyncIterator]() {
            await new Promise((r) => setTimeout(r, delayMs));
            yield { type: 'done' as const, continuationToken: undefined };
          },
        },
        async stop() {},
        async waitForExit() { return true; },
      };
    },
  };
}

function mkErrorAgent(id: string, displayName: string): AgentAdapter {
  return {
    id,
    displayName,
    async isAvailable() { return true; },
    async getCapabilities() { return {} as any; },
    run(_req: RunRequest): AgentRun {
      return {
        events: {
          async *[Symbol.asyncIterator]() {
            yield { type: 'error' as const, message: 'test error' };
          },
        },
        async stop() {},
        async waitForExit() { return true; },
      };
    },
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wb-follow-'));
  store = new BindingStore(join(dir, 'wb-bot.db'));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('follow flow & completion push', () => {
  describe('D1: threshold-gated push', () => {
    it('D1.1: run done duration < threshold → replyText NOT called', async () => {
      const agent = mkTimedAgent('claude-code', 'Claude Code', 10);
      const registry = new DefaultAgentRegistry([{ agent, command: 'claude' }]);
      const testCwd = mkdtempSync(join(tmpdir(), 'wb-cwd-'));
      const replyText = vi.fn(async () => 'msg-1');
      let replySeq = 0;

      const handler = new EventHandler(registry, store, {
        async replyCard() { return `reply-${++replySeq}`; },
        async updateCard() {},
        replyText,
      }, testCwd);

      await handler.handleMessage({ eventId: 'e1', userOpenId: 'u1', threadId: 't1', messageId: 'm1', text: 'hello' });
      expect(replyText).not.toHaveBeenCalled();
      rmSync(testCwd, { recursive: true, force: true });
    });

    it('D1.2: run done duration >= threshold → replyText called with completion message', async () => {
      const prev = process.env['WB_PUSH_THRESHOLD_MS'];
      process.env['WB_PUSH_THRESHOLD_MS'] = '0';
      try {
        const agent = mkTimedAgent('claude-code', 'Claude Code', 10);
        const registry = new DefaultAgentRegistry([{ agent, command: 'claude' }]);
        const testCwd = mkdtempSync(join(tmpdir(), 'wb-cwd-'));
        const replyText = vi.fn(async () => 'msg-1');
        let replySeq = 0;

        const handler = new EventHandler(registry, store, {
          async replyCard() { return `reply-${++replySeq}`; },
          async updateCard() {},
          replyText,
        }, testCwd);

        await handler.handleMessage({ eventId: 'e1', userOpenId: 'u1', threadId: 't1', messageId: 'm1', text: 'hello' });
        expect(replyText).toHaveBeenCalledTimes(1);
        const msg = (replyText.mock.calls[0] as unknown as [string, string])[1];
        expect(msg).toContain('✅');
        expect(msg).toContain('Claude Code');
        expect(msg).toContain('任务完成');
      } finally {
        if (prev === undefined) delete process.env['WB_PUSH_THRESHOLD_MS'];
        else process.env['WB_PUSH_THRESHOLD_MS'] = prev;
      }
    });

    it('D1.3: error event does NOT trigger push', async () => {
      const prev = process.env['WB_PUSH_THRESHOLD_MS'];
      process.env['WB_PUSH_THRESHOLD_MS'] = '0';
      try {
        const agent = mkErrorAgent('claude-code', 'Claude Code');
        const registry = new DefaultAgentRegistry([{ agent, command: 'claude' }]);
        const testCwd = mkdtempSync(join(tmpdir(), 'wb-cwd-'));
        const replyText = vi.fn(async () => 'msg-1');
        let replySeq = 0;

        const handler = new EventHandler(registry, store, {
          async replyCard() { return `reply-${++replySeq}`; },
          async updateCard() {},
          replyText,
        }, testCwd);

        await handler.handleMessage({ eventId: 'e1', userOpenId: 'u1', threadId: 't1', messageId: 'm1', text: 'hello' });
        expect(replyText).not.toHaveBeenCalled();
      } finally {
        if (prev === undefined) delete process.env['WB_PUSH_THRESHOLD_MS'];
        else process.env['WB_PUSH_THRESHOLD_MS'] = prev;
      }
    });

    it('D1.4: /stop event does NOT trigger push', async () => {
      const prev = process.env['WB_PUSH_THRESHOLD_MS'];
      process.env['WB_PUSH_THRESHOLD_MS'] = '0';
      try {
        const agent = mkTestAgent('claude-code', 'Claude Code');
        const registry = new DefaultAgentRegistry([{ agent, command: 'claude' }]);
        const testCwd = mkdtempSync(join(tmpdir(), 'wb-cwd-'));
        const replyText = vi.fn(async () => 'msg-1');
        let replySeq = 0;

        const handler = new EventHandler(registry, store, {
          async replyCard() { return `reply-${++replySeq}`; },
          async updateCard() {},
          replyText,
        }, testCwd);

        const p = handler.handleMessage({ eventId: 'e1', userOpenId: 'u1', threadId: 't1', messageId: 'm1', text: 'task' });
        await new Promise((r) => setTimeout(r, 20));
        await handler.handleMessage({ eventId: 'e2', userOpenId: 'u1', threadId: 't1', messageId: 'm2', text: '/stop' });
        await p;
        expect(replyText).not.toHaveBeenCalled();
        rmSync(testCwd, { recursive: true, force: true });
      } finally {
        if (prev === undefined) delete process.env['WB_PUSH_THRESHOLD_MS'];
        else process.env['WB_PUSH_THRESHOLD_MS'] = prev;
      }
    });
  });

  describe('D2: /follow command', () => {
    it('D2.1: /follow with 0 active sessions returns error card', async () => {
      const agent = mkTimedAgent('claude-code', 'Claude Code', 10);
      const registry = new DefaultAgentRegistry([{ agent, command: 'claude' }]);
      const replyCards: Array<Record<string, unknown>> = [];
      let replySeq = 0;

      const handler = new EventHandler(registry, store, {
        async replyCard(_msgId, card) { replyCards.push(card); return `reply-${++replySeq}`; },
        async updateCard() {},
        async replyText() { return 'msg-1'; },
      }, '/tmp');

      await handler.handleMessage({ eventId: 'e1', userOpenId: 'u1', threadId: 't1', messageId: 'm1', text: '/follow' });
      const cardJson = JSON.stringify(replyCards[0]);
      expect(cardJson).toContain('无 active run');
    });

    it('D2.2: /follow with active session sets flag and returns confirm card', async () => {
      const agent = mkTestAgent('claude-code', 'Claude Code');
      const registry = new DefaultAgentRegistry([{ agent, command: 'claude' }]);
      const testCwd = mkdtempSync(join(tmpdir(), 'wb-cwd-'));
      const replyCards: Array<Record<string, unknown>> = [];
      let replySeq = 0;

      const handler = new EventHandler(registry, store, {
        async replyCard(_msgId, card) { replyCards.push(card); return `reply-${++replySeq}`; },
        async updateCard() {},
        async replyText() { return 'msg-1'; },
      }, testCwd);

      const p = handler.handleMessage({ eventId: 'e1', userOpenId: 'u1', threadId: 't1', messageId: 'm1', text: 'task' });
      await new Promise((r) => setTimeout(r, 20));

      await handler.handleMessage({ eventId: 'e2', userOpenId: 'u1', threadId: 't1', messageId: 'm2', text: '/follow' });
      const cardJson = JSON.stringify(replyCards.at(-1));
      expect(cardJson).toContain('/follow 已设置');

      await handler.stopAllSessions();
      await p;
      rmSync(testCwd, { recursive: true, force: true });
    });

    it('D2.3: /follow + run done (< threshold) → push triggered by follow flag', async () => {
      const agent = mkTimedAgent('claude-code', 'Claude Code', 10);
      const registry = new DefaultAgentRegistry([{ agent, command: 'claude' }]);
      const testCwd = mkdtempSync(join(tmpdir(), 'wb-cwd-'));
      const replyText = vi.fn(async () => 'msg-push');
      const replyCards: Array<Record<string, unknown>> = [];
      let replySeq = 0;

      const handler = new EventHandler(registry, store, {
        async replyCard(_msgId, card) { replyCards.push(card); return `reply-${++replySeq}`; },
        async updateCard() {},
        replyText,
      }, testCwd);

      // Start a run (will finish quickly in ~10ms)
      const p = handler.handleMessage({ eventId: 'e1', userOpenId: 'u1', threadId: 't1', messageId: 'm1', text: 'task' });
      // Wait for the run to actually start (session registered)
      await new Promise((r) => setTimeout(r, 5));

      // Set /follow flag
      await handler.handleMessage({ eventId: 'e2', userOpenId: 'u1', threadId: 't1', messageId: 'm2', text: '/follow' });

      // Wait for run to complete
      await p;
      expect(replyText).toHaveBeenCalledTimes(1);
      rmSync(testCwd, { recursive: true, force: true });
    });

    it('D2.4: /follow + 2 concurrent runs → both push, flag cleared after last', async () => {
      const agents = [
        mkTimedAgent('claude-code', 'Claude Code', 30),
        mkTimedAgent('codex', 'Codex', 50),
      ];
      const registry = new DefaultAgentRegistry(agents.map((a) => ({ agent: a, command: a.id })));
      const testCwd = mkdtempSync(join(tmpdir(), 'wb-cwd-'));
      const replyText = vi.fn(async () => 'msg-push');
      let replySeq = 0;

      const handler = new EventHandler(registry, store, {
        async replyCard() { return `reply-${++replySeq}`; },
        async updateCard() {},
        replyText,
      }, testCwd);

      const p1 = handler.handleMessage({ eventId: 'e1', userOpenId: 'u1', threadId: 't1', messageId: 'm1', text: '/agent claude-code task1' });
      const p2 = handler.handleMessage({ eventId: 'e2', userOpenId: 'u1', threadId: 't1', messageId: 'm2', text: '/agent codex task2' });
      await new Promise((r) => setTimeout(r, 10));

      await handler.handleMessage({ eventId: 'e3', userOpenId: 'u1', threadId: 't1', messageId: 'm3', text: '/follow' });

      await Promise.all([p1, p2]);
      expect(replyText).toHaveBeenCalledTimes(2);
      rmSync(testCwd, { recursive: true, force: true });
    });

    it('D3.1: WB_PUSH_THRESHOLD_MS=0 forces push on any run done', async () => {
      const prev = process.env['WB_PUSH_THRESHOLD_MS'];
      process.env['WB_PUSH_THRESHOLD_MS'] = '0';
      try {
        const agent = mkTimedAgent('claude-code', 'Claude Code', 5);
        const registry = new DefaultAgentRegistry([{ agent, command: 'claude' }]);
        const testCwd = mkdtempSync(join(tmpdir(), 'wb-cwd-'));
        const replyText = vi.fn(async () => 'msg-1');
        let replySeq = 0;

        const handler = new EventHandler(registry, store, {
          async replyCard() { return `reply-${++replySeq}`; },
          async updateCard() {},
          replyText,
        }, testCwd);

        await handler.handleMessage({ eventId: 'e1', userOpenId: 'u1', threadId: 't1', messageId: 'm1', text: 'quick task' });
        expect(replyText).toHaveBeenCalledTimes(1);
        rmSync(testCwd, { recursive: true, force: true });
      } finally {
        if (prev === undefined) delete process.env['WB_PUSH_THRESHOLD_MS'];
        else process.env['WB_PUSH_THRESHOLD_MS'] = prev;
      }
    });
  });
});
