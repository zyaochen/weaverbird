import {
  QUEUE_HISTOGRAM_BUCKETS,
  QUEUE_METRIC_NAMES,
  QUEUE_METRIC_TYPES,
  type HistogramSnapshot,
  type MetricsSnapshot,
  type QueueMetricEvent,
  type QueueMetricName,
} from './contracts.js';
import type { QueueMetricsEventStore } from './event-store.js';

type HistogramState = {
  values: number[];
};

type SessionState = {
  counters: Partial<Record<QueueMetricName, number>>;
  gauges: Partial<Record<QueueMetricName, number>>;
  histograms: Partial<Record<QueueMetricName, HistogramState>>;
};

function emptyState(): SessionState {
  return { counters: {}, gauges: {}, histograms: {} };
}

function ensureState(map: Map<string, SessionState>, sessionId: string): SessionState {
  const existing = map.get(sessionId);
  if (existing) return existing;
  const created = emptyState();
  map.set(sessionId, created);
  return created;
}

function observeHistogram(state: SessionState, metric: QueueMetricName, value: number): void {
  const existing = state.histograms[metric] ?? { values: [] };
  existing.values.push(value);
  state.histograms[metric] = existing;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[index] ?? 0;
}

function histogramSnapshot(metric: QueueMetricName, values: number[]): HistogramSnapshot {
  const buckets = QUEUE_HISTOGRAM_BUCKETS[metric as keyof typeof QUEUE_HISTOGRAM_BUCKETS] ?? [];
  const bucketCounts: Record<string, number> = {};
  for (const bucket of buckets) {
    bucketCounts[String(bucket)] = values.filter((value) => value <= bucket).length;
  }
  return {
    count: values.length,
    sum: values.reduce((total, value) => total + value, 0),
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    buckets: bucketCounts,
  };
}

function snapshotState(state: SessionState): MetricsSnapshot {
  const histograms: Partial<Record<QueueMetricName, HistogramSnapshot>> = {};
  for (const [metric, histogram] of Object.entries(state.histograms) as Array<[QueueMetricName, HistogramState]>) {
    histograms[metric] = histogramSnapshot(metric, histogram.values);
  }
  return {
    counters: { ...state.counters },
    gauges: { ...state.gauges },
    histograms,
  };
}

export type QueueMetricsAggregator = {
  record(event: QueueMetricEvent): void;
  snapshot(opts?: { session_id?: string }): MetricsSnapshot;
};

export type CreateQueueMetricsAggregatorOptions = {
  eventStore?: Pick<QueueMetricsEventStore, 'append'>;
};

export function createQueueMetricsAggregator(options: CreateQueueMetricsAggregatorOptions = {}): QueueMetricsAggregator {
  const globalState = emptyState();
  const sessionStates = new Map<string, SessionState>();

  function apply(state: SessionState, event: QueueMetricEvent): void {
    const type = QUEUE_METRIC_TYPES[event.metric];
    if (type === 'counter') {
      state.counters[event.metric] = (state.counters[event.metric] ?? 0) + event.value;
      return;
    }
    if (type === 'gauge') {
      state.gauges[event.metric] = event.value;
      return;
    }
    observeHistogram(state, event.metric, event.value);
  }

  function recordInternal(event: QueueMetricEvent): void {
    apply(globalState, event);
    if (event.labels?.session_id) {
      apply(ensureState(sessionStates, event.labels.session_id), event);
    }
  }

  function recordStoreError(sessionId?: string): void {
    const errorEvent: QueueMetricEvent = {
      metric: 'captain_queue_store_read_errors_total',
      value: 1,
      ...(sessionId ? { labels: { session_id: sessionId } } : {}),
    };
    recordInternal(errorEvent);
  }

  return {
    record(event: QueueMetricEvent): void {
      if (!QUEUE_METRIC_NAMES.includes(event.metric)) return;
      recordInternal(event);
      try {
        options.eventStore?.append(event);
      } catch {
        recordStoreError(event.labels?.session_id);
      }
    },
    snapshot(opts?: { session_id?: string }): MetricsSnapshot {
      if (opts?.session_id) {
        return snapshotState(sessionStates.get(opts.session_id) ?? emptyState());
      }
      return snapshotState(globalState);
    },
  };
}
