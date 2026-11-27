import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startCalendarScheduler, type CalendarHookConfig } from '../../packages/core/src/calendar-hook/index.js';

const roots: string[] = [];
const config: CalendarHookConfig = {
  enabled: true,
  transport: 'mock',
  rpc_timeout_ms: 50,
  overdue_after_ms: 1_000,
  sweep_interval_ms: 10_000,
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('calendar-hook scheduler', () => {
  it('fires scheduled trigger only once for same revision', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-cal-scheduler-'));
    roots.push(root);
    mkdirSync(join(root, 'calendar-hook'), { recursive: true });
    writeFileSync(join(root, 'calendar-hook', 'mock-triggers.json'), JSON.stringify([
      {
        request_id: 'req-1',
        session_id: 'sid-1',
        run_id: 'run-1',
        revision: 0,
        text: '/help',
        scheduled_at: '2026-06-27T00:00:00.000Z',
      },
    ], null, 2));
    const onCommand = vi.fn().mockResolvedValue(undefined);
    const scheduler = startCalendarScheduler({
      dataDir: root,
      config,
      nowFn: () => Date.parse('2026-06-27T00:00:01.000Z'),
      onCommand,
    });

    await scheduler.tick();
    await scheduler.tick();

    expect(onCommand).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it('writes overdue RunStateChanged once when block remains open past due time', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-cal-scheduler-'));
    roots.push(root);
    const runDir = join(root, 'runs', 'default', 'run-2');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'calendar-hook.json'), JSON.stringify({
      run_id: 'run-2',
      session_id: 'sid-2',
      open_revision_applied: 0,
      close_revision_applied: null,
      calendar_block_id: 'cal_run-2',
      calendar_hook_failed: false,
      desired_state: 'open',
      due_at: '2026-06-27T00:00:00.000Z',
      overdue_escalated_at: null,
      last_error: null,
      updated_at: '2026-06-27T00:00:00.000Z',
    }, null, 2));
    const scheduler = startCalendarScheduler({
      dataDir: root,
      config,
      nowFn: () => Date.parse('2026-06-27T00:00:02.000Z'),
      onCommand: vi.fn().mockResolvedValue(undefined),
    });

    await scheduler.tick();
    await scheduler.tick();

    const ndjson = readFileSync(join(root, 'calendar-hook', 'run-state-changed.ndjson'), 'utf8').trim().split('\n');
    expect(ndjson).toHaveLength(1);
    scheduler.stop();
  });
});
