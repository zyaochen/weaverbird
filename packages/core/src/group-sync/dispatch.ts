import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { groupSyncDir, runDir } from '../paths.js';
import { appendNdjsonLine } from '../util/ndjson-rotation.js';
import { GroupSyncCommandReceivedSchema, type GroupSyncCommandReceived } from './contracts.js';

const GroupSyncDispatchRecordSchema = GroupSyncCommandReceivedSchema.extend({
  dispatch_id: z.string().min(1),
  created_at: z.string().datetime(),
  dispatched_at: z.string().datetime().nullable().default(null),
  dispatch_failed: z.boolean().default(false),
  last_error: z.string().nullable().default(null),
});
export type GroupSyncDispatchRecord = z.infer<typeof GroupSyncDispatchRecordSchema>;

const GroupSyncDispatchStateSchema = z.object({
  session_id: z.string().min(1),
  run_id: z.string().min(1),
  last_revision: z.number().int().min(0),
  updated_at: z.string().datetime(),
  commands: z.array(GroupSyncDispatchRecordSchema).default([]),
});
export type GroupSyncDispatchState = z.infer<typeof GroupSyncDispatchStateSchema>;

export interface GroupSyncDispatchTransport {
  dispatchCommand(input: GroupSyncCommandReceived): Promise<void>;
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  writeFileSync(temp, content);
  renameSync(temp, path);
}

function runGroupSyncDispatchPath(dataDir: string, runId: string, botId = 'default'): string {
  return join(runDir(dataDir, runId, botId), 'group-sync-dispatch.json');
}

function readDispatchSet(path: string, input: GroupSyncCommandReceived, nowIso: string): GroupSyncDispatchState {
  if (!existsSync(path)) {
    return GroupSyncDispatchStateSchema.parse({
      session_id: input.session_id,
      run_id: input.run_id,
      last_revision: input.revision,
      updated_at: nowIso,
      commands: [],
    });
  }
  return GroupSyncDispatchStateSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

function writeDispatchSet(path: string, state: GroupSyncDispatchState): void {
  atomicWrite(path, JSON.stringify(state, null, 2));
}

function sanitizeIdPart(value: string | null | undefined): string {
  const raw = value?.trim() ?? '';
  if (raw.length === 0) return 'none';
  return raw.replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function buildDispatchId(input: GroupSyncCommandReceived): string {
  return [
    'dispatch',
    sanitizeIdPart(input.request_id),
    sanitizeIdPart(input.run_id),
    sanitizeIdPart(String(input.revision)),
  ].join(':');
}

function toDispatchRecord(
  input: GroupSyncCommandReceived,
  nowIso: string,
  patch: Partial<Pick<GroupSyncDispatchRecord, 'created_at' | 'dispatched_at' | 'dispatch_failed' | 'last_error'>> = {},
): GroupSyncDispatchRecord {
  return GroupSyncDispatchRecordSchema.parse({
    request_id: input.request_id,
    session_id: input.session_id,
    run_id: input.run_id,
    revision: input.revision,
    text: input.text,
    scheduled_at: input.scheduled_at,
    user_open_id: input.user_open_id,
    thread_id: input.thread_id,
    message_id: input.message_id,
    dispatch_id: buildDispatchId(input),
    created_at: patch.created_at ?? nowIso,
    dispatched_at: patch.dispatched_at ?? null,
    dispatch_failed: patch.dispatch_failed ?? false,
    last_error: patch.last_error ?? null,
  });
}

function mergeDispatchSet(state: GroupSyncDispatchState, record: GroupSyncDispatchRecord, nowIso: string): GroupSyncDispatchState {
  const commands = state.commands.filter((item) => item.dispatch_id !== record.dispatch_id);
  commands.push(record);
  commands.sort((left, right) => left.dispatch_id.localeCompare(right.dispatch_id));
  return GroupSyncDispatchStateSchema.parse({
    session_id: state.session_id,
    run_id: state.run_id,
    last_revision: Math.max(state.last_revision, record.revision),
    updated_at: nowIso,
    commands,
  });
}

export type DispatchGroupSyncCommandOptions = {
  dataDir: string;
  botId?: string;
  command: GroupSyncCommandReceived;
  transport: GroupSyncDispatchTransport;
  nowFn?: () => number;
};

export type DispatchGroupSyncCommandResult = {
  dispatch_failed: boolean;
  record: GroupSyncDispatchRecord;
  state: GroupSyncDispatchState;
  statePath: string;
};

export function groupSyncMockDispatchLedgerPath(dataDir: string): string {
  return join(groupSyncDir(dataDir), 'mock-dispatch.ndjson');
}

export function createInlineGroupSyncDispatchTransport(handler: (command: GroupSyncCommandReceived) => Promise<void>): GroupSyncDispatchTransport {
  return {
    async dispatchCommand(input): Promise<void> {
      await handler(input);
    },
  };
}

export function createMockGroupSyncDispatchTransport(dataDir: string): GroupSyncDispatchTransport {
  const ledgerPath = groupSyncMockDispatchLedgerPath(dataDir);
  return {
    async dispatchCommand(input): Promise<void> {
      mkdirSync(dirname(ledgerPath), { recursive: true });
      appendNdjsonLine(ledgerPath, JSON.stringify(GroupSyncCommandReceivedSchema.parse(input)));
    },
  };
}

export function createGuardedCliGroupSyncDispatchTransport(): GroupSyncDispatchTransport {
  return {
    async dispatchCommand(): Promise<void> {
      throw new Error('group sync dispatch egress requires explicit real-device authorization');
    },
  };
}

export async function dispatchGroupSyncCommand(options: DispatchGroupSyncCommandOptions): Promise<DispatchGroupSyncCommandResult> {
  const command = GroupSyncCommandReceivedSchema.parse(options.command);
  const nowFn = options.nowFn ?? Date.now;
  const nowIso = new Date(nowFn()).toISOString();
  const statePath = runGroupSyncDispatchPath(options.dataDir, command.run_id, options.botId ?? 'default');
  const current = readDispatchSet(statePath, command, nowIso);
  const existing = current.commands.find((item) => item.dispatch_id === buildDispatchId(command));
  if (existing && existing.dispatch_failed === false) {
    return {
      dispatch_failed: false,
      record: existing,
      state: current,
      statePath,
    };
  }

  try {
    await options.transport.dispatchCommand(command);
    const record = toDispatchRecord(command, nowIso, {
      created_at: existing?.created_at ?? nowIso,
      dispatched_at: nowIso,
      dispatch_failed: false,
      last_error: null,
    });
    const nextState = mergeDispatchSet(current, record, nowIso);
    writeDispatchSet(statePath, nextState);
    return {
      dispatch_failed: false,
      record,
      state: nextState,
      statePath,
    };
  } catch (error) {
    const record = toDispatchRecord(command, nowIso, {
      created_at: existing?.created_at ?? nowIso,
      dispatched_at: null,
      dispatch_failed: true,
      last_error: error instanceof Error ? error.message : String(error),
    });
    const nextState = mergeDispatchSet(current, record, nowIso);
    writeDispatchSet(statePath, nextState);
    return {
      dispatch_failed: true,
      record,
      state: nextState,
      statePath,
    };
  }
}
