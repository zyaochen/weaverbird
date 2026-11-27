import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TaskIndex } from '../../apps/wb-bot/src/binding/task-index.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createRun(dataDir: string, runId: string, agentId: string, status: string): void {
  const runDir = join(dataDir, 'runs', 'default', runId);
  mkdirSync(runDir, { recursive: true });
  const spec = {
    runId,
    botId: 'default',
    agentId,
    cwd: '/tmp/test',
    userOpenId: 'u1',
    threadId: 't1',
    startedAt: new Date().toISOString(),
    schemaVersion: 1,
  };
  writeFileSync(join(runDir, 'spec.json'), JSON.stringify(spec));
  writeFileSync(join(runDir, 'status'), status);
}

describe('A8 task history index', () => {
  it('scans runs/ directory and indexes spec.json + status', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-task-idx-'));
    roots.push(dir);

    createRun(dir, 'run-1', 'claude-code', 'done');
    createRun(dir, 'run-2', 'codex', 'error');
    createRun(dir, 'run-3', 'claude-code', 'running');

    const index = new TaskIndex(dir);
    index.scan();

    expect(index.size).toBe(3);
    expect(index.get('run-1')?.agentId).toBe('claude-code');
    expect(index.get('run-1')?.status).toBe('done');
    expect(index.get('run-2')?.status).toBe('error');
    expect(index.get('run-3')?.status).toBe('running');
  });

  it('respects LRU 700 entries limit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-task-idx-'));
    roots.push(dir);

    for (let i = 0; i < 750; i++) {
      createRun(dir, `run-${i}`, 'claude-code', 'done');
    }

    const index = new TaskIndex(dir);
    index.scan();

    expect(index.size).toBe(700);
  });

  it('lists entries sorted by lastModified descending', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-task-idx-'));
    roots.push(dir);

    createRun(dir, 'run-old', 'claude-code', 'done');
    createRun(dir, 'run-new', 'codex', 'done');

    const index = new TaskIndex(dir);
    index.scan();

    const list = index.list();
    expect(list.length).toBe(2);
    expect(list[0]?.lastModified).toBeGreaterThanOrEqual(list[1]?.lastModified ?? 0);
  });

  it('scheduleScan uses setImmediate (lazy, non-blocking)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-task-idx-'));
    roots.push(dir);

    createRun(dir, 'run-1', 'claude-code', 'done');

    const index = new TaskIndex(dir);
    index.scheduleScan();

    expect(index.size).toBe(0);

    await new Promise((r) => setTimeout(r, 50));
    expect(index.size).toBe(1);
  });

  it('skips runs older than 7 days', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-task-idx-'));
    roots.push(dir);

    const runDir = join(dir, 'runs', 'default', 'run-ancient');
    mkdirSync(runDir, { recursive: true });
    const spec = {
      runId: 'run-ancient',
      botId: 'default',
      agentId: 'claude-code',
      cwd: '/tmp/test',
      userOpenId: 'u1',
      threadId: 't1',
      startedAt: '2020-01-01T00:00:00Z',
      schemaVersion: 1,
    };
    writeFileSync(join(runDir, 'spec.json'), JSON.stringify(spec));
    writeFileSync(join(runDir, 'status'), 'done');

    const { utimesSync } = require('node:fs');
    const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    utimesSync(runDir, oldDate, oldDate);

    const index = new TaskIndex(dir);
    index.scan();

    expect(index.size).toBe(0);
  });

  it('handles missing spec.json gracefully', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-task-idx-'));
    roots.push(dir);

    const runDir = join(dir, 'runs', 'default', 'run-nospec');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'status'), 'done');

    const index = new TaskIndex(dir);
    index.scan();

    expect(index.size).toBe(0);
  });
});
