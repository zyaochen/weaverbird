import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCaptainConcurrencyContainer } from '../../../packages/core/src/captain/index.js';
import { createQueueMetricsAggregator } from '../../../packages/core/src/captain/queue-metrics/aggregator.js';
import { createQueueMetricsEventStore } from '../../../packages/core/src/captain/queue-metrics/event-store.js';

const roots: string[] = [];

function readNdjson(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('T3-event-store', () => {
  it('T13-append: 3 events append to captain/queue-metrics.ndjson in order', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-queue-metrics-'));
    roots.push(dir);
    const store = createQueueMetricsEventStore(dir);
    const aggregator = createQueueMetricsAggregator({ eventStore: store });

    aggregator.record({ metric: 'captain_queue_decisions_total', value: 1, labels: { session_id: 's1' } });
    aggregator.record({ metric: 'captain_queue_depth', value: 2, labels: { session_id: 's1' } });
    aggregator.record({ metric: 'captain_queue_commands_total', value: 3, labels: { session_id: 's1', command: '/queue' } });

    expect(readNdjson(store.path)).toEqual([
      {
        ts: expect.any(String),
        metric: 'captain_queue_decisions_total',
        type: 'counter',
        value: 1,
        labels: { session_id: 's1' },
      },
      {
        ts: expect.any(String),
        metric: 'captain_queue_depth',
        type: 'gauge',
        value: 2,
        labels: { session_id: 's1' },
      },
      {
        ts: expect.any(String),
        metric: 'captain_queue_commands_total',
        type: 'counter',
        value: 3,
        labels: { session_id: 's1', command: '/queue' },
      },
    ]);
  });

  it('T14-payload: persisted payload keeps contract fields and strips run/message ids', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-queue-metrics-'));
    roots.push(dir);
    const store = createQueueMetricsEventStore(dir);
    const aggregator = createQueueMetricsAggregator({ eventStore: store });

    aggregator.record({
      metric: 'captain_queue_commands_total',
      value: 1,
      labels: {
        session_id: 's1',
        command: '/queue',
        run_id: 'run-1',
        message_id: 'msg-1',
      } as any,
    });

    const record = readNdjson(store.path)[0]!;
    expect(record).toEqual({
      ts: expect.any(String),
      metric: 'captain_queue_commands_total',
      type: 'counter',
      value: 1,
      labels: {
        session_id: 's1',
        command: '/queue',
      },
    });
    expect(record['run_id']).toBeUndefined();
    expect(record['message_id']).toBeUndefined();
    expect((record['labels'] as Record<string, unknown>)['run_id']).toBeUndefined();
    expect((record['labels'] as Record<string, unknown>)['message_id']).toBeUndefined();
  });

  it('T15-write-failure: store write failure stays silent and increments error counter', () => {
    const aggregator = createQueueMetricsAggregator({
      eventStore: {
        append() {
          throw new Error('disk full');
        },
      },
    });

    expect(() => {
      aggregator.record({ metric: 'captain_queue_decisions_total', value: 1, labels: { session_id: 's1' } });
    }).not.toThrow();

    const session = aggregator.snapshot({ session_id: 's1' });
    const global = aggregator.snapshot();
    expect(session.counters.captain_queue_decisions_total).toBe(1);
    expect(global.counters.captain_queue_decisions_total).toBe(1);
    expect(session.counters.captain_queue_store_read_errors_total).toBe(1);
    expect(global.counters.captain_queue_store_read_errors_total).toBe(1);
  });

  it('T16-no-replay: new aggregator/container keeps file but does not restore in-memory state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-queue-metrics-'));
    roots.push(dir);

    const container1 = createCaptainConcurrencyContainer(dir);
    container1.metrics.record({ metric: 'captain_queue_decisions_total', value: 1, labels: { session_id: 's1' } });

    const path = join(dir, 'captain', 'queue-metrics.ndjson');
    expect(readNdjson(path)).toHaveLength(1);

    const container2 = createCaptainConcurrencyContainer(dir);
    expect(container2.metrics.snapshot({ session_id: 's1' }).counters.captain_queue_decisions_total).toBeUndefined();

    container2.metrics.record({ metric: 'captain_queue_commands_total', value: 1, labels: { session_id: 's1', command: '/queue' } });

    expect(readNdjson(path)).toEqual([
      {
        ts: expect.any(String),
        metric: 'captain_queue_decisions_total',
        type: 'counter',
        value: 1,
        labels: { session_id: 's1' },
      },
      {
        ts: expect.any(String),
        metric: 'captain_queue_commands_total',
        type: 'counter',
        value: 1,
        labels: { session_id: 's1', command: '/queue' },
      },
    ]);
  });

  it('T17-rotation: queue metrics event store rotates at 8 MiB and keeps oldest-first segments', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-queue-metrics-'));
    roots.push(dir);
    const store = createQueueMetricsEventStore(dir);
    const rotated = `${store.path}.1`;
    mkdirSync(join(dir, 'captain'), { recursive: true });
    writeFileSync(store.path, 'x'.repeat(8 * 1024 * 1024), 'utf8');

    store.append({ metric: 'captain_queue_decisions_total', value: 1, labels: { session_id: 's1' } });

    expect(readFileSync(rotated, 'utf8')).toHaveLength(8 * 1024 * 1024);
    expect(readNdjson(store.path)).toEqual([
      {
        ts: expect.any(String),
        metric: 'captain_queue_decisions_total',
        type: 'counter',
        value: 1,
        labels: { session_id: 's1' },
      },
    ]);
  });
});
