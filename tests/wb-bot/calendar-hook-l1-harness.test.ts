import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMockCalendarTransport, openCalendarBlock, closeCalendarBlock, startCalendarScheduler, type CalendarHookConfig } from '../../packages/core/src/calendar-hook/index.js';

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

describe('Calendar Hook L1 harness', () => {
  it('opens and closes block with zero real egress via mock transport', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-cal-l1-'));
    roots.push(root);
    const transport = createMockCalendarTransport(root);

    const opened = await openCalendarBlock({
      dataDir: root,
      runId: 'run-l1-1',
      sessionId: 'sid-l1-1',
      revision: 0,
      title: 'Run run-l1-1',
      startsAt: '2026-06-27T00:00:00.000Z',
      endsAt: '2026-06-27T01:00:00.000Z',
      config,
      transport,
    });
    const closed = await closeCalendarBlock({
      dataDir: root,
      runId: 'run-l1-1',
      revision: 1,
      config,
      transport,
    });

    expect(opened.calendar_block_id).toBe('cal_run-l1-1');
    expect(closed.calendar_hook_failed).toBe(false);
    expect(readFileSync(join(root, 'runs', 'default', 'run-l1-1', 'calendar-hook.json'), 'utf8')).toContain('"desired_state": "closed"');
  });

  it('scheduler converts calendar trigger to command ingress payload', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-cal-l1-'));
    roots.push(root);
    mkdirSync(join(root, 'calendar-hook'), { recursive: true });
    writeFileSync(join(root, 'calendar-hook', 'mock-triggers.json'), JSON.stringify([
      {
        request_id: 'req-cal-1',
        session_id: 'sid-cal-1',
        run_id: 'run-cal-1',
        revision: 0,
        text: '/help',
        scheduled_at: '2026-06-27T00:00:00.000Z',
        user_open_id: 'ou_test',
        thread_id: 'th_test',
        message_id: 'msg_test',
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

    expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({
      source: 'calendar',
      request_id: 'req-cal-1',
      session_id: 'sid-cal-1',
      run_id: 'run-cal-1',
      revision: 0,
    }));
    scheduler.stop();
  });
});
