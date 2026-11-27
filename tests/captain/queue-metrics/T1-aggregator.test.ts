import { describe, expect, it } from 'vitest';
import {
  QUEUE_METRIC_NAMES,
  QUEUE_METRIC_TYPES,
} from '../../../packages/core/src/captain/queue-metrics/contracts.js';
import { createQueueMetricsAggregator } from '../../../packages/core/src/captain/queue-metrics/aggregator.js';

describe('T1-aggregator', () => {
  it('T1-shape: exports all 17 first-batch metric names', () => {
    expect(QUEUE_METRIC_NAMES).toEqual([
      'captain_queue_decisions_total',
      'captain_queue_rejections_total',
      'captain_queue_enqueue_position',
      'captain_queue_depth',
      'captain_queue_running_total',
      'captain_queue_wait_duration_seconds',
      'captain_queue_promotions_total',
      'captain_run_ended_total',
      'captain_queue_commands_total',
      'captain_queue_cancelled_runs_total',
      'captain_queue_preempted_runs_total',
      'captain_queue_promoted_by_preempt_total',
      'captain_queue_promotion_failures_total',
      'captain_queue_entries_appended_total',
      'captain_queue_store_read_errors_total',
      'captain_queue_config_max_concurrent_runs',
      'captain_queue_config_max_depth',
    ]);
    expect(QUEUE_METRIC_TYPES.captain_queue_wait_duration_seconds).toBe('histogram');
  });

  it('T2-counter-aggregate: accumulates counters inside one session', () => {
    const aggregator = createQueueMetricsAggregator();
    aggregator.record({ metric: 'captain_queue_decisions_total', value: 1, labels: { session_id: 's1', decision: 'spawn' } });
    aggregator.record({ metric: 'captain_queue_decisions_total', value: 2, labels: { session_id: 's1', decision: 'queued' } });

    const session = aggregator.snapshot({ session_id: 's1' });
    const global = aggregator.snapshot();
    expect(session.counters.captain_queue_decisions_total).toBe(3);
    expect(global.counters.captain_queue_decisions_total).toBe(3);
  });

  it('T3-histogram-percentile: computes p50 and p95 from fixed inputs', () => {
    const aggregator = createQueueMetricsAggregator();
    for (const value of [1, 5, 10, 30, 60]) {
      aggregator.record({ metric: 'captain_queue_wait_duration_seconds', value, labels: { session_id: 's1' } });
    }

    const snapshot = aggregator.snapshot({ session_id: 's1' });
    expect(snapshot.histograms.captain_queue_wait_duration_seconds?.p50).toBe(10);
    expect(snapshot.histograms.captain_queue_wait_duration_seconds?.p95).toBe(60);
  });

  it('T4-session-isolation: sessions stay isolated and global rollup sums them', () => {
    const aggregator = createQueueMetricsAggregator();
    aggregator.record({ metric: 'captain_queue_rejections_total', value: 1, labels: { session_id: 'A' } });
    aggregator.record({ metric: 'captain_queue_rejections_total', value: 2, labels: { session_id: 'B' } });
    aggregator.record({ metric: 'captain_queue_depth', value: 3, labels: { session_id: 'A' } });
    aggregator.record({ metric: 'captain_queue_depth', value: 4, labels: { session_id: 'B' } });

    const a = aggregator.snapshot({ session_id: 'A' });
    const b = aggregator.snapshot({ session_id: 'B' });
    const global = aggregator.snapshot();

    expect(a.counters.captain_queue_rejections_total).toBe(1);
    expect(b.counters.captain_queue_rejections_total).toBe(2);
    expect(global.counters.captain_queue_rejections_total).toBe(3);
    expect(a.gauges.captain_queue_depth).toBe(3);
    expect(b.gauges.captain_queue_depth).toBe(4);
    expect(global.gauges.captain_queue_depth).toBe(4);
  });
});
