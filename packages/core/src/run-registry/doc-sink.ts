import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildDocBody, classifyDocSink } from './doc-sink-classifier.js';
import { createLarkDocTransport, type DocSinkTransport } from './doc-sink-transport.js';
import { replayEventsFromNdjson } from '../runner/event-replay.js';
import { runDocFallbackPath, runDocSinkLockPath, runDocSinkStatePath, runEventsPath } from '../paths.js';
import { RUN_REGISTRY_ERROR_CODES, type RunRecord, type RunRegistryConfig, type RunStatus } from './contracts.js';

export type DocSinkState = {
  run_id: string;
  status: 'succeeded' | 'failed';
  doc_url: string | null;
  error_code: string | null;
  error_message: string | null;
  updated_at: string;
};

export type EnsureRunDocOptions = {
  dataDir: string;
  runId: string;
  botId?: string;
  status: RunStatus;
  existingDocUrls?: string[];
  config: RunRegistryConfig;
  transport?: DocSinkTransport;
  env?: NodeJS.ProcessEnv;
};

export type EnsureRunDocResult = {
  produced_doc_urls: string[];
  doc_sink_failed: boolean;
  statePath: string;
  fallbackPath: string;
  reason: 'already_succeeded' | 'existing_registry_url' | 'not_terminal' | 'not_longform' | 'created' | 'failed' | 'locked';
};

function readState(path: string): DocSinkState | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as DocSinkState;
  } catch {
    return null;
  }
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  writeFileSync(temp, content);
  renameSync(temp, path);
}

function writeState(path: string, value: DocSinkState): void {
  atomicWrite(path, JSON.stringify(value, null, 2));
}

function writeFallback(path: string, content: string): void {
  atomicWrite(path, content);
}

function buildFailureState(runId: string, message: string): DocSinkState {
  return {
    run_id: runId,
    status: 'failed',
    doc_url: null,
    error_code: RUN_REGISTRY_ERROR_CODES.E_DOC_SINK_WRITE,
    error_message: message,
    updated_at: new Date().toISOString(),
  };
}

function mergeProducedDocUrls(existing: readonly string[], next: readonly string[]): string[] {
  return [...new Set([...existing, ...next])];
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
      // ignore stale cleanup failure
    }
  }
}

export function buildRunRecordFromUpserted(input: {
  event: {
    run_id: string;
    status: RunStatus;
    cost_tokens: number | null;
    cost_minutes: number | null;
    produced_doc_urls: string[];
    commit_shas: string[];
  };
  entry: {
    spec: {
      startedAt?: string;
      userOpenId?: string;
      botId?: string;
      threadId?: string;
      cwd?: string;
      consentLevel?: string;
      agentId?: string;
      model?: string | null;
    } | null;
    doc_sink_failed?: boolean;
  };
}): RunRecord {
  const spec = input.entry.spec;
  const threadId = spec?.threadId ?? '';
  return {
    run_id: input.event.run_id,
    created_at: spec?.startedAt ?? new Date().toISOString(),
    operator: spec?.userOpenId ?? 'unknown',
    project: threadId ? `${spec?.botId ?? 'default'}_${threadId.split('/')[0] ?? ''}` : null,
    cwd: spec?.cwd ?? '',
    scope: spec?.consentLevel ?? 'normal',
    agent: spec?.agentId ?? 'claude-code',
    cmd: spec?.model ? `${spec?.agentId ?? 'claude-code'} --model ${spec.model}` : (spec?.agentId ?? 'claude-code'),
    status: input.event.status,
    cost_tokens: input.event.cost_tokens,
    cost_minutes: input.event.cost_minutes,
    produced_doc_urls: input.event.produced_doc_urls,
    commit_shas: input.event.commit_shas,
    risk_level: 'unknown',
    home_group_id: threadId || null,
    entry_form: threadId ? 'im' : 'cli',
    doc_sink_failed: input.entry.doc_sink_failed ?? false,
    calendar_block_id: (input.event as { calendar_block_id?: string | null }).calendar_block_id ?? null,
    calendar_hook_failed: (input.entry as { calendar_hook_failed?: boolean }).calendar_hook_failed ?? false,
  };
}

export async function ensureRunDoc(options: EnsureRunDocOptions): Promise<EnsureRunDocResult> {
  const botId = options.botId ?? 'default';
  const statePath = runDocSinkStatePath(options.dataDir, options.runId, botId);
  const fallbackPath = runDocFallbackPath(options.dataDir, options.runId, botId);
  const lockPath = runDocSinkLockPath(options.dataDir, options.runId, botId);

  if (options.status !== 'succeeded' && options.status !== 'failed' && options.status !== 'cancelled') {
    return {
      produced_doc_urls: options.existingDocUrls ?? [],
      doc_sink_failed: false,
      statePath,
      fallbackPath,
      reason: 'not_terminal',
    };
  }

  const existingState = readState(statePath);
  if (existingState?.status === 'succeeded' && existingState.doc_url) {
    return {
      produced_doc_urls: mergeProducedDocUrls(options.existingDocUrls ?? [], [existingState.doc_url]),
      doc_sink_failed: false,
      statePath,
      fallbackPath,
      reason: 'already_succeeded',
    };
  }

  const eventsPath = runEventsPath(options.dataDir, options.runId, botId);
  const replay = replayEventsFromNdjson(eventsPath);
  if (replay.skipped) {
    const message = replay.errors.join('; ') || 'event replay skipped';
    writeState(statePath, buildFailureState(options.runId, message));
    writeFallback(fallbackPath, `Run ID: ${options.runId}\n\n${message}`);
    return {
      produced_doc_urls: [],
      doc_sink_failed: true,
      statePath,
      fallbackPath,
      reason: 'failed',
    };
  }

  const classification = classifyDocSink(replay.events, options.runId);
  if (!classification.shouldSink) {
    return {
      produced_doc_urls: [],
      doc_sink_failed: false,
      statePath,
      fallbackPath,
      reason: 'not_longform',
    };
  }

  const lockFd = acquireLock(lockPath);
  if (lockFd === null) {
    const refreshedState = readState(statePath);
    if (refreshedState?.status === 'succeeded' && refreshedState.doc_url) {
      return {
        produced_doc_urls: [refreshedState.doc_url],
        doc_sink_failed: false,
        statePath,
        fallbackPath,
        reason: 'already_succeeded',
      };
    }
    return {
      produced_doc_urls: [],
      doc_sink_failed: false,
      statePath,
      fallbackPath,
      reason: 'locked',
    };
  }

  const transport = options.transport ?? createLarkDocTransport();
  const body = buildDocBody(options.runId, classification.text);
  try {
    const created = await transport.create({
      runId: options.runId,
      title: classification.title,
      body,
      env: options.env,
    });
    writeState(statePath, {
      run_id: options.runId,
      status: 'succeeded',
      doc_url: created.url,
      error_code: null,
      error_message: null,
      updated_at: new Date().toISOString(),
    });
    return {
      produced_doc_urls: [created.url],
      doc_sink_failed: false,
      statePath,
      fallbackPath,
      reason: 'created',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeState(statePath, buildFailureState(options.runId, message));
    writeFallback(fallbackPath, body);
    return {
      produced_doc_urls: [],
      doc_sink_failed: true,
      statePath,
      fallbackPath,
      reason: 'failed',
    };
  } finally {
    releaseLock(lockPath, lockFd);
  }
}
