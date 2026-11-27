import { describe, expect, it } from 'vitest';
import { createQueueMetricsAggregator } from '../../../packages/core/src/captain/queue-metrics/aggregator.js';
import { enqueueOrSpawn } from '../../../packages/core/src/captain/enqueue-or-spawn.js';
import { createConcurrencyQueueIndex } from '../../../packages/core/src/captain/concurrency-queue-index.js';

describe('T2-core-metrics', () => {
  it('T5-decisions: spawn/queued/rejected all record decision counters', async () => {
    const metrics = createQueueMetricsAggregator();
    const index = createConcurrencyQueueIndex(metrics);
    const store = { append() {} };

    await enqueueOrSpawn({
      config: { max_concurrent_runs: 1, queue_max_depth: 1 },
      index,
      store,
      metrics,
      now: () => '2026-06-11T00:00:00.000Z',
      genRunId: () => 'run-1',
    }, { session_id: 's1' });

    index.markRunning('s1', 'run-active', '2026-06-11T00:00:01.000Z');
    await enqueueOrSpawn({
      config: { max_concurrent_runs: 1, queue_max_depth: 2 },
      index,
      store,
      metrics,
      now: () => '2026-06-11T00:00:02.000Z',
      genRunId: () => 'run-2',
    }, { session_id: 's1' });

    index.enqueue('s1', 'run-prequeued', '2026-06-11T00:00:03.000Z');
    await enqueueOrSpawn({
      config: { max_concurrent_runs: 1, queue_max_depth: 1 },
      index,
      store,
      metrics,
      now: () => '2026-06-11T00:00:04.000Z',
      genRunId: () => 'run-3',
    }, { session_id: 's1' });

    const snapshot = metrics.snapshot({ session_id: 's1' });
    expect(snapshot.counters.captain_queue_decisions_total).toBe(6);
    expect(snapshot.counters.captain_queue_rejections_total).toBe(1);
  });

  it('T6-position-histogram: queued positions 1/2/3 are recorded', async () => {
    const metrics = createQueueMetricsAggregator();
    const index = createConcurrencyQueueIndex(metrics);
    const store = { append() {} };
    index.markRunning('s1', 'run-active', '2026-06-11T00:00:00.000Z');

    await enqueueOrSpawn({ config: { max_concurrent_runs: 1, queue_max_depth: 5 }, index, store, metrics, now: () => '2026-06-11T00:00:01.000Z', genRunId: () => 'run-1' }, { session_id: 's1' });
    await enqueueOrSpawn({ config: { max_concurrent_runs: 1, queue_max_depth: 5 }, index, store, metrics, now: () => '2026-06-11T00:00:02.000Z', genRunId: () => 'run-2' }, { session_id: 's1' });
    await enqueueOrSpawn({ config: { max_concurrent_runs: 1, queue_max_depth: 5 }, index, store, metrics, now: () => '2026-06-11T00:00:03.000Z', genRunId: () => 'run-3' }, { session_id: 's1' });

    const histogram = metrics.snapshot({ session_id: 's1' }).histograms.captain_queue_enqueue_position!;
    expect(histogram.count).toBe(3);
    expect(histogram.buckets['1']).toBe(1);
    expect(histogram.buckets['2']).toBe(2);
    expect(histogram.buckets['3']).toBe(3);
  });

  it('T7-wait-duration: enqueue to promote records wait duration histogram', () => {
    const metrics = createQueueMetricsAggregator();
    const index = createConcurrencyQueueIndex(metrics);
    index.enqueue('s1', 'run-queued', '2026-06-11T00:00:00.000Z');
    metrics.record({ metric: 'captain_queue_wait_duration_seconds', value: 1, labels: { session_id: 's1' } });
    metrics.record({ metric: 'captain_queue_promotions_total', value: 1, labels: { session_id: 's1', trigger_reason: 'succeeded' } });

    const histogram = metrics.snapshot({ session_id: 's1' }).histograms.captain_queue_wait_duration_seconds!;
    expect(histogram.count).toBe(1);
    expect(histogram.p50).toBe(1);
    expect(histogram.p95).toBe(1);
    expect(metrics.snapshot({ session_id: 's1' }).counters.captain_queue_promotions_total).toBe(1);
  });

  it('T8-gauge-sync: depth and running gauges stay in sync with index state', () => {
    const metrics = createQueueMetricsAggregator();
    const index = createConcurrencyQueueIndex(metrics);
    index.enqueue('s1', 'run-1', '2026-06-11T00:00:00.000Z');
    index.enqueue('s1', 'run-2', '2026-06-11T00:00:01.000Z');
    index.markRunning('s1', 'run-1', '2026-06-11T00:00:02.000Z');
    index.markEnded('s1', 'run-1', '2026-06-11T00:00:03.000Z');

    const snapshot = metrics.snapshot({ session_id: 's1' });
    expect(snapshot.gauges.captain_queue_depth).toBe(1);
    expect(snapshot.gauges.captain_queue_running_total).toBe(0);
  });
});
