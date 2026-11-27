import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DefaultAgentRegistry } from '../../packages/core/src/agent/registry.js';
import type { AgentAdapter, AgentRun, RunRequest } from '../../packages/core/src/index.js';
import { BindingStore } from '../../apps/wb-bot/src/binding/store.js';
import { EventHandler } from '../../apps/wb-bot/src/feishu/event-handler.js';
import { getAgentDisplay, AGENT_DISPLAY } from '../../apps/wb-bot/src/agent-display.js';

let dir = '';
let store: BindingStore;

function mkTestAgent(id: string, displayName: string): AgentAdapter {
  return {
    id,
    displayName,
    async isAvailable() { return true; },
    async getCapabilities() { return {} as any; },
    run(_req: RunRequest): AgentRun {
      let resolve: () => void;
      const donePromise = new Promise<void>((r) => { resolve = r; });
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
  };
}

function mkImmediateAgent(id: string, displayName: string): AgentAdapter {
  return {
    id,
    displayName,
    async isAvailable() { return true; },
    async getCapabilities() { return {} as any; },
    run(_req: RunRequest): AgentRun {
      return {
        events: {
          async *[Symbol.asyncIterator]() {
            yield { type: 'done' as const, continuationToken: undefined };
          },
        },
        async stop() {},
        async waitForExit() { return true; },
      };
    },
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wb-concurrent-'));
  store = new BindingStore(join(dir, 'wb-bot.db'));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('Block C: concurrent agents', () => {
  describe('C7: 3 agents same thread concurrently', () => {
    it('3 different agents on same thread create 3 active sessions simultaneously', async () => {
      const agents = [
        mkTestAgent('claude-code', 'Claude Code'),
        mkTestAgent('codex', 'Codex'),
        mkTestAgent('mira-cli', 'Mira'),
      ];
      const registry = new DefaultAgentRegistry(agents.map((a) => ({ agent: a, command: a.id })));
      const testCwd = mkdtempSync(join(tmpdir(), 'wb-cwd-'));

      const replyCards: Array<Record<string, unknown>> = [];
      let replySeq = 0;
      const handler = new EventHandler(registry, store, {
        async replyCard(_messageId, card) { replyCards.push(card); return `reply-${++replySeq}`; },
        async updateCard() {},
        async replyText() { return 'msg-1'; },
      }, testCwd);

      // Dispatch 3 messages with /agent syntax for different agents, don't await (they should run concurrently)
      const p1 = handler.handleMessage({ eventId: 'e1', userOpenId: 'u1', threadId: 't1', messageId: 'm1', text: '/agent claude-code check impact' });
      const p2 = handler.handleMessage({ eventId: 'e2', userOpenId: 'u1', threadId: 't1', messageId: 'm2', text: '/agent codex find RCA' });
      const p3 = handler.handleMessage({ eventId: 'e3', userOpenId: 'u1', threadId: 't1', messageId: 'm3', text: '/agent mira-cli run diagnostics' });

      // Wait a tick for all handlers to register their sessions
      await new Promise((r) => setTimeout(r, 50));

      const snapshot = handler.activeSessionsSnapshot();
      expect(snapshot.length).toBe(3);
      const scopeKeys = snapshot.map((s) => s.scopeKey);
      expect(scopeKeys).toContain('u1:t1:claude-code');
      expect(scopeKeys).toContain('u1:t1:codex');
      expect(scopeKeys).toContain('u1:t1:mira-cli');

      // Stop all to let promises resolve
      await handler.stopAllSessions();
      await Promise.allSettled([p1, p2, p3]);
      rmSync(testCwd, { recursive: true, force: true });
    });

    it('same agent same thread triggers busy, different agent same thread does not', async () => {
      const agents = [
        mkTestAgent('claude-code', 'Claude Code'),
        mkTestAgent('codex', 'Codex'),
      ];
      const registry = new DefaultAgentRegistry(agents.map((a) => ({ agent: a, command: a.id })));
      const testCwd = mkdtempSync(join(tmpdir(), 'wb-cwd-'));

      const replyCards: Array<Record<string, unknown>> = [];
      let replySeq = 0;
      const handler = new EventHandler(registry, store, {
        async replyCard(_messageId, card) { replyCards.push(card); return `reply-${++replySeq}`; },
        async updateCard() {},
        async replyText() { return 'msg-1'; },
      }, testCwd);

      // Start claude-code session
      const p1 = handler.handleMessage({ eventId: 'e1', userOpenId: 'u1', threadId: 't1', messageId: 'm1', text: '/agent claude-code task1' });
      await new Promise((r) => setTimeout(r, 20));

      // Start codex on same thread - should NOT be busy
      const p2 = handler.handleMessage({ eventId: 'e2', userOpenId: 'u1', threadId: 't1', messageId: 'm2', text: '/agent codex task2' });
      await new Promise((r) => setTimeout(r, 20));

      expect(handler.activeSessionsSnapshot().length).toBe(2);

      // Try claude-code again - should trigger busy
      const p3 = handler.handleMessage({ eventId: 'e3', userOpenId: 'u1', threadId: 't1', messageId: 'm3', text: '/agent claude-code task3' });
      await new Promise((r) => setTimeout(r, 20));

      // Still only 2 active sessions
      expect(handler.activeSessionsSnapshot().length).toBe(2);
      // Busy card should mention claude-code
      const busyCard = replyCards.at(-1);
      expect(JSON.stringify(busyCard)).toContain('claude-code');
      expect(JSON.stringify(busyCard)).toContain('已排队');

      await handler.stopAllSessions();
      await Promise.allSettled([p1, p2, p3]);
      rmSync(testCwd, { recursive: true, force: true });
    });
  });

  describe('C8: same agent same thread busy queue', () => {
    it('second message to same agent shows busy card with agent name', async () => {
      const agent = mkTestAgent('claude-code', 'Claude Code');
      const registry = new DefaultAgentRegistry([{ agent, command: 'claude' }]);
      const testCwd = mkdtempSync(join(tmpdir(), 'wb-cwd-'));

      const replyCards: Array<Record<string, unknown>> = [];
      let replySeq = 0;
      const handler = new EventHandler(registry, store, {
        async replyCard(_messageId, card) { replyCards.push(card); return `reply-${++replySeq}`; },
        async updateCard() {},
        async replyText() { return 'msg-1'; },
      }, testCwd);

      const p1 = handler.handleMessage({ eventId: 'e1', userOpenId: 'u1', threadId: 't1', messageId: 'm1', text: 'first task' });
      await new Promise((r) => setTimeout(r, 20));
      const p2 = handler.handleMessage({ eventId: 'e2', userOpenId: 'u1', threadId: 't1', messageId: 'm2', text: 'second task' });
      await new Promise((r) => setTimeout(r, 20));

      const busyCardJson = JSON.stringify(replyCards.at(-1));
      expect(busyCardJson).toContain('claude-code');
      expect(busyCardJson).toContain('已排队');

      await handler.stopAllSessions();
      await Promise.allSettled([p1, p2]);
      rmSync(testCwd, { recursive: true, force: true });
    });
  });

  describe('C5: /agent <id> <prompt> parsing', () => {
    it('valid /agent syntax runs specified agent without updating binding', async () => {
      const agents = [
        mkImmediateAgent('claude-code', 'Claude Code'),
        mkImmediateAgent('codex', 'Codex'),
      ];
      const registry = new DefaultAgentRegistry(agents.map((a) => ({ agent: a, command: a.id })));
      const testCwd = mkdtempSync(join(tmpdir(), 'wb-cwd-'));

      let replySeq = 0;
      const handler = new EventHandler(registry, store, {
        async replyCard() { return `reply-${++replySeq}`; },
        async updateCard() {},
        async replyText() { return 'msg-1'; },
      }, testCwd);

      await handler.handleMessage({ eventId: 'e1', userOpenId: 'u1', threadId: 't1', messageId: 'm1', text: '/agent codex explain this' });

      // /agent is one-shot: does NOT update thread_binding (Red line 8)
      const binding = store.getThreadBinding('default', 'u1', 't1');
      expect(binding?.agentId).toBeUndefined();
      rmSync(testCwd, { recursive: true, force: true });
    });

    it('unregistered agent returns error card', async () => {
      const agent = mkImmediateAgent('claude-code', 'Claude Code');
      const registry = new DefaultAgentRegistry([{ agent, command: 'claude' }]);

      const replyCards: Array<Record<string, unknown>> = [];
      const handler = new EventHandler(registry, store, {
        async replyCard(_messageId, card) { replyCards.push(card); return 'reply-1'; },
        async updateCard() {},
        async replyText() { return 'msg-1'; },
      }, '/tmp');

      await handler.handleMessage({ eventId: 'e1', userOpenId: 'u1', threadId: 't1', messageId: 'm1', text: '/agent nonexistent do something' });

      expect(JSON.stringify(replyCards[0])).toContain('未注册 agent');
      expect(JSON.stringify(replyCards[0])).toContain('nonexistent');
    });

    it('empty prompt after /agent returns error card', async () => {
      const agent = mkImmediateAgent('claude-code', 'Claude Code');
      const registry = new DefaultAgentRegistry([{ agent, command: 'claude' }]);

      const replyCards: Array<Record<string, unknown>> = [];
      const handler = new EventHandler(registry, store, {
        async replyCard(_messageId, card) { replyCards.push(card); return 'reply-1'; },
        async updateCard() {},
        async replyText() { return 'msg-1'; },
      }, '/tmp');

      await handler.handleMessage({ eventId: 'e1', userOpenId: 'u1', threadId: 't1', messageId: 'm1', text: '/agent claude-code    ' });

      expect(JSON.stringify(replyCards[0])).toContain('请在 /agent');
    });

    it('/agent does not change thread_binding (one-shot)', async () => {
      const agents = [
        mkImmediateAgent('claude-code', 'Claude Code'),
        mkImmediateAgent('codex', 'Codex'),
      ];
      const registry = new DefaultAgentRegistry(agents.map((a) => ({ agent: a, command: a.id })));
      const testCwd = mkdtempSync(join(tmpdir(), 'wb-cwd-'));

      let replySeq = 0;
      const handler = new EventHandler(registry, store, {
        async replyCard() { return `reply-${++replySeq}`; },
        async updateCard() {},
        async replyText() { return 'msg-1'; },
      }, testCwd);

      // First set binding to claude-code via normal message
      await handler.handleMessage({ eventId: 'e1', userOpenId: 'u1', threadId: 't1', messageId: 'm1', text: 'hello' });
      const binding1 = store.getThreadBinding('default', 'u1', 't1');
      expect(binding1?.agentId).toBe('claude-code');

      // Use /agent codex - binding should still be claude-code after
      await handler.handleMessage({ eventId: 'e2', userOpenId: 'u1', threadId: 't1', messageId: 'm2', text: '/agent codex do thing' });
      const binding2 = store.getThreadBinding('default', 'u1', 't1');
      // Note: the current implementation does upsertThreadBinding after run for all paths
      // For /agent one-shot behavior, we must NOT upsert binding.
      // This test verifies the spec requirement (Red line 8)
      expect(binding2?.agentId).toBe('claude-code');

      rmSync(testCwd, { recursive: true, force: true });
    });
  });

  describe('C5.1: typed /stop multi-session', () => {
    it('/stop with 0 active sessions falls through to router', async () => {
      const agent = mkImmediateAgent('claude-code', 'Claude Code');
      const registry = new DefaultAgentRegistry([{ agent, command: 'claude' }]);

      const replyCards: Array<Record<string, unknown>> = [];
      const handler = new EventHandler(registry, store, {
        async replyCard(_messageId, card) { replyCards.push(card); return 'reply-1'; },
        async updateCard() {},
        async replyText() { return 'msg-1'; },
      }, '/tmp');

      await handler.handleMessage({ eventId: 'e1', userOpenId: 'u1', threadId: 't1', messageId: 'm1', text: '/stop' });
      // Router should handle and return help or "当前没有"
      expect(replyCards.length).toBeGreaterThan(0);
    });

    it('/stop with 1 active session stops it (W1 behavior)', async () => {
      const agent = mkTestAgent('claude-code', 'Claude Code');
      const registry = new DefaultAgentRegistry([{ agent, command: 'claude' }]);
      const testCwd = mkdtempSync(join(tmpdir(), 'wb-cwd-'));

      let replySeq = 0;
      const handler = new EventHandler(registry, store, {
        async replyCard() { return `reply-${++replySeq}`; },
        async updateCard() {},
        async replyText() { return 'msg-1'; },
      }, testCwd);

      const p1 = handler.handleMessage({ eventId: 'e1', userOpenId: 'u1', threadId: 't1', messageId: 'm1', text: 'do something' });
      await new Promise((r) => setTimeout(r, 20));
      expect(handler.activeSessionsSnapshot().length).toBe(1);

      await handler.handleMessage({ eventId: 'e2', userOpenId: 'u1', threadId: 't1', messageId: 'm2', text: '/stop' });
      await p1;
      expect(handler.activeSessionsSnapshot().length).toBe(0);

      rmSync(testCwd, { recursive: true, force: true });
    });

    it('/stop with ≥2 active sessions stops all (stop-all alias)', async () => {
      const agents = [
        mkTestAgent('claude-code', 'Claude Code'),
        mkTestAgent('codex', 'Codex'),
      ];
      const registry = new DefaultAgentRegistry(agents.map((a) => ({ agent: a, command: a.id })));
      const testCwd = mkdtempSync(join(tmpdir(), 'wb-cwd-'));

      const replyCards: Array<Record<string, unknown>> = [];
      let replySeq = 0;
      const handler = new EventHandler(registry, store, {
        async replyCard(_messageId, card) { replyCards.push(card); return `reply-${++replySeq}`; },
        async updateCard() {},
        async replyText() { return 'msg-1'; },
      }, testCwd);

      const p1 = handler.handleMessage({ eventId: 'e1', userOpenId: 'u1', threadId: 't1', messageId: 'm1', text: '/agent claude-code task1' });
      const p2 = handler.handleMessage({ eventId: 'e2', userOpenId: 'u1', threadId: 't1', messageId: 'm2', text: '/agent codex task2' });
      await new Promise((r) => setTimeout(r, 50));
      expect(handler.activeSessionsSnapshot().length).toBe(2);

      await handler.handleMessage({ eventId: 'e3', userOpenId: 'u1', threadId: 't1', messageId: 'm3', text: '/stop' });
      await Promise.allSettled([p1, p2]);

      expect(handler.activeSessionsSnapshot().length).toBe(0);
      const stopCard = JSON.stringify(replyCards.at(-1));
      expect(stopCard).toContain('已停止 2 个任务');

      rmSync(testCwd, { recursive: true, force: true });
    });

    it('/stop <id> stops only the specified agent', async () => {
      const agents = [
        mkTestAgent('claude-code', 'Claude Code'),
        mkTestAgent('codex', 'Codex'),
      ];
      const registry = new DefaultAgentRegistry(agents.map((a) => ({ agent: a, command: a.id })));
      const testCwd = mkdtempSync(join(tmpdir(), 'wb-cwd-'));

      let replySeq = 0;
      const handler = new EventHandler(registry, store, {
        async replyCard() { return `reply-${++replySeq}`; },
        async updateCard() {},
        async replyText() { return 'msg-1'; },
      }, testCwd);

      const p1 = handler.handleMessage({ eventId: 'e1', userOpenId: 'u1', threadId: 't1', messageId: 'm1', text: '/agent claude-code task1' });
      const p2 = handler.handleMessage({ eventId: 'e2', userOpenId: 'u1', threadId: 't1', messageId: 'm2', text: '/agent codex task2' });
      await new Promise((r) => setTimeout(r, 50));
      expect(handler.activeSessionsSnapshot().length).toBe(2);

      await handler.handleMessage({ eventId: 'e3', userOpenId: 'u1', threadId: 't1', messageId: 'm3', text: '/stop codex' });
      await new Promise((r) => setTimeout(r, 20));

      const remaining = handler.activeSessionsSnapshot();
      expect(remaining.length).toBe(1);
      expect(remaining[0]!.agentId).toBe('claude-code');

      await handler.stopAllSessions();
      await Promise.allSettled([p1, p2]);
      rmSync(testCwd, { recursive: true, force: true });
    });
  });

  describe('C6: agent-display', () => {
    it('returns correct emoji for registered agents', () => {
      expect(getAgentDisplay('claude-code').emoji).toBe('🧠');
      expect(getAgentDisplay('codex').emoji).toBe('⚡');
      expect(getAgentDisplay('mira-cli').emoji).toBe('🔧');
    });

    it('returns fallback for unknown agents', () => {
      expect(getAgentDisplay('unknown-agent').emoji).toBe('🤖');
      expect(getAgentDisplay('unknown-agent').supportsSubagent).toBe(false);
    });

    it('all built-in emojis pass validation (startup check)', () => {
      for (const [id, meta] of Object.entries(AGENT_DISPLAY)) {
        expect(meta.emoji.length).toBeGreaterThan(0);
        expect(meta.emoji.length).toBeLessThanOrEqual(4);
        expect(/^[\x00-\x1F\x7F]/.test(meta.emoji)).toBe(false);
        expect(/^[A-Za-z]$/.test(meta.emoji)).toBe(false);
      }
    });
  });
});
