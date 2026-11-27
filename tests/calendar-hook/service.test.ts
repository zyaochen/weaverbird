import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeCalendarBlock, openCalendarBlock, type CalendarHookConfig, type CalendarTransport } from '../../packages/core/src/calendar-hook/index.js';

const roots: string[] = [];
const config: CalendarHookConfig = {
  enabled: true,
  transport: 'mock',
  rpc_timeout_ms: 50,
  overdue_after_ms: 60_000,
  sweep_interval_ms: 10_000,
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('calendar-hook service', () => {
  it('opens a block once per run_id + revision', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-cal-hook-'));
    roots.push(root);
    const transport: CalendarTransport = {
      openBlock: vi.fn().mockResolvedValue({ calendar_block_id: 'cal_run-1' }),
      closeBlock: vi.fn().mockResolvedValue(undefined),
    };

    const first = await openCalendarBlock({
      dataDir: root,
      runId: 'run-1',
      sessionId: 'sid-1',
      revision: 0,
      title: 'Run run-1',
      startsAt: '2026-06-27T00:00:00.000Z',
      endsAt: '2026-06-27T01:00:00.000Z',
      config,
      transport,
    });
    const second = await openCalendarBlock({
      dataDir: root,
      runId: 'run-1',
      sessionId: 'sid-1',
      revision: 0,
      title: 'Run run-1',
      startsAt: '2026-06-27T00:00:00.000Z',
      endsAt: '2026-06-27T01:00:00.000Z',
      config,
      transport,
    });

    expect(first.calendar_block_id).toBe('cal_run-1');
    expect(second.calendar_block_id).toBe('cal_run-1');
    expect(transport.openBlock).toHaveBeenCalledTimes(1);
  });

  it('close is idempotent for same revision', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-cal-hook-'));
    roots.push(root);
    const transport: CalendarTransport = {
      openBlock: vi.fn().mockResolvedValue({ calendar_block_id: 'cal_run-2' }),
      closeBlock: vi.fn().mockResolvedValue(undefined),
    };

    await openCalendarBlock({
      dataDir: root,
      runId: 'run-2',
      sessionId: 'sid-2',
      revision: 0,
      title: 'Run run-2',
      startsAt: '2026-06-27T00:00:00.000Z',
      endsAt: '2026-06-27T01:00:00.000Z',
      config,
      transport,
    });
    await closeCalendarBlock({ dataDir: root, runId: 'run-2', revision: 1, config, transport });
    await closeCalendarBlock({ dataDir: root, runId: 'run-2', revision: 1, config, transport });

    expect(transport.closeBlock).toHaveBeenCalledTimes(1);
  });

  it('marks fail-safe state when open times out', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-cal-hook-'));
    roots.push(root);
    const transport: CalendarTransport = {
      openBlock: vi.fn().mockImplementation(() => new Promise(() => undefined)),
      closeBlock: vi.fn().mockResolvedValue(undefined),
    };

    const result = await openCalendarBlock({
      dataDir: root,
      runId: 'run-3',
      sessionId: 'sid-3',
      revision: 0,
      title: 'Run run-3',
      startsAt: '2026-06-27T00:00:00.000Z',
      endsAt: '2026-06-27T01:00:00.000Z',
      config,
      transport,
    });

    expect(result.calendar_hook_failed).toBe(true);
    const content = readFileSync(join(root, 'runs', 'default', 'run-3', 'calendar-hook.json'), 'utf8');
    expect(content).toContain('calendar open timeout');
  });

  it('marks fail-safe state when close times out', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-cal-hook-'));
    roots.push(root);
    const transport: CalendarTransport = {
      openBlock: vi.fn().mockResolvedValue({ calendar_block_id: 'cal_run-4' }),
      closeBlock: vi.fn().mockImplementation(() => new Promise(() => undefined)),
    };

    await openCalendarBlock({
      dataDir: root,
      runId: 'run-4',
      sessionId: 'sid-4',
      revision: 0,
      title: 'Run run-4',
      startsAt: '2026-06-27T00:00:00.000Z',
      endsAt: '2026-06-27T01:00:00.000Z',
      config,
      transport,
    });
    const result = await closeCalendarBlock({ dataDir: root, runId: 'run-4', revision: 1, config, transport });

    expect(result.calendar_hook_failed).toBe(true);
  });
});
