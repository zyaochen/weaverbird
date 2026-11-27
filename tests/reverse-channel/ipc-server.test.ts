import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IpcServer, REVERSE_CHANNEL_ERROR_CODES } from '../../packages/core/src/reverse-channel/index.js';

const roots: string[] = [];

function socketPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'wb-ipc-server-'));
  roots.push(root);
  return join(root, 'captain.sock');
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('ipc-server', () => {
  it('starts on unix socket path and enforces 0600 mode', async () => {
    const path = socketPath();
    const server = new IpcServer(path);
    await server.start();
    expect((statSync(path).mode & 0o777)).toBe(0o600);
    await server.stop();
  });

  it('handles hello handshake and bye cleanup', async () => {
    const path = socketPath();
    const server = new IpcServer(path);
    const hello = vi.fn();
    const bye = vi.fn();
    server.on('hello', hello);
    server.on('bye', bye);
    await server.start();

    const socket = net.createConnection(path);
    socket.setEncoding('utf8');
    const lines: string[] = [];
    socket.on('data', (chunk) => lines.push(String(chunk)));
    socket.write('{"kind":"hello","run_id":"run-001","pid":1234}\n');
    await new Promise((resolve) => setTimeout(resolve, 50));
    socket.write('{"kind":"bye","run_id":"run-001"}\n');
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(hello).toHaveBeenCalled();
    expect(bye).toHaveBeenCalled();
    expect(lines.join('')).toContain('"command":"hello"');
    await server.stop();
  });

  it('responds to ping with pong', async () => {
    const path = socketPath();
    const server = new IpcServer(path);
    await server.start();
    const socket = net.createConnection(path);
    socket.setEncoding('utf8');
    let output = '';
    socket.on('data', (chunk) => { output += String(chunk); });
    socket.write('{"kind":"ping"}\n');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(output).toContain('"kind":"pong"');
    socket.destroy();
    await server.stop();
  });

  it('does not auto-ack on control; lets subscriber decide', async () => {
    const path = socketPath();
    const server = new IpcServer(path);
    const control = vi.fn();
    server.on('control', control);
    await server.start();
    const socket = net.createConnection(path);
    socket.setEncoding('utf8');
    let output = '';
    socket.on('data', (chunk) => { output += String(chunk); });
    socket.write('{"kind":"control","command":"pause","run_id":"run-001"}\n');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(control).toHaveBeenCalled();
    expect(output).toBe('');
    socket.destroy();
    await server.stop();
  });

  it('emits attach event without immediate ack', async () => {
    const path = socketPath();
    const server = new IpcServer(path);
    const attach = vi.fn();
    server.on('attach', attach);
    await server.start();
    const socket = net.createConnection(path);
    socket.setEncoding('utf8');
    let output = '';
    socket.on('data', (chunk) => { output += String(chunk); });
    socket.write('{"kind":"attach","run_id":"session-001","session_id":"session-001","requester_captain_id":"host-B","force":true}\n');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(attach).toHaveBeenCalled();
    expect(output).toBe('');
    socket.destroy();
    await server.stop();
  });

  it('returns parse ack and stays alive after invalid payload', async () => {
    const path = socketPath();
    const server = new IpcServer(path);
    await server.start();

    const badSocket = net.createConnection(path);
    badSocket.setEncoding('utf8');
    let badOutput = '';
    badSocket.on('data', (chunk) => { badOutput += String(chunk); });
    badSocket.write('{"kind":"attach","run_id":"session-001","session_id":"","requester_captain_id":"host-B"}\n');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(badOutput).toContain('"command":"parse"');
    expect(badOutput).toContain(REVERSE_CHANNEL_ERROR_CODES.E_IPC_PARSE);

    const goodSocket = net.createConnection(path);
    goodSocket.setEncoding('utf8');
    let goodOutput = '';
    goodSocket.on('data', (chunk) => { goodOutput += String(chunk); });
    goodSocket.write('{"kind":"ping"}\n');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(goodOutput).toContain('"kind":"pong"');

    badSocket.destroy();
    goodSocket.destroy();
    await server.stop();
  });

  it('recreates stale socket file even if previous mode is wrong', async () => {
    const path = socketPath();
    const root = path.slice(0, path.lastIndexOf('/'));
    require('node:fs').writeFileSync(path, 'stale');
    require('node:fs').chmodSync(path, 0o644);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const server = new IpcServer(path);
    await server.start();
    expect((statSync(path).mode & 0o777)).toBe(0o600);
    expect(warn).toHaveBeenCalled();
    await server.stop();
    expect(root).toBeTruthy();
  });
});
