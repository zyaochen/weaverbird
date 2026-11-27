import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startBotHeartbeat } from '../../apps/wb-bot/src/heartbeat/bot-heartbeat.js';

let dir = '';

beforeEach(() => {
  vi.useFakeTimers();
  dir = mkdtempSync(join(tmpdir(), 'wb-bot-heartbeat-'));
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe('startBotHeartbeat', () => {
  it('writes runs/<botId>/heartbeat immediately as unix seconds', () => {
    const handle = startBotHeartbeat({ dataDir: dir, botId: 'default', nowFn: () => 12_345_000 });
    const heartbeatPath = join(dir, 'runs', 'default', 'heartbeat');

    expect(existsSync(heartbeatPath)).toBe(true);
    expect(readFileSync(heartbeatPath, 'utf8')).toBe('12345');
    handle.stop();
  });

  it('writeOnce atomically overwrites heartbeat content', () => {
    let now = 10_000;
    const handle = startBotHeartbeat({ dataDir: dir, botId: 'claude', nowFn: () => now });
    const heartbeatPath = join(dir, 'runs', 'claude', 'heartbeat');

    now = 20_000;
    handle.writeOnce();
    expect(readFileSync(heartbeatPath, 'utf8')).toBe('20');
    expect(existsSync(join(dir, 'runs', 'claude', '.heartbeat.tmp'))).toBe(false);
    handle.stop();
  });

  it('stops interval updates after stop is called', () => {
    let now = 10_000;
    const handle = startBotHeartbeat({ dataDir: dir, botId: 'codex', intervalMs: 1000, nowFn: () => now });
    const heartbeatPath = join(dir, 'runs', 'codex', 'heartbeat');

    now = 20_000;
    vi.advanceTimersByTime(1000);
    expect(readFileSync(heartbeatPath, 'utf8')).toBe('20');

    handle.stop();
    now = 30_000;
    vi.advanceTimersByTime(5000);
    expect(readFileSync(heartbeatPath, 'utf8')).toBe('20');
  });
});
