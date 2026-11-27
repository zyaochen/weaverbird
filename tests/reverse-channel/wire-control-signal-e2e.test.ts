import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CaptainService } from '../../packages/core/src/captain/index.js';
import { IpcClient, IpcServer, REVERSE_CHANNEL_ERROR_CODES } from '../../packages/core/src/reverse-channel/index.js';
import { wireUpReverseChannel } from '../../apps/wb-bot/src/server/wire-up.js';
import { waitForStoppedState } from '../helpers/process-state.js';

const roots: string[] = [];
const children: ChildProcess[] = [];

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
}

function createService(dir: string): CaptainService {
  writeConfig(dir);
  process.env['WB_DATA_DIR'] = dir;
  return new CaptainService({ dataDir: dir });
}

function writePidFile(dataDir: string, botId: string, runId: string, pid: number): void {
  const runDir = join(dataDir, 'runs', botId, runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'pid'), String(pid));
}

function spawnSleeper(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  children.push(child);
  return child;
}

afterEach(async () => {
  delete process.env['WB_DATA_DIR'];
  for (const child of children.splice(0)) {
    if (child.pid && !child.killed) {
      try { process.kill(child.pid, 'SIGCONT'); } catch {}
      try { process.kill(child.pid, 'SIGKILL'); } catch {}
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('wire-control-signal e2e', () => {
  it.skipIf(process.platform === 'win32')('sends SIGSTOP to the pid resolved from wb-runner pid file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-wire-control-'));
    roots.push(dir);
    const socketPath = join(dir, 'captain.sock');
    const runId = 'run-control-001';
    const captainService = createService(dir);
    const child = spawnSleeper();
    expect(child.pid).toBeTypeOf('number');
    writePidFile(dir, 'default', runId, child.pid!);

    const server = new IpcServer(socketPath);
    await server.start();
    wireUpReverseChannel(server, captainService, dir, 'default');
    const client = new IpcClient(socketPath);
    const connection = await client.openSession();
    try {
      await connection.send({ kind: 'hello', run_id: runId, pid: process.pid });
      const ackMessage = await connection.send({ kind: 'control', command: 'pause', run_id: runId });
      expect(ackMessage.kind).toBe('ack');
      if (ackMessage.kind !== 'ack') throw new Error('expected ack');
      expect(ackMessage.ok).toBe(true);
      expect(await waitForStoppedState(child.pid!, 1_500)).toBe(true);
      process.kill(child.pid!, 'SIGCONT');
    } finally {
      await connection.close();
      await server.stop();
    }
  });

  it('returns run gone when pid file cannot be resolved', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-wire-control-'));
    roots.push(dir);
    const socketPath = join(dir, 'captain.sock');
    const captainService = createService(dir);
    const server = new IpcServer(socketPath);
    await server.start();
    wireUpReverseChannel(server, captainService, dir, 'default');
    const client = new IpcClient(socketPath);
    const connection = await client.openSession();
    try {
      await connection.send({ kind: 'hello', run_id: 'run-missing', pid: process.pid });
      const ackMessage = await connection.send({ kind: 'control', command: 'pause', run_id: 'run-missing' });
      expect(ackMessage.kind).toBe('ack');
      if (ackMessage.kind !== 'ack') throw new Error('expected ack');
      expect(ackMessage.ok).toBe(false);
      expect(ackMessage.reason).toBe(REVERSE_CHANNEL_ERROR_CODES.E_REVERSE_AT_RUN_GONE);
    } finally {
      await connection.close();
      await server.stop();
    }
  });
});
