import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, readdirSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { auditMirrorPath, runCalendarHookStatePath, runDir as resolveRunDir, runsRootDir } from '../paths.js';
import type { AuditRecord, RunRegistryConfig, RunSpec, RunStatus, RunTailerEntry, RunUpserted } from './contracts.js';
import { RUN_STATUS } from './contracts.js';
import { extractShas, extractUrls } from './extractor.js';
import { ensureRunDoc } from './doc-sink.js';
import { loadRunRegistryConfig } from './config.js';
import type { DocSinkTransport } from './doc-sink-transport.js';
import { CalendarHookStateSchema } from '../calendar-hook/contracts.js';

type RejectedRecord = {
  audit_record_id: string;
  status: 'rejected';
  reason: 'parse_error' | 'missing_spec' | 'invalid_entry_form' | 'unknown_tool';
  raw_line: string;
  ts: string;
  run_id: string | null;
};

export type RunTailerOptions = {
  dataDir: string;
  mirrorPath?: string;
  batchFlushIntervalMs?: number;
  pollIntervalMs?: number;
  finalizeIntervalMs?: number;
  runFinalizeGraceMs?: number;
  nowFn?: () => number;
  config?: RunRegistryConfig;
  docSinkTransport?: DocSinkTransport;
  env?: NodeJS.ProcessEnv;
  onRunUpserted?: (event: RunUpserted, entry: RunTailerEntry) => void | Promise<void>;
};

type InternalEntry = RunTailerEntry & {
  session_id: string;
  next_revision: number;
  pending_initial: boolean;
  dirty: boolean;
  run_dir: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseMirrorLine(line: string): AuditRecord | RejectedRecord | null {
  if (!line.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (parsed['status'] === 'rejected') return parsed as unknown as RejectedRecord;
  if (
    typeof parsed['run_id'] === 'string'
    && typeof parsed['session_id'] === 'string'
    && typeof parsed['revision'] === 'number'
    && typeof parsed['ts'] === 'string'
  ) {
    return parsed as unknown as AuditRecord;
  }
  return null;
}

function parseTs(ts: string, fallback: number): number {
  const parsed = Date.parse(ts);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isTerminalStatus(value: string): value is 'done' | 'error' | 'cancelled' | 'failed' | 'stopped' {
  return value === 'done' || value === 'error' || value === 'cancelled' || value === 'failed' || value === 'stopped';
}

function mapTerminalStatus(value: 'done' | 'error' | 'cancelled' | 'failed' | 'stopped'): RunStatus {
  if (value === 'done') return RUN_STATUS.SUCCEEDED;
  if (value === 'cancelled' || value === 'stopped') return RUN_STATUS.CANCELLED;
  return RUN_STATUS.FAILED;
}

export class RunTailer {
  private readonly dataDir: string;
  private readonly mirrorPath: string;
  private readonly batchFlushIntervalMs: number;
  private readonly pollIntervalMs: number;
  private readonly finalizeIntervalMs: number;
  private readonly runFinalizeGraceMs: number;
  private readonly nowFn: () => number;
  private readonly config: RunRegistryConfig | null;
  private readonly docSinkTransport?: DocSinkTransport;
  private readonly env?: NodeJS.ProcessEnv;
  private readonly onRunUpserted?: (event: RunUpserted, entry: RunTailerEntry) => void | Promise<void>;
  private readonly entries = new Map<string, InternalEntry>();
  private readonly runDirByRunId = new Map<string, string | null>();
  private readonly finalizingRuns = new Set<string>();
  private readonly finalizerPromises = new Map<string, Promise<void>>();
  private offset = 0;
  private remainder = '';
  private pollTimer: NodeJS.Timeout | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private finalizeTimer: NodeJS.Timeout | null = null;

  constructor(options: RunTailerOptions) {
    this.dataDir = options.dataDir;
    this.mirrorPath = options.mirrorPath ?? auditMirrorPath(options.dataDir);
    this.batchFlushIntervalMs = options.batchFlushIntervalMs ?? 5_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 200;
    this.finalizeIntervalMs = options.finalizeIntervalMs ?? Math.min(options.runFinalizeGraceMs ?? 30_000, 200);
    this.runFinalizeGraceMs = options.runFinalizeGraceMs ?? 30_000;
    this.nowFn = options.nowFn ?? Date.now;
    this.config = options.config ?? this.loadConfigOrNull(options.env);
    this.docSinkTransport = options.docSinkTransport;
    this.env = options.env;
    this.onRunUpserted = options.onRunUpserted;
  }

  get size(): number {
    return this.entries.size;
  }

  getEntry(runId: string): RunTailerEntry | undefined {
    const entry = this.entries.get(runId);
    if (!entry) return undefined;
    return {
      run_id: entry.run_id,
      state: entry.state,
      first_event_ts: entry.first_event_ts,
      last_event_ts: entry.last_event_ts,
      event_count: entry.event_count,
      produced_doc_urls: [...entry.produced_doc_urls],
      commit_shas: [...entry.commit_shas],
      doc_sink_failed: entry.doc_sink_failed,
      calendar_block_id: entry.calendar_block_id,
      calendar_hook_failed: entry.calendar_hook_failed,
      spec: entry.spec,
    };
  }

  start(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => this.pollMirror(), this.pollIntervalMs);
    this.flushTimer = setInterval(() => this.flushDirtyEntries(), this.batchFlushIntervalMs);
    this.finalizeTimer = setInterval(() => this.finalizeEligibleEntries(), this.finalizeIntervalMs);
    this.pollMirror();
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.finalizeTimer) clearInterval(this.finalizeTimer);
    this.pollTimer = null;
    this.flushTimer = null;
    this.finalizeTimer = null;
  }

  async waitForIdle(): Promise<void> {
    await Promise.all([...this.finalizerPromises.values()]);
  }

  private pollMirror(): void {
    if (!existsSync(this.mirrorPath)) return;
    const { size } = statSync(this.mirrorPath);
    if (size < this.offset) {
      this.offset = 0;
      this.remainder = '';
    }
    if (size === this.offset) return;
    const chunk = Buffer.alloc(size - this.offset);
    const fd = openSync(this.mirrorPath, 'r');
    try {
      readSync(fd, chunk, 0, chunk.length, this.offset);
    } finally {
      closeSync(fd);
    }
    this.offset = size;
    const text = this.remainder + chunk.toString('utf8');
    const lines = text.split('\n');
    this.remainder = lines.pop() ?? '';
    for (const line of lines) this.processLine(line);
  }

  private processLine(line: string): void {
    const parsed = parseMirrorLine(line);
    if (!parsed || 'status' in parsed) return;
    const recordTs = parseTs(parsed.ts, this.nowFn());
    const runId = parsed.run_id || parsed.session_id || randomUUID();
    const entry = this.entries.get(runId) ?? this.createEntry(runId, parsed.session_id, recordTs);
    entry.last_event_ts = Math.max(entry.last_event_ts, recordTs);
    entry.event_count += 1;
    entry.session_id = parsed.session_id;
    entry.dirty = true;
    if (!entry.run_dir) entry.run_dir = this.findRunDir(runId, { allowRetry: true });
    if (!entry.spec) entry.spec = this.readRunSpec(runId);
    this.entries.set(runId, entry);
  }

  private loadConfigOrNull(env?: NodeJS.ProcessEnv): RunRegistryConfig | null {
    try {
      return loadRunRegistryConfig({ env });
    } catch {
      return null;
    }
  }

  private createEntry(runId: string, sessionId: string, recordTs: number): InternalEntry {
    return {
      run_id: runId,
      state: 'ACTIVE',
      first_event_ts: recordTs,
      last_event_ts: recordTs,
      event_count: 0,
      produced_doc_urls: [],
      commit_shas: [],
      doc_sink_failed: false,
      calendar_block_id: null,
      calendar_hook_failed: false,
      spec: this.readRunSpec(runId),
      session_id: sessionId,
      next_revision: 0,
      pending_initial: true,
      dirty: false,
      run_dir: this.findRunDir(runId, { allowRetry: true }),
    };
  }

  private flushDirtyEntries(): void {
    for (const entry of this.entries.values()) {
      if (entry.state !== 'ACTIVE') continue;
      if (entry.pending_initial) {
        this.emitUpsert(entry, RUN_STATUS.PENDING);
        entry.pending_initial = false;
        entry.dirty = false;
        continue;
      }
      if (!entry.dirty) continue;
      this.emitUpsert(entry, RUN_STATUS.ACTIVE);
      entry.dirty = false;
    }
  }

  private finalizeEligibleEntries(): void {
    const now = this.nowFn();
    for (const entry of this.entries.values()) {
      if (entry.state !== 'ACTIVE') continue;
      const signalA = this.readTerminalStatus(entry);
      if (signalA) {
        this.finalizeEntry(entry, signalA);
        continue;
      }
      if (now - entry.last_event_ts > this.runFinalizeGraceMs) {
        this.finalizeEntry(entry, RUN_STATUS.SUCCEEDED);
      }
    }
  }

  private finalizeEntry(entry: InternalEntry, status: RunStatus): void {
    if (this.finalizingRuns.has(entry.run_id)) return;
    this.finalizingRuns.add(entry.run_id);
    entry.state = 'FINALIZING';
    if (entry.pending_initial) {
      this.emitUpsert(entry, RUN_STATUS.PENDING);
      entry.pending_initial = false;
    }
    if (!entry.spec) entry.spec = this.readRunSpec(entry.run_id);
    this.refreshArtifacts(entry);
    this.emitUpsert(entry, status);
    entry.dirty = false;
    entry.state = 'DONE';
    const finalizer = this.runDocSink(entry, status).finally(() => {
      this.finalizingRuns.delete(entry.run_id);
      this.finalizerPromises.delete(entry.run_id);
    });
    this.finalizerPromises.set(entry.run_id, finalizer);
    void finalizer;
  }

  private refreshArtifacts(entry: InternalEntry): void {
    const records = this.readRunRecords(entry.run_id);
    entry.commit_shas = extractShas(records);
    if (this.config) {
      entry.produced_doc_urls = extractUrls(records, this.config.doc_url_allowlist);
    }
    const calendarState = this.readCalendarHookState(entry.run_id, entry.spec?.botId);
    entry.calendar_block_id = calendarState?.calendar_block_id ?? null;
    entry.calendar_hook_failed = calendarState?.calendar_hook_failed ?? false;
  }

  private readCalendarHookState(runId: string, botId = 'default') {
    const path = runCalendarHookStatePath(this.dataDir, runId, botId);
    if (!existsSync(path)) return null;
    try {
      return CalendarHookStateSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    } catch {
      return null;
    }
  }

  private async runDocSink(entry: InternalEntry, status: RunStatus): Promise<void> {
    if (!this.config) return;
    const docResult = await ensureRunDoc({
      dataDir: this.dataDir,
      runId: entry.run_id,
      botId: entry.spec?.botId,
      status,
      existingDocUrls: entry.produced_doc_urls,
      config: this.config,
      transport: this.docSinkTransport,
      env: this.env,
    });
    if (docResult.reason === 'created' || docResult.reason === 'already_succeeded' || docResult.reason === 'existing_registry_url' || docResult.reason === 'failed') {
      entry.produced_doc_urls = docResult.produced_doc_urls;
      entry.doc_sink_failed = docResult.doc_sink_failed;
      this.emitUpsert(entry, status);
    }
  }

  private emitUpsert(entry: InternalEntry, status: RunStatus): void {
    const event: RunUpserted = {
      event: 'RunUpserted',
      run_id: entry.run_id,
      session_id: entry.session_id,
      revision: entry.next_revision,
      status,
      cost_tokens: null,
      cost_minutes: this.computeCostMinutes(entry),
      produced_doc_urls: [...entry.produced_doc_urls],
      commit_shas: [...entry.commit_shas],
      doc_sink_failed: entry.doc_sink_failed,
      calendar_block_id: entry.calendar_block_id,
      calendar_hook_failed: entry.calendar_hook_failed,
      updated_at: new Date(this.nowFn()).toISOString(),
    };
    entry.next_revision += 1;
    if (this.onRunUpserted) void Promise.resolve(this.onRunUpserted(event, this.getEntry(entry.run_id)!));
  }

  private readRunRecords(runId: string): AuditRecord[] {
    if (!existsSync(this.mirrorPath)) return [];
    try {
      return readFileSync(this.mirrorPath, 'utf8')
        .split('\n')
        .map((line) => parseMirrorLine(line))
        .filter((record): record is AuditRecord => record !== null && !('status' in record) && record.run_id === runId);
    } catch {
      return [];
    }
  }

  private computeCostMinutes(entry: InternalEntry): number | null {
    const startedAt = entry.spec?.startedAt ? Date.parse(entry.spec.startedAt) : entry.first_event_ts;
    if (!Number.isFinite(startedAt)) return null;
    return Math.max(0, Math.floor((entry.last_event_ts - startedAt) / 60_000));
  }

  private readTerminalStatus(entry: InternalEntry): RunStatus | null {
    const runDir = entry.run_dir ?? this.findRunDir(entry.run_id, { allowRetry: true });
    if (!runDir) return null;
    entry.run_dir = runDir;
    const statusPath = join(runDir, 'status');
    if (!existsSync(statusPath)) return null;
    try {
      const status = readFileSync(statusPath, 'utf8').trim();
      return isTerminalStatus(status) ? mapTerminalStatus(status) : null;
    } catch {
      return null;
    }
  }

  private readRunSpec(runId: string): RunSpec | null {
    const runDir = this.findRunDir(runId, { allowRetry: true });
    if (!runDir) return null;
    const specPath = join(runDir, 'spec.json');
    if (!existsSync(specPath)) return null;
    try {
      return JSON.parse(readFileSync(specPath, 'utf8')) as RunSpec;
    } catch {
      return null;
    }
  }

  private findRunDir(runId: string, options: { allowRetry: boolean } = { allowRetry: false }): string | null {
    const cached = this.runDirByRunId.get(runId);
    if (cached) return cached;
    if (cached === null && !options.allowRetry) return null;
    const runsRoot = runsRootDir(this.dataDir);
    if (!existsSync(runsRoot)) {
      if (!options.allowRetry) this.runDirByRunId.set(runId, null);
      return null;
    }
    try {
      for (const botEntry of readdirSync(runsRoot, { withFileTypes: true })) {
        if (!botEntry.isDirectory()) continue;
        const candidate = resolveRunDir(this.dataDir, runId, botEntry.name);
        if (existsSync(candidate)) {
          this.runDirByRunId.set(runId, candidate);
          return candidate;
        }
      }
    } catch {
      if (!options.allowRetry) this.runDirByRunId.set(runId, null);
      return null;
    }
    if (!options.allowRetry) this.runDirByRunId.set(runId, null);
    return null;
  }
}
