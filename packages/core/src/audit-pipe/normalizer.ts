import { randomUUID } from 'node:crypto';
import type { AuditRecord, EntryDetail, EventType, RejectedRecord, RunSpec, ToolUseEvent } from './contracts.js';

const revisionByKey = new Map<string, number>();
const recordIdByKey = new Map<string, string>();
let nextRevision = 1;

type NormalizeResult = { kind: 'audit'; record: AuditRecord } | { kind: 'rejected'; record: RejectedRecord };

function cacheKey(runId: string, toolUseId: string): string {
  return `${runId}:${toolUseId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function classifyBash(command: string): EventType {
  if (/\$\{?[A-Z][A-Z0-9_]*\}?/.test(command)) return 'env_access';
  if (/\bgit\b/.test(command)) return 'git_op';
  return 'shell_exec';
}

/**
 * Check whether a tool_use input references a (potentially sensitive) env var.
 * Catches `$NAME`, `${NAME}` inside `command`, plus `env.NAME` / `process.env.NAME`.
 * Returns the matched names so callers can emit an independent env_filter_hit flag.
 */
export function detectEnvVarReferences(input: unknown): string[] {
  const found = new Set<string>();
  if (!input || typeof input !== 'object') return [];
  const command = (input as { command?: unknown }).command;
  if (typeof command === 'string' && command) {
    for (const match of command.matchAll(/\$\{?([A-Z][A-Z0-9_]*)\}?/g)) {
      if (match[1]) found.add(match[1]);
    }
    for (const match of command.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) {
      if (match[1]) found.add(match[1]);
    }
  }
  return [...found].sort();
}

function deriveAction(event: ToolUseEvent): EventType {
  if (event.name === 'Read' || event.name === 'Glob' || event.name === 'Grep') return 'file_read';
  if (event.name === 'Write' || event.name === 'Edit') return 'file_write';
  if (event.name === 'WebSearch' || event.name === 'WebFetch') return 'network_call';
  if (event.name === 'Bash') {
    const command = isRecord(event.input) ? readString(event.input['command']) : null;
    return classifyBash(command ?? '');
  }
  return 'other';
}

function deriveResource(action: EventType, input: unknown): string {
  const record = isRecord(input) ? input : {};
  if (action === 'file_read' || action === 'file_write') {
    return readString(record['file_path']) ?? readString(record['pattern']) ?? 'unknown';
  }
  if (action === 'shell_exec' || action === 'env_access' || action === 'git_op') {
    return (readString(record['command']) ?? 'unknown').slice(0, 500);
  }
  if (action === 'network_call') {
    return readString(record['url']) ?? readString(record['query']) ?? 'unknown';
  }
  return JSON.stringify(input).slice(0, 500);
}

function deriveEntry(spec: RunSpec): { entryForm: 'im' | 'cli'; entryDetail: EntryDetail } | null {
  if (typeof spec.sourceMessageId !== 'string' || typeof spec.userOpenId !== 'string' || typeof spec.threadId !== 'string' || typeof spec.host !== 'string') {
    return null;
  }
  if (spec.sourceMessageId.length > 0) {
    return { entryForm: 'im', entryDetail: { source_message_id: spec.sourceMessageId, user_open_id: spec.userOpenId, thread_id: spec.threadId } };
  }
  return { entryForm: 'cli', entryDetail: { user_open_id: spec.userOpenId, host: spec.host } };
}

function createRejected(reason: RejectedRecord['reason'], runId: string | null, rawLine: string, now: string): RejectedRecord {
  return { audit_record_id: randomUUID(), status: 'rejected', reason, raw_line: rawLine.slice(0, 2048), ts: now, run_id: runId };
}

export function resetNormalizerState(): void {
  revisionByKey.clear();
  recordIdByKey.clear();
  nextRevision = 1;
}

export function hydrateNormalizer(records: AuditRecord[]): void {
  let maxRevision = nextRevision - 1;
  for (const record of records) {
    const key = cacheKey(record.run_id, record.raw_tool_use_id);
    revisionByKey.set(key, record.revision);
    recordIdByKey.set(key, record.audit_record_id);
    if (record.revision > maxRevision) maxRevision = record.revision;
  }
  nextRevision = Math.max(nextRevision, maxRevision + 1);
}

export function normalize(event: ToolUseEvent, spec: RunSpec | null, now = new Date().toISOString(), rawLine = JSON.stringify(event)): NormalizeResult {
  if (!spec) return { kind: 'rejected', record: createRejected('missing_spec', null, rawLine, now) };
  const entry = deriveEntry(spec);
  if (!entry) return { kind: 'rejected', record: createRejected('invalid_entry_form', spec.runId, rawLine, now) };
  const key = cacheKey(spec.runId, event.id);
  const revision = revisionByKey.get(key) ?? nextRevision++;
  revisionByKey.set(key, revision);
  const auditRecordId = recordIdByKey.get(key) ?? randomUUID();
  recordIdByKey.set(key, auditRecordId);
  const action = deriveAction(event);
  const envHits = detectEnvVarReferences(event.input);
  return {
    kind: 'audit',
    record: {
      audit_record_id: auditRecordId,
      session_id: spec.threadId,
      run_id: spec.runId,
      revision,
      actor: spec.userOpenId,
      action,
      resource: deriveResource(action, event.input),
      ts: now,
      entry_form: entry.entryForm,
      entry_detail: entry.entryDetail,
      agent_id: 'claude-code',
      raw_tool_use_id: event.id,
      raw_tool_name: event.name,
      ...(envHits.length > 0 ? { env_filter_hit: true } : {}),
    },
  };
}
