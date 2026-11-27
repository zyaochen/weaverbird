import * as fs from 'node:fs';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProgressStore, RUN_OBSERVABILITY_ERROR_CODES } from '../../packages/core/src/run-observability/progress-store.js';

const roots: string[] = [];

function makeStore(maxBytes = 200, fsImpl?: ConstructorParameters<typeof ProgressStore>[0]['fsImpl']): ProgressStore {
  const dir = mkdtempSync(join(tmpdir(), 'wb-progress-store-'));
  roots.push(dir);
  return new ProgressStore({ dataDir: dir, botId: 'default', runId: 'run-001', sessionId: 'sid-001', maxBytes, fsImpl });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('T2 store truncation', () => {
  it('marks store_truncated and stops writing progress rows after hitting max bytes', () => {
    const store = makeStore(260);
    const first = store.append({ lineIndex: 0, source: 'stdout', text: 'a'.repeat(80), ts: '2026-06-10T00:00:00.000Z' });
    const second = store.append({ lineIndex: 1, source: 'stdout', text: 'b'.repeat(120), ts: '2026-06-10T00:00:01.000Z' });
    expect(first.wroteLine).toBe(true);
    expect(second.wroteLine).toBe(false);
    expect(second.storeTruncated).toBe(true);
    const meta = JSON.parse(readFileSync(store.metaPath, 'utf8')) as { store_truncated: boolean };
    expect(meta.store_truncated).toBe(true);
    const progressLines = readFileSync(store.progressPath, 'utf8').trim().split('\n');
    expect(progressLines).toHaveLength(1);
  });

  it('retries write once and succeeds on second appendFileSync call', () => {
    const appendFileSync = vi.fn()
      .mockImplementationOnce(() => { throw new Error('disk busy'); })
      .mockImplementationOnce((path: fs.PathOrFileDescriptor, data: string) => fs.writeFileSync(path, data, { flag: 'a' }));
    const store = makeStore(200, { ...fs, appendFileSync });
    const result = store.append({ lineIndex: 0, source: 'stdout', text: 'retry-line', ts: '2026-06-10T00:00:00.000Z' });
    expect(result.ok).toBe(true);
    expect(appendFileSync).toHaveBeenCalledTimes(2);
  });

  it('fails after two append attempts and exposes store write error code', () => {
    const appendFileSync = vi.fn(() => {
      throw new Error('disk full');
    });
    const store = makeStore(200, { ...fs, appendFileSync });
    const result = store.append({ lineIndex: 0, source: 'stdout', text: 'drop-line', ts: '2026-06-10T00:00:00.000Z' });
    expect(result.ok).toBe(false);
    expect(result.wroteLine).toBe(false);
    expect(RUN_OBSERVABILITY_ERROR_CODES.E_STORE_WRITE).toBe('run-observability.store.write_failed');
  });
});
