import { PassThrough } from 'node:stream';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProgressCollector } from '../../packages/core/src/run-observability/progress-collector.js';
import { ProgressStore } from '../../packages/core/src/run-observability/progress-store.js';

const roots: string[] = [];

function makeStore(): ProgressStore {
  const dir = mkdtempSync(join(tmpdir(), 'wb-progress-store-'));
  roots.push(dir);
  return new ProgressStore({ dataDir: dir, botId: 'default', runId: 'run-001', sessionId: 'sid-001' });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('T1 stdout capture', () => {
  it('captures stdout and stderr lines into progress.ndjson', () => {
    const store = makeStore();
    const collector = new ProgressCollector(store, () => '2026-06-10T00:00:00.000Z');
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const detach = collector.attach({ stdout, stderr });
    stdout.write('step1\n');
    stderr.write('warn1\n');
    detach();
    const lines = readFileSync(store.progressPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { source: string; text: string });
    expect(lines).toHaveLength(2);
    expect(lines[0]?.source).toBe('stdout');
    expect(lines[0]?.text).toBe('step1');
    expect(lines[1]?.source).toBe('stderr');
    expect(lines[1]?.text).toBe('warn1');
  });

  it('truncates single overlong line to 64KB and marks truncated', () => {
    const store = makeStore();
    const collector = new ProgressCollector(store, () => '2026-06-10T00:00:00.000Z');
    const longLine = 'x'.repeat(70_000);
    collector.push('stdout', `${longLine}\n`);
    const line = JSON.parse(readFileSync(store.progressPath, 'utf8').trim()) as { truncated: boolean; text: string };
    expect(line.truncated).toBe(true);
    expect(line.text.length).toBe(65_536);
  });

  it('flushes trailing buffered line without newline', () => {
    const store = makeStore();
    const collector = new ProgressCollector(store, () => '2026-06-10T00:00:00.000Z');
    collector.push('stdout', 'tail-without-newline');
    collector.flush();
    const line = JSON.parse(readFileSync(store.progressPath, 'utf8').trim()) as { text: string };
    expect(line.text).toBe('tail-without-newline');
  });
});
