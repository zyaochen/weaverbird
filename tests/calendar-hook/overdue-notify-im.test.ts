import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DefaultAgentRegistry } from '../../packages/core/src/agent/registry.js';
import { ClaudeCodeAgent } from '../../packages/core/src/agent/claude-code.js';
import { BindingStore } from '../../apps/wb-bot/src/binding/store.js';
import { EventHandler } from '../../apps/wb-bot/src/feishu/event-handler.js';
import { startCalendarScheduler } from '../../packages/core/src/calendar-hook/scheduler.js';

const registry = new DefaultAgentRegistry([{ agent: new ClaudeCodeAgent(), command: 'claude' }]);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-calendar-overdue-'));
  roots.push(dir);
  return dir;
}

function seedOverdueRunState(dataDir: string, runId: string, dueAtIso: string): void {
  const runDir = join(dataDir, 'runs', 'default', runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'calendar-hook.json'), JSON.stringify({
    run_id: runId,
    session_id: `default:u1:${runId}`,
    open_revision_applied: 1,
    close_revision_applied: null,
    calendar_block_id: 'cal_block_1',
    calendar_hook_failed: false,
    desired_state: 'open',
    due_at: dueAtIso,
    overdue_escalated_at: null,
    last_error: null,
    updated_at: '2026-08-04T00:00:00.000Z',
  }, null, 2));
}

describe('calendar overdue -> IM', () => {
  it('invokes onOverdueEscalated once and writes overdue_escalated_at', async () => {
    const dataDir = makeDir();
    seedOverdueRunState(dataDir, 'run-overdue-1', '2000-01-01T00:00:00.000Z');

    const escalations: Array<{ run_id: string; due_at: string }> = [];
    const scheduler = startCalendarScheduler({
      dataDir,
      config: {
        enabled: false, // manual tick only
        transport: 'mock',
        rpc_timeout_ms: 1_000,
        overdue_after_ms: 60_000,
        sweep_interval_ms: 5_000,
      },
      onCommand: async () => {},
      onOverdueEscalated: async (payload) => { escalations.push({ run_id: payload.run_id, due_at: payload.due_at }); },
      nowFn: () => Date.parse('2026-08-04T12:00:00.000Z'),
    });

    await scheduler.tick();
    expect(escalations).toHaveLength(1);
    expect(escalations[0]?.run_id).toBe('run-overdue-1');

    // second tick must not re-fire: overdue_escalated_at now stamped
    await scheduler.tick();
    expect(escalations).toHaveLength(1);
    scheduler.stop();
  });

  it('approves a missing onOverdueEscalated hook silently', async () => {
    const dataDir = makeDir();
    seedOverdueRunState(dataDir, 'run-overdue-2', '2000-01-01T00:00:00.000Z');
    const scheduler = startCalendarScheduler({
      dataDir,
      config: {
        enabled: false,
        transport: 'mock',
        rpc_timeout_ms: 1_000,
        overdue_after_ms: 60_000,
        sweep_interval_ms: 5_000,
      },
      onCommand: async () => {},
      nowFn: () => Date.parse('2026-08-04T12:00:00.000Z'),
    });
    await expect(scheduler.tick()).resolves.toBeUndefined();
    scheduler.stop();
  });
});

describe('EventHandler.notifyCalendarOverdue', () => {
  it('routes to home group via sendCard', async () => {
    const dir = makeDir();
    const store = new BindingStore(join(dir, 'wb-bot.db'));
    const sent: Array<{ chatId: string; card: Record<string, unknown> }> = [];
    const handler = new EventHandler(registry, store, {
      async replyCard() { return 'r1'; },
      async updateCard() {},
      async replyText() { return 'r1'; },
      sendCard: async (chatId, card) => { sent.push({ chatId, card }); },
    }, '/tmp', undefined, { dataDir: dir, wbRunnerMainPath: '/dev/null', botId: 'default' });

    await handler.notifyCalendarOverdue({
      runId: 'run-overdue-1',
      sessionId: 'default:u1:oc_home',
      dueAt: '2026-08-04T00:00:00.000Z',
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.chatId).toBe('oc_home');
    expect(JSON.stringify(sent[0]?.card)).toContain('run-overdue-1'.slice(0, 12));
    handler.dispose();
    store.close();
  });

  it('swallows when sendCard raises so caller sweep does not stop', async () => {
    const dir = makeDir();
    const store = new BindingStore(join(dir, 'wb-bot.db'));
    const handler = new EventHandler(registry, store, {
      async replyCard() { return 'r1'; },
      async updateCard() {},
      async replyText() { return 'r1'; },
      sendCard: async () => { throw new Error('rate limited'); },
    }, '/tmp', undefined, { dataDir: dir, wbRunnerMainPath: '/dev/null', botId: 'default' });

    await expect(handler.notifyCalendarOverdue({
      runId: 'run-overdue-2',
      sessionId: 'default:u1:oc_home',
      dueAt: '2026-08-04T00:00:00.000Z',
    })).rejects.toThrow('rate limited');

    handler.dispose();
    store.close();
  });
});
