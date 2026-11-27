import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { runCalendarHookStatePath } from '../paths.js';
import { CalendarHookStateSchema, type CalendarBlockRequest, type CalendarHookConfig, type CalendarHookState, type CalendarTransport } from './contracts.js';
import { withTimeout } from './transport.js';

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  writeFileSync(temp, content);
  renameSync(temp, path);
}

function readState(path: string, runId: string, dueAt: string | null): CalendarHookState {
  if (!existsSync(path)) {
    return CalendarHookStateSchema.parse({
      run_id: runId,
      session_id: null,
      open_revision_applied: null,
      close_revision_applied: null,
      calendar_block_id: null,
      calendar_hook_failed: false,
      desired_state: 'open',
      due_at: dueAt,
      overdue_escalated_at: null,
      last_error: null,
      updated_at: new Date().toISOString(),
    });
  }
  return CalendarHookStateSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

function writeState(path: string, state: CalendarHookState): void {
  atomicWrite(path, JSON.stringify(state, null, 2));
}

function lockPath(statePath: string): string {
  return `${statePath}.lock`;
}

function acquireLock(path: string): number | null {
  mkdirSync(dirname(path), { recursive: true });
  try {
    return openSync(path, 'wx');
  } catch {
    return null;
  }
}

function releaseLock(path: string, fd: number | null): void {
  if (fd === null) return;
  try {
    closeSync(fd);
  } finally {
    try {
      unlinkSync(path);
    } catch {
      // ignore cleanup failure
    }
  }
}

export type OpenCalendarBlockOptions = {
  dataDir: string;
  botId?: string;
  runId: string;
  sessionId: string;
  revision: number;
  title: string;
  startsAt: string;
  endsAt: string;
  config: CalendarHookConfig;
  transport: CalendarTransport;
};

export type CloseCalendarBlockOptions = {
  dataDir: string;
  botId?: string;
  runId: string;
  revision: number;
  config: CalendarHookConfig;
  transport: CalendarTransport;
};

export type CalendarHookResult = {
  calendar_block_id: string | null;
  calendar_hook_failed: boolean;
  state: CalendarHookState;
};

export async function openCalendarBlock(options: OpenCalendarBlockOptions): Promise<CalendarHookResult> {
  const statePath = runCalendarHookStatePath(options.dataDir, options.runId, options.botId ?? 'default');
  const state = readState(statePath, options.runId, options.endsAt);
  if (state.open_revision_applied !== null && state.open_revision_applied >= options.revision && state.calendar_block_id) {
    return { calendar_block_id: state.calendar_block_id, calendar_hook_failed: state.calendar_hook_failed, state };
  }
  const fd = acquireLock(lockPath(statePath));
  if (fd === null) {
    return { calendar_block_id: state.calendar_block_id, calendar_hook_failed: state.calendar_hook_failed, state };
  }
  try {
    writeState(statePath, CalendarHookStateSchema.parse({
      ...state,
      session_id: options.sessionId,
      desired_state: 'open',
      due_at: options.endsAt,
      updated_at: new Date().toISOString(),
    }));
    const result = await withTimeout(options.transport.openBlock({
      run_id: options.runId,
      session_id: options.sessionId,
      revision: options.revision,
      title: options.title,
      starts_at: options.startsAt,
      ends_at: options.endsAt,
    } satisfies CalendarBlockRequest), options.config.rpc_timeout_ms, 'calendar open timeout');
    const latestState = readState(statePath, options.runId, options.endsAt);
    const nextState = CalendarHookStateSchema.parse({
      ...latestState,
      session_id: options.sessionId,
      open_revision_applied: options.revision,
      calendar_block_id: result.calendar_block_id,
      calendar_hook_failed: false,
      desired_state: latestState.desired_state,
      due_at: options.endsAt,
      last_error: null,
      updated_at: new Date().toISOString(),
    });
    writeState(statePath, nextState);
    if (nextState.desired_state === 'closed' && nextState.close_revision_applied !== null) {
      try {
        await withTimeout(options.transport.closeBlock({
          run_id: options.runId,
          revision: nextState.close_revision_applied,
          calendar_block_id: result.calendar_block_id,
        }), options.config.rpc_timeout_ms, 'calendar close timeout');
        const closedState = CalendarHookStateSchema.parse({
          ...nextState,
          calendar_hook_failed: false,
          last_error: null,
          updated_at: new Date().toISOString(),
        });
        writeState(statePath, closedState);
        return { calendar_block_id: closedState.calendar_block_id, calendar_hook_failed: false, state: closedState };
      } catch (closeError) {
        const failedClosedState = CalendarHookStateSchema.parse({
          ...nextState,
          calendar_hook_failed: true,
          last_error: closeError instanceof Error ? closeError.message : String(closeError),
          updated_at: new Date().toISOString(),
        });
        writeState(statePath, failedClosedState);
        return { calendar_block_id: failedClosedState.calendar_block_id, calendar_hook_failed: true, state: failedClosedState };
      }
    }
    return { calendar_block_id: nextState.calendar_block_id, calendar_hook_failed: false, state: nextState };
  } catch (error) {
    const nextState = CalendarHookStateSchema.parse({
      ...state,
      session_id: options.sessionId,
      desired_state: 'open',
      due_at: options.endsAt,
      calendar_hook_failed: true,
      last_error: error instanceof Error ? error.message : String(error),
      updated_at: new Date().toISOString(),
    });
    writeState(statePath, nextState);
    return { calendar_block_id: nextState.calendar_block_id, calendar_hook_failed: true, state: nextState };
  } finally {
    releaseLock(lockPath(statePath), fd);
  }
}

export async function closeCalendarBlock(options: CloseCalendarBlockOptions): Promise<CalendarHookResult> {
  const statePath = runCalendarHookStatePath(options.dataDir, options.runId, options.botId ?? 'default');
  const state = readState(statePath, options.runId, null);
  if (!state.calendar_block_id) {
    return { calendar_block_id: null, calendar_hook_failed: state.calendar_hook_failed, state };
  }
  if (state.close_revision_applied !== null && state.close_revision_applied >= options.revision) {
    return { calendar_block_id: state.calendar_block_id, calendar_hook_failed: state.calendar_hook_failed, state };
  }
  const fd = acquireLock(lockPath(statePath));
  if (fd === null) {
    return { calendar_block_id: state.calendar_block_id, calendar_hook_failed: state.calendar_hook_failed, state };
  }
  try {
    await withTimeout(options.transport.closeBlock({
      run_id: options.runId,
      revision: options.revision,
      calendar_block_id: state.calendar_block_id,
    }), options.config.rpc_timeout_ms, 'calendar close timeout');
    const nextState = CalendarHookStateSchema.parse({
      ...state,
      close_revision_applied: options.revision,
      calendar_hook_failed: false,
      desired_state: 'closed',
      last_error: null,
      updated_at: new Date().toISOString(),
    });
    writeState(statePath, nextState);
    return { calendar_block_id: nextState.calendar_block_id, calendar_hook_failed: false, state: nextState };
  } catch (error) {
    const nextState = CalendarHookStateSchema.parse({
      ...state,
      calendar_hook_failed: true,
      desired_state: 'closed',
      last_error: error instanceof Error ? error.message : String(error),
      updated_at: new Date().toISOString(),
    });
    writeState(statePath, nextState);
    return { calendar_block_id: nextState.calendar_block_id, calendar_hook_failed: true, state: nextState };
  } finally {
    releaseLock(lockPath(statePath), fd);
  }
}
