import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runPeriodicPhase } from '../../packages/core/src/periodic-tasks/index.js';

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('periodic-tasks orchestrator', () => {
  it('spawns one occurrence per task/window and remains idempotent on replay', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-periodic-'));
    roots.push(dir);
    mkdirSync(join(dir, 'config'), { recursive: true });
    const configPath1 = join(dir, 'config', 'periodic-tasks.json');
    writeFileSync(configPath1, JSON.stringify({
      enabled: true,
      tasks: [{
        task_id: 'task-1',
        owner_open_id: 'ou_owner',
        schedule: { type: 'interval', interval_ms: 60_000 },
        target: { home_group_id: 'oc_group', user_open_id: 'ou_user', cwd: '/repo', agent_id: 'claude-code' },
        run_template: { text: 'inspect {{task_id}} @ {{window_start}}' },
        reentry: { policy: 'skip' },
      }],
    }, null, 2));
    chmodSync(configPath1, 0o600);
    const onCommand = vi.fn().mockResolvedValue(undefined);
    const now = Date.parse('2026-06-28T00:00:30.000Z');

    await runPeriodicPhase({ dataDir: dir, nowFn: () => now, onCommand });
    await runPeriodicPhase({ dataDir: dir, nowFn: () => now, onCommand });

    expect(onCommand).toHaveBeenCalledTimes(1);
    const ledger = readFileSync(join(dir, 'periodic-tasks', 'occurrence-ledger.ndjson'), 'utf8').trim().split('\n');
    expect(ledger).toHaveLength(1);
  });

  it('skips next cycle when previous occurrence is still active', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-periodic-'));
    roots.push(dir);
    mkdirSync(join(dir, 'config'), { recursive: true });
    const configPath2 = join(dir, 'config', 'periodic-tasks.json');
    writeFileSync(configPath2, JSON.stringify({
      enabled: true,
      tasks: [{
        task_id: 'task-2',
        owner_open_id: 'ou_owner',
        schedule: { type: 'interval', interval_ms: 60_000 },
        target: { home_group_id: 'oc_group', user_open_id: 'ou_user', cwd: '/repo' },
        run_template: { text: 'inspect {{task_id}}' },
        reentry: { policy: 'skip', timeout_ms: 300_000 },
      }],
    }, null, 2));
    chmodSync(configPath2, 0o600);
    mkdirSync(join(dir, 'periodic-tasks'), { recursive: true });
    writeFileSync(join(dir, 'periodic-tasks', 'state.json'), JSON.stringify({
      version: 1,
      tasks: {
        'task-2': {
          active_occurrence_id: 'task-2:2026-06-28T00:00:00.000Z',
          active_run_id: 'ptask_task-2_old',
          active_started_at: '2026-06-28T00:00:00.000Z',
        },
      },
    }, null, 2));
    const onCommand = vi.fn().mockResolvedValue(undefined);

    await runPeriodicPhase({ dataDir: dir, nowFn: () => Date.parse('2026-06-28T00:01:30.000Z'), onCommand });

    expect(onCommand).not.toHaveBeenCalled();
    const ledger = readFileSync(join(dir, 'periodic-tasks', 'occurrence-ledger.ndjson'), 'utf8');
    expect(ledger).toContain('skipped_busy');
  });

  it('records dispatch failure without blocking later cycles', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-periodic-'));
    roots.push(dir);
    mkdirSync(join(dir, 'config'), { recursive: true });
    const configPath3 = join(dir, 'config', 'periodic-tasks.json');
    writeFileSync(configPath3, JSON.stringify({
      enabled: true,
      tasks: [{
        task_id: 'task-3',
        owner_open_id: 'ou_owner',
        schedule: { type: 'interval', interval_ms: 60_000 },
        target: { home_group_id: 'oc_group', user_open_id: 'ou_user', cwd: '/repo' },
        run_template: { text: 'inspect {{task_id}}' },
        reentry: { policy: 'skip' },
      }],
    }, null, 2));
    chmodSync(configPath3, 0o600);
    const onCommand = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined);

    await runPeriodicPhase({ dataDir: dir, nowFn: () => Date.parse('2026-06-28T00:00:30.000Z'), onCommand });
    await runPeriodicPhase({ dataDir: dir, nowFn: () => Date.parse('2026-06-28T00:01:30.000Z'), onCommand });

    expect(onCommand).toHaveBeenCalledTimes(2);
    const ledgerLines = readFileSync(join(dir, 'periodic-tasks', 'occurrence-ledger.ndjson'), 'utf8').trim().split('\n');
    expect(ledgerLines.some((line) => line.includes('dispatch_failed'))).toBe(true);
    expect(ledgerLines.some((line) => line.includes('spawned'))).toBe(true);
  });

  it('keeps only one queued occurrence for queue_one policy', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-periodic-'));
    roots.push(dir);
    mkdirSync(join(dir, 'config'), { recursive: true });
    const configPath4 = join(dir, 'config', 'periodic-tasks.json');
    writeFileSync(configPath4, JSON.stringify({
      enabled: true,
      tasks: [{
        task_id: 'task-4',
        owner_open_id: 'ou_owner',
        schedule: { type: 'interval', interval_ms: 60_000 },
        target: { home_group_id: 'oc_group', user_open_id: 'ou_user', cwd: '/repo' },
        run_template: { text: 'inspect {{task_id}}' },
        reentry: { policy: 'queue_one', timeout_ms: 300_000 },
      }],
    }, null, 2));
    chmodSync(configPath4, 0o600);
    mkdirSync(join(dir, 'periodic-tasks'), { recursive: true });
    writeFileSync(join(dir, 'periodic-tasks', 'state.json'), JSON.stringify({
      version: 1,
      tasks: {
        'task-4': {
          active_occurrence_id: 'task-4:2026-06-28T00:00:00.000Z',
          active_run_id: 'ptask_task-4_old',
          active_started_at: '2026-06-28T00:00:00.000Z',
        },
      },
    }, null, 2));
    const onCommand = vi.fn().mockResolvedValue(undefined);

    await runPeriodicPhase({ dataDir: dir, nowFn: () => Date.parse('2026-06-28T00:01:30.000Z'), onCommand });
    await runPeriodicPhase({ dataDir: dir, nowFn: () => Date.parse('2026-06-28T00:02:30.000Z'), onCommand });

    expect(onCommand).not.toHaveBeenCalled();
    const state = JSON.parse(readFileSync(join(dir, 'periodic-tasks', 'state.json'), 'utf8')) as { tasks: Record<string, { queued_occurrence_id?: string }> };
    expect(state.tasks['task-4']?.queued_occurrence_id).toContain('2026-06-28T00:02:00.000Z');
  });
});
