export const QUEUE_METRIC_NAMES = [
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
] as const;

export type QueueMetricName = typeof QUEUE_METRIC_NAMES[number];
export type QueueMetricType = 'counter' | 'gauge' | 'histogram';

export const QUEUE_METRIC_TYPES: Record<QueueMetricName, QueueMetricType> = {
  captain_queue_decisions_total: 'counter',
  captain_queue_rejections_total: 'counter',
  captain_queue_enqueue_position: 'histogram',
  captain_queue_depth: 'gauge',
  captain_queue_running_total: 'gauge',
  captain_queue_wait_duration_seconds: 'histogram',
  captain_queue_promotions_total: 'counter',
  captain_run_ended_total: 'counter',
  captain_queue_commands_total: 'counter',
  captain_queue_cancelled_runs_total: 'counter',
  captain_queue_preempted_runs_total: 'counter',
  captain_queue_promoted_by_preempt_total: 'counter',
  captain_queue_promotion_failures_total: 'counter',
  captain_queue_entries_appended_total: 'counter',
  captain_queue_store_read_errors_total: 'counter',
  captain_queue_config_max_concurrent_runs: 'gauge',
  captain_queue_config_max_depth: 'gauge',
};

export const QUEUE_HISTOGRAM_BUCKETS = {
  captain_queue_enqueue_position: [1, 2, 3, 5, 8, 13],
  captain_queue_wait_duration_seconds: [1, 5, 10, 30, 60, 120, 300],
} as const;

export type QueueMetricLabels = {
  session_id?: string;
  bot_id?: string;
  agent?: string;
  decision?: string;
  reason?: string;
  command?: string;
  state?: string;
  trigger_reason?: string;
};

export type QueueMetricEvent = {
  metric: QueueMetricName;
  labels?: QueueMetricLabels;
  value: number;
};

export type HistogramSnapshot = {
  count: number;
  sum: number;
  p50: number;
  p95: number;
  buckets: Record<string, number>;
};

export type MetricsSnapshot = {
  counters: Partial<Record<QueueMetricName, number>>;
  gauges: Partial<Record<QueueMetricName, number>>;
  histograms: Partial<Record<QueueMetricName, HistogramSnapshot>>;
};
