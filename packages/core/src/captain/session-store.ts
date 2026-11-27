import * as Lark from '@larksuiteoapi/node-sdk';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ZodSchema } from 'zod';
import { loadConfig } from '../config/registry.js';
import { CODES, ConfigError } from '../config/errors.js';
import { captainSessionsWalDir, configFile, legacyConfigJsonPath, resolveDataDir } from '../paths.js';
import {
  CAPTAIN_ERROR_CODES,
  CaptainConfigSchema,
  CaptainError,
  SessionRecordSchema,
  type CaptainConfig,
  type CaptainMirrorEntry,
  type SessionRecord,
} from './contracts.js';
import { DEFAULT_RETRY_POLICY } from '../audit-pipe/contracts.js';

type RetryPolicy = typeof DEFAULT_RETRY_POLICY;
type FieldListItem = { field_name?: string };
type BitableRecordRow = { record_id?: string; fields?: Record<string, unknown> };
type FieldListResponse = { code?: number; msg?: string; data?: { items?: FieldListItem[] } };
type SearchResponse = { code?: number; msg?: string; data?: { items?: BitableRecordRow[] } };
type BatchCreateResponse = { code?: number; msg?: string; data?: { records?: Array<{ record_id?: string }> } };
type BatchUpdateResponse = { code?: number; msg?: string; data?: { records?: Array<{ record_id?: string }> } };

type BitableFieldValue = string | number | boolean | Array<{ id: string }>;

type SearchPayload = {
  path: { app_token: string; table_id: string };
  params?: { page_size?: number };
  data?: { field_names?: string[]; filter?: { conjunction: 'and' | 'or'; conditions?: Array<{ field_name: string; operator: 'is'; value?: string[] }> } };
};

type BatchCreatePayload = {
  path: { app_token: string; table_id: string };
  params?: { client_token?: string };
  data: { records: Array<{ fields: Record<string, BitableFieldValue> }> };
};

type BatchUpdatePayload = {
  path: { app_token: string; table_id: string };
  data: { records: Array<{ record_id: string; fields: Record<string, BitableFieldValue> }> };
};

type FieldListPayload = {
  path: { app_token: string; table_id: string };
  params?: { page_size?: number };
};

export interface CaptainStoreClientLike {
  bitable: {
    appTableField: { list(payload?: FieldListPayload): Promise<FieldListResponse> };
    appTableRecord: {
      search(payload?: SearchPayload): Promise<SearchResponse>;
      batchCreate(payload?: BatchCreatePayload): Promise<BatchCreateResponse>;
      batchUpdate(payload?: BatchUpdatePayload): Promise<BatchUpdateResponse>;
    };
  };
}

type SessionWalEntry = {
  seq: number;
  session_id: string;
  record: SessionRecord;
  attempts: number;
  state: 'queued' | 'pending-sync';
  enqueued_at: string;
};

export type CaptainSessionStore = {
  config: CaptainConfig;
  validateSchema(): Promise<void>;
  upsert(record: SessionRecord): Promise<{ ok: boolean; attempt: number }>;
  /**
   * M11-D D1 (2026-08-04 owner-authorized): CAS-style upsert keyed by
   * `(session_id, expectedRevision)`. The remote row's `revision` must equal
   * `expectedRevision` for the write to apply. On mismatch the store raises
   * `CaptainError(E_REVISION_MISMATCH)` and leaves the remote row untouched.
   *
   * On success the persisted record is written with `revision = expectedRevision + 1`.
   * Cross-device attach uses this so two hosts racing to claim a session cannot
   * both "win"; the loser sees the mismatch and re-reads state before retrying.
   */
  upsertWithRevision(record: SessionRecord, expectedRevision: number): Promise<{ ok: boolean; attempt: number; newRevision: number }>;
  reconcile(): Promise<SessionRecord[]>;
  syncOnce(): Promise<number>;
  startSyncWorker(): NodeJS.Timeout;
  stopSyncWorker(): void;
};

export type CreateCaptainSessionStoreOptions = {
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  _client?: CaptainStoreClientLike;
  _retryOverride?: RetryPolicy;
  _syncIntervalMs?: number;
};

function resolveConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(configFile(resolveDataDir({ dataDir: env['WB_DATA_DIR'] }), 'captain-store'));
}

function createClient(config: CaptainConfig): CaptainStoreClientLike {
  const domain = config.lark_domain === 'LarkSuite' ? Lark.Domain.Lark : config.lark_domain === 'LarkOffice' ? 'https://open.larkoffice.com' : Lark.Domain.Lark;
  return new Lark.Client({
    appId: config.app_id,
    appSecret: config.app_secret,
    domain,
  }) as unknown as CaptainStoreClientLike;
}

function loadCaptainStoreConfig(options: { configPath?: string; env?: NodeJS.ProcessEnv } = {}): CaptainConfig {
  const env = options.env ?? process.env;
  const dataDir = resolveDataDir({ dataDir: env['WB_DATA_DIR'] });
  const configPath = resolve(options.configPath ?? resolveConfigPath(env));
  const legacyPath = resolve(legacyConfigJsonPath(dataDir));

  if (!options.configPath) {
    if (existsSync(configPath)) {
      const stat = statSync(configPath);
      if ((stat.mode & 0o777) !== 0o600) {
        console.warn('[captain] captain-store.json mode is not 0600, recommend chmod 600');
      }
      try {
        return loadConfig(
          dataDir,
          'captain-store',
          CaptainConfigSchema as unknown as ZodSchema<CaptainConfig>,
        );
      } catch (error) {
        if (error instanceof ConfigError && error.code === CODES.E_CONFIG_MISSING) {
          throw new CaptainError(CAPTAIN_ERROR_CODES.E_CONFIG_INCOMPLETE, 'captain-store config is missing', error);
        }
        throw new CaptainError(CAPTAIN_ERROR_CODES.E_CONFIG_INCOMPLETE, 'captain-store config is invalid', error);
      }
    }

    if (existsSync(legacyPath)) {
    const stat = statSync(legacyPath);
    if ((stat.mode & 0o777) !== 0o600) {
      console.warn('[captain] config.json mode is not 0600, recommend chmod 600');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(legacyPath, 'utf8'));
    } catch (error) {
      throw new CaptainError(CAPTAIN_ERROR_CODES.E_CONFIG_INCOMPLETE, `failed to parse ${legacyPath}: ${error instanceof Error ? error.message : String(error)}`, error);
    }
    const captain = typeof parsed === 'object' && parsed !== null ? (parsed as { captain?: unknown }).captain : undefined;
    if (typeof captain !== 'object' || captain === null) {
      throw new CaptainError(CAPTAIN_ERROR_CODES.E_CONFIG_INCOMPLETE, 'captain config is missing');
    }
      console.warn('[captain] deprecated legacy config.json path in use; migrate to config/captain-store.json');
      try {
        return CaptainConfigSchema.parse(captain);
      } catch (error) {
        throw new CaptainError(CAPTAIN_ERROR_CODES.E_CONFIG_INCOMPLETE, 'captain-store config is invalid', error);
      }
    }

    throw new CaptainError(CAPTAIN_ERROR_CODES.E_CONFIG_INCOMPLETE, 'captain-store config is missing');
  }

  const stat = statSync(configPath);
  if ((stat.mode & 0o777) !== 0o600) {
    console.warn('[captain] captain-store.json mode is not 0600, recommend chmod 600');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw new CaptainError(CAPTAIN_ERROR_CODES.E_CONFIG_INCOMPLETE, `failed to parse ${configPath}: ${error instanceof Error ? error.message : String(error)}`, error);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new CaptainError(CAPTAIN_ERROR_CODES.E_CONFIG_INCOMPLETE, 'captain-store config is missing');
  }
  const missing = ['bitable_base_id', 'sessions_table_id', 'app_id', 'app_secret', 'lark_domain', 'captain_state_path', 'captain_toml_path']
    .filter((key) => !(parsed as Record<string, unknown>)[key]);
  if (missing.length > 0) {
    throw new CaptainError(CAPTAIN_ERROR_CODES.E_CONFIG_INCOMPLETE, `missing captain-store config: ${missing.join(', ')}`);
  }
  return CaptainConfigSchema.parse(parsed);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextDelay(retry: RetryPolicy, attempt: number): number {
  const base = Math.min(retry.baseMs * retry.factor ** (attempt - 1), retry.capMs);
  const spread = base * retry.jitterRatio;
  return Math.max(0, Math.round(base + (Math.random() * 2 - 1) * spread));
}

function isRetryableCode(code: number): boolean {
  return code === 99991663 || code === 99991661 || code >= 99990000;
}

function httpStatusFromError(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const response = (error as { response?: { status?: number } }).response;
  return typeof response?.status === 'number' ? response.status : undefined;
}

function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

function serializeSeq(seq: number): string {
  return `${seq}`.padStart(16, '0');
}

function formatSessionFields(record: SessionRecord): Record<string, BitableFieldValue> {
  const fields: Record<string, BitableFieldValue> = {
    session_id: record.session_id,
    captain_id: record.captain_id,
    created_at: Date.parse(record.created_at),
    last_active_at: Date.parse(record.last_active_at),
    status: record.status,
    cwd: record.cwd,
    scope: record.scope,
    project: record.project,
    home_group_id: record.home_group_id ?? '',
    agent: record.agent,
    latest_run_id: record.latest_run_id ?? '',
    operator: [{ id: record.operator }],
    entry_form: record.entry_form,
    revision: record.revision,
  };
  if (record.closed_at) fields['closed_at'] = Date.parse(record.closed_at);
  return fields;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function parseSessionRecord(fields: Record<string, unknown>): SessionRecord {
  const operatorValue = fields['operator'];
  const operator = Array.isArray(operatorValue) && operatorValue[0] && typeof operatorValue[0] === 'object' && operatorValue[0] !== null
    ? asString((operatorValue[0] as { id?: unknown }).id) ?? ''
    : asString(operatorValue) ?? '';
  return SessionRecordSchema.parse({
    session_id: asString(fields['session_id']) ?? '',
    captain_id: asString(fields['captain_id']) ?? '',
    created_at: typeof fields['created_at'] === 'number' ? new Date(fields['created_at']).toISOString() : asString(fields['created_at']) ?? '',
    last_active_at: typeof fields['last_active_at'] === 'number' ? new Date(fields['last_active_at']).toISOString() : asString(fields['last_active_at']) ?? '',
    closed_at: typeof fields['closed_at'] === 'number' ? new Date(fields['closed_at']).toISOString() : asString(fields['closed_at']),
    status: asString(fields['status']) ?? 'idle',
    cwd: asString(fields['cwd']) ?? '',
    scope: asString(fields['scope']) ?? 'dev',
    project: asString(fields['project']) ?? 'weaverbird',
    home_group_id: asString(fields['home_group_id']),
    agent: asString(fields['agent']) ?? 'other',
    latest_run_id: asString(fields['latest_run_id']),
    operator,
    entry_form: asString(fields['entry_form']) ?? 'cli',
    revision: typeof fields['revision'] === 'number' ? fields['revision'] : 0,
  });
}

function readMirrorSnapshot(path: string): Map<string, SessionRecord> {
  const latest = new Map<string, SessionRecord>();
  if (!existsSync(path)) return latest;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as CaptainMirrorEntry;
      latest.set(parsed.session.session_id, parsed.session);
    } catch {
      continue;
    }
  }
  return latest;
}

function createWal(dir: string) {
  mkdirSync(dir, { recursive: true });
  let counter = 0;
  let lastSeq = 0;
  for (const file of readdirSync(dir)) {
    const match = file.match(/_(\d+)\.jsonl$/);
    const seq = match ? Number.parseInt(match[1]!, 10) : Number.NaN;
    if (Number.isFinite(seq)) lastSeq = Math.max(lastSeq, seq);
  }
  function filePath(entry: Pick<SessionWalEntry, 'session_id' | 'seq'>): string {
    return join(dir, `${entry.session_id}_${serializeSeq(entry.seq)}.jsonl`);
  }
  function findPath(seq: number): string | null {
    const suffix = `_${serializeSeq(seq)}.jsonl`;
    const file = readdirSync(dir).find((name) => name.endsWith(suffix));
    return file ? join(dir, file) : null;
  }
  function parseEntry(path: string): SessionWalEntry | null {
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as SessionWalEntry;
    } catch {
      return null;
    }
  }
  function writeEntry(entry: SessionWalEntry): void {
    atomicWrite(filePath(entry), JSON.stringify(entry));
  }
  function nextSeq(): number {
    counter += 1;
    lastSeq = Math.max(lastSeq + 1, Date.now() * 1000 + counter);
    return lastSeq;
  }
  return {
    append(sessionId: string, record: SessionRecord): number {
      const seq = nextSeq();
      writeEntry({ seq, session_id: sessionId, record, attempts: 0, state: 'queued', enqueued_at: new Date().toISOString() });
      return seq;
    },
    async *replay(): AsyncIterable<SessionWalEntry> {
      for (const file of readdirSync(dir).filter((name) => name.endsWith('.jsonl')).sort()) {
        const entry = parseEntry(join(dir, file));
        if (entry) yield entry;
      }
    },
    ack(seq: number): void {
      const path = findPath(seq);
      if (path) unlinkSync(path);
    },
    markPendingSync(seq: number): void {
      const path = findPath(seq);
      if (!path) return;
      const entry = parseEntry(path);
      if (!entry) return;
      unlinkSync(path);
      writeEntry({ ...entry, attempts: Math.max(entry.attempts, 5), state: 'pending-sync' });
    },
    bumpAttempts(seq: number): void {
      const path = findPath(seq);
      if (!path) return;
      const entry = parseEntry(path);
      if (!entry) return;
      unlinkSync(path);
      writeEntry({ ...entry, attempts: entry.attempts + 1 });
    },
    listFiles(): string[] {
      return readdirSync(dir).filter((name) => name.endsWith('.jsonl')).sort();
    },
  };
}

async function searchBySessionId(client: CaptainStoreClientLike, config: CaptainConfig, sessionId: string): Promise<{ recordId: string; record: SessionRecord } | null> {
  const response = await client.bitable.appTableRecord.search({
    path: { app_token: config.bitable_base_id, table_id: config.sessions_table_id },
    params: { page_size: 1 },
    data: { field_names: Object.keys(SessionRecordSchema.shape), filter: { conjunction: 'and', conditions: [{ field_name: 'session_id', operator: 'is', value: [sessionId] }] } },
  });
  const item = response.data?.items?.[0];
  if (!item?.record_id || !item.fields) return null;
  return { recordId: item.record_id, record: parseSessionRecord(item.fields) };
}

export function createCaptainSessionStore(options: CreateCaptainSessionStoreOptions = {}): CaptainSessionStore {
  const dataDir = resolveDataDir({ dataDir: options.env?.['WB_DATA_DIR'] });
  const config = loadCaptainStoreConfig({ configPath: options.configPath, env: options.env });
  const client = options._client ?? createClient(config);
  const retry = options._retryOverride ?? DEFAULT_RETRY_POLICY;
  const statePath = resolve(config.captain_state_path.replace(/^~\//, `${homedir()}/`));
  const walDir = captainSessionsWalDir(dataDir);
  const wal = createWal(walDir);
  let syncTimer: NodeJS.Timeout | null = null;

  async function validateSchema(): Promise<void> {
    const response = await client.bitable.appTableField.list({
      path: { app_token: config.bitable_base_id, table_id: config.sessions_table_id },
      params: { page_size: 100 },
    });
    const fields = new Set((response.data?.items ?? []).map((item) => item.field_name).filter((name): name is string => Boolean(name)));
    const missing = Object.keys(SessionRecordSchema.shape).filter((name) => !fields.has(name));
    if (missing.length > 0) {
      throw new CaptainError(CAPTAIN_ERROR_CODES.E_STORE_WRITE, `missing session fields: ${missing.join(', ')}`);
    }
  }

  async function upsert(record: SessionRecord): Promise<{ ok: boolean; attempt: number }> {
    let seq: number | null = null;
    let lastAttempt = 0;
    for (let attempt = 1; attempt <= retry.maxAttempts; attempt += 1) {
      lastAttempt = attempt;
      try {
        const existing = await searchBySessionId(client, config, record.session_id);
        if (existing) {
          const response = await client.bitable.appTableRecord.batchUpdate({
            path: { app_token: config.bitable_base_id, table_id: config.sessions_table_id },
            data: { records: [{ record_id: existing.recordId, fields: formatSessionFields(record) }] },
          });
          const code = response.code ?? 0;
          if (code === 0) {
            if (seq !== null) wal.ack(seq);
            return { ok: true, attempt };
          }
          if (seq === null) seq = wal.append(record.session_id, record);
          if (isRetryableCode(code)) {
            wal.bumpAttempts(seq);
            if (attempt < retry.maxAttempts) await sleep(nextDelay(retry, attempt));
            continue;
          }
          wal.markPendingSync(seq);
          return { ok: false, attempt };
        }
        const response = await client.bitable.appTableRecord.batchCreate({
          path: { app_token: config.bitable_base_id, table_id: config.sessions_table_id },
          params: { client_token: record.session_id },
          data: { records: [{ fields: formatSessionFields(record) }] },
        });
        const code = response.code ?? 0;
        if (code === 0) {
          if (seq !== null) wal.ack(seq);
          return { ok: true, attempt };
        }
        if (seq === null) seq = wal.append(record.session_id, record);
        if (isRetryableCode(code)) {
          wal.bumpAttempts(seq);
          if (attempt < retry.maxAttempts) await sleep(nextDelay(retry, attempt));
          continue;
        }
        wal.markPendingSync(seq);
        return { ok: false, attempt };
      } catch (error) {
        if (seq === null) seq = wal.append(record.session_id, record);
        const status = httpStatusFromError(error);
        if (typeof status === 'number' && status >= 400 && status < 500) {
          wal.markPendingSync(seq);
          return { ok: false, attempt };
        }
        wal.bumpAttempts(seq);
        if (attempt < retry.maxAttempts) await sleep(nextDelay(retry, attempt));
      }
    }
    if (seq !== null) wal.markPendingSync(seq);
    return { ok: false, attempt: lastAttempt || retry.maxAttempts };
  }

  async function reconcile(): Promise<SessionRecord[]> {
    const mirror = readMirrorSnapshot(statePath);
    const sessions = [...mirror.values()];
    for (const record of sessions) {
      const existing = await searchBySessionId(client, config, record.session_id);
      if (!existing) {
        await upsert(record);
        continue;
      }
      if (Date.parse(record.last_active_at) > Date.parse(existing.record.last_active_at)) {
        await upsert(record);
      }
    }
    return sessions;
  }

  async function syncOnce(): Promise<number> {
    let drained = 0;
    for await (const entry of wal.replay()) {
      const result = await upsert(entry.record);
      if (result.ok) {
        wal.ack(entry.seq);
        drained += 1;
      }
    }
    return drained;
  }

  function startSyncWorker(): NodeJS.Timeout {
    if (syncTimer) return syncTimer;
    syncTimer = setInterval(() => { void syncOnce(); }, options._syncIntervalMs ?? 60_000);
    return syncTimer;
  }

  function stopSyncWorker(): void {
    if (!syncTimer) return;
    clearInterval(syncTimer);
    syncTimer = null;
  }

  return {
    config,
    validateSchema,
    upsert,
    async upsertWithRevision(record, expectedRevision) {
      const target: SessionRecord = { ...record, revision: expectedRevision + 1 };
      // fast path: no existing row → insert as revision=expectedRevision+1.
      const existing = await searchBySessionId(client, config, record.session_id);
      if (!existing) {
        // 第一次创建;我们仍然标 revision=expectedRevision+1 保持单调.
        const response = await client.bitable.appTableRecord.batchCreate({
          path: { app_token: config.bitable_base_id, table_id: config.sessions_table_id },
          params: { client_token: record.session_id },
          data: { records: [{ fields: formatSessionFields(target) }] },
        });
        const code = response.code ?? 0;
        if (code === 0) return { ok: true, attempt: 1, newRevision: target.revision };
        return { ok: false, attempt: 1, newRevision: expectedRevision };
      }
      if (existing.record.revision !== expectedRevision) {
        throw new CaptainError(
          CAPTAIN_ERROR_CODES.E_REVISION_MISMATCH,
          `session ${record.session_id} revision mismatch: expected=${expectedRevision} actual=${existing.record.revision}`,
        );
      }
      const response = await client.bitable.appTableRecord.batchUpdate({
        path: { app_token: config.bitable_base_id, table_id: config.sessions_table_id },
        data: { records: [{ record_id: existing.recordId, fields: formatSessionFields(target) }] },
      });
      const code = response.code ?? 0;
      if (code === 0) return { ok: true, attempt: 1, newRevision: target.revision };
      return { ok: false, attempt: 1, newRevision: expectedRevision };
    },
    reconcile,
    syncOnce,
    startSyncWorker,
    stopSyncWorker,
  };
}
