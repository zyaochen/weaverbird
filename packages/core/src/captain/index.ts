import { loadConcurrencyConfig, type ConcurrencyConfig } from './concurrency-config.js';
import { createConcurrencyQueueIndex, type ConcurrencyQueueIndex } from './concurrency-queue-index.js';
import { createConcurrencyQueueStore, type ConcurrencyQueueStore } from './concurrency-queue-store.js';
import { createQueueMetricsAggregator, type QueueMetricsAggregator } from './queue-metrics/aggregator.js';
import { createQueueMetricsEventStore } from './queue-metrics/event-store.js';

export * from './contracts.js';
export { CaptainService } from './captain-service.js';
export { createCaptainSessionStore, type CaptainSessionStore, type CaptainStoreClientLike } from './session-store.js';
export { validateCatalog, COMMAND_CATALOG } from './command-catalog.js';
export { inferCaptain } from './cwd-inference.js';
export { loadCaptainConfig } from './toml-loader.js';

let processQueueMetricsAggregator: QueueMetricsAggregator | undefined;

export type CaptainConcurrencyContainer = {
  config: ConcurrencyConfig;
  index: ConcurrencyQueueIndex;
  store: ConcurrencyQueueStore;
  metrics: QueueMetricsAggregator;
  now?: () => string;
  genRunId?: () => string;
};

export function getCaptainProcessQueueMetrics(): QueueMetricsAggregator | undefined {
  return processQueueMetricsAggregator;
}

export function createCaptainConcurrencyContainer(dataDir: string): CaptainConcurrencyContainer {
  const metrics = createQueueMetricsAggregator({
    eventStore: createQueueMetricsEventStore(dataDir),
  });
  processQueueMetricsAggregator = metrics;
  return {
    config: loadConcurrencyConfig(dataDir),
    index: createConcurrencyQueueIndex(metrics),
    store: createConcurrencyQueueStore(dataDir),
    metrics,
  };
}
