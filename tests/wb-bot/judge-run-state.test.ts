import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { judgeRunState } from '../../apps/wb-bot/src/feishu/run-state.js';

const roots: string[] = [];

function createRunDir(botId: string, runId: string): { root: string; runDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'wb-judge-run-state-'));
  roots.push(root);
  const runDir = join(root, 'runs', botId, runId);
  mkdirSync(runDir, { recursive: true });
  return { root, runDir };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('judgeRunState', () => {
  it('returns resumed for custom bot when status is running and heartbeat is fresh', () => {
    const now = 1_000_000;
    const { root, runDir } = createRunDir('custom_bot', 'run-1');
    writeFileSync(join(runDir, 'status'), 'running\n');
    writeFileSync(join(runDir, 'heartbeat'), String(Math.floor((now - 10_000) / 1000)));

    expect(judgeRunState('custom_bot', 'run-1', { dataDir: root, staleMs: 240_000, now })).toBe('resumed');
  });

  it('returns lost when status file is missing', () => {
    const { root } = createRunDir('custom_bot', 'run-2');
    expect(judgeRunState('custom_bot', 'run-2', { dataDir: root, staleMs: 240_000, now: 1_000_000 })).toBe('lost');
  });

  it('returns lost when status is not running', () => {
    const { root, runDir } = createRunDir('custom_bot', 'run-3');
    writeFileSync(join(runDir, 'status'), 'completed\n');
    writeFileSync(join(runDir, 'heartbeat'), String(Math.floor((1_000_000 - 10_000) / 1000)));

    expect(judgeRunState('custom_bot', 'run-3', { dataDir: root, staleMs: 240_000, now: 1_000_000 })).toBe('lost');
  });

  it('returns lost when heartbeat is stale', () => {
    const now = 1_000_000;
    const { root, runDir } = createRunDir('custom_bot', 'run-4');
    writeFileSync(join(runDir, 'status'), 'running\n');
    writeFileSync(join(runDir, 'heartbeat'), String(Math.floor((now - 300_000) / 1000)));

    expect(judgeRunState('custom_bot', 'run-4', { dataDir: root, staleMs: 240_000, now })).toBe('lost');
  });

  it('keeps default bot behavior unchanged', () => {
    const now = 1_000_000;
    const { root, runDir } = createRunDir('default', 'run-5');
    writeFileSync(join(runDir, 'status'), 'running\n');
    writeFileSync(join(runDir, 'heartbeat'), String(Math.floor((now - 5_000) / 1000)));

    expect(judgeRunState('default', 'run-5', { dataDir: root, staleMs: 240_000, now })).toBe('resumed');
  });

  it('returns lost for defensive path traversal botId without crashing', () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-judge-run-state-traversal-'));
    roots.push(root);

    expect(judgeRunState('../../etc/passwd', 'run-6', { dataDir: root, staleMs: 240_000, now: 1_000_000 })).toBe('lost');
  });

  it('uses events.ndjson mtime as L2 heartbeat fallback', () => {
    const now = 2_000_000;
    const { root, runDir } = createRunDir('custom_bot', 'run-7');
    writeFileSync(join(runDir, 'status'), 'running\n');
    const ndjsonPath = join(runDir, 'events.ndjson');
    writeFileSync(ndjsonPath, '{"type":"text"}\n');
    const mtime = new Date(now - 5_000);
    utimesSync(ndjsonPath, mtime, mtime);

    expect(judgeRunState('custom_bot', 'run-7', { dataDir: root, staleMs: 240_000, now })).toBe('resumed');
  });
});
