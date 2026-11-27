import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { IpcClient } from '../../packages/core/src/reverse-channel/ipc-client.js';
import { IpcServer } from '../../packages/core/src/reverse-channel/ipc-server.js';
import { checkReverseChannel } from '../../apps/wb-bot/src/commands/health.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('health-reverse-channel', () => {
  it('warns when socket is missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-health-reverse-'));
    roots.push(dir);
    const result = await checkReverseChannel(dir);
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('socket missing');
  });

  it('warns when socket mode is not 0600', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-health-reverse-'));
    roots.push(dir);
    const socketPath = join(dir, 'captain.sock');
    writeFileSync(socketPath, 'x');
    chmodSync(socketPath, 0o644);
    const result = await checkReverseChannel(dir);
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('mode');
  });

  it('can verify socket + ping path when server is alive', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-health-reverse-'));
    roots.push(dir);
    const socketPath = join(dir, 'captain.sock');
    const server = new IpcServer(socketPath);
    await server.start();
    try {
      const result = await checkReverseChannel(dir);
      expect(result.label).toBe('Reverse Channel');
      expect(result.status).toBe('ok');
      expect(result.detail).toContain('hello ack');
    } finally {
      await server.stop();
    }
  }, 10_000);

  it('uses health-check run_id with random suffix', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-health-reverse-'));
    roots.push(dir);
    const socketPath = join(dir, 'captain.sock');
    const seenRunIds: string[] = [];
    const server = new IpcServer(socketPath);
    server.on('hello', (message) => {
      seenRunIds.push(message.run_id);
    });
    await server.start();
    try {
      await checkReverseChannel(dir);
      expect(seenRunIds).toHaveLength(1);
      expect(seenRunIds[0]).toMatch(/^health-check-[a-f0-9]{8}$/);
    } finally {
      await server.stop();
    }
  });
});
