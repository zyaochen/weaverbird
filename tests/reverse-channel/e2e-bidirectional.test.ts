import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CaptainService } from '../../packages/core/src/captain/index.js';
import { checkCaptainSessions } from '../../apps/wb-bot/src/commands/health.js';
import { wireUpReverseChannel } from '../../apps/wb-bot/src/server/wire-up.js';
import { handleAttachRequest } from '../../packages/core/src/reverse-channel/attach-handler.js';
import { REVERSE_CHANNEL_ERROR_CODES } from '../../packages/core/src/reverse-channel/contracts.js';
import { EchoTailer } from '../../packages/core/src/reverse-channel/echo-tailer.js';
import { IpcClient } from '../../packages/core/src/reverse-channel/ipc-client.js';
import { IpcServer } from '../../packages/core/src/reverse-channel/ipc-server.js';
import { parseReverseAt } from '../../packages/core/src/reverse-channel/reverse-at-handler.js';

const roots: string[] = [];

function writeConfig(dir: string): void {
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({
    captain: {
      bitable_base_id: 'Uq6hb0dUaaYiDQsunHel7EisgWd',
      sessions_table_id: 'tblyqLE52hgNO7UA',
      app_id: 'cli_yyyyyyyyyyyyyyyy',
      app_secret: 'secret-32-characters-000000000000',
      lark_domain: 'LarkSuite',
      captain_state_path: join(dir, 'captain-state.ndjson'),
      captain_toml_path: join(dir, 'captain.json'),
    },
  }, null, 2));
  chmodSync(path, 0o600);
  writeFileSync(join(dir, 'captain.json'), JSON.stringify({ version: 1, mapping: [{ git_remote: 'github\\.com.*/weaverbird.*', cwd_prefix: dir, captain_id: 'default' }] }, null, 2));
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('e2e-bidirectional', () => {
  it('E1: attach restores active session state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-e2e-'));
    roots.push(dir);
    writeConfig(dir);
    process.env['WB_DATA_DIR'] = dir;
    const service = new CaptainService({ dataDir: dir });
    service.createSession({ session_id: 'sid-001', captain_id: 'old', created_at: '2026-06-07T00:00:00.000Z', last_active_at: '2026-06-07T00:00:00.000Z', cwd: '/repo', scope: 'dev', project: 'weaverbird', home_group_id: 'grp', agent: 'claude-code', latest_run_id: 'run-001', operator: 'ou_abc', entry_form: 'im' });
    const result = await handleAttachRequest(service, { session_id: 'sid-001', requester_captain_id: 'default', requested_at: '2026-06-07T00:00:01.000Z', force: true });
    expect(result.outcome).toBe('attached');
    expect(service.getSession('sid-001')?.record.status).toBe('active');
  });

  it('E2: host-B attach switches ownership in shared session store', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-e2e-'));
    roots.push(dir);
    writeConfig(dir);
    process.env['WB_DATA_DIR'] = dir;
    const upsertCalls: Array<{ session_id: string; captain_id: string }> = [];
    const sharedStore: import('../../packages/core/src/captain/session-store.js').CaptainSessionStore = {
      config: {} as any,
      validateSchema: async () => {},
      upsert: async (record) => {
        upsertCalls.push({ session_id: record.session_id, captain_id: record.captain_id });
        return { ok: true, attempt: 1 };
      },
      upsertWithRevision: async (record, expectedRevision) => {
        upsertCalls.push({ session_id: record.session_id, captain_id: record.captain_id });
        return { ok: true, attempt: 1, newRevision: expectedRevision + 1 };
      },
      reconcile: async () => [],
      syncOnce: async () => 0,
      startSyncWorker: () => setInterval(() => undefined, 1000),
      stopSyncWorker: () => {},
    };
    const hostA = new CaptainService({ dataDir: dir, store: sharedStore });
    const hostB = new CaptainService({ dataDir: dir, store: sharedStore });
    hostA.createSession({ session_id: 'session_X', captain_id: 'host-A', created_at: '2026-06-07T00:00:00.000Z', last_active_at: '2026-06-07T00:00:00.000Z', cwd: '/repo', scope: 'dev', project: 'weaverbird', home_group_id: 'grp', agent: 'claude-code', latest_run_id: 'run-001', operator: 'ou_abc', entry_form: 'im' });
    hostA.bindRun('session_X', 'run-001');
    const result = await handleAttachRequest(hostA, { session_id: 'session_X', requester_captain_id: 'host-B', requested_at: '2026-06-07T00:00:30.000Z', force: true });
    expect(result.outcome).toBe('attached');
    await hostB.reconcile();
    const sessionAfter = hostB.getSession('session_X');
    expect(sessionAfter?.record.captain_id).toBe('host-B');
    const calls = upsertCalls.filter((call) => call.session_id === 'session_X');
    expect(calls.some((call) => call.captain_id === 'host-B')).toBe(true);
  });

  it('E2.1: host-A wire-up rejects control after captain handover', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-e2e-'));
    roots.push(dir);
    writeConfig(dir);
    process.env['WB_DATA_DIR'] = dir;
    const socketPath = join(dir, 'captain.sock');
    const hostA = new CaptainService({ dataDir: dir });
    hostA.createSession({ session_id: 'session_X', captain_id: 'host-A', created_at: '2026-06-07T00:00:00.000Z', last_active_at: '2026-06-07T00:00:00.000Z', cwd: '/repo', scope: 'dev', project: 'weaverbird', home_group_id: 'grp', agent: 'claude-code', latest_run_id: 'run-001', operator: 'ou_abc', entry_form: 'im' });
    hostA.bindRun('session_X', 'run-001');
    await handleAttachRequest(hostA, {
      session_id: 'session_X',
      requester_captain_id: 'host-B',
      requested_at: '2026-06-07T00:00:30.000Z',
      force: true,
    });

    const server = new IpcServer(socketPath);
    await server.start();
    wireUpReverseChannel(server, hostA, dir, 'host-A');
    const client = new IpcClient(socketPath);
    const connection = await client.openSession();
    try {
      await connection.send({ kind: 'hello', run_id: 'run-001', pid: process.pid });
      const ackMessage = await connection.send({ kind: 'control', command: 'pause', run_id: 'run-001' });
      expect(ackMessage.kind).toBe('ack');
      if (ackMessage.kind !== 'ack') {
        throw new Error(`expected ack, got ${ackMessage.kind}`);
      }
      expect(ackMessage.ok).toBe(false);
      expect(ackMessage.reason).toBe(REVERSE_CHANNEL_ERROR_CODES.E_CAPTAIN_HANDED_OVER);
    } finally {
      await connection.close();
      await server.stop();
    }
  });

  it('E3/E4: echo tailer sends once within dedup window and max 3 per run', async () => {
    const sent: string[] = [];
    let now = 0;
    const tailer = new EchoTailer(async (payload) => { sent.push(`${payload.run_id}:${payload.status}`); }, { nowFn: () => now });
    const session = { session_id: 'sid-001', home_group_id: 'grp-001' } as any;
    await tailer.onRunUpserted({ run_id: 'run-001', cmd: 'cmd', cwd: '/repo', created_at: '2026-06-07T00:00:00.000Z', status: 'active', session, operator_open_id: 'ou_abc' });
    await tailer.onRunUpserted({ run_id: 'run-001', cmd: 'cmd', cwd: '/repo', created_at: '2026-06-07T00:00:00.000Z', status: 'active', session, operator_open_id: 'ou_abc' });
    now = 31_000;
    await tailer.onRunUpserted({ run_id: 'run-001', cmd: 'cmd', cwd: '/repo', created_at: '2026-06-07T00:00:00.000Z', status: 'failed', session, operator_open_id: 'ou_abc' });
    now = 62_000;
    await tailer.onRunUpserted({ run_id: 'run-001', cmd: 'cmd', cwd: '/repo', created_at: '2026-06-07T00:00:00.000Z', status: 'cancelled', session, operator_open_id: 'ou_abc' });
    now = 93_000;
    await tailer.onRunUpserted({ run_id: 'run-001', cmd: 'cmd', cwd: '/repo', created_at: '2026-06-07T00:00:00.000Z', status: 'succeeded', session, operator_open_id: 'ou_abc' });
    expect(sent).toEqual(['run-001:active', 'run-001:failed', 'run-001:cancelled']);
  });

  it('E5/E6/E7: reverse @ parse supports pause resume cancel', () => {
    expect(parseReverseAt('pause run_abc123', 'ou_abc', 'm1')?.command).toBe('pause');
    expect(parseReverseAt('resume run_abc123', 'ou_abc', 'm1')?.command).toBe('resume');
    expect(parseReverseAt('cancel run_abc123', 'ou_abc', 'm1')?.command).toBe('cancel');
  });

  it('E8: reverse @ invalid run can be represented as parse success but later fail', () => {
    const cmd = parseReverseAt('pause nonexistent_run', 'ou_abc', 'm1');
    expect(cmd?.run_id).toBe('nonexistent_run');
  });

  it('E9: IPC reconnect baseline fails cleanly when socket is gone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-e2e-'));
    roots.push(dir);
    const path = join(dir, 'captain.sock');
    const server = new IpcServer(path);
    await server.start();
    const client = new IpcClient(path);
    const conn = await client.openSession();
    await conn.send({ kind: 'hello', run_id: 'run-001', pid: 1234 });
    await server.stop();
    await expect(client.openSession()).rejects.toThrow();
    await conn.close();
  });

  it('E10: health reverse-channel prerequisites can be checked from fs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-e2e-'));
    roots.push(dir);
    writeConfig(dir);
    writeFileSync(join(dir, 'captain-state.ndjson'), '{}\n');
    const result = checkCaptainSessions(dir);
    expect(result.status).toBe('ok');
    expect(result.detail).toContain('1 sessions in mirror');
  });
});
