import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BindingStore } from '../../apps/wb-bot/src/binding/store.js';
import { EventHandler } from '../../apps/wb-bot/src/feishu/event-handler.js';
import { DefaultAgentRegistry } from '../../packages/core/src/agent/registry.js';
import type { AgentAdapter, AgentRun, RunRequest } from '../../packages/core/src/index.js';
import { closeCalendarBlock } from '../../packages/core/src/calendar-hook/index.js';
import type { CalendarHookConfig, CalendarTransport } from '../../packages/core/src/calendar-hook/index.js';

const roots: string[] = [];

beforeEach(() => {
  process.env['WB_DISABLE_CALENDAR_HOOK'] = '1';
});

const calendarConfig: CalendarHookConfig = {
  enabled: true,
  transport: 'mock',
  rpc_timeout_ms: 50,
  overdue_after_ms: 60_000,
  sweep_interval_ms: 10_000,
};

function createFeishu() {
  return {
    replyCard: vi.fn(async () => 'reply-1'),
    updateCard: vi.fn(async () => undefined),
    replyText: vi.fn(async () => 'msg-1'),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['WB_DISABLE_CALENDAR_HOOK'];
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('calendar command ingress', () => {
  it('routes calendar slash command through existing runCommand path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-cal-ingress-'));
    roots.push(dir);
    const store = new BindingStore(join(dir, 'wb-bot.db'));
    const registry = new DefaultAgentRegistry([]);
    const feishu = createFeishu();
    const handler = new EventHandler(registry, store, feishu as any, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, {
      config: calendarConfig,
      transport: {
        openBlock: vi.fn(),
        closeBlock: vi.fn(),
      } as unknown as CalendarTransport,
    });

    await handler.dispatchCommandReceived({
      source: 'calendar',
      requestId: 'req-1',
      sessionId: 'sid-1',
      runId: 'run-1',
      revision: 0,
      text: '/help',
      userOpenId: 'ou_user',
      threadId: 'oc_thread',
      messageId: 'msg-1',
      scheduledAt: '2026-06-28T00:00:00.000Z',
    });

    expect(feishu.replyCard).toHaveBeenCalledTimes(1);
    const cardArg = (feishu.replyCard as ReturnType<typeof vi.fn>).mock.calls.at(0)?.[1];
    expect(JSON.stringify(cardArg)).toContain('核心');
    store.close();
    handler.dispose();
  });

  it('routes calendar run trigger through existing event-handler execution path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-cal-ingress-'));
    roots.push(dir);
    const store = new BindingStore(join(dir, 'wb-bot.db'));
    const feishu = createFeishu();
    const agent: AgentAdapter = {
      id: 'claude-code',
      displayName: 'Claude Code',
      async isAvailable() { return true; },
      async getCapabilities() { return {} as any; },
      run(_req: RunRequest): AgentRun {
        return {
          events: {
            async *[Symbol.asyncIterator]() {
              yield { type: 'done' as const };
            },
          },
          async stop() {},
          async waitForExit() { return true; },
        };
      },
    };
    const registry = new DefaultAgentRegistry([{ agent, command: 'claude' }]);
    const handler = new EventHandler(registry, store, feishu as any, '/tmp', undefined, undefined, undefined, undefined, undefined, undefined, undefined, {
      config: calendarConfig,
      transport: {
        openBlock: vi.fn().mockResolvedValue({ calendar_block_id: 'cal_run-pipe-1' }),
        closeBlock: vi.fn().mockResolvedValue(undefined),
      },
    });

    await handler.dispatchCommandReceived({
      source: 'calendar',
      requestId: 'req-2',
      sessionId: 'sid-2',
      runId: 'run-pipe-1',
      revision: 0,
      text: 'hello from calendar',
      userOpenId: 'ou_user',
      threadId: 'oc_thread',
      messageId: 'msg-2',
      scheduledAt: '2026-06-28T00:00:00.000Z',
    });

    const inflight = store.listInflightCards('default');
    expect(inflight).toHaveLength(0);
    expect(feishu.replyCard).toHaveBeenCalled();
    store.close();
    handler.dispose();
  });

  it('keeps calendar ingress run completion alive even when transport would fail elsewhere', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-cal-ingress-'));
    roots.push(dir);
    const store = new BindingStore(join(dir, 'wb-bot.db'));
    const feishu = createFeishu();
    const agent: AgentAdapter = {
      id: 'claude-code',
      displayName: 'Claude Code',
      async isAvailable() { return true; },
      async getCapabilities() { return {} as any; },
      run(_req: RunRequest): AgentRun {
        return {
          events: {
            async *[Symbol.asyncIterator]() {
              yield { type: 'done' as const };
            },
          },
          async stop() {},
          async waitForExit() { return true; },
        };
      },
    };
    const registry = new DefaultAgentRegistry([{ agent, command: 'claude' }]);
    const handler = new EventHandler(registry, store, feishu as any, '/tmp', undefined, undefined, undefined, undefined, undefined, undefined, undefined, {
      config: calendarConfig,
      transport: {
        openBlock: vi.fn().mockResolvedValue({ calendar_block_id: 'cal_run-pipe-2' }),
        closeBlock: vi.fn().mockRejectedValue(new Error('calendar close boom')),
      },
    });

    await expect(handler.dispatchCommandReceived({
      source: 'calendar',
      requestId: 'req-3',
      sessionId: 'sid-3',
      runId: 'run-pipe-2',
      revision: 0,
      text: 'hello from calendar',
      userOpenId: 'ou_user',
      threadId: 'oc_thread',
      messageId: 'msg-3',
      scheduledAt: '2026-06-28T00:00:00.000Z',
    })).resolves.toBeUndefined();

    expect(store.listInflightCards('default')).toHaveLength(0);
    store.close();
    handler.dispose();
  });
});
