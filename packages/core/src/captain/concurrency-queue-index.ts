import {
  ConcurrencyQueueEntryStatus,
  type ConcurrencyQueueEntry,
} from './concurrency-queue-store.js';
import type { QueueMetricsAggregator } from './queue-metrics/aggregator.js';

export type ConcurrencyQueueIndex = {
  enqueue(sessionId: string, runId: string, ts: string): void;
  markRunning(sessionId: string, runId: string, ts: string): void;
  markEnded(sessionId: string, runId: string, ts: string): void;
  listQueued(sessionId: string): string[];
  listRunning(sessionId: string): string[];
  listQueuedEntries(sessionId: string): ConcurrencyQueueEntry[];
  listRunningEntries(sessionId: string): ConcurrencyQueueEntry[];
  countQueued(sessionId?: string): number;
  countRunning(sessionId?: string): number;
  replay(entries: ConcurrencyQueueEntry[]): void;
};

type SessionQueueState = {
  queued: string[];
  running: string[];
  entries: Map<string, ConcurrencyQueueEntry>;
};

function getSessionState(state: Map<string, SessionQueueState>, sessionId: string): SessionQueueState {
  const existing = state.get(sessionId);
  if (existing) return existing;
  const created: SessionQueueState = { queued: [], running: [], entries: new Map() };
  state.set(sessionId, created);
  return created;
}

function removeRun(runs: string[], runId: string): void {
  const index = runs.indexOf(runId);
  if (index >= 0) runs.splice(index, 1);
}

function sumCounts(state: Map<string, SessionQueueState>, key: 'queued' | 'running', sessionId?: string): number {
  if (sessionId) return getSessionState(state, sessionId)[key].length;
  return [...state.values()].reduce((total, item) => total + item[key].length, 0);
}

export function createConcurrencyQueueIndex(metrics?: QueueMetricsAggregator): ConcurrencyQueueIndex {
  const state = new Map<string, SessionQueueState>();

  function publishGauges(sessionId: string): void {
    if (!metrics) return;
    const session = getSessionState(state, sessionId);
    metrics.record({
      metric: 'captain_queue_depth',
      value: session.queued.length,
      labels: { session_id: sessionId },
    });
    metrics.record({
      metric: 'captain_queue_running_total',
      value: session.running.length,
      labels: { session_id: sessionId },
    });
  }

  function apply(entry: ConcurrencyQueueEntry): void {
    const session = getSessionState(state, entry.session_id);
    session.entries.set(entry.run_id, entry);
    if (entry.status === ConcurrencyQueueEntryStatus.QUEUED) {
      removeRun(session.running, entry.run_id);
      if (!session.queued.includes(entry.run_id)) session.queued.push(entry.run_id);
      publishGauges(entry.session_id);
      return;
    }
    if (entry.status === ConcurrencyQueueEntryStatus.RUNNING) {
      removeRun(session.queued, entry.run_id);
      if (!session.running.includes(entry.run_id)) session.running.push(entry.run_id);
      publishGauges(entry.session_id);
      return;
    }
    removeRun(session.queued, entry.run_id);
    removeRun(session.running, entry.run_id);
    publishGauges(entry.session_id);
  }

  return {
    enqueue(sessionId: string, runId: string, ts: string): void {
      apply({ session_id: sessionId, run_id: runId, status: ConcurrencyQueueEntryStatus.QUEUED, ts });
    },
    markRunning(sessionId: string, runId: string, ts: string): void {
      apply({ session_id: sessionId, run_id: runId, status: ConcurrencyQueueEntryStatus.RUNNING, ts });
    },
    markEnded(sessionId: string, runId: string, ts: string): void {
      apply({ session_id: sessionId, run_id: runId, status: ConcurrencyQueueEntryStatus.ENDED, ts });
    },
    listQueued(sessionId: string): string[] {
      return [...getSessionState(state, sessionId).queued];
    },
    listRunning(sessionId: string): string[] {
      return [...getSessionState(state, sessionId).running];
    },
    listQueuedEntries(sessionId: string): ConcurrencyQueueEntry[] {
      const session = getSessionState(state, sessionId);
      return session.queued.map((runId) => session.entries.get(runId)!).filter(Boolean);
    },
    listRunningEntries(sessionId: string): ConcurrencyQueueEntry[] {
      const session = getSessionState(state, sessionId);
      return session.running.map((runId) => session.entries.get(runId)!).filter(Boolean);
    },
    countQueued(sessionId?: string): number {
      return sumCounts(state, 'queued', sessionId);
    },
    countRunning(sessionId?: string): number {
      return sumCounts(state, 'running', sessionId);
    },
    replay(entries: ConcurrencyQueueEntry[]): void {
      state.clear();
      for (const entry of entries) apply(entry);
    },
  };
}
