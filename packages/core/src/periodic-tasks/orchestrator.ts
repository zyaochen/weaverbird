import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readNdjsonSegments } from '../util/ndjson-rotation.js';
import { periodicOccurrenceLedgerPath, periodicTasksStatePath } from '../paths.js';
import { CalendarCommandReceivedSchema, type CalendarCommandReceived } from '../calendar-hook/contracts.js';
import { loadPeriodicTasksConfig } from './config.js';
import {
  PeriodicOccurrenceLedgerRecordSchema,
  PeriodicStateEntrySchema,
  PeriodicStateSchema,
  PeriodicTaskConfigSchema,
  PeriodicTaskRunSidecarSchema,
  type PeriodicOccurrence,
  type PeriodicOccurrenceLedgerRecord,
  type PeriodicState,
  type PeriodicStateEntry,
  type PeriodicTaskConfig,
} from './contracts.js';
import { readPeriodicState, readPeriodicStateEntry, writePeriodicOccurrenceLedger, writePeriodicRunSidecar, writePeriodicState } from './state.js';

function isoFromMs(ms: number): string {
  return new Date(ms).toISOString();
}

function floorWindow(now: number, intervalMs: number): { start: number; end: number } {
  const start = now - (now % intervalMs);
  return { start, end: start + intervalMs };
}

function hashCompact(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 12);
}

function buildOccurrence(task: PeriodicTaskConfig, now: number): PeriodicOccurrence | null {
  if (task.schedule.type !== 'interval') return null;
  const { start, end } = floorWindow(now, task.schedule.interval_ms);
  const windowStart = isoFromMs(start);
  const windowEnd = isoFromMs(end);
  const occurrence_id = `${task.task_id}:${windowStart}`;
  return {
    task_id: task.task_id,
    occurrence_id,
    window_start: windowStart,
    window_end: windowEnd,
    scheduled_at: windowStart,
    request_id: occurrence_id,
    run_id: `ptask_${task.task_id}_${hashCompact(windowStart)}`,
  };
}

function buildCommand(task: PeriodicTaskConfig, occurrence: PeriodicOccurrence): CalendarCommandReceived {
  return CalendarCommandReceivedSchema.parse({
    source: 'periodic',
    request_id: occurrence.request_id,
    session_id: `${task.task_id}:${task.target.user_open_id}:${task.target.home_group_id}`,
    run_id: occurrence.run_id,
    revision: 0,
    text: task.run_template.text
      .replace(/\{\{task_id\}\}/g, task.task_id)
      .replace(/\{\{scheduled_at\}\}/g, occurrence.scheduled_at)
      .replace(/\{\{window_start\}\}/g, occurrence.window_start)
      .replace(/\{\{window_end\}\}/g, occurrence.window_end),
    scheduled_at: occurrence.scheduled_at,
    user_open_id: task.target.user_open_id,
    thread_id: task.target.home_group_id,
    message_id: `periodic:${occurrence.occurrence_id}`,
  });
}

function hasLedgerOccurrence(dataDir: string, occurrenceId: string): boolean {
  const path = periodicOccurrenceLedgerPath(dataDir);
  if (!existsSync(path)) return false;
  for (const line of readNdjsonSegments(path)) {
    try {
      const record = PeriodicOccurrenceLedgerRecordSchema.parse(JSON.parse(line));
      if (record.occurrence_id === occurrenceId) return true;
    } catch {
      continue;
    }
  }
  return false;
}

function isTaskActive(entry: PeriodicStateEntry, now: number, timeoutMs?: number): boolean {
  if (!entry.active_occurrence_id) return false;
  if (!entry.active_started_at) return true;
  const timeout = timeoutMs ?? Infinity;
  return (Date.parse(entry.active_started_at) + timeout) > now;
}

function markDecision(state: PeriodicState, taskId: string, patch: Partial<PeriodicStateEntry>): PeriodicState {
  const current = readPeriodicStateEntry(state, taskId);
  return PeriodicStateSchema.parse({
    ...state,
    tasks: {
      ...state.tasks,
      [taskId]: PeriodicStateEntrySchema.parse({
        ...current,
        ...patch,
      }),
    },
  });
}

export type RunStatusLookup = (runId: string) => 'terminal' | 'active' | 'missing';

export type PeriodicSchedulerPhaseOptions = {
  dataDir: string;
  nowFn?: () => number;
  onCommand: (command: CalendarCommandReceived) => Promise<void>;
  lookupRunStatus?: RunStatusLookup;
};

export async function runPeriodicPhase(options: PeriodicSchedulerPhaseOptions): Promise<void> {
  const nowFn = options.nowFn ?? Date.now;
  const now = nowFn();
  const nowIso = isoFromMs(now);
  const config = loadPeriodicTasksConfig({ env: { WB_DATA_DIR: options.dataDir } });
  if (!config.enabled) return;
  let state = readPeriodicState(options.dataDir);

  for (const rawTask of config.tasks) {
    const task = PeriodicTaskConfigSchema.parse(rawTask);
    if (!task.enabled) continue;
    const occurrence = buildOccurrence(task, now);
    if (!occurrence) continue;
    if (hasLedgerOccurrence(options.dataDir, occurrence.occurrence_id)) continue;

    const entry = readPeriodicStateEntry(state, task.task_id);
    const active = isTaskActive(entry, now, task.reentry.timeout_ms);

    if (active && task.reentry.policy === 'skip') {
      state = markDecision(state, task.task_id, {
        last_window_start: occurrence.window_start,
        last_decision: 'skipped_busy',
        last_decision_at: nowIso,
      });
      writePeriodicState(options.dataDir, state);
      writePeriodicOccurrenceLedger(options.dataDir, PeriodicOccurrenceLedgerRecordSchema.parse({
        task_id: task.task_id,
        occurrence_id: occurrence.occurrence_id,
        window_start: occurrence.window_start,
        window_end: occurrence.window_end,
        scheduled_at: occurrence.scheduled_at,
        request_id: occurrence.request_id,
        run_id: occurrence.run_id,
        decision: 'skipped_busy',
        reason: 'previous occurrence still active',
        ts: nowIso,
      }));
      continue;
    }

    if (active && task.reentry.policy === 'queue_one') {
      state = markDecision(state, task.task_id, {
        queued_occurrence_id: occurrence.occurrence_id,
        queued_run_id: occurrence.run_id,
        last_window_start: occurrence.window_start,
        last_decision: 'queued',
        last_decision_at: nowIso,
      });
      writePeriodicState(options.dataDir, state);
      writePeriodicOccurrenceLedger(options.dataDir, PeriodicOccurrenceLedgerRecordSchema.parse({
        task_id: task.task_id,
        occurrence_id: occurrence.occurrence_id,
        window_start: occurrence.window_start,
        window_end: occurrence.window_end,
        scheduled_at: occurrence.scheduled_at,
        request_id: occurrence.request_id,
        run_id: occurrence.run_id,
        decision: 'queued',
        reason: 'previous occurrence still active',
        ts: nowIso,
      }));
      continue;
    }

    const command = buildCommand(task, occurrence);
    try {
      await options.onCommand(command);
      state = markDecision(state, task.task_id, {
        last_window_start: occurrence.window_start,
        active_occurrence_id: occurrence.occurrence_id,
        active_run_id: occurrence.run_id,
        active_started_at: nowIso,
        last_decision: 'spawned',
        last_decision_at: nowIso,
        last_error: null,
      });
      writePeriodicState(options.dataDir, state);
      writePeriodicOccurrenceLedger(options.dataDir, PeriodicOccurrenceLedgerRecordSchema.parse({
        task_id: task.task_id,
        occurrence_id: occurrence.occurrence_id,
        window_start: occurrence.window_start,
        window_end: occurrence.window_end,
        scheduled_at: occurrence.scheduled_at,
        request_id: occurrence.request_id,
        run_id: occurrence.run_id,
        decision: 'spawned',
        reason: null,
        ts: nowIso,
      }));
      writePeriodicRunSidecar(options.dataDir, occurrence.run_id, 'default', PeriodicTaskRunSidecarSchema.parse({
        task_id: task.task_id,
        occurrence_id: occurrence.occurrence_id,
        window_start: occurrence.window_start,
        window_end: occurrence.window_end,
        scheduled_at: occurrence.scheduled_at,
        policy: task.reentry.policy,
        home_group_id: task.target.home_group_id,
      }));
    } catch (error) {
      state = markDecision(state, task.task_id, {
        last_window_start: occurrence.window_start,
        last_decision: 'dispatch_failed',
        last_decision_at: nowIso,
        last_error: error instanceof Error ? error.message : String(error),
      });
      writePeriodicState(options.dataDir, state);
      writePeriodicOccurrenceLedger(options.dataDir, PeriodicOccurrenceLedgerRecordSchema.parse({
        task_id: task.task_id,
        occurrence_id: occurrence.occurrence_id,
        window_start: occurrence.window_start,
        window_end: occurrence.window_end,
        scheduled_at: occurrence.scheduled_at,
        request_id: occurrence.request_id,
        run_id: occurrence.run_id,
        decision: 'dispatch_failed',
        reason: error instanceof Error ? error.message : String(error),
        ts: nowIso,
      }));
    }

    const nextEntry = readPeriodicStateEntry(state, task.task_id);
    if (!nextEntry.active_occurrence_id && nextEntry.queued_occurrence_id) {
      const queuedOccurrence = {
        ...occurrence,
        occurrence_id: nextEntry.queued_occurrence_id,
        request_id: nextEntry.queued_occurrence_id,
        run_id: nextEntry.queued_run_id ?? occurrence.run_id,
      };
      try {
        await options.onCommand(buildCommand(task, queuedOccurrence));
        state = markDecision(state, task.task_id, {
          active_occurrence_id: queuedOccurrence.occurrence_id,
          active_run_id: queuedOccurrence.run_id,
          active_started_at: nowIso,
          queued_occurrence_id: null,
          queued_run_id: null,
          last_decision: 'dequeued_spawned',
          last_decision_at: nowIso,
        });
        writePeriodicState(options.dataDir, state);
        writePeriodicOccurrenceLedger(options.dataDir, PeriodicOccurrenceLedgerRecordSchema.parse({
          task_id: task.task_id,
          occurrence_id: queuedOccurrence.occurrence_id,
          window_start: queuedOccurrence.window_start,
          window_end: queuedOccurrence.window_end,
          scheduled_at: queuedOccurrence.scheduled_at,
          request_id: queuedOccurrence.request_id,
          run_id: queuedOccurrence.run_id,
          decision: 'dequeued_spawned',
          reason: null,
          ts: nowIso,
        }));
      } catch {
        // fail-safe: leave queued occurrence for next cycle
      }
    }
  }
}
