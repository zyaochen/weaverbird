import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runGroupSyncStatePath } from '../../packages/core/src/paths.js';
import { syncGroupCommand, type GroupSyncCommandReceived, type GroupSyncConfig, type GroupSyncTransport } from '../../packages/core/src/group-sync/index.js';

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

describe('group-sync service', () => {
  it('syncs once per run_id + revision and records success state', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-group-sync-'));
    roots.push(root);
    const command: GroupSyncCommandReceived = {
      request_id: 'req-1',
      session_id: 'sid-1',
      run_id: 'run-1',
      revision: 0,
      text: 'hello from group sync',
      scheduled_at: '2026-06-29T00:00:00.000Z',
      user_open_id: 'ou_user',
      thread_id: 'oc_thread',
      message_id: 'msg-1',
    };
    const transport: GroupSyncTransport = {
      syncCommand: vi.fn().mockResolvedValue(undefined),
    };

    const first = await syncGroupCommand({ dataDir: root, command, config, transport });
    const second = await syncGroupCommand({ dataDir: root, command, config, transport });

    expect(first.sync_failed).toBe(false);
    expect(second.sync_failed).toBe(false);
    expect(transport.syncCommand).toHaveBeenCalledTimes(1);

    const state = JSON.parse(readFileSync(runGroupSyncStatePath(root, 'run-1'), 'utf8')) as Record<string, unknown>;
    expect(state['session_id']).toBe('sid-1');
    expect(state['run_id']).toBe('run-1');
    expect(state['revision']).toBe(0);
    expect(state['sync_failed']).toBe(false);
    expect(typeof state['last_synced_at']).toBe('string');
  });
});

