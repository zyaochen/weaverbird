import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCaptainConcurrencyContainer } from '../../packages/core/src/captain/index.js';
import { ConcurrencyQueueEntryStatus, createConcurrencyQueueStore } from '../../packages/core/src/captain/concurrency-queue-store.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('T2-queue-store', () => {
  it('starts empty when captain/queue.ndjson does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-captain-queue-'));
    roots.push(dir);
    const store = createConcurrencyQueueStore(dir);

    expect(store.readAll()).toEqual([]);
  });

  it('appends and reads back queue entries from captain/queue.ndjson', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-captain-queue-'));
    roots.push(dir);
    const store = createConcurrencyQueueStore(dir);

    store.append({ session_id: 's1', run_id: 'run-1', status: ConcurrencyQueueEntryStatus.QUEUED, ts: '2026-06-10T00:00:00.000Z' });
    store.append({ session_id: 's1', run_id: 'run-1', status: ConcurrencyQueueEntryStatus.RUNNING, ts: '2026-06-10T00:00:01.000Z' });

    expect(store.readAll()).toEqual([
      { session_id: 's1', run_id: 'run-1', status: 'queued', ts: '2026-06-10T00:00:00.000Z' },
      { session_id: 's1', run_id: 'run-1', status: 'running', ts: '2026-06-10T00:00:01.000Z' },
    ]);
  });

  it('reads active plus .1 shard oldest-first', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-captain-queue-'));
    roots.push(dir);
    const store = createConcurrencyQueueStore(dir);
    writeFileSync(`${store.path}.1`, '{"session_id":"s1","run_id":"run-1","status":"queued","ts":"2026-06-10T00:00:00.000Z"}\n', 'utf8');
    writeFileSync(store.path, '{"session_id":"s1","run_id":"run-1","status":"running","ts":"2026-06-10T00:00:01.000Z"}\n', 'utf8');

    expect(store.readAll()).toEqual([
      { session_id: 's1', run_id: 'run-1', status: 'queued', ts: '2026-06-10T00:00:00.000Z' },
      { session_id: 's1', run_id: 'run-1', status: 'running', ts: '2026-06-10T00:00:01.000Z' },
    ]);
  });

  it('reads .2 -> .1 -> active and skips empty or missing shards', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-captain-queue-'));
    roots.push(dir);
    const store = createConcurrencyQueueStore(dir);
    writeFileSync(`${store.path}.2`, '{"session_id":"s1","run_id":"run-1","status":"queued","ts":"2026-06-10T00:00:00.000Z"}\n', 'utf8');
    writeFileSync(`${store.path}.1`, '', 'utf8');
    writeFileSync(store.path, '{"session_id":"s1","run_id":"run-1","status":"ended","ts":"2026-06-10T00:00:02.000Z"}\n', 'utf8');

    expect(store.readAll()).toEqual([
      { session_id: 's1', run_id: 'run-1', status: 'queued', ts: '2026-06-10T00:00:00.000Z' },
      { session_id: 's1', run_id: 'run-1', status: 'ended', ts: '2026-06-10T00:00:02.000Z' },
    ]);
  });

  it('skips malformed lines, increments read error metric once per bad line, and still returns good entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-captain-queue-'));
    roots.push(dir);
    const container = createCaptainConcurrencyContainer(dir);
    const store = container.store;
    writeFileSync(`${store.path}.2`, '{bad-json}\n', 'utf8');
    writeFileSync(`${store.path}.1`, '{also-bad}\n', 'utf8');
    writeFileSync(store.path, '{"session_id":"s1","run_id":"run-1","status":"queued","ts":"2026-06-10T00:00:00.000Z"}\n', 'utf8');

    expect(store.readAll()).toEqual([
      { session_id: 's1', run_id: 'run-1', status: 'queued', ts: '2026-06-10T00:00:00.000Z' },
    ]);
    expect(container.metrics.snapshot().counters.captain_queue_store_read_errors_total).toBe(2);
  });

  it('rotates queue.ndjson on append and keeps readAll oldest-first across shards', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-captain-queue-'));
    roots.push(dir);
    const store = createConcurrencyQueueStore(dir);
    mkdirSync(join(dir, 'captain'), { recursive: true });
    writeFileSync(store.path, 'x'.repeat(8 * 1024 * 1024), 'utf8');

    store.append({ session_id: 's1', run_id: 'run-1', status: ConcurrencyQueueEntryStatus.QUEUED, ts: '2026-06-10T00:00:00.000Z' });

    expect(readFileSync(`${store.path}.1`, 'utf8')).toHaveLength(8 * 1024 * 1024);
    expect(store.readAll()).toEqual([
      { session_id: 's1', run_id: 'run-1', status: 'queued', ts: '2026-06-10T00:00:00.000Z' },
    ]);
  });
});
