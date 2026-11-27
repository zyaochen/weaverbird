import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter, AgentRun, RunRequest } from '../../packages/core/src/index.js';
import { DefaultAgentRegistry } from '../../packages/core/src/agent/registry.js';
import { BindingStore } from '../../apps/wb-bot/src/binding/store.js';
import { EventHandler } from '../../apps/wb-bot/src/feishu/event-handler.js';
import { replayCaptainQueueOrAlert } from '../../apps/wb-bot/src/feishu/transport.js';
import { createCaptainConcurrencyContainer, type CaptainService, type CaptainConcurrencyContainer } from '../../packages/core/src/captain/index.js';
import { createConcurrencyQueueIndex } from '../../packages/core/src/captain/concurrency-queue-index.js';
import { createQueueMetricsAggregator } from '../../packages/core/src/captain/queue-metrics/aggregator.js';

const roots: string[] = [];
const envBackup = process.env['WB_MODE'];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mkDeferredAgent(requests: RunRequest[], controllers: Array<() => Promise<void>>): AgentAdapter {
  let callIndex = 0;
  return {
    id: 'claude-code',
    displayName: 'Claude Code',
    async isAvailable() { return true; },
    async getCapabilities() { return {} as any; },
    run(req: RunRequest): AgentRun {
      requests.push(req);
      const waitForDone = controllers[callIndex++] ?? (async () => undefined);
      return {
        events: {
          async *[Symbol.asyncIterator]() {
            await waitForDone();
            yield { type: 'done' as const };
          },
        },
        async stop() {},
        async waitForExit() { return true; },
      };
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  if (envBackup === undefined) delete process.env['WB_MODE'];
  else process.env['WB_MODE'] = envBackup;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('T6-wire-up', () => {
  it('T15.5 boot replay rebuilds running/queued state from queue.ndjson before handling new messages', async () => {
    process.env['WB_MODE'] = 'multi-bot';
    const dir = mkdtempSync(join(tmpdir(), 'wb-captain-wire-'));
    roots.push(dir);
    const store = new BindingStore(join(dir, 'wb-bot.db'));
    const requests: RunRequest[] = [];

    mkdirSync(join(dir, 'captain'), { recursive: true });
    writeFileSync(join(dir, 'captain', 'queue.ndjson.1'), '{"session_id":"default:u1:t1","run_id":"run-old","status":"running","ts":"2026-06-10T00:00:00.000Z"}\n', 'utf8');
    writeFileSync(join(dir, 'captain', 'queue.ndjson'), '{"session_id":"default:u1:t1","run_id":"run-queued","status":"queued","ts":"2026-06-10T00:00:01.000Z"}\n', 'utf8');

    const registry = new DefaultAgentRegistry([{
      agent: mkDeferredAgent(requests, [async () => undefined]),
      command: 'claude',
    }]);

    const replyText = vi.fn(async () => 'msg-1');
    const captainService = {
      getSession: () => undefined,
      createSession: vi.fn(),
      updateSession: vi.fn(),
      bindRun: vi.fn(),
      closeSession: vi.fn(),
      listActiveSessions: () => [],
    } as unknown as CaptainService;
    const captainConcurrency = createCaptainConcurrencyContainer(dir);
    replayCaptainQueueOrAlert(captainConcurrency, dir);

    expect(captainConcurrency.index.countRunning('default:u1:t1')).toBe(1);
    expect(captainConcurrency.index.countQueued('default:u1:t1')).toBe(1);

    const handler = new EventHandler(
      registry,
      store,
      {
        async replyCard() { return 'reply-1'; },
        async updateCard() {},
        replyText,
      },
      dir,
      undefined,
      undefined,
      undefined,
      captainService,
      captainConcurrency,
    );

    await handler.handleMessage({ eventId: 'e1', userOpenId: 'u1', threadId: 't1', messageId: 'm1', text: 'after-restart' });

    expect(replyText).toHaveBeenCalledWith('m1', 'queued at position 2');
    expect(requests).toHaveLength(0);
    expect(captainConcurrency.index.countQueued('default:u1:t1')).toBe(2);
    store.close();
  });

  it('T16 max=1 连发 2 个 run → 第 2 个 queued position=1; 第 1 个结束自动 promote', async () => {
    process.env['WB_MODE'] = 'multi-bot';
    const dir = mkdtempSync(join(tmpdir(), 'wb-captain-wire-'));
    roots.push(dir);
    const store = new BindingStore(join(dir, 'wb-bot.db'));
    const requests: RunRequest[] = [];

    let releaseFirst!: () => void;
    const firstDone = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const registry = new DefaultAgentRegistry([{
      agent: mkDeferredAgent(requests, [() => firstDone, async () => undefined]),
      command: 'claude',
    }]);

    const replyText = vi.fn(async () => 'msg-1');
    const captainService = {
      getSession: () => undefined,
      createSession: vi.fn(),
      updateSession: vi.fn(),
      bindRun: vi.fn(),
      closeSession: vi.fn(),
      listActiveSessions: () => [],
    } as unknown as CaptainService;
    const captainConcurrency: CaptainConcurrencyContainer = {
      config: { max_concurrent_runs: 1, queue_max_depth: 1 },
      index: createConcurrencyQueueIndex(),
      store: { append: vi.fn() } as any,
      metrics: createQueueMetricsAggregator(),
      now: () => '2026-06-10T00:00:00.000Z',
      genRunId: vi.fn().mockReturnValueOnce('run-1').mockReturnValueOnce('run-2'),
    };

    const handler = new EventHandler(
      registry,
      store,
      {
        async replyCard() { return 'reply-1'; },
        async updateCard() {},
        replyText,
      },
      dir,
      undefined,
      undefined,
      undefined,
      captainService,
      captainConcurrency,
    );

    const first = handler.handleMessage({ eventId: 'e1', userOpenId: 'u1', threadId: 't1', messageId: 'm1', text: 'first' });
    await sleep(20);
    await handler.handleMessage({ eventId: 'e2', userOpenId: 'u1', threadId: 't1', messageId: 'm2', text: 'second' });

    expect(replyText).toHaveBeenCalledWith('m2', 'queued at position 1');
    expect(requests).toHaveLength(1);

    releaseFirst();
    await first;
    await sleep(20);

    expect(requests).toHaveLength(2);
    expect(captainConcurrency.index.listRunning('default:u1:t1')).toEqual([]);
    store.close();
  });

  it('T17 max=1 depth=0 连发 2 个 → 第 2 个 rejected', async () => {
    process.env['WB_MODE'] = 'multi-bot';
    const dir = mkdtempSync(join(tmpdir(), 'wb-captain-wire-'));
    roots.push(dir);
    const store = new BindingStore(join(dir, 'wb-bot.db'));
    const requests: RunRequest[] = [];

    let releaseFirst!: () => void;
    const firstDone = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const registry = new DefaultAgentRegistry([{
      agent: mkDeferredAgent(requests, [() => firstDone]),
      command: 'claude',
    }]);

    const replyText = vi.fn(async () => 'msg-1');
    const captainService = {
      getSession: () => undefined,
      createSession: vi.fn(),
      updateSession: vi.fn(),
      bindRun: vi.fn(),
      closeSession: vi.fn(),
      listActiveSessions: () => [],
    } as unknown as CaptainService;
    const captainConcurrency: CaptainConcurrencyContainer = {
      config: { max_concurrent_runs: 1, queue_max_depth: 0 },
      index: createConcurrencyQueueIndex(),
      store: { append: vi.fn() } as any,
      metrics: createQueueMetricsAggregator(),
      now: () => '2026-06-10T00:00:00.000Z',
      genRunId: vi.fn().mockReturnValueOnce('run-1').mockReturnValueOnce('run-2'),
    };

    const handler = new EventHandler(
      registry,
      store,
      {
        async replyCard() { return 'reply-1'; },
        async updateCard() {},
        replyText,
      },
      dir,
      undefined,
      undefined,
      undefined,
      captainService,
      captainConcurrency,
    );

    const first = handler.handleMessage({ eventId: 'e1', userOpenId: 'u1', threadId: 't1', messageId: 'm1', text: 'first' });
    await sleep(20);
    await handler.handleMessage({ eventId: 'e2', userOpenId: 'u1', threadId: 't1', messageId: 'm2', text: 'second' });

    expect(replyText).toHaveBeenCalledWith('m2', 'queue full');
    expect(requests).toHaveLength(1);

    releaseFirst();
    await first;
    store.close();
  });
});
