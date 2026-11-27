import { describe, expect, it } from 'vitest';
import { createConcurrencyQueueIndex } from '../../packages/core/src/captain/concurrency-queue-index.js';
import { ConcurrencyQueueEntryStatus } from '../../packages/core/src/captain/concurrency-queue-store.js';

describe('T3-queue-index', () => {
  it('keeps per-session FIFO queues and running sets', () => {
    const index = createConcurrencyQueueIndex();

    index.enqueue('s1', 'run-1', '2026-06-10T00:00:00.000Z');
    index.enqueue('s1', 'run-2', '2026-06-10T00:00:01.000Z');
    index.markRunning('s1', 'run-1', '2026-06-10T00:00:02.000Z');

    expect(index.listQueued('s1')).toEqual(['run-2']);
    expect(index.listRunning('s1')).toEqual(['run-1']);
    expect(index.countQueued('s1')).toBe(1);
    expect(index.countRunning('s1')).toBe(1);
  });

  it('markEnded removes a run from queued and running state', () => {
    const index = createConcurrencyQueueIndex();

    index.enqueue('s1', 'run-1', '2026-06-10T00:00:00.000Z');
    index.markRunning('s1', 'run-1', '2026-06-10T00:00:01.000Z');
    index.markEnded('s1', 'run-1', '2026-06-10T00:00:02.000Z');

    expect(index.listQueued('s1')).toEqual([]);
    expect(index.listRunning('s1')).toEqual([]);
    expect(index.countQueued()).toBe(0);
    expect(index.countRunning()).toBe(0);
  });

  it('replays append-only queue history into queued and running views', () => {
    const index = createConcurrencyQueueIndex();

    index.replay([
      { session_id: 's1', run_id: 'run-1', status: ConcurrencyQueueEntryStatus.QUEUED, ts: '2026-06-10T00:00:00.000Z' },
      { session_id: 's1', run_id: 'run-2', status: ConcurrencyQueueEntryStatus.QUEUED, ts: '2026-06-10T00:00:01.000Z' },
      { session_id: 's1', run_id: 'run-1', status: ConcurrencyQueueEntryStatus.RUNNING, ts: '2026-06-10T00:00:02.000Z' },
      { session_id: 's2', run_id: 'run-3', status: ConcurrencyQueueEntryStatus.QUEUED, ts: '2026-06-10T00:00:03.000Z' },
      { session_id: 's1', run_id: 'run-1', status: ConcurrencyQueueEntryStatus.ENDED, ts: '2026-06-10T00:00:04.000Z' },
    ]);

    expect(index.listQueued('s1')).toEqual(['run-2']);
    expect(index.listRunning('s1')).toEqual([]);
    expect(index.listQueued('s2')).toEqual(['run-3']);
    expect(index.countQueued()).toBe(2);
    expect(index.countRunning()).toBe(0);
  });
});
