import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { calendarMockTriggersPath, calendarRunStateChangedPath, calendarTriggerStatePath, runCalendarHookStatePath, runsRootDir } from '../paths.js';
import { appendNdjsonLine } from '../util/ndjson-rotation.js';
import { runPeriodicPhase } from '../periodic-tasks/orchestrator.js';
import {
  CalendarCommandReceivedSchema,
  CalendarHookStateSchema,
  CalendarRunStateChangedSchema,
  CalendarTriggerRecordSchema,
  type CalendarCommandReceived,
  type CalendarHookConfig,
  type CalendarHookState,
  type CalendarTriggerRecord,
} from './contracts.js';

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  writeFileSync(temp, content);
  renameSync(temp, path);
}

function readTriggerRecords(path: string): CalendarTriggerRecord[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown[];
    return Array.isArray(parsed) ? parsed.map((item) => CalendarTriggerRecordSchema.parse(item)) : [];
  } catch {
    return [];
  }
}

function readTriggerState(path: string): Record<string, string | null> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, string | null>;
  } catch {
    return {};
  }
}

function writeTriggerState(path: string, state: Record<string, string | null>): void {
  atomicWrite(path, JSON.stringify(state, null, 2));
}

function readDirNames(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function listCalendarStateFiles(dataDir: string): string[] {
  const runsRoot = runsRootDir(dataDir);
  if (!existsSync(runsRoot)) return [];
  const files: string[] = [];
  for (const botId of readDirNames(runsRoot)) {
    const botDir = join(runsRoot, botId);
    for (const runId of readDirNames(botDir)) {
      const statePath = runCalendarHookStatePath(dataDir, runId, botId);
      if (existsSync(statePath)) files.push(statePath);
    }
  }
  return files;
}

function readCalendarState(path: string): CalendarHookState | null {
  if (!existsSync(path)) return null;
  try {
    return CalendarHookStateSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return null;
  }
}

function writeCalendarState(path: string, state: CalendarHookState): void {
  atomicWrite(path, JSON.stringify(state, null, 2));
}

export type CalendarScheduler = {
  tick(): Promise<void>;
  stop(): void;
};

export type CalendarRunOverduePayload = {
  run_id: string;
  session_id: string;
  revision: number;
  due_at: string;
  escalated_at: string;
};

export type StartCalendarSchedulerOptions = {
  dataDir: string;
  config: CalendarHookConfig;
  onCommand: (command: CalendarCommandReceived) => Promise<void>;
  /**
   * M11-C C2 (2026-08-04 owner-authorized): 当 overdue 事件升级到
   * RunStateChanged 且 `overdue_escalated_at` 刚刚被设置时, 派发一条
   * 降级通道通知 (典型: IM 卡片 / owner DM)。失败被吞掉, 不影响下次 sweep。
   * 缺省 => 只写 events ndjson, 不发 IM。
   */
  onOverdueEscalated?: (payload: CalendarRunOverduePayload) => Promise<void>;
  nowFn?: () => number;
};

export function startCalendarScheduler(options: StartCalendarSchedulerOptions): CalendarScheduler {
  const nowFn = options.nowFn ?? Date.now;
  const triggerFile = calendarMockTriggersPath(options.dataDir);
  const triggerStateFile = calendarTriggerStatePath(options.dataDir);
  let timer: NodeJS.Timeout | null = null;
  let inFlight = false;

  async function tick(): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    try {
      const triggerState = readTriggerState(triggerStateFile);
      const now = nowFn();
      const nowIso = new Date(now).toISOString();

      for (const record of readTriggerRecords(triggerFile)) {
        if (Date.parse(record.scheduled_at) > now) continue;
        if (triggerState[record.request_id]) continue;
        triggerState[record.request_id] = nowIso;
        writeTriggerState(triggerStateFile, triggerState);
        await options.onCommand(CalendarCommandReceivedSchema.parse({
          source: 'calendar',
          request_id: record.request_id,
          session_id: record.session_id,
          run_id: record.run_id,
          revision: record.revision,
          text: record.text,
          scheduled_at: record.scheduled_at,
          user_open_id: record.user_open_id,
          thread_id: record.thread_id,
          message_id: record.message_id,
        }));
      }

      await runPeriodicPhase({
        dataDir: options.dataDir,
        nowFn,
        onCommand: options.onCommand,
      });

      for (const statePath of listCalendarStateFiles(options.dataDir)) {
        const state = readCalendarState(statePath);
        if (!state || !state.due_at || state.desired_state !== 'open' || state.overdue_escalated_at) continue;
        if (Date.parse(state.due_at) > now) continue;
        appendNdjsonLine(calendarRunStateChangedPath(options.dataDir), JSON.stringify(CalendarRunStateChangedSchema.parse({
          event: 'RunStateChanged',
          reason: 'calendar_overdue',
          run_id: state.run_id,
          session_id: state.session_id ?? state.run_id,
          revision: state.open_revision_applied ?? 0,
          ts: nowIso,
        })));
        writeCalendarState(statePath, CalendarHookStateSchema.parse({
          ...state,
          overdue_escalated_at: nowIso,
          updated_at: nowIso,
        }));
        if (options.onOverdueEscalated) {
          try {
            await options.onOverdueEscalated({
              run_id: state.run_id,
              session_id: state.session_id ?? state.run_id,
              revision: state.open_revision_applied ?? 0,
              due_at: state.due_at,
              escalated_at: nowIso,
            });
          } catch (notifyError) {
            // Do not surface IM/notification failure back to the sweep loop; the
            // escalation has already been recorded in the RunStateChanged queue.
            void notifyError;
          }
        }
      }
    } finally {
      inFlight = false;
    }
  }

  if (options.config.enabled) {
    timer = setInterval(() => {
      void tick();
    }, options.config.sweep_interval_ms);
    timer.unref?.();
  }

  return {
    tick,
    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
