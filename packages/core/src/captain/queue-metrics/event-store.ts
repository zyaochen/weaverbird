import { captainQueueMetricsPath } from '../../paths.js';
import { appendNdjsonLine } from '../../util/ndjson-rotation.js';
import {
  QUEUE_METRIC_TYPES,
  type QueueMetricEvent,
  type QueueMetricType,
} from './contracts.js';

export type QueueMetricsEventRecord = {
  ts: string;
  metric: QueueMetricEvent['metric'];
  type: QueueMetricType;
  value: number;
  labels?: {
    session_id?: string;
    command?: string;
  };
};

export type QueueMetricsEventStore = {
  path: string;
  append(event: QueueMetricEvent): void;
};

function toRecord(event: QueueMetricEvent): QueueMetricsEventRecord {
  const labels: QueueMetricsEventRecord['labels'] = {};
  if (event.labels?.session_id) labels.session_id = event.labels.session_id;
  if (event.labels?.command) labels.command = event.labels.command;

  return {
    ts: new Date().toISOString(),
    metric: event.metric,
    type: QUEUE_METRIC_TYPES[event.metric],
    value: event.value,
    ...(Object.keys(labels).length > 0 ? { labels } : {}),
  };
}

export function createQueueMetricsEventStore(dataDir: string): QueueMetricsEventStore {
  const path = captainQueueMetricsPath(dataDir);

  return {
    path,
    append(event: QueueMetricEvent): void {
      appendNdjsonLine(path, JSON.stringify(toRecord(event)));
    },
  };
}
