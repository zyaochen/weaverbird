import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CaptainService } from '../../packages/core/src/captain/index.js';
import { IpcClient, IpcServer, REVERSE_CHANNEL_ERROR_CODES, type IpcMessage } from '../../packages/core/src/reverse-channel/index.js';
import { wireUpReverseChannel } from '../../apps/wb-bot/src/server/wire-up.js';

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
}

function createService(dir: string): CaptainService {
  writeConfig(dir);
  process.env['WB_DATA_DIR'] = dir;
  return new CaptainService({ dataDir: dir });
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['WB_DATA_DIR'];
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('wire-up attach e2e', () => {
  it('CLI attach with captain switch → ack ok, payload.outcome=attached', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-wire-attach-'));
    roots.push(dir);
    const socketPath = join(dir, 'captain.sock');
    const captainService = createService(dir);
    captainService.createSession({
      session_id: 'session_X',
      captain_id: 'host-A',
      created_at: '2026-06-07T00:00:00.000Z',
      last_active_at: '2026-06-07T00:00:00.000Z',
      cwd: '/repo',
      scope: 'dev',
      project: 'weaverbird',
      home_group_id: 'grp',
      agent: 'claude-code',
      latest_run_id: 'run-001',
      operator: 'ou_abc',
      entry_form: 'im',
    });
    const server = new IpcServer(socketPath);
    await server.start();
    wireUpReverseChannel(server, captainService, dir, 'default');
    const client = new IpcClient(socketPath);
    const connection = await client.openSession();
    try {
      await connection.send({ kind: 'hello', run_id: 'session_X', pid: process.pid });
      const ackMessage = await connection.send({
        kind: 'attach',
        run_id: 'session_X',
        session_id: 'session_X',
        requester_captain_id: 'host-B',
        force: true,
      });
      expect(ackMessage.kind).toBe('ack');
      if (ackMessage.kind !== 'ack') {
        throw new Error(`expected ack, got ${ackMessage.kind}`);
      }
      const ack: Extract<IpcMessage, { kind: 'ack' }> = ackMessage;
      expect(ack.ok).toBe(true);
      expect(ack.payload).toMatchObject({
        outcome: 'attached',
        session_id: 'session_X',
      });
      expect((ack.payload as any).session.captain_id).toBe('host-B');
      expect(Array.isArray((ack.payload as any).run_ids)).toBe(true);
      expect(captainService.getSession('session_X')?.record.captain_id).toBe('host-B');
    } finally {
      await connection.close();
      await server.stop();
    }
  });

  it('CLI attach without force when captain mismatch → ack mutex_conflict', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-wire-attach-'));
    roots.push(dir);
    const socketPath = join(dir, 'captain.sock');
    const captainService = createService(dir);
    captainService.createSession({
      session_id: 'session_X',
      captain_id: 'host-A',
      created_at: '2026-06-07T00:00:00.000Z',
      last_active_at: '2026-06-07T00:00:00.000Z',
      cwd: '/repo',
      scope: 'dev',
      project: 'weaverbird',
      home_group_id: 'grp',
      agent: 'claude-code',
      latest_run_id: null,
      operator: 'ou_abc',
      entry_form: 'im',
    });
    const server = new IpcServer(socketPath);
    await server.start();
    wireUpReverseChannel(server, captainService, dir, 'default');
    const client = new IpcClient(socketPath);
    const connection = await client.openSession();
    try {
      await connection.send({ kind: 'hello', run_id: 'session_X', pid: process.pid });
      const ackMessage = await connection.send({
        kind: 'attach',
        run_id: 'session_X',
        session_id: 'session_X',
        requester_captain_id: 'host-B',
      });
      expect(ackMessage.kind).toBe('ack');
      if (ackMessage.kind !== 'ack') {
        throw new Error(`expected ack, got ${ackMessage.kind}`);
      }
      const ack: Extract<IpcMessage, { kind: 'ack' }> = ackMessage;
      expect(ack.ok).toBe(false);
      expect(ack.reason).toBe(REVERSE_CHANNEL_ERROR_CODES.E_ATTACH_MUTEX);
      expect(ack.payload).toMatchObject({
        outcome: 'mutex_conflict',
        current_captain_id: 'host-A',
      });
      expect((ack.payload as any).suggestion).toContain('--force');
    } finally {
      await connection.close();
      await server.stop();
    }
  });

  it('CLI attach missing session → ack not_found', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-wire-attach-'));
    roots.push(dir);
    const socketPath = join(dir, 'captain.sock');
    const captainService = createService(dir);
    const server = new IpcServer(socketPath);
    await server.start();
    wireUpReverseChannel(server, captainService, dir, 'default');
    const client = new IpcClient(socketPath);
    const connection = await client.openSession();
    try {
      await connection.send({ kind: 'hello', run_id: 'session_missing', pid: process.pid });
      const ackMessage = await connection.send({
        kind: 'attach',
        run_id: 'session_missing',
        session_id: 'session_missing',
        requester_captain_id: 'host-B',
      });
      expect(ackMessage.kind).toBe('ack');
      if (ackMessage.kind !== 'ack') {
        throw new Error(`expected ack, got ${ackMessage.kind}`);
      }
      const ack: Extract<IpcMessage, { kind: 'ack' }> = ackMessage;
      expect(ack.ok).toBe(false);
      expect(ack.reason).toBe(REVERSE_CHANNEL_ERROR_CODES.E_ATTACH_NOT_FOUND);
      expect(ack.payload).toMatchObject({
        outcome: 'not_found',
        session_id: 'session_missing',
        candidates: [],
      });
    } finally {
      await connection.close();
      await server.stop();
    }
  });

  it('flush throw maps to attach flush_failed ack', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-wire-attach-'));
    roots.push(dir);
    const socketPath = join(dir, 'captain.sock');
    const captainService = createService(dir);
    captainService.createSession({
      session_id: 'session_X',
      captain_id: 'host-A',
      created_at: '2026-06-07T00:00:00.000Z',
      last_active_at: '2026-06-07T00:00:00.000Z',
      cwd: '/repo',
      scope: 'dev',
      project: 'weaverbird',
      home_group_id: 'grp',
      agent: 'claude-code',
      latest_run_id: null,
      operator: 'ou_abc',
      entry_form: 'im',
    });
    vi.spyOn(captainService, 'flush').mockRejectedValue(new Error('bitable down'));
    const server = new IpcServer(socketPath);
    await server.start();
    wireUpReverseChannel(server, captainService, dir, 'default');
    const client = new IpcClient(socketPath);
    const connection = await client.openSession();
    try {
      await connection.send({ kind: 'hello', run_id: 'session_X', pid: process.pid });
      const ackMessage = await connection.send({
        kind: 'attach',
        run_id: 'session_X',
        session_id: 'session_X',
        requester_captain_id: 'host-B',
        force: true,
      });
      expect(ackMessage.kind).toBe('ack');
      if (ackMessage.kind !== 'ack') {
        throw new Error(`expected ack, got ${ackMessage.kind}`);
      }
      const ack: Extract<IpcMessage, { kind: 'ack' }> = ackMessage;
      expect(ack.ok).toBe(false);
      expect(ack.reason).toBe(REVERSE_CHANNEL_ERROR_CODES.E_ATTACH_FLUSH_FAILED);
      expect(ack.payload).toMatchObject({
        outcome: 'error',
        code: 'reverse.attach.flush_failed',
      });
    } finally {
      await connection.close();
      await server.stop();
    }
  });

  it('invalid attach payload → server returns E_IPC_PARSE ack', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-wire-attach-'));
    roots.push(dir);
    const socketPath = join(dir, 'captain.sock');
    const captainService = createService(dir);
    const server = new IpcServer(socketPath);
    await server.start();
    wireUpReverseChannel(server, captainService, dir, 'default');
    const rawClient = await new Promise<import('node:net').Socket>((resolve, reject) => {
      const net = require('node:net') as typeof import('node:net');
      const socket = net.createConnection(socketPath, () => resolve(socket));
      socket.once('error', reject);
    });
    rawClient.setEncoding('utf8');
    let output = '';
    rawClient.on('data', (chunk) => {
      output += String(chunk);
    });
    rawClient.write('{"kind":"attach","run_id":"session_X","session_id":"","requester_captain_id":"host-B"}\n');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(output).toContain('"kind":"ack"');
    expect(output).toContain(REVERSE_CHANNEL_ERROR_CODES.E_IPC_PARSE);
    rawClient.destroy();
    await server.stop();
  });
});
