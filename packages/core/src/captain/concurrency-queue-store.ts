import { mkdirSync } from 'node:fs';
import { appendNdjsonLine, readNdjsonSegments } from '../util/ndjson-rotation.js';
import { captainDir, captainQueuePath } from '../paths.js';
import { getCaptainProcessQueueMetrics } from './index.js';

export const ConcurrencyQueueEntryStatus = {
  QUEUED: 'queued',
  RUNNING: 'running',
  ENDED: 'ended',
} as const;

export type ConcurrencyQueueEntryStatus = typeof ConcurrencyQueueEntryStatus[keyof typeof ConcurrencyQueueEntryStatus];

export type ConcurrencyQueueEntry = {
  session_id: string;
  run_id: string;
  status: ConcurrencyQueueEntryStatus;
  ts: string;
  reason?: 'cancelled' | 'preempted';
};

export type ConcurrencyQueueStore = {
  path: string;
  append(entry: ConcurrencyQueueEntry): void;
  readAll(): ConcurrencyQueueEntry[];
};

export function createConcurrencyQueueStore(dataDir: string): ConcurrencyQueueStore {
  const dir = captainDir(dataDir);
  const path = captainQueuePath(dataDir);
  mkdirSync(dir, { recursive: true });

  return {
    path,
    append(entry: ConcurrencyQueueEntry): void {
      appendNdjsonLine(path, JSON.stringify(entry));
    },
    readAll(): ConcurrencyQueueEntry[] {
      const entries: ConcurrencyQueueEntry[] = [];
      for (const line of readNdjsonSegments(path)) {
        if (!line.trim()) continue;
        try {
          entries.push(JSON.parse(line) as ConcurrencyQueueEntry);
        } catch {
          try {
            getCaptainProcessQueueMetrics()?.record({
              metric: 'captain_queue_store_read_errors_total',
              value: 1,
            });
          } catch {
            // best-effort metrics hook only
          }
          continue;
        }
      }
      return entries;
    },
  };
}
