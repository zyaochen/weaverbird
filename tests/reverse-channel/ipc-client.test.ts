import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import net from 'node:net';
import { IpcClient, IpcServer, REVERSE_CHANNEL_ERROR_CODES, ReverseChannelError } from '../../packages/core/src/reverse-channel/index.js';

const roots: string[] = [];

function socketPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'wb-ipc-client-'));
  roots.push(root);
  return join(root, 'captain.sock');
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('ipc-client', () => {
  it('throws connect_failed when socket does not exist', async () => {
    const client = new IpcClient(join(tmpdir(), 'no-such-socket.sock'));
    await expect(client.openSession()).rejects.toMatchObject({ code: REVERSE_CHANNEL_ERROR_CODES.E_IPC_CONNECT_FAILED });
  });

  it('requestOnce performs hello handshake and receives ack', async () => {
    const path = socketPath();
    const server = new IpcServer(path);
    await server.start();
    const client = new IpcClient(path);
    const connection = await client.openSession();
    const ack = await connection.send({ kind: 'hello', run_id: 'run-001', pid: 4321 });
    expect(ack.kind).toBe('ack');
    await connection.close();
    await server.stop();
  });

  it('supports sending bye after handshake', async () => {
    const path = socketPath();
    const server = new IpcServer(path);
    await server.start();
    const client = new IpcClient(path);
    const connection = await client.openSession();
    await connection.send({ kind: 'hello', run_id: 'run-001', pid: 4321 });
    const ack = await connection.send({ kind: 'bye', run_id: 'run-001' });
    expect(ack.kind).toBe('ack');
    await connection.close();
    await server.stop();
  });

  it('can listen for push-style messages on a long-lived session', async () => {
    const path = socketPath();
    const server = new IpcServer(path);
    await server.start();
    const client = new IpcClient(path);
    const connection = await client.openSession();
    const seen: string[] = [];
    connection.on('push', (message) => {
      if (message.kind === 'ack') seen.push(message.command);
    });
    await connection.send({ kind: 'hello', run_id: 'run-002', pid: 1234 });
    server.send('run-002', { kind: 'ack', command: 'push', run_id: 'run-002', ok: true });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(seen).toContain('push');
    await connection.close();
    await server.stop();
  });

  it('keeps old path when openSession options are omitted', async () => {
    const path = socketPath();
    const server = new IpcServer(path);
    await server.start();
    const client = new IpcClient(path);
    const connection = await client.openSession();
    const ack = await connection.send({ kind: 'hello', run_id: 'run-legacy', pid: 4321 });
    expect(ack.kind).toBe('ack');
    await connection.close();
    await server.stop();
  });

  it('sends hello automatically when openSession receives runId', async () => {
    const path = socketPath();
    const server = new IpcServer(path);
    await server.start();
    const client = new IpcClient(path);
    const connection = await client.openSession({ runId: 'run-auto', pid: 999 });
    const pong = await connection.send({ kind: 'ping' });
    expect(pong.kind).toBe('pong');
    await connection.close();
    await server.stop();
  });
});
