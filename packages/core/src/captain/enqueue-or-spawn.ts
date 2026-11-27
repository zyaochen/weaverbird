import type { ConcurrencyConfig } from './concurrency-config.js';
import type { ConcurrencyQueueIndex } from './concurrency-queue-index.js';
import {
  ConcurrencyQueueEntryStatus,
  type ConcurrencyQueueStore,
} from './concurrency-queue-store.js';
import type { QueueMetricsAggregator } from './queue-metrics/aggregator.js';

export type EnqueueDecision =
  | { kind: 'spawn'; run_id: string }
  | { kind: 'queued'; run_id: string; position: number }
  | { kind: 'rejected'; reason: 'queue_full' };

export async function enqueueOrSpawn(
  deps: {
    config: ConcurrencyConfig;
    index: ConcurrencyQueueIndex;
    store: Pick<ConcurrencyQueueStore, 'append'>;
    now: () => string;
    genRunId: () => string;
    metrics?: QueueMetricsAggregator;
  },
  input: { session_id: string },
): Promise<EnqueueDecision> {
  const runId = deps.genRunId();
  const ts = deps.now();
  const runningCount = deps.index.countRunning(input.session_id);

  deps.metrics?.record({
    metric: 'captain_queue_decisions_total',
    value: 1,
    labels: { session_id: input.session_id, decision: 'incoming' },
  });

  if (runningCount < deps.config.max_concurrent_runs) {
    deps.store.append({
      session_id: input.session_id,
      run_id: runId,
      status: ConcurrencyQueueEntryStatus.RUNNING,
      ts,
    });
    deps.index.markRunning(input.session_id, runId, ts);
    deps.metrics?.record({
      metric: 'captain_queue_decisions_total',
      value: 1,
      labels: { session_id: input.session_id, decision: 'spawn' },
    });
    return { kind: 'spawn', run_id: runId };
  }

  const queuedCount = deps.index.countQueued(input.session_id);
  if (queuedCount >= deps.config.queue_max_depth) {
    deps.metrics?.record({
      metric: 'captain_queue_decisions_total',
      value: 1,
      labels: { session_id: input.session_id, decision: 'rejected', reason: 'queue_full' },
    });
    deps.metrics?.record({
      metric: 'captain_queue_rejections_total',
      value: 1,
      labels: { session_id: input.session_id, reason: 'queue_full' },
    });
    return { kind: 'rejected', reason: 'queue_full' };
  }

  deps.store.append({
    session_id: input.session_id,
    run_id: runId,
    status: ConcurrencyQueueEntryStatus.QUEUED,
    ts,
  });
  deps.index.enqueue(input.session_id, runId, ts);
  const position = deps.index.countQueued(input.session_id);
  deps.metrics?.record({
    metric: 'captain_queue_decisions_total',
    value: 1,
    labels: { session_id: input.session_id, decision: 'queued' },
  });
  deps.metrics?.record({
    metric: 'captain_queue_enqueue_position',
    value: position,
    labels: { session_id: input.session_id },
  });
  return {
    kind: 'queued',
    run_id: runId,
    position,
  };
}
