import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { groupSyncDir, runDir } from '../paths.js';
import {
  GroupSyncCrossGroupReferenceInputSchema,
  GroupSyncCrossGroupReferenceSchema,
  GroupSyncCrossGroupReferenceSetSchema,
  type GroupSyncConfig,
  type GroupSyncCrossGroupReference,
  type GroupSyncCrossGroupReferenceInput,
  type GroupSyncCrossGroupReferenceSet,
  type GroupSyncReferenceTransport,
} from './contracts.js';

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  writeFileSync(temp, content);
  renameSync(temp, path);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    void promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function runGroupSyncReferencesPath(dataDir: string, runId: string, botId = 'default'): string {
  return join(runDir(dataDir, runId, botId), 'group-sync-xrefs.json');
}

function readReferenceSet(path: string, input: GroupSyncCrossGroupReferenceInput, nowIso: string): GroupSyncCrossGroupReferenceSet {
  if (!existsSync(path)) {
    return GroupSyncCrossGroupReferenceSetSchema.parse({
      session_id: input.session_id,
      run_id: input.run_id,
      last_revision: input.revision,
      updated_at: nowIso,
      references: [],
    });
  }
  return GroupSyncCrossGroupReferenceSetSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

function writeReferenceSet(path: string, state: GroupSyncCrossGroupReferenceSet): void {
  atomicWrite(path, JSON.stringify(state, null, 2));
}

function sanitizeIdPart(value: string | null | undefined): string {
  const raw = value?.trim() ?? '';
  if (raw.length === 0) return 'none';
  return raw.replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function buildReferenceId(input: GroupSyncCrossGroupReferenceInput): string {
  return [
    'xref',
    sanitizeIdPart(input.request_id),
    sanitizeIdPart(input.artifact_kind),
    sanitizeIdPart(input.target_thread_id),
    sanitizeIdPart(input.target_message_id ?? null),
  ].join(':');
}

function toReference(
  input: GroupSyncCrossGroupReferenceInput,
  nowIso: string,
  patch: Partial<Pick<GroupSyncCrossGroupReference, 'created_at' | 'synced_at' | 'sync_failed' | 'last_error'>> = {},
): GroupSyncCrossGroupReference {
  return GroupSyncCrossGroupReferenceSchema.parse({
    request_id: input.request_id,
    session_id: input.session_id,
    run_id: input.run_id,
    revision: input.revision,
    source_thread_id: input.source_thread_id,
    source_message_id: input.source_message_id ?? null,
    target_thread_id: input.target_thread_id,
    target_message_id: input.target_message_id ?? null,
    artifact_kind: input.artifact_kind,
    artifact_label: input.artifact_label,
    artifact_path: input.artifact_path ?? null,
    reference_id: buildReferenceId(input),
    created_at: patch.created_at ?? nowIso,
    synced_at: patch.synced_at ?? null,
    sync_failed: patch.sync_failed ?? false,
    last_error: patch.last_error ?? null,
  });
}

function mergeReferenceSet(state: GroupSyncCrossGroupReferenceSet, reference: GroupSyncCrossGroupReference, nowIso: string): GroupSyncCrossGroupReferenceSet {
  const references = state.references.filter((item) => item.reference_id !== reference.reference_id);
  references.push(reference);
  references.sort((left, right) => left.reference_id.localeCompare(right.reference_id));
  return GroupSyncCrossGroupReferenceSetSchema.parse({
    session_id: state.session_id,
    run_id: state.run_id,
    last_revision: Math.max(state.last_revision, reference.revision),
    updated_at: nowIso,
    references,
  });
}

export type PublishCrossGroupReferenceOptions = {
  dataDir: string;
  botId?: string;
  reference: GroupSyncCrossGroupReferenceInput;
  config: GroupSyncConfig;
  transport: GroupSyncReferenceTransport;
  nowFn?: () => number;
};

export type PublishCrossGroupReferenceResult = {
  sync_failed: boolean;
  reference: GroupSyncCrossGroupReference;
  state: GroupSyncCrossGroupReferenceSet;
  statePath: string;
};

export function groupSyncMockReferenceLedgerPath(dataDir: string): string {
  return join(groupSyncDir(dataDir), 'mock-xrefs.ndjson');
}

export async function publishCrossGroupReference(options: PublishCrossGroupReferenceOptions): Promise<PublishCrossGroupReferenceResult> {
  const input = GroupSyncCrossGroupReferenceInputSchema.parse(options.reference);
  const nowFn = options.nowFn ?? Date.now;
  const nowIso = new Date(nowFn()).toISOString();
  const statePath = runGroupSyncReferencesPath(options.dataDir, input.run_id, options.botId ?? 'default');
  const current = readReferenceSet(statePath, input, nowIso);
  const existing = current.references.find((item) => item.reference_id === buildReferenceId(input));
  if (existing && existing.sync_failed === false) {
    return {
      sync_failed: false,
      reference: existing,
      state: current,
      statePath,
    };
  }

  try {
    const reference = toReference(input, nowIso, {
      created_at: existing?.created_at ?? nowIso,
      synced_at: nowIso,
      sync_failed: false,
      last_error: null,
    });
    await withTimeout(options.transport.publishReference(reference), options.config.rpc_timeout_ms, 'group sync xref timeout');
    const nextState = mergeReferenceSet(current, reference, nowIso);
    writeReferenceSet(statePath, nextState);
    return {
      sync_failed: false,
      reference,
      state: nextState,
      statePath,
    };
  } catch (error) {
    const reference = toReference(input, nowIso, {
      created_at: existing?.created_at ?? nowIso,
      synced_at: null,
      sync_failed: true,
      last_error: error instanceof Error ? error.message : String(error),
    });
    const nextState = mergeReferenceSet(current, reference, nowIso);
    writeReferenceSet(statePath, nextState);
    return {
      sync_failed: true,
      reference,
      state: nextState,
      statePath,
    };
  }
}
