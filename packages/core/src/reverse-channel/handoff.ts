import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { SessionRecord } from '../captain/contracts.js';
import { ENTRY_FORMS, buildRunInheritanceSnapshot, type RunInheritanceSnapshot } from '../run-registry/index.js';
import { runDir } from '../paths.js';
import { appendNdjsonLine } from '../util/ndjson-rotation.js';

const ReverseHandoffInheritedSchema = z.object({
  project: z.string().nullable(),
  cwd: z.string().min(1),
  scope: z.string().min(1),
  agent: z.string().min(1),
  home_group_id: z.string().nullable(),
  entry_form: z.enum(ENTRY_FORMS),
});
export type ReverseHandoffInherited = z.infer<typeof ReverseHandoffInheritedSchema>;

export const ReverseHandoffInputSchema = ReverseHandoffInheritedSchema.extend({
  session_id: z.string().min(1),
  run_id: z.string().min(1),
  revision: z.number().int().min(0),
  changed_at: z.string().datetime(),
  previous_captain_id: z.string().min(1),
  next_captain_id: z.string().min(1),
  previous_holder_open_id: z.string().nullable().default(null),
  next_holder_open_id: z.string().min(1),
});
export type ReverseHandoffInput = z.infer<typeof ReverseHandoffInputSchema>;

export const ReverseHandoffNotificationSchema = ReverseHandoffInheritedSchema.extend({
  handoff_id: z.string().min(1),
  session_id: z.string().min(1),
  run_id: z.string().min(1),
  revision: z.number().int().min(0),
  created_at: z.string().datetime(),
  previous_captain_id: z.string().min(1),
  next_captain_id: z.string().min(1),
  previous_holder_open_id: z.string().nullable(),
  next_holder_open_id: z.string().min(1),
});
export type ReverseHandoffNotification = z.infer<typeof ReverseHandoffNotificationSchema>;

export const ReverseHandoffRecordSchema = ReverseHandoffNotificationSchema.extend({
  notify_failed: z.boolean().default(false),
  notified_at: z.string().datetime().nullable().default(null),
  last_error: z.string().nullable().default(null),
});
export type ReverseHandoffRecord = z.infer<typeof ReverseHandoffRecordSchema>;

export const ReverseHandoffStateSchema = z.object({
  session_id: z.string().min(1),
  run_id: z.string().min(1),
  last_revision: z.number().int().min(0),
  updated_at: z.string().datetime(),
  handoffs: z.array(ReverseHandoffRecordSchema).default([]),
});
export type ReverseHandoffState = z.infer<typeof ReverseHandoffStateSchema>;

export interface ReverseHandoffTransport {
  notifyReverseAt(input: ReverseHandoffNotification): Promise<void>;
}

export type PublishReverseHandoffOptions = {
  dataDir: string;
  botId?: string;
  handoff: ReverseHandoffInput;
  transport: ReverseHandoffTransport;
  nowFn?: () => number;
};

export type PublishReverseHandoffResult = {
  notify_failed: boolean;
  record: ReverseHandoffRecord;
  state: ReverseHandoffState;
  statePath: string;
};

export type RecordReverseHandoffFromSessionOptions = {
  dataDir: string;
  botId?: string;
  previousSession: SessionRecord;
  nextSession: SessionRecord;
  revision: number;
  transport: ReverseHandoffTransport;
  runId?: string | null;
  nowFn?: () => number;
};

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  writeFileSync(temp, content);
  renameSync(temp, path);
}

function reverseChannelDir(dataDir: string): string {
  return join(dataDir, 'reverse-channel');
}

function runReverseHandoffStatePath(dataDir: string, runId: string, botId = 'default'): string {
  return join(runDir(dataDir, runId, botId), 'reverse-handoff.json');
}

export function reverseHandoffMockLedgerPath(dataDir: string): string {
  return join(reverseChannelDir(dataDir), 'mock-handoffs.ndjson');
}

function readReverseHandoffState(path: string, input: ReverseHandoffInput, nowIso: string): ReverseHandoffState {
  if (!existsSync(path)) {
    return ReverseHandoffStateSchema.parse({
      session_id: input.session_id,
      run_id: input.run_id,
      last_revision: input.revision,
      updated_at: nowIso,
      handoffs: [],
    });
  }
  return ReverseHandoffStateSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

function writeReverseHandoffState(path: string, state: ReverseHandoffState): void {
  atomicWrite(path, JSON.stringify(state, null, 2));
}

function sanitizeIdPart(value: string | null | undefined): string {
  const raw = value?.trim() ?? '';
  if (raw.length === 0) return 'none';
  return raw.replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function buildHandoffId(input: ReverseHandoffInput): string {
  return [
    'reverse-handoff',
    sanitizeIdPart(input.session_id),
    sanitizeIdPart(input.run_id),
    sanitizeIdPart(String(input.revision)),
    sanitizeIdPart(input.next_holder_open_id),
  ].join(':');
}

function mergeReverseHandoffState(state: ReverseHandoffState, record: ReverseHandoffRecord, nowIso: string): ReverseHandoffState {
  const handoffs = state.handoffs.filter((item) => item.handoff_id !== record.handoff_id);
  handoffs.push(record);
  handoffs.sort((left, right) => left.handoff_id.localeCompare(right.handoff_id));
  return ReverseHandoffStateSchema.parse({
    session_id: state.session_id,
    run_id: state.run_id,
    last_revision: Math.max(state.last_revision, record.revision),
    updated_at: nowIso,
    handoffs,
  });
}

function buildInherited(input: ReverseHandoffInput): RunInheritanceSnapshot {
  return buildRunInheritanceSnapshot({
    project: input.project,
    cwd: input.cwd,
    scope: input.scope,
    agent: input.agent,
    home_group_id: input.home_group_id,
    entry_form: input.entry_form,
  });
}

function toNotification(input: ReverseHandoffInput, createdAt: string): ReverseHandoffNotification {
  const inherited = buildInherited(input);
  return ReverseHandoffNotificationSchema.parse({
    handoff_id: buildHandoffId(input),
    session_id: input.session_id,
    run_id: input.run_id,
    revision: input.revision,
    created_at: createdAt,
    previous_captain_id: input.previous_captain_id,
    next_captain_id: input.next_captain_id,
    previous_holder_open_id: input.previous_holder_open_id,
    next_holder_open_id: input.next_holder_open_id,
    ...inherited,
  });
}

function toRecord(
  notification: ReverseHandoffNotification,
  patch: Partial<Pick<ReverseHandoffRecord, 'notify_failed' | 'notified_at' | 'last_error'>> = {},
): ReverseHandoffRecord {
  return ReverseHandoffRecordSchema.parse({
    ...notification,
    notify_failed: patch.notify_failed ?? false,
    notified_at: patch.notified_at !== undefined ? patch.notified_at : notification.created_at,
    last_error: patch.last_error !== undefined ? patch.last_error : null,
  });
}

export function createInlineReverseHandoffTransport(
  handler: (input: ReverseHandoffNotification) => Promise<void>,
): ReverseHandoffTransport {
  return {
    async notifyReverseAt(input): Promise<void> {
      await handler(input);
    },
  };
}

export function createMockReverseHandoffTransport(dataDir: string): ReverseHandoffTransport {
  const ledgerPath = reverseHandoffMockLedgerPath(dataDir);
  return {
    async notifyReverseAt(input): Promise<void> {
      mkdirSync(dirname(ledgerPath), { recursive: true });
      appendNdjsonLine(ledgerPath, JSON.stringify(ReverseHandoffNotificationSchema.parse(input)));
    },
  };
}

export function createGuardedReverseHandoffTransport(): ReverseHandoffTransport {
  return {
    async notifyReverseAt(): Promise<void> {
      throw new Error('reverse handoff reverse-@ egress requires explicit real-device authorization');
    },
  };
}

export async function publishReverseHandoff(options: PublishReverseHandoffOptions): Promise<PublishReverseHandoffResult> {
  const input = ReverseHandoffInputSchema.parse(options.handoff);
  const nowFn = options.nowFn ?? Date.now;
  const nowIso = new Date(nowFn()).toISOString();
  const statePath = runReverseHandoffStatePath(options.dataDir, input.run_id, options.botId ?? 'default');
  const current = readReverseHandoffState(statePath, input, nowIso);
  const handoffId = buildHandoffId(input);
  const existing = current.handoffs.find((item) => item.handoff_id === handoffId);
  if (existing) {
    return {
      notify_failed: existing.notify_failed,
      record: existing,
      state: current,
      statePath,
    };
  }

  const notification = toNotification(input, nowIso);

  try {
    await options.transport.notifyReverseAt(notification);
    const record = toRecord(notification, { notify_failed: false, notified_at: nowIso, last_error: null });
    const nextState = mergeReverseHandoffState(current, record, nowIso);
    writeReverseHandoffState(statePath, nextState);
    return {
      notify_failed: false,
      record,
      state: nextState,
      statePath,
    };
  } catch (error) {
    const record = toRecord(notification, {
      notify_failed: true,
      notified_at: null,
      last_error: error instanceof Error ? error.message : String(error),
    });
    const nextState = mergeReverseHandoffState(current, record, nowIso);
    writeReverseHandoffState(statePath, nextState);
    return {
      notify_failed: true,
      record,
      state: nextState,
      statePath,
    };
  }
}

export async function recordReverseHandoffFromSession(
  options: RecordReverseHandoffFromSessionOptions,
): Promise<PublishReverseHandoffResult | null> {
  const runId = options.runId ?? options.nextSession.latest_run_id;
  if (!runId) {
    return null;
  }
  if (
    options.previousSession.captain_id === options.nextSession.captain_id
    && options.previousSession.operator === options.nextSession.operator
  ) {
    return null;
  }

  const nowFn = options.nowFn ?? Date.now;
  return publishReverseHandoff({
    dataDir: options.dataDir,
    botId: options.botId,
    transport: options.transport,
    nowFn,
    handoff: {
      session_id: options.nextSession.session_id,
      run_id: runId,
      revision: options.revision,
      changed_at: new Date(nowFn()).toISOString(),
      previous_captain_id: options.previousSession.captain_id,
      next_captain_id: options.nextSession.captain_id,
      previous_holder_open_id: options.previousSession.operator,
      next_holder_open_id: options.nextSession.operator,
      project: options.nextSession.project,
      cwd: options.nextSession.cwd,
      scope: options.nextSession.scope,
      agent: options.nextSession.agent,
      home_group_id: options.nextSession.home_group_id,
      entry_form: options.nextSession.entry_form,
    },
  });
}
