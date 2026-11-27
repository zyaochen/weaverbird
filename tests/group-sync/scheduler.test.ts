import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runGroupSyncStatePath } from '../../packages/core/src/paths.js';
import { startGroupSyncScheduler, type GroupSyncConfig, type GroupSyncTransport } from '../../packages/core/src/group-sync/index.js';

const roots: string[] = [];
const config: GroupSyncConfig = {
  enabled: true,
  transport: 'mock',
  rpc_timeout_ms: 50,
  sweep_interval_ms: 10_000,
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('group-sync scheduler', () => {
  it('keeps command dispatch alive when sync transport fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-group-sync-'));
    roots.push(root);
    mkdirSync(join(root, 'group-sync'), { recursive: true });
    writeFileSync(join(root, 'group-sync', 'mock-commands.json'), JSON.stringify([
      {
        request_id: 'req-2',
        session_id: 'sid-2',
        run_id: 'run-2',
        revision: 1,
        text: 'hello from group sync',
        scheduled_at: '2026-06-29T00:00:00.000Z',
        user_open_id: 'ou_user',
        thread_id: 'oc_thread',
        message_id: 'msg-2',
      },
    ], null, 2));
    const transport: GroupSyncTransport = {
      syncCommand: vi.fn().mockRejectedValue(new Error('group sync boom')),
    };
    const onCommand = vi.fn().mockResolvedValue(undefined);
    const scheduler = startGroupSyncScheduler({
      dataDir: root,
      config,
      transport,
      onCommand,
      nowFn: () => Date.parse('2026-06-29T00:00:01.000Z'),
    });

    await expect(scheduler.tick()).resolves.toBeUndefined();
    await scheduler.tick();

    expect(onCommand).toHaveBeenCalledTimes(1);
    const state = JSON.parse(readFileSync(runGroupSyncStatePath(root, 'run-2'), 'utf8')) as Record<string, unknown>;
    expect(state['sync_failed']).toBe(true);
    expect(state['last_error']).toBe('group sync boom');
    scheduler.stop();
  });

  it('keeps later command dispatches alive when one dispatch fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-group-sync-'));
    roots.push(root);
    mkdirSync(join(root, 'group-sync'), { recursive: true });
    writeFileSync(join(root, 'group-sync', 'mock-commands.json'), JSON.stringify([
      {
        request_id: 'req-dispatch-a',
        session_id: 'sid-dispatch',
        run_id: 'run-dispatch-a',
        revision: 1,
        text: '/review diff',
        scheduled_at: '2026-06-29T00:00:00.000Z',
        user_open_id: 'ou_user',
        thread_id: 'oc_thread',
        message_id: 'msg-a',
      },
      {
        request_id: 'req-dispatch-b',
        session_id: 'sid-dispatch',
        run_id: 'run-dispatch-b',
        revision: 2,
        text: '/review ship',
        scheduled_at: '2026-06-29T00:00:00.000Z',
        user_open_id: 'ou_user',
        thread_id: 'oc_thread',
        message_id: 'msg-b',
      },
    ], null, 2));
    const transport: GroupSyncTransport = {
      syncCommand: vi.fn().mockResolvedValue(undefined),
    };
    const onCommand = vi.fn(async (command) => {
      if (command.request_id === 'req-dispatch-a') {
        throw new Error('dispatch boom');
      }
    });
    const scheduler = startGroupSyncScheduler({
      dataDir: root,
      config,
      transport,
      onCommand,
      nowFn: () => Date.parse('2026-06-29T00:00:01.000Z'),
    });

    await expect(scheduler.tick()).resolves.toBeUndefined();

    expect(onCommand).toHaveBeenCalledTimes(2);
    const failedDispatch = JSON.parse(readFileSync(join(root, 'runs', 'default', 'run-dispatch-a', 'group-sync-dispatch.json'), 'utf8')) as Record<string, unknown>;
    const successDispatch = JSON.parse(readFileSync(join(root, 'runs', 'default', 'run-dispatch-b', 'group-sync-dispatch.json'), 'utf8')) as Record<string, unknown>;
    expect((failedDispatch['commands'] as Array<Record<string, unknown>>)[0]?.['dispatch_failed']).toBe(true);
    expect((failedDispatch['commands'] as Array<Record<string, unknown>>)[0]?.['last_error']).toBe('dispatch boom');
    expect((successDispatch['commands'] as Array<Record<string, unknown>>)[0]?.['dispatch_failed']).toBe(false);
    scheduler.stop();
  });
});
