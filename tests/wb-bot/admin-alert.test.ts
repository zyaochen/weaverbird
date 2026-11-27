import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getPendingAlertCount, sendAdminAlert, type AlertSeverity } from '../../apps/wb-bot/src/feishu/admin-alert.js';

const roots: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-admin-alert-'));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  delete process.env['WB_ADMIN_THREAD_ID'];
  delete process.env['WB_OWNER_OPEN_ID'];
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('admin-alert', () => {
  it('rotates admin-alerts.ndjson and still counts active plus rotated segments', async () => {
    const dir = createTempDir();
    const alertFile = join(dir, 'admin-alerts.ndjson');
    writeFileSync(alertFile, JSON.stringify({ message: 'x'.repeat(8 * 1024 * 1024) }), 'utf8');

    await sendAdminAlert(null, dir, 'rotation-trigger', 'warn');

    expect(getPendingAlertCount(dir)).toBe(2);
  });

  it('keeps fail-open behavior when dataDir cannot host admin-alerts.ndjson', async () => {
    const dir = createTempDir();
    const blocked = join(dir, 'blocked');
    writeFileSync(blocked, 'not-a-directory', 'utf8');

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      await expect(sendAdminAlert(null, blocked, 'fail-open', 'error')).resolves.toBeUndefined();
      expect(getPendingAlertCount(blocked)).toBe(0);
      expect(stderrSpy).toHaveBeenCalled();
      expect(String(stderrSpy.mock.calls[0]?.[0] ?? '')).toContain('[wb-bot][admin-alert][last-resort][error]');
      expect(String(stderrSpy.mock.calls[0]?.[0] ?? '')).toContain('⛔ [wb-bot] fail-open');
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('M13-C: prefers DM to WB_OWNER_OPEN_ID before cluster thread', async () => {
    process.env['WB_OWNER_OPEN_ID'] = 'ou_owner_x';
    process.env['WB_ADMIN_THREAD_ID'] = 'oc_cluster_1';
    const dir = createTempDir();
    const calls: Array<{ kind: 'dm' | 'text'; target: string; body: string }> = [];
    const sink = {
      sendText: async (chatId: string, body: string) => { calls.push({ kind: 'text', target: chatId, body }); },
      sendDm: async (openId: string, body: string) => { calls.push({ kind: 'dm', target: openId, body }); },
    };
    await sendAdminAlert(sink, dir, 'heartbeat-stall detected', 'error' as AlertSeverity);
    expect(calls).toEqual([{ kind: 'dm', target: 'ou_owner_x', body: expect.stringContaining('heartbeat-stall detected') }]);
  });

  it('M13-C: falls back to cluster when sendDm fails', async () => {
    process.env['WB_OWNER_OPEN_ID'] = 'ou_owner_x';
    process.env['WB_ADMIN_THREAD_ID'] = 'oc_cluster_1';
    const dir = createTempDir();
    const calls: Array<{ kind: 'dm' | 'text'; target: string }> = [];
    const sink = {
      sendText: async (chatId: string) => { calls.push({ kind: 'text', target: chatId }); },
      sendDm: async () => { throw new Error('permission denied'); },
    };
    await expect(sendAdminAlert(sink as never, dir, 'owner offline test', 'error')).resolves.toBeUndefined();
    expect(calls).toEqual([{ kind: 'text', target: 'oc_cluster_1' }]);
  });

  it('M13-C: skips DM when owner open_id is malformed (does not crash the pipeline)', async () => {
    process.env['WB_OWNER_OPEN_ID'] = 'not-an-open-id';
    process.env['WB_ADMIN_THREAD_ID'] = 'oc_cluster_1';
    const dir = createTempDir();
    const calls: Array<{ kind: 'dm' | 'text'; target: string }> = [];
    const sink = {
      sendText: async (chatId: string) => { calls.push({ kind: 'text', target: chatId }); },
      sendDm: async (openId: string) => { calls.push({ kind: 'dm', target: openId }); },
    };
    await sendAdminAlert(sink as never, dir, 'malformed owner id', 'warn');
    expect(calls).toEqual([{ kind: 'text', target: 'oc_cluster_1' }]);
  });

  it('M13-C: no DM helper => cluster sendText only, never throws', async () => {
    process.env['WB_OWNER_OPEN_ID'] = 'ou_owner_x';
    process.env['WB_ADMIN_THREAD_ID'] = 'oc_cluster_1';
    const dir = createTempDir();
    const calls: Array<{ kind: 'text'; target: string }> = [];
    const sink = {
      sendText: async (chatId: string) => { calls.push({ kind: 'text', target: chatId }); },
      // 无 sendDm
    };
    await sendAdminAlert(sink as never, dir, 'cluster-only path', 'error');
    expect(calls).toEqual([{ kind: 'text', target: 'oc_cluster_1' }]);
  });
});
