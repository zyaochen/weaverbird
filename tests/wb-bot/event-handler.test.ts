import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DefaultAgentRegistry } from '../../packages/core/src/agent/registry.js';
import { ClaudeCodeAgent } from '../../packages/core/src/agent/claude-code.js';
import type { AgentAdapter, AgentRegistry, AgentRun, RunRequest } from '../../packages/core/src/index.js';
import { BindingStore } from '../../apps/wb-bot/src/binding/store.js';
import { runStopSignalPath } from '../../packages/core/src/paths.js';
import { EventHandler } from '../../apps/wb-bot/src/feishu/event-handler.js';
import { allocateSessionShortId, createInitialState } from '../../apps/wb-bot/src/feishu/stream-state.js';
import { CaptainService } from '../../packages/core/src/captain/index.js';
import { createConcurrencyQueueIndex } from '../../packages/core/src/captain/concurrency-queue-index.js';
import { createQueueMetricsAggregator } from '../../packages/core/src/captain/queue-metrics/aggregator.js';

let dir = '';
let store: BindingStore;
const registry = new DefaultAgentRegistry([{ agent: new ClaudeCodeAgent(), command: 'claude' }]);

function mkTmpDir(): string {
  return mkdtempSync('/tmp/wb-handler-test-');
}

function mkTestAgent(id: string, displayName: string): AgentAdapter {
  return {
    id,
    displayName,
    async isAvailable() { return true; },
    async getCapabilities() { return {} as any; },
    run(_req: RunRequest): AgentRun {
      let resolve!: () => void;
      const donePromise = new Promise<void>((r) => { resolve = r; });
      return {
        events: {
          async *[Symbol.asyncIterator]() {
            await donePromise;
            yield { type: 'done' as const, continuationToken: undefined };
          },
        },
        async stop() { resolve(); },
        async waitForExit() { return true; },
      };
    },
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wb-bot-handler-'));
  store = new BindingStore(join(dir, 'wb-bot.db'));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('event handler', () => {
  it('allocates unique visible short ids and resolves them back to the owning session', async () => {
    const first = allocateSessionShortId('aaaaaaaa11111111', []);
    const second = allocateSessionShortId('aaaaaaaa22222222', [first]);
    expect(first).toBe('aaaaaaaa');
    expect(second).toBe('aaaaaaaa2');

    const testCwd = mkTmpDir();
    const agents = [
      mkTestAgent('claude-code', 'Claude Code'),
      mkTestAgent('codex', 'Codex'),
    ];
    const registry = new DefaultAgentRegistry(agents.map((a) => ({ agent: a, command: a.id })));

    let replySeq = 0;
    const handler = new EventHandler(registry, store, {
      async replyCard() { return `reply-${++replySeq}`; },
      async updateCard() {},
      async replyText() { return 'msg-1'; },
    }, testCwd);

    try {
      const p1 = handler.handleMessage({ eventId: 'e1', userOpenId: 'u1', threadId: 't1', messageId: 'm1', text: '/agent claude-code hello' });
      const p2 = handler.handleMessage({ eventId: 'e2', userOpenId: 'u2', threadId: 't2', messageId: 'm2', text: '/agent codex hello' });
      await new Promise((r) => setTimeout(r, 30));

      const snapshots = handler.activeSessionsSnapshot();
      expect(snapshots).toHaveLength(2);
      const ids = snapshots.map((s) => s.sessionShortId);
      expect(new Set(ids).size).toBe(2);
      for (const snapshot of snapshots) {
        expect(snapshot.sessionShortId).toBeDefined();
        const resolved = handler.activeSessionSnapshotByShortId(snapshot.sessionShortId!);
        expect(resolved?.scopeKey).toBe(snapshot.scopeKey);
      }
      await handler.stopAllSessions();
      await Promise.allSettled([p1, p2]);
    } finally {
      handler.dispose();
      rmSync(testCwd, { recursive: true, force: true });
    }
  });

  it('does not inject ANTHROPIC_MODEL into agent run requests (adapter handles model env internally)', async () => {
    const previous = process.env['ANTHROPIC_MODEL'];
    process.env['ANTHROPIC_MODEL'] = 'claude-sonnet-4';
    const testCwd = mkTmpDir();
    try {
      store.setCurrentCwd('default', 'u1', 't1', testCwd);
      const requests: RunRequest[] = [];
      const registry: AgentRegistry = {
        register() {},
        lookup() {
          return {
            id: 'claude-code',
            displayName: 'Claude Code',
            async isAvailable() { return true; },
            async getCapabilities() {
              return new ClaudeCodeAgent().getCapabilities();
            },
            run(req: RunRequest): AgentRun {
              requests.push(req);
              return {
                events: { async *[Symbol.asyncIterator]() { yield { type: 'done' } as const; } },
                async stop() {},
                async waitForExit() { return true; },
              };
            },
          };
        },
        list() { return []; },
        async isAvailable() { return true; },
      };
      const handler = new EventHandler(registry, store, {
        async replyCard() { return 'reply-1'; },
        async updateCard() {},
      async replyText() { return 'msg-1'; },
      });

      await handler.handleMessage({
        eventId: 'evt-model',
        userOpenId: 'u1',
        threadId: 't1',
        messageId: 'm1',
        text: 'hello',
      });

      expect(requests).toHaveLength(1);
      expect(requests[0]?.model).toBeUndefined();
    } finally {
      rmSync(testCwd, { recursive: true, force: true });
      if (previous === undefined) delete process.env['ANTHROPIC_MODEL'];
      else process.env['ANTHROPIC_MODEL'] = previous;
    }
  });

  it('rejects message when bot process.cwd() is not in HP-2 allowlist', async () => {
    const replies: Array<Record<string, unknown>> = [];
    const registry: AgentRegistry = {
      register() {},
      lookup() {
        return {
          id: 'claude-code',
          displayName: 'Claude Code',
          async isAvailable() { return true; },
          async getCapabilities() { return new ClaudeCodeAgent().getCapabilities(); },
          run(): AgentRun {
            return {
              events: { async *[Symbol.asyncIterator]() { yield { type: 'done' } as const; } },
              async stop() {},
              async waitForExit() { return true; },
            };
          },
        };
      },
      list() { return []; },
      async isAvailable() { return true; },
    };
    const handler = new EventHandler(registry, store, {
      async replyCard(_messageId, card) { replies.push(card); return 'reply-1'; },
      async updateCard() {},
      async replyText() { return 'msg-1'; },
    });

    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/etc');
    try {
      await handler.handleMessage({
        eventId: 'evt-cwd-denied',
        userOpenId: 'u1',
        threadId: 't1',
        messageId: 'm1',
        text: 'hello',
      });
      expect(replies).toHaveLength(1);
      const bodyText = JSON.stringify(replies[0]);
      expect(bodyText).toContain('bot 当前工作目录不在允许范围');
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it('resolves default agent via isAvailable() when no thread binding exists', async () => {
    const testCwd = mkTmpDir();
    const requests: RunRequest[] = [];
    const codexAgent = {
      id: 'codex',
      displayName: 'Codex',
      async isAvailable() { return true; },
      async getCapabilities() { return new ClaudeCodeAgent().getCapabilities(); },
      run(req: RunRequest): AgentRun {
        requests.push(req);
        return {
          events: { async *[Symbol.asyncIterator]() { yield { type: 'done' } as const; } },
          async stop() {},
          async waitForExit() { return true; },
        };
      },
    };
    const claudeAgent = {
      id: 'claude-code',
      displayName: 'Claude Code',
      async isAvailable() { return false; },
      async getCapabilities() { return new ClaudeCodeAgent().getCapabilities(); },
      run(): AgentRun {
        throw new Error('should not be called');
      },
    };
    const onlyCodexRegistry: AgentRegistry = {
      register() {},
      lookup(id: string) {
        if (id === 'claude-code') return claudeAgent;
        if (id === 'codex') return codexAgent;
        return null;
      },
      list() { return [claudeAgent, codexAgent]; },
      async isAvailable(id: string) {
        if (id === 'claude-code') return false;
        if (id === 'codex') return true;
        return null;
      },
    };
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(testCwd);
    try {
      const handler = new EventHandler(onlyCodexRegistry, store, {
        async replyCard() { return 'reply-1'; },
        async updateCard() {},
      async replyText() { return 'msg-1'; },
      });

      await handler.handleMessage({
        eventId: 'evt-default-agent',
        userOpenId: 'u1',
        threadId: 't1',
        messageId: 'm1',
        text: 'hello from only-codex env',
      });

      expect(requests).toHaveLength(1);
    } finally {
      cwdSpy.mockRestore();
      rmSync(testCwd, { recursive: true, force: true });
    }
  });

  it('acks command handling without starting a reply stream', async () => {
    const replyCard = vi.fn(async () => 'reply-1');
    const handler = new EventHandler(registry, store, {
      replyCard,
      async updateCard() {},
      async replyText() { return 'msg-1'; },
    });

    await handler.handleMessage({
      eventId: 'evt-cmd',
      userOpenId: 'u1',
      threadId: 't1',
      messageId: 'm1',
      text: '/help',
    });

    expect(replyCard).toHaveBeenCalledTimes(1);
  });

  it('binds /queue-metrics to current session snapshot only', async () => {
    const replies: Array<Record<string, unknown>> = [];
    const metrics = createQueueMetricsAggregator();
    metrics.record({ metric: 'captain_queue_running_total', value: 1, labels: { session_id: 'default:u1:t1' } });
    metrics.record({ metric: 'captain_queue_depth', value: 2, labels: { session_id: 'default:u1:t1' } });
    metrics.record({ metric: 'captain_queue_decisions_total', value: 3, labels: { session_id: 'default:u1:t1' } });
    metrics.record({ metric: 'captain_queue_promotions_total', value: 4, labels: { session_id: 'default:u1:t1' } });
    metrics.record({ metric: 'captain_queue_preempted_runs_total', value: 5, labels: { session_id: 'default:u1:t1' } });
    metrics.record({ metric: 'captain_queue_cancelled_runs_total', value: 6, labels: { session_id: 'default:u1:t1' } });
    metrics.record({ metric: 'captain_queue_wait_duration_seconds', value: 7, labels: { session_id: 'default:u1:t1' } });
    metrics.record({ metric: 'captain_queue_wait_duration_seconds', value: 9, labels: { session_id: 'default:u1:t1' } });
    metrics.record({ metric: 'captain_queue_running_total', value: 99, labels: { session_id: 'default:u2:t2' } });
    metrics.record({ metric: 'captain_queue_depth', value: 88, labels: { session_id: 'default:u2:t2' } });

    const handler = new EventHandler(registry, store, {
      async replyCard(_messageId, card) {
        replies.push(card);
        return 'reply-1';
      },
      async updateCard() {},
      async replyText() { return 'msg-1'; },
    }, undefined, undefined, undefined, undefined, undefined, {
      config: { max_concurrent_runs: 1, queue_max_depth: 1 },
      index: createConcurrencyQueueIndex(metrics),
      store: { append() {}, readAll() { return []; }, path: '' },
      metrics,
    });

    await handler.handleMessage({
      eventId: 'evt-queue-metrics',
      userOpenId: 'u1',
      threadId: 't1',
      messageId: 'm1',
      text: '/queue-metrics',
    });

    const reply = replies[0] as { body: { elements: Array<{ content?: string }> } };
    const bodyText = reply.body.elements.map((element) => element.content ?? '').join('\n');
    expect(bodyText).toContain('Queue Metrics (session)');
    expect(bodyText).toContain('- running: 1');
    expect(bodyText).toContain('- queued: 2');
    expect(bodyText).toContain('- decisions_total: 3');
    expect(bodyText).toContain('- promoted_total: 4');
    expect(bodyText).toContain('- preempted_total: 5');
    expect(bodyText).toContain('- cancelled_total: 6');
    expect(bodyText).toContain('- wait_p50_s: 7');
    expect(bodyText).toContain('- wait_p95_s: 9');
    expect(bodyText).not.toContain('99');
    expect(bodyText).not.toContain('88');
  });

  it('does not append system meta to ordinary command cards', async () => {
    const replies: Array<Record<string, unknown>> = [];
    const handler = new EventHandler(registry, store, {
      async replyCard(_messageId, card) {
        replies.push(card);
        return 'reply-1';
      },
      async updateCard() {},
      async replyText() { return 'msg-1'; },
    });

    await handler.handleMessage({
      eventId: 'evt-now',
      userOpenId: 'u1',
      threadId: 't1',
      messageId: 'm1',
      text: '/now',
    });

    const reply = replies[0] as { body: { elements: Array<{ content?: string }> } };
    expect(reply.body.elements.some((element) => element.content?.includes('agent: system'))).toBe(false);
    expect(reply.body.elements.some((element) => element.content?.includes('model: -'))).toBe(false);
  });

  it('deduplicates repeated card actions', async () => {
    const updates: Array<Record<string, unknown>> = [];
    const replies: Array<Record<string, unknown>> = [];
    const handler = new EventHandler(registry, store, {
      async replyCard(_messageId, card) {
        replies.push(card);
        return 'reply-1';
      },
      async updateCard(_messageId, card) {
        updates.push(card);
      },
      async replyText() { return 'msg-1'; },
    });

    const first = await handler.handleCardAction({ eventId: 'evt-1', userOpenId: 'u1', threadId: 't1', messageId: 'm1', action: 'stop' });
    const second = await handler.handleCardAction({ eventId: 'evt-1', userOpenId: 'u1', threadId: 't1', messageId: 'm1', action: 'stop' });
    expect(first).toEqual({ toast: { type: 'info', content: '当前没有可停止的运行' } });
    expect(second).toEqual({ toast: { type: 'info', content: 'duplicate' } });
    expect(replies).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it('stops active runs by reply message id and updates card to stopping state', async () => {
    const testCwd = mkTmpDir();
    store.setCurrentCwd('default', 'u1', 't1', testCwd);
    let stopResolve: (() => void) | null = null;
    let stopped = false;
    const updates: Array<Record<string, unknown>> = [];
    const registry: AgentRegistry = {
      register() {},
      lookup() {
        return {
          id: 'claude-code',
          displayName: 'Claude Code',
          async isAvailable() { return true; },
          async getCapabilities() {
            return new ClaudeCodeAgent().getCapabilities();
          },
          run(): AgentRun {
            return {
              events: {
                async *[Symbol.asyncIterator]() {
                  yield { type: 'system', cwd: '/tmp/project', model: 'gpt-5.4', continuationToken: 'tok-1' } as const;
                  await new Promise<void>((resolve) => { stopResolve = resolve; });
                  yield { type: 'done', continuationToken: 'tok-1' } as const;
                },
              },
              async stop() {
                stopped = true;
                stopResolve?.();
              },
              async waitForExit() { return true; },
            };
          },
        };
      },
      list() { return []; },
      async isAvailable() { return true; },
    };
    const handler = new EventHandler(registry, store, {
      async replyCard() { return 'reply-1'; },
      async updateCard(_messageId, card) {
        updates.push(card);
      },
      async replyText() { return 'msg-1'; },
    });

    const running = handler.handleMessage({
      eventId: 'evt-run',
      userOpenId: 'u1',
      threadId: 't1',
      messageId: 'm1',
      text: 'hello',
    });
    await vi.waitFor(() => expect(updates.length).toBeGreaterThan(0));

    try {
      const stopByReply = await handler.handleCardAction({
        eventId: 'evt-stop',
        userOpenId: 'u1',
        threadId: 't1',
        messageId: 'reply-1',
        action: 'stop',
      });

      expect(stopByReply).toEqual({ toast: { type: 'success', content: '停止中...' } });
      expect(stopped).toBe(true);
      await vi.waitFor(() => {
        expect(updates.some((card) => JSON.stringify(card).includes('停止中'))).toBe(true);
      });
      await running;
      expect(JSON.stringify(updates.at(-1))).toContain('已停止');
    } finally {
      await running;
      rmSync(testCwd, { recursive: true, force: true });
    }
  });

  it('keeps stop button in stopping state until the terminal event arrives', async () => {
    const testCwd = mkTmpDir();
    store.setCurrentCwd('default', 'u1', 't1', testCwd);
    let releaseTerminal: (() => void) | undefined;
    let stopRequested = false;
    const updates: Array<Record<string, unknown>> = [];

    const registry: AgentRegistry = {
      register() {},
      lookup() {
        return {
          id: 'claude-code',
          displayName: 'Claude Code',
          async isAvailable() { return true; },
          async getCapabilities() {
            return new ClaudeCodeAgent().getCapabilities();
          },
          run(): AgentRun {
            return {
              events: {
                async *[Symbol.asyncIterator]() {
                  yield { type: 'system', cwd: '/tmp/project', model: 'gpt-5.4', continuationToken: 'tok-1' } as const;
                  await new Promise<void>((resolve) => { releaseTerminal = resolve; });
                  yield { type: 'done', continuationToken: 'tok-1' } as const;
                },
              },
              async stop() {
                stopRequested = true;
              },
              async waitForExit() { return true; },
            };
          },
        };
      },
      list() { return []; },
      async isAvailable() { return true; },
    };
    const handler = new EventHandler(registry, store, {
      async replyCard() { return 'reply-1'; },
      async updateCard(_messageId, card) {
        updates.push(card);
      },
      async replyText() { return 'msg-1'; },
    });

    const running = handler.handleMessage({
      eventId: 'evt-run-wait-stop',
      userOpenId: 'u1',
      threadId: 't1',
      messageId: 'm1',
      text: 'hello',
    });
    await vi.waitFor(() => expect(updates.length).toBeGreaterThan(0));

    try {
      const stopByReply = await handler.handleCardAction({
        eventId: 'evt-stop-pending',
        userOpenId: 'u1',
        threadId: 't1',
        messageId: 'reply-1',
        action: 'stop',
      });

      expect(stopByReply).toEqual({ toast: { type: 'success', content: '停止中...' } });
      expect(stopRequested).toBe(true);
      await vi.waitFor(() => {
        expect(JSON.stringify(updates.at(-1))).toContain('停止中');
      });
      expect(JSON.stringify(updates.at(-1))).not.toContain('已停止');

      if (typeof releaseTerminal === 'function') releaseTerminal();
      await running;
      expect(JSON.stringify(updates.at(-1))).toContain('已停止');
    } finally {
      if (typeof releaseTerminal === 'function') releaseTerminal();
      await running;
      rmSync(testCwd, { recursive: true, force: true });
    }
  });

  it('stops active runs by source message id too', async () => {
    const testCwd = mkTmpDir();
    store.setCurrentCwd('default', 'u1', 't1', testCwd);
    let stopResolve: (() => void) | null = null;
    let stopped = false;
    const updates: Array<Record<string, unknown>> = [];
    const registry: AgentRegistry = {
      register() {},
      lookup() {
        return {
          id: 'claude-code',
          displayName: 'Claude Code',
          async isAvailable() { return true; },
          async getCapabilities() {
            return new ClaudeCodeAgent().getCapabilities();
          },
          run(): AgentRun {
            return {
              events: {
                async *[Symbol.asyncIterator]() {
                  yield { type: 'system', cwd: '/tmp/project', model: 'gpt-5.4', continuationToken: 'tok-1' } as const;
                  await new Promise<void>((resolve) => { stopResolve = resolve; });
                  yield { type: 'done', continuationToken: 'tok-1' } as const;
                },
              },
              async stop() {
                stopped = true;
                stopResolve?.();
              },
              async waitForExit() { return true; },
            };
          },
        };
      },
      list() { return []; },
      async isAvailable() { return true; },
    };
    const handler = new EventHandler(registry, store, {
      async replyCard() { return 'reply-1'; },
      async updateCard(_messageId, card) {
        updates.push(card);
      },
      async replyText() { return 'msg-1'; },
    });

    const running = handler.handleMessage({
      eventId: 'evt-run-source',
      userOpenId: 'u1',
      threadId: 't1',
      messageId: 'm1',
      text: 'hello',
    });
    await vi.waitFor(() => expect(updates.length).toBeGreaterThan(0));

    try {
      const stopBySource = await handler.handleCardAction({
        eventId: 'evt-stop-source',
        userOpenId: 'u1',
        threadId: 't1',
        messageId: 'm1',
        action: 'stop',
      });

      expect(stopBySource).toEqual({ toast: { type: 'success', content: '停止中...' } });
      expect(stopped).toBe(true);
      await running;
      expect(JSON.stringify(updates.at(-1))).toContain('已停止');
    } finally {
      await running;
      rmSync(testCwd, { recursive: true, force: true });
    }
  });

  it('marks restart cards', async () => {
    const replies: Array<Record<string, unknown>> = [];
    const handler = new EventHandler(registry, store, {
      async replyCard(_messageId, card) {
        replies.push(card);
        return 'reply-1';
      },
      async updateCard() {},
      async replyText() { return 'msg-1'; },
    });

    await handler.markRestarted('m1');
    const reply = replies[0] as { header: { title: { content: string } }; body: { elements: Array<{ content?: string }> } };
    expect(reply.header.title.content).toContain('🔴 error');
    expect(JSON.stringify(reply)).not.toContain('操作: 已停止');
  });

  it('deduplicates retries by thread and message id when Feishu omits event id', async () => {
    const replyCard = vi.fn(async () => 'reply-1');
    const handler = new EventHandler(registry, store, {
      replyCard,
      async updateCard() {},
      async replyText() { return 'msg-1'; },
    });

    await handler.handleMessage({
      eventId: '',
      userOpenId: 'u1',
      threadId: 't1',
      messageId: 'm1',
      text: '/help',
    });
    await handler.handleMessage({
      eventId: '',
      userOpenId: 'u1',
      threadId: 't1',
      messageId: 'm1',
      text: '/help',
    });
    await handler.handleMessage({
      eventId: '',
      userOpenId: 'u1',
      threadId: 't1',
      messageId: 'm2',
      text: '/help',
    });

    expect(replyCard).toHaveBeenCalledTimes(2);
  });

  it('stopAllSessions() stops all active agent runs', async () => {
    const testCwd = mkTmpDir();
    store.setCurrentCwd('default', 'u1', 't1', testCwd);
    const stopCalls: string[] = [];
    let runResolve: (() => void) | null = null;

    const registry: AgentRegistry = {
      register() {},
      lookup() {
        return {
          id: 'claude-code',
          displayName: 'Claude Code',
          async isAvailable() { return true; },
          async getCapabilities() { return new ClaudeCodeAgent().getCapabilities(); },
          run(): AgentRun {
            return {
              events: {
                async *[Symbol.asyncIterator]() {
                  await new Promise<void>((resolve) => { runResolve = resolve; });
                  yield { type: 'done' } as const;
                },
              },
              async stop() { stopCalls.push('stopped'); runResolve?.(); },
              async waitForExit() { return true; },
            };
          },
        };
      },
      list() { return []; },
      async isAvailable() { return true; },
    };

    const handler = new EventHandler(registry, store, {
      async replyCard() { return 'reply-1'; },
      async updateCard() {},
      async replyText() { return 'msg-1'; },
    });

    const running = handler.handleMessage({
      eventId: 'evt-shutdown',
      userOpenId: 'u1',
      threadId: 't1',
      messageId: 'm1',
      text: 'long running task',
    });

    await vi.waitFor(() => expect(runResolve).not.toBeNull());
    await handler.stopAllSessions();
    await running;

    expect(stopCalls).toContain('stopped');
    rmSync(testCwd, { recursive: true, force: true });
  });

  it('P2 #9: /stop with active session calls run.stop() without emitting a new reply card', async () => {
    const testCwd = mkTmpDir();
    store.setCurrentCwd('default', 'u1', 't1', testCwd);
    let runResolve: (() => void) | null = null;
    let stopped = false;
    const replyCard = vi.fn(async () => 'reply-1');

    const stopRegistry: AgentRegistry = {
      register() {},
      lookup() {
        return {
          id: 'claude-code',
          displayName: 'Claude Code',
          async isAvailable() { return true; },
          async getCapabilities() { return new ClaudeCodeAgent().getCapabilities(); },
          run(): AgentRun {
            return {
              events: {
                async *[Symbol.asyncIterator]() {
                  await new Promise<void>((resolve) => { runResolve = resolve; });
                  yield { type: 'done' } as const;
                },
              },
              async stop() { stopped = true; runResolve?.(); },
              async waitForExit() { return true; },
            };
          },
        };
      },
      list() { return []; },
      async isAvailable() { return true; },
    };

    const handler = new EventHandler(stopRegistry, store, {
      replyCard,
      async updateCard() {},
      async replyText() { return 'msg-1'; },
    });

    const running = handler.handleMessage({
      eventId: 'evt-run',
      userOpenId: 'u1',
      threadId: 't1',
      messageId: 'm1',
      text: 'task',
    });

    // Wait until session is registered (initial replyCard call happened)
    await vi.waitFor(() => expect(replyCard).toHaveBeenCalledTimes(1));

    const stopCardCountBefore = replyCard.mock.calls.length;
    await handler.handleMessage({
      eventId: 'evt-stop',
      userOpenId: 'u1',
      threadId: 't1',
      messageId: 'm2',
      text: '/stop',
    });

    // /stop with active session must NOT send a new card
    expect(replyCard.mock.calls.length).toBe(stopCardCountBefore);
    expect(stopped).toBe(true);

    await running;
    rmSync(testCwd, { recursive: true, force: true });
  });

  it('P2 #9: /stop without active session replies with "no active run" card', async () => {
    const replyCard = vi.fn(async () => 'reply-1');
    const handler = new EventHandler(registry, store, {
      replyCard,
      async updateCard() {},
      async replyText() { return 'msg-1'; },
    });

    await handler.handleMessage({
      eventId: 'evt-stop-idle',
      userOpenId: 'u1',
      threadId: 't1',
      messageId: 'm1',
      text: '/stop',
    });

    expect(replyCard).toHaveBeenCalledTimes(1);
    const card = (replyCard.mock.calls[0] as unknown[])?.[1] as { body: { elements: Array<{ content?: string }> } } | undefined;
    expect(JSON.stringify(card)).toContain('没有可停止的运行');
  });

  it('stale STOP card action (re-delivered by Feishu) does not stop a newly started session', async () => {
    const testCwd = mkTmpDir();
    store.setCurrentCwd('default', 'u1', 't1', testCwd);
    let runResolve: (() => void) | null = null;
    let stopCalled = false;

    const slowRegistry: AgentRegistry = {
      register() {},
      lookup() {
        return {
          id: 'claude-code',
          displayName: 'Claude Code',
          async isAvailable() { return true; },
          async getCapabilities() { return new ClaudeCodeAgent().getCapabilities(); },
          run(): AgentRun {
            return {
              events: {
                async *[Symbol.asyncIterator]() {
                  await new Promise<void>((resolve) => { runResolve = resolve; });
                  yield { type: 'done' } as const;
                },
              },
              async stop() { stopCalled = true; runResolve?.(); },
              async waitForExit() { return true; },
            };
          },
        };
      },
      list() { return []; },
      async isAvailable() { return true; },
    };

    const handler = new EventHandler(slowRegistry, store, {
      async replyCard() { return 'reply-new'; },
      async updateCard() {},
      async replyText() { return 'msg-1'; },
    });

    // Start a new session
    const running = handler.handleMessage({
      eventId: 'evt-new-run',
      userOpenId: 'u1',
      threadId: 't1',
      messageId: 'm-new',
      text: 'find / -name *.ts',
    });
    await vi.waitFor(() => expect(runResolve).not.toBeNull());

    // Feishu re-delivers an old STOP action for a different card (not this session's card)
    const result = await handler.handleCardAction({
      eventId: '',
      userOpenId: 'u1',
      threadId: 't1',
      messageId: 'om-old-card',
      action: 'stop',
    });

    // Should NOT stop the new session
    expect(stopCalled).toBe(false);
    expect((result as { toast?: { content?: string } }).toast?.content).toBe('当前没有可停止的运行');

    runResolve!();
    await running;
    rmSync(testCwd, { recursive: true, force: true });
  });

  it('P2 #11: concurrent message while session is active is queued and runs after the current one', async () => {
    const testCwd = mkTmpDir();
    store.setCurrentCwd('default', 'u1', 't1', testCwd);
    const resolvers: Array<() => void> = [];
    const prompts: string[] = [];
    const replyCardMessages: Array<Record<string, unknown>> = [];
    const updatedCards: Array<{ messageId: string; card: Record<string, unknown> }> = [];
    let replySeq = 0;
    const replyCard = vi.fn(async (_msgId: string, card: Record<string, unknown>) => {
      replyCardMessages.push(card);
      return `reply-${++replySeq}`;
    });

    const concurrentRegistry: AgentRegistry = {
      register() {},
      lookup() {
        return {
          id: 'claude-code',
          displayName: 'Claude Code',
          async isAvailable() { return true; },
          async getCapabilities() { return new ClaudeCodeAgent().getCapabilities(); },
          run(req: RunRequest): AgentRun {
            prompts.push(req.prompt);
            let resolveRun!: () => void;
            const done = new Promise<void>((resolve) => { resolveRun = resolve; });
            resolvers.push(resolveRun);
            return {
              events: {
                async *[Symbol.asyncIterator]() {
                  await done;
                  yield { type: 'done' } as const;
                },
              },
              async stop() { resolveRun(); },
              async waitForExit() { return true; },
            };
          },
        };
      },
      list() { return []; },
      async isAvailable() { return true; },
    };

    const handler = new EventHandler(concurrentRegistry, store, {
      replyCard,
      async updateCard(messageId, card) { updatedCards.push({ messageId, card }); },
      async replyText() { return 'msg-1'; },
    });

    const running = handler.handleMessage({ eventId: 'evt-first', userOpenId: 'u1', threadId: 't1', messageId: 'm1', text: 'first task' });
    await vi.waitFor(() => expect(resolvers).toHaveLength(1));
    const cardsAfterFirst = replyCardMessages.length;

    await handler.handleMessage({ eventId: 'evt-second', userOpenId: 'u1', threadId: 't1', messageId: 'm2', text: 'second task' });
    await handler.handleMessage({ eventId: 'evt-third', userOpenId: 'u1', threadId: 't1', messageId: 'm3', text: 'third task' });

    // Queue notices only; no second run while the first is active
    expect(replyCard.mock.calls.length).toBe(cardsAfterFirst + 2);
    expect(prompts).toEqual(['first task']);
    expect(JSON.stringify(replyCardMessages.at(-1))).toContain('已排队 (第 2 条)');

    resolvers[0]!();
    await running;
    // Both queued messages are merged into one follow-up run
    await vi.waitFor(() => expect(prompts).toHaveLength(2));
    expect(prompts[1]).toBe('second task\n\nthird task');
    await vi.waitFor(() => expect(JSON.stringify(updatedCards.map((u) => u.card))).toContain('已合并 2 条排队消息开始处理'));

    await handler.stopAllSessions(500);
    rmSync(testCwd, { recursive: true, force: true });
  });

  it('P2 #11: stopping the active run drops its queued follow-ups', async () => {
    const testCwd = mkTmpDir();
    store.setCurrentCwd('default', 'u1', 't1', testCwd);
    let runResolve: (() => void) | null = null;
    let runCount = 0;
    const updatedCards: Array<Record<string, unknown>> = [];
    let replySeq = 0;
    const concurrentRegistry: AgentRegistry = {
      register() {},
      lookup() {
        return {
          id: 'claude-code',
          displayName: 'Claude Code',
          async isAvailable() { return true; },
          async getCapabilities() { return new ClaudeCodeAgent().getCapabilities(); },
          run(): AgentRun {
            runCount++;
            return {
              events: {
                async *[Symbol.asyncIterator]() {
                  await new Promise<void>((resolve) => { runResolve = resolve; });
                  yield { type: 'done' } as const;
                },
              },
              async stop() { runResolve?.(); },
              async waitForExit() { return true; },
            };
          },
        };
      },
      list() { return []; },
      async isAvailable() { return true; },
    };
    const handler = new EventHandler(concurrentRegistry, store, {
      async replyCard() { return `reply-${++replySeq}`; },
      async updateCard(_messageId, card) { updatedCards.push(card); },
      async replyText() { return 'msg-1'; },
    });

    const running = handler.handleMessage({ eventId: 'evt-first', userOpenId: 'u1', threadId: 't1', messageId: 'm1', text: 'first task' });
    await vi.waitFor(() => expect(runResolve).not.toBeNull());
    await handler.handleMessage({ eventId: 'evt-second', userOpenId: 'u1', threadId: 't1', messageId: 'm2', text: 'second task' });
    await handler.handleMessage({ eventId: 'evt-stop', userOpenId: 'u1', threadId: 't1', messageId: 'm3', text: '/stop' });
    await running;
    await new Promise((resolve) => setImmediate(resolve));

    expect(runCount).toBe(1);
    expect(JSON.stringify(updatedCards)).toContain('已随上一条一起停止');
    rmSync(testCwd, { recursive: true, force: true });
  });

  it('recalling a queued message removes it before it runs', async () => {
    const testCwd = mkTmpDir();
    store.setCurrentCwd('default', 'u1', 't1', testCwd);
    let runResolve: (() => void) | null = null;
    let runCount = 0;
    const updatedCards: Array<Record<string, unknown>> = [];
    let replySeq = 0;
    const concurrentRegistry: AgentRegistry = {
      register() {},
      lookup() {
        return {
          id: 'claude-code',
          displayName: 'Claude Code',
          async isAvailable() { return true; },
          async getCapabilities() { return new ClaudeCodeAgent().getCapabilities(); },
          run(): AgentRun {
            runCount++;
            return {
              events: {
                async *[Symbol.asyncIterator]() {
                  await new Promise<void>((resolve) => { runResolve = resolve; });
                  yield { type: 'done' } as const;
                },
              },
              async stop() { runResolve?.(); },
              async waitForExit() { return true; },
            };
          },
        };
      },
      list() { return []; },
      async isAvailable() { return true; },
    };
    const handler = new EventHandler(concurrentRegistry, store, {
      async replyCard() { return `reply-${++replySeq}`; },
      async updateCard(_messageId, card) { updatedCards.push(card); },
      async replyText() { return 'msg-1'; },
    });

    const running = handler.handleMessage({ eventId: 'evt-first', userOpenId: 'u1', threadId: 't1', messageId: 'm1', text: 'first task' });
    await vi.waitFor(() => expect(runResolve).not.toBeNull());
    await handler.handleMessage({ eventId: 'evt-second', userOpenId: 'u1', threadId: 't1', messageId: 'm2', text: 'second task' });
    expect(await handler.handleMessageRecalled('m2')).toBe(true);
    expect(await handler.handleMessageRecalled('m2')).toBe(false);
    runResolve!();
    await running;
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(runCount).toBe(1);
    expect(JSON.stringify(updatedCards)).toContain('消息已撤回, 不再处理');
    rmSync(testCwd, { recursive: true, force: true });
  });

  it('P2 #11: STOP button on busy card resolves to the active session', async () => {
    const testCwd = mkTmpDir();
    store.setCurrentCwd('default', 'u1', 't1', testCwd);
    let runResolve: (() => void) | null = null;
    let stopCalled = false;
    let replySeq = 0;
    const replyCard = vi.fn(async (_msgId: string, _card: Record<string, unknown>) => {
      return `reply-${++replySeq}`;
    });

    const concurrentRegistry: AgentRegistry = {
      register() {},
      lookup() {
        return {
          id: 'claude-code',
          displayName: 'Claude Code',
          async isAvailable() { return true; },
          async getCapabilities() { return new ClaudeCodeAgent().getCapabilities(); },
          run(): AgentRun {
            return {
              events: {
                async *[Symbol.asyncIterator]() {
                  await new Promise<void>((resolve) => { runResolve = resolve; });
                  yield { type: 'done' } as const;
                },
              },
              async stop() { stopCalled = true; runResolve?.(); },
              async waitForExit() { return true; },
            };
          },
        };
      },
      list() { return []; },
      async isAvailable() { return true; },
    };

    const handler = new EventHandler(concurrentRegistry, store, {
      replyCard,
      async updateCard() {},
      async replyText() { return 'msg-1'; },
    });

    // Start first run
    const running = handler.handleMessage({
      eventId: 'evt-first',
      userOpenId: 'u1',
      threadId: 't1',
      messageId: 'm1',
      text: 'first task',
    });
    await vi.waitFor(() => expect(runResolve).not.toBeNull());

    // Send second message → gets busy card (reply-2)
    await handler.handleMessage({
      eventId: 'evt-second',
      userOpenId: 'u1',
      threadId: 't1',
      messageId: 'm2',
      text: 'second task',
    });
    const busyReplyId = `reply-${replySeq}`; // the ID returned for the busy card

    // Click STOP on the busy card — should resolve to the active session
    const result = await handler.handleCardAction({
      eventId: 'evt-stop',
      userOpenId: 'u1',
      threadId: 't1',
      messageId: busyReplyId,
      action: 'stop',
    });
    expect((result as { toast?: { content?: string } }).toast?.content).toBe('停止中...');
    expect(stopCalled).toBe(true);

    await running;
    rmSync(testCwd, { recursive: true, force: true });
  });

  function writeCaptainConfig(dirPath: string): void {
    const path = join(dirPath, 'config.json');
    writeFileSync(path, JSON.stringify({
      captain: {
        bitable_base_id: 'Uq6hb0dUaaYiDQsunHel7EisgWd',
        sessions_table_id: 'tblyqLE52hgNO7UA',
        app_id: 'cli_yyyyyyyyyyyyyyyy',
        app_secret: 'secret-32-characters-000000000000',
        lark_domain: 'LarkSuite',
        captain_state_path: join(dirPath, 'captain-state.ndjson'),
        captain_toml_path: join(dirPath, 'captain.json'),
      },
    }, null, 2));
    chmodSync(path, 0o600);
  }

  function createActiveSessionFixture(agentId = 'claude-code') {
    const shortId = 'sess-001';
    const replyMessageId = 'reply-1';
    const sourceMessageId = 'm1';
    const runId = 'run-001';
    const updates: Array<Record<string, unknown>> = [];
    const stopSpy = vi.fn(async () => undefined);
    const replyCards: Array<Record<string, unknown>> = [];
    const handler = new EventHandler(registry, store, {
      async replyCard(_messageId, card) {
        replyCards.push(card);
        return replyMessageId;
      },
      async updateCard(_messageId, card) {
        updates.push(card);
      },
      async replyText() { return 'msg-1'; },
    }, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined);

    const scopeKey = `ou_owner:grp:${agentId}`;
    const state = {
      ...createInitialState(agentId, agentId === 'claude-code' ? 'Claude Code' : agentId, agentId),
      sessionShortId: shortId,
      adminCancelEnabled: true,
      cwd: '/tmp/project',
    };
    const session = {
      scopeKey,
      sourceMessageId,
      replyMessageId,
      run: { stop: stopSpy },
      runId,
      pipeline: { force: vi.fn(async (card: Record<string, unknown>) => { updates.push(card); }), flush: vi.fn(async () => {}) },
      state,
      extraMessageIds: [],
      startedAt: Date.now(),
      agentId,
      sessionId: 'default:ou_owner:grp',
    };

    (handler as any).activeSessions.set(scopeKey, session);
    (handler as any).activeSessionsByMessageId.set(sourceMessageId, session);
    (handler as any).activeSessionsByMessageId.set(replyMessageId, session);
    (handler as any).activeSessionsByShortId.set(shortId, session);
    return { handler, session, shortId, replyMessageId, sourceMessageId, runId, updates, stopSpy, replyCards };
  }

  it('routes admin-cancel button through W8 cancel path and writes one audit entry', async () => {
    const dataDir = mkTmpDir();
    process.env['WB_DATA_DIR'] = dataDir;
    writeCaptainConfig(dataDir);
    const { handler, shortId, replyMessageId } = createActiveSessionFixture();
    const captainService = new CaptainService({ dataDir });
    captainService.createSession({
      session_id: 'default:ou_owner:grp',
      captain_id: 'default',
      created_at: '2026-06-24T10:00:00.000Z',
      last_active_at: '2026-06-24T10:00:00.000Z',
      cwd: '/tmp/project',
      scope: 'dev',
      project: 'weaverbird',
      home_group_id: 'grp',
      agent: 'claude-code',
      latest_run_id: null,
      operator: 'ou_owner',
      entry_form: 'im',
    });
    captainService.bindRun('default:ou_owner:grp', 'run-001');
    (handler as any).captainService = captainService;
    (handler as any).reverseAtAdminRoleResolver = async (context: { userOpenId: string }) => context.userOpenId === 'ou_admin' ? 'whitelist' : null;
    const notifyOperator = vi.fn(async () => undefined);
    (handler as any).reverseAtOperatorNotifier = notifyOperator;

    const result = await handler.handleCardAction({
      eventId: 'evt-admin-btn',
      userOpenId: 'ou_admin',
      threadId: 'grp',
      messageId: replyMessageId,
      action: 'admin_cancel',
      shortId,
    });

    expect((result as { toast?: { content?: string } }).toast?.content).toBe('已提交');
    expect(notifyOperator).toHaveBeenCalledTimes(1);
    const auditText = readFileSync(join(dataDir, 'audit-mirror.ndjson'), 'utf8').trim();
    expect(auditText).toContain('event=admin_cancel:actor_role=whitelist');
    expect(auditText).toContain(`target_session=${shortId}`);

    delete process.env['WB_DATA_DIR'];
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('denies non-admin admin-cancel button clicks', async () => {
    const dataDir = mkTmpDir();
    process.env['WB_DATA_DIR'] = dataDir;
    writeCaptainConfig(dataDir);
    const { handler, shortId, replyMessageId } = createActiveSessionFixture();
    const captainService = new CaptainService({ dataDir });
    captainService.createSession({
      session_id: 'default:ou_owner:grp',
      captain_id: 'default',
      created_at: '2026-06-24T10:00:00.000Z',
      last_active_at: '2026-06-24T10:00:00.000Z',
      cwd: '/tmp/project',
      scope: 'dev',
      project: 'weaverbird',
      home_group_id: 'grp',
      agent: 'claude-code',
      latest_run_id: null,
      operator: 'ou_owner',
      entry_form: 'im',
    });
    captainService.bindRun('default:ou_owner:grp', 'run-001');
    (handler as any).captainService = captainService;
    (handler as any).reverseAtAdminRoleResolver = async () => null;

    const result = await handler.handleCardAction({
      eventId: 'evt-member-deny',
      userOpenId: 'ou_member',
      threadId: 'grp',
      messageId: replyMessageId,
      action: 'admin_cancel',
      shortId,
    });

    expect((result as { toast?: { content?: string } }).toast?.content).toBe('已提交');
    const auditPath = join(dataDir, 'audit-mirror.ndjson');
    const auditText = readFileSync(auditPath, 'utf8');
    expect(auditText).not.toContain('event=admin_cancel');

    delete process.env['WB_DATA_DIR'];
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('operator admin-cancel button clicks stay on operator stop path and do not write admin_cancel audit', async () => {
    const dataDir = mkTmpDir();
    process.env['WB_DATA_DIR'] = dataDir;
    writeCaptainConfig(dataDir);
    const { handler, shortId, replyMessageId, stopSpy, updates } = createActiveSessionFixture();
    const captainService = new CaptainService({ dataDir });
    captainService.createSession({
      session_id: 'default:ou_owner:grp',
      captain_id: 'default',
      created_at: '2026-06-24T10:00:00.000Z',
      last_active_at: '2026-06-24T10:00:00.000Z',
      cwd: '/tmp/project',
      scope: 'dev',
      project: 'weaverbird',
      home_group_id: 'grp',
      agent: 'claude-code',
      latest_run_id: null,
      operator: 'ou_owner',
      entry_form: 'im',
    });
    captainService.bindRun('default:ou_owner:grp', 'run-001');
    (handler as any).captainService = captainService;
    (handler as any).reverseAtAdminRoleResolver = async () => 'whitelist';

    const result = await handler.handleCardAction({
      eventId: 'evt-operator-button',
      userOpenId: 'ou_owner',
      threadId: 'grp',
      messageId: replyMessageId,
      action: 'admin_cancel',
      shortId,
    });

    expect((result as { toast?: { content?: string } }).toast?.content).toBe('停止中...');
    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(updates.at(-1))).toContain('停止中');
    expect(JSON.stringify(updates.at(-1))).not.toContain('已停止');
    const auditPath = join(dataDir, 'audit-mirror.ndjson');
    expect(() => readFileSync(auditPath, 'utf8')).toThrow();

    delete process.env['WB_DATA_DIR'];
    rmSync(dataDir, { recursive: true, force: true });
  });
});
