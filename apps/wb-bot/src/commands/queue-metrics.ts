import type { MetricsSnapshot } from '../../../../packages/core/src/captain/queue-metrics/contracts.js';

function metricValue(value: number | undefined): string {
  return Number.isFinite(value) ? String(value) : '0';
}

export function renderQueueMetrics(snapshot: MetricsSnapshot): string {
  const running = snapshot.gauges.captain_queue_running_total;
  const queued = snapshot.gauges.captain_queue_depth;
  const decisionsTotal = snapshot.counters.captain_queue_decisions_total;
  const promotedTotal = snapshot.counters.captain_queue_promotions_total;
  const preemptedTotal = snapshot.counters.captain_queue_preempted_runs_total;
  const cancelledTotal = snapshot.counters.captain_queue_cancelled_runs_total;
  const waitP50 = snapshot.histograms.captain_queue_wait_duration_seconds?.p50;
  const waitP95 = snapshot.histograms.captain_queue_wait_duration_seconds?.p95;

  return [
    'Queue Metrics (session)',
    `- running: ${metricValue(running)}`,
    `- queued: ${metricValue(queued)}`,
    `- decisions_total: ${metricValue(decisionsTotal)}`,
    `- promoted_total: ${metricValue(promotedTotal)}`,
    `- preempted_total: ${metricValue(preemptedTotal)}`,
    `- cancelled_total: ${metricValue(cancelledTotal)}`,
    `- wait_p50_s: ${metricValue(waitP50)}`,
    `- wait_p95_s: ${metricValue(waitP95)}`,
  ].join('\n');
}
