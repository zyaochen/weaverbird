import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { groupSyncDir, runDir, runDocFallbackPath, runDocSinkStatePath } from '../paths.js';
import { ensureRunDoc, type DocSinkTransport, type RunRegistryConfig } from '../run-registry/index.js';
import {
  GroupSyncAutoDocArtifactSchema,
  GroupSyncAutoDocArtifactSetSchema,
  GroupSyncAutoDocInputSchema,
  type GroupSyncAutoDocArtifact,
  type GroupSyncAutoDocArtifactSet,
  type GroupSyncAutoDocInput,
  type GroupSyncConfig,
} from './contracts.js';

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  writeFileSync(temp, content);
  renameSync(temp, path);
}

function runGroupSyncAutoDocsPath(dataDir: string, runId: string, botId = 'default'): string {
  return join(runDir(dataDir, runId, botId), 'group-sync-docs.json');
}

function readArtifactSet(path: string, input: GroupSyncAutoDocInput, nowIso: string): GroupSyncAutoDocArtifactSet {
  if (!existsSync(path)) {
    return GroupSyncAutoDocArtifactSetSchema.parse({
      session_id: input.session_id,
      run_id: input.run_id,
      last_revision: input.revision,
      updated_at: nowIso,
      artifacts: [],
    });
  }
  return GroupSyncAutoDocArtifactSetSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

function writeArtifactSet(path: string, state: GroupSyncAutoDocArtifactSet): void {
  atomicWrite(path, JSON.stringify(state, null, 2));
}

function sanitizeIdPart(value: string | null | undefined): string {
  const raw = value?.trim() ?? '';
  if (raw.length === 0) return 'none';
  return raw.replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function buildSyncId(input: GroupSyncAutoDocInput): string {
  return [
    'autodoc',
    sanitizeIdPart(input.request_id),
    sanitizeIdPart(input.artifact_id),
    sanitizeIdPart(input.sink_run_id),
  ].join(':');
}

function readDocSinkError(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { error_message?: unknown };
    return typeof parsed.error_message === 'string' && parsed.error_message.length > 0 ? parsed.error_message : null;
  } catch {
    return null;
  }
}

function toArtifact(
  input: GroupSyncAutoDocInput,
  nowIso: string,
  patch: Partial<Omit<GroupSyncAutoDocArtifact, keyof GroupSyncAutoDocInput | 'sync_id'>> = {},
): GroupSyncAutoDocArtifact {
  return GroupSyncAutoDocArtifactSchema.parse({
    request_id: input.request_id,
    session_id: input.session_id,
    run_id: input.run_id,
    revision: input.revision,
    artifact_id: input.artifact_id,
    artifact_label: input.artifact_label,
    artifact_path: input.artifact_path ?? null,
    sink_run_id: input.sink_run_id,
    terminal_status: input.terminal_status,
    existing_doc_urls: input.existing_doc_urls,
    sync_id: buildSyncId(input),
    doc_urls: patch.doc_urls ?? [],
    doc_sink_failed: patch.doc_sink_failed ?? false,
    sync_failed: patch.sync_failed ?? false,
    sink_reason: patch.sink_reason ?? 'not_longform',
    doc_state_path: patch.doc_state_path ?? '',
    fallback_path: patch.fallback_path ?? '',
    created_at: patch.created_at ?? nowIso,
    synced_at: patch.synced_at ?? null,
    last_error: patch.last_error ?? null,
  });
}

function mergeArtifactSet(state: GroupSyncAutoDocArtifactSet, artifact: GroupSyncAutoDocArtifact, nowIso: string): GroupSyncAutoDocArtifactSet {
  const artifacts = state.artifacts.filter((item) => item.sync_id !== artifact.sync_id);
  artifacts.push(artifact);
  artifacts.sort((left, right) => left.sync_id.localeCompare(right.sync_id));
  return GroupSyncAutoDocArtifactSetSchema.parse({
    session_id: state.session_id,
    run_id: state.run_id,
    last_revision: Math.max(state.last_revision, artifact.revision),
    updated_at: nowIso,
    artifacts,
  });
}

export type PublishAutoDocArtifactOptions = {
  dataDir: string;
  botId?: string;
  doc: GroupSyncAutoDocInput;
  config: GroupSyncConfig;
  runRegistryConfig: RunRegistryConfig;
  transport: DocSinkTransport;
  env?: NodeJS.ProcessEnv;
  nowFn?: () => number;
};

export type PublishAutoDocArtifactResult = {
  sync_failed: boolean;
  artifact: GroupSyncAutoDocArtifact;
  state: GroupSyncAutoDocArtifactSet;
  statePath: string;
};

export function groupSyncMockAutoDocLedgerPath(dataDir: string): string {
  return join(groupSyncDir(dataDir), 'mock-docs.ndjson');
}

export async function publishAutoDocArtifact(options: PublishAutoDocArtifactOptions): Promise<PublishAutoDocArtifactResult> {
  const input = GroupSyncAutoDocInputSchema.parse(options.doc);
  const nowFn = options.nowFn ?? Date.now;
  const nowIso = new Date(nowFn()).toISOString();
  const botId = options.botId ?? 'default';
  const statePath = runGroupSyncAutoDocsPath(options.dataDir, input.run_id, botId);
  const current = readArtifactSet(statePath, input, nowIso);
  const existing = current.artifacts.find((item) => item.sync_id === buildSyncId(input));
  if (existing && existing.sync_failed === false) {
    return {
      sync_failed: false,
      artifact: existing,
      state: current,
      statePath,
    };
  }

  try {
    const docResult = await ensureRunDoc({
      dataDir: options.dataDir,
      runId: input.sink_run_id,
      botId,
      status: input.terminal_status,
      existingDocUrls: input.existing_doc_urls,
      config: options.runRegistryConfig,
      transport: options.transport,
      env: options.env,
    });
    const lastError = docResult.doc_sink_failed ? readDocSinkError(docResult.statePath) : null;
    const artifact = toArtifact(input, nowIso, {
      created_at: existing?.created_at ?? nowIso,
      doc_urls: docResult.produced_doc_urls,
      doc_sink_failed: docResult.doc_sink_failed,
      sync_failed: docResult.doc_sink_failed,
      sink_reason: docResult.reason,
      doc_state_path: docResult.statePath,
      fallback_path: docResult.fallbackPath,
      synced_at: docResult.doc_sink_failed ? null : nowIso,
      last_error: lastError,
    });
    const nextState = mergeArtifactSet(current, artifact, nowIso);
    writeArtifactSet(statePath, nextState);
    return {
      sync_failed: artifact.sync_failed,
      artifact,
      state: nextState,
      statePath,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const docStatePath = runDocSinkStatePath(options.dataDir, input.sink_run_id, botId);
    const fallbackPath = runDocFallbackPath(options.dataDir, input.sink_run_id, botId);
    const artifact = toArtifact(input, nowIso, {
      created_at: existing?.created_at ?? nowIso,
      doc_urls: [],
      doc_sink_failed: true,
      sync_failed: true,
      sink_reason: 'failed',
      doc_state_path: docStatePath,
      fallback_path: fallbackPath,
      synced_at: null,
      last_error: message,
    });
    const nextState = mergeArtifactSet(current, artifact, nowIso);
    writeArtifactSet(statePath, nextState);
    return {
      sync_failed: true,
      artifact,
      state: nextState,
      statePath,
    };
  }
}
