import * as Lark from '@larksuiteoapi/node-sdk';
import { runRegistryWalDir } from '../paths.js';
import {
  DEFAULT_RETRY_POLICY,
  RUN_REGISTRY_ERROR_CODES,
  RunQuerySchema,
  RunRecordSchema,
  RunRegistryError,
  type RunQuery,
  type RunQueryResult,
  type RunRecord,
  type RunRegistryConfig,
} from './contracts.js';
import { loadRunRegistryConfig, resolveRunRegistryDataDir } from './config.js';
import { createRunRegistryWal, type RunRegistryWal } from './wal.js';
import type { RetryPolicy } from '../audit-pipe/contracts.js';

type BitableFieldValue = string | number | boolean | string[] | null;
type BitableRecordRow = { record_id?: string; fields?: Record<string, unknown> };
type FieldListItem = { field_name?: string };
type SearchResponse = { code?: number; msg?: string; data?: { items?: BitableRecordRow[]; page_token?: string; total?: number; has_more?: boolean } };
type BatchCreateResponse = { code?: number; msg?: string; data?: { records?: Array<{ record_id?: string }> } };
type BatchUpdateResponse = { code?: number; msg?: string; data?: { records?: Array<{ record_id?: string }> } };
type FieldListResponse = { code?: number; msg?: string; data?: { items?: FieldListItem[] } };

type FilterOperator = 'is' | 'contains' | 'isGreaterEqual' | 'isLessEqual';
type FilterCondition = { field_name: string; operator: FilterOperator; value?: string[] };

type SearchPayload = {
  path: { app_token: string; table_id: string };
  params?: { page_token?: string; page_size?: number };
  data?: {
    field_names?: string[];
    sort?: Array<{ field_name?: string; desc?: boolean }>;
    filter?: {
      conjunction: 'and' | 'or';
      conditions?: FilterCondition[];
      children?: Array<{ conjunction: 'and' | 'or'; conditions?: FilterCondition[] }>;
    };
  };
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
  params?: { page_size?: number; page_token?: string };
};

export interface RunRegistryClientLike {
  bitable: {
    appTableField: { list(payload?: FieldListPayload): Promise<FieldListResponse> };
    appTableRecord: {
      search(payload?: SearchPayload): Promise<SearchResponse>;
      batchCreate(payload?: BatchCreatePayload): Promise<BatchCreateResponse>;
      batchUpdate(payload?: BatchUpdatePayload): Promise<BatchUpdateResponse>;
    };
  };
}

export type RunRegistryWriteResult = {
  ok: boolean;
  attempt: number;
  record_id?: string;
  http_status?: number;
  lark_code?: number;
  lark_msg?: string;
};

export type RunRegistryWriter = {
  config: RunRegistryConfig;
  wal: RunRegistryWal;
  validateSchema(): Promise<void>;
  upsert(record: RunRecord): Promise<RunRegistryWriteResult>;
  findByRunId(runId: string): Promise<RunRecord | null>;
  queryRuns(query: RunQuery): Promise<RunQueryResult>;
  syncOnce(): Promise<number>;
  startSyncWorker(): NodeJS.Timeout;
  stopSyncWorker(): void;
};

export type CreateRunRegistryWriterOptions = {
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  walPath?: string;
  _client?: RunRegistryClientLike;
  _retryOverride?: RetryPolicy;
  _syncIntervalMs?: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createClient(config: RunRegistryConfig): RunRegistryClientLike {
  const domain = config.lark_domain.includes('larkoffice') ? Lark.Domain.Lark : config.lark_domain;
  return new Lark.Client({
    appId: config.app_id,
    appSecret: config.app_secret,
    domain,
  }) as unknown as RunRegistryClientLike;
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

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  if (typeof value === 'string' && value.trim()) return value.split(/\n+/).map((item) => item.trim()).filter(Boolean);
  return [];
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function asStrictBoolean(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (value === false || value === 0 || value === null || value === undefined) return false;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'checked') return true;
    if (normalized === '' || normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'unchecked') return false;
  }
  return false;
}

function formatFields(record: RunRecord): Record<string, BitableFieldValue> {
  return {
    run_id: record.run_id,
    created_at: Date.parse(record.created_at),
    operator: record.operator,
    project: record.project,
    cwd: record.cwd,
    scope: record.scope,
    agent: record.agent,
    cmd: record.cmd,
    status: record.status,
    cost_tokens: record.cost_tokens,
    cost_minutes: record.cost_minutes,
    produced_doc_urls: record.produced_doc_urls,
    commit_shas: record.commit_shas,
    doc_sink_failed: record.doc_sink_failed,
    calendar_block_id: record.calendar_block_id,
    calendar_hook_failed: record.calendar_hook_failed,
    risk_level: record.risk_level,
    home_group_id: record.home_group_id,
    entry_form: record.entry_form,
  };
}

function parseRunRecord(fields: Record<string, unknown>): RunRecord {
  return RunRecordSchema.parse({
    run_id: asString(fields['run_id']) ?? '',
    created_at: typeof fields['created_at'] === 'number'
      ? new Date(fields['created_at']).toISOString()
      : asString(fields['created_at']) ?? '',
    operator: asString(fields['operator']) ?? '',
    project: asString(fields['project']),
    cwd: asString(fields['cwd']) ?? '',
    scope: asString(fields['scope']) ?? '',
    agent: asString(fields['agent']) ?? '',
    cmd: asString(fields['cmd']) ?? '',
    status: asString(fields['status']) ?? '',
    cost_tokens: asNullableNumber(fields['cost_tokens']),
    cost_minutes: asNullableNumber(fields['cost_minutes']),
    produced_doc_urls: asStringArray(fields['produced_doc_urls']),
    commit_shas: asStringArray(fields['commit_shas']),
    doc_sink_failed: asStrictBoolean(fields['doc_sink_failed']),
    calendar_block_id: asString(fields['calendar_block_id']),
    calendar_hook_failed: asStrictBoolean(fields['calendar_hook_failed']),
    risk_level: asString(fields['risk_level']) ?? 'unknown',
    home_group_id: asString(fields['home_group_id']),
    entry_form: asString(fields['entry_form']) ?? 'cli',
  });
}

function buildQueryConditions(query: RunQuery): FilterCondition[] {
  const conditions: FilterCondition[] = [];
  if (query.operator) conditions.push({ field_name: 'operator', operator: 'is', value: [query.operator] });
  if (query.project) conditions.push({ field_name: 'project', operator: 'is', value: [query.project] });
  if (query.agent) conditions.push({ field_name: 'agent', operator: 'is', value: [query.agent] });
  if (query.entry_form) conditions.push({ field_name: 'entry_form', operator: 'is', value: [query.entry_form] });
  if (query.status) conditions.push({ field_name: 'status', operator: 'is', value: [query.status] });
  if (query.after) conditions.push({ field_name: 'created_at', operator: 'isGreaterEqual', value: [String(Date.parse(query.after))] });
  if (query.before) conditions.push({ field_name: 'created_at', operator: 'isLessEqual', value: [String(Date.parse(query.before))] });
  return conditions;
}

function buildQueryChildren(query: RunQuery): Array<{ conjunction: 'and' | 'or'; conditions?: FilterCondition[] }> {
  if (!query.keyword) return [];
  return [{
    conjunction: 'or',
    conditions: [
      { field_name: 'cwd', operator: 'contains', value: [query.keyword] },
      { field_name: 'cmd', operator: 'contains', value: [query.keyword] },
      { field_name: 'project', operator: 'contains', value: [query.keyword] },
    ],
  }];
}

function buildSearchPayload(config: RunRegistryConfig, query: RunQuery): SearchPayload {
  const conditions = buildQueryConditions(query);
  const children = buildQueryChildren(query);
  return {
    path: { app_token: config.bitable_base_id, table_id: config.bitable_table_id },
    params: { page_size: query.limit, page_token: query.cursor },
    data: {
      field_names: Object.keys(RunRecordSchema.shape),
      sort: [{ field_name: 'created_at', desc: true }],
      filter: conditions.length || children.length
        ? { conjunction: 'and', conditions, children }
        : undefined,
    },
  };
}

async function searchByRunId(client: RunRegistryClientLike, config: RunRegistryConfig, runId: string): Promise<{ recordId: string; record: RunRecord } | null> {
  const response = await client.bitable.appTableRecord.search({
    path: { app_token: config.bitable_base_id, table_id: config.bitable_table_id },
    params: { page_size: 1 },
    data: {
      field_names: Object.keys(RunRecordSchema.shape),
      filter: { conjunction: 'and', conditions: [{ field_name: 'run_id', operator: 'is', value: [runId] }] },
    },
  });
  const item = response.data?.items?.[0];
  if (!item?.record_id || !item.fields) return null;
  return { recordId: item.record_id, record: parseRunRecord(item.fields) };
}

export function createRunRegistryWriter(options: CreateRunRegistryWriterOptions = {}): RunRegistryWriter {
  const dataDir = resolveRunRegistryDataDir(options.env);
  const config = loadRunRegistryConfig({ configPath: options.configPath, env: options.env });
  const wal = createRunRegistryWal({ dataDir, walPath: options.walPath ?? runRegistryWalDir(dataDir) });
  const retry = options._retryOverride ?? DEFAULT_RETRY_POLICY;
  const client = options._client ?? createClient(config);
  let syncTimer: NodeJS.Timeout | null = null;

  async function validateSchema(): Promise<void> {
    const response = await client.bitable.appTableField.list({
      path: { app_token: config.bitable_base_id, table_id: config.bitable_table_id },
      params: { page_size: 100 },
    });
    if ((response.code ?? 0) !== 0) {
      throw new RunRegistryError(RUN_REGISTRY_ERROR_CODES.E_SCHEMA_MISMATCH, response.msg ?? 'failed to list bitable fields');
    }
    const fields = new Set((response.data?.items ?? []).map((item) => item.field_name).filter((name): name is string => Boolean(name)));
    const missing = Object.keys(RunRecordSchema.shape).filter((name) => !fields.has(name));
    if (missing.length > 0) {
      throw new RunRegistryError(RUN_REGISTRY_ERROR_CODES.E_SCHEMA_MISMATCH, `missing fields: ${missing.join(', ')}`);
    }
  }

  async function upsert(record: RunRecord): Promise<RunRegistryWriteResult> {
    let seq: number | null = null;
    let last: RunRegistryWriteResult = { ok: false, attempt: 0 };
    for (let attempt = 1; attempt <= retry.maxAttempts; attempt += 1) {
      try {
        const existing = await searchByRunId(client, config, record.run_id);
        if (existing) {
          const response = await client.bitable.appTableRecord.batchUpdate({
            path: { app_token: config.bitable_base_id, table_id: config.bitable_table_id },
            data: { records: [{ record_id: existing.recordId, fields: formatFields(record) }] },
          });
          const code = response.code ?? 0;
          if (code === 0) {
            if (seq !== null) wal.ack(seq);
            return { ok: true, attempt, record_id: existing.recordId, lark_code: code, lark_msg: response.msg };
          }
          if (seq === null) seq = wal.append(record.run_id, record);
          if (isRetryableCode(code)) {
            wal.bumpAttempts(seq);
            last = { ok: false, attempt, lark_code: code, lark_msg: response.msg };
            if (attempt < retry.maxAttempts) await sleep(nextDelay(retry, attempt));
            continue;
          }
          wal.markPendingSync(seq);
          return { ok: false, attempt, lark_code: code, lark_msg: response.msg };
        }

        const response = await client.bitable.appTableRecord.batchCreate({
          path: { app_token: config.bitable_base_id, table_id: config.bitable_table_id },
          params: { client_token: record.run_id },
          data: { records: [{ fields: formatFields(record) }] },
        });
        const code = response.code ?? 0;
        if (code === 0) {
          if (seq !== null) wal.ack(seq);
          return { ok: true, attempt, record_id: response.data?.records?.[0]?.record_id, lark_code: code, lark_msg: response.msg };
        }
        if (seq === null) seq = wal.append(record.run_id, record);
        if (isRetryableCode(code)) {
          wal.bumpAttempts(seq);
          last = { ok: false, attempt, lark_code: code, lark_msg: response.msg };
          if (attempt < retry.maxAttempts) await sleep(nextDelay(retry, attempt));
          continue;
        }
        wal.markPendingSync(seq);
        return { ok: false, attempt, lark_code: code, lark_msg: response.msg };
      } catch (error) {
        if (seq === null) seq = wal.append(record.run_id, record);
        const status = httpStatusFromError(error);
        if (typeof status === 'number' && status >= 400 && status < 500) {
          wal.markPendingSync(seq);
          return { ok: false, attempt, http_status: status, lark_msg: RUN_REGISTRY_ERROR_CODES.E_BITABLE_WRITE };
        }
        wal.bumpAttempts(seq);
        last = { ok: false, attempt, http_status: status, lark_msg: RUN_REGISTRY_ERROR_CODES.E_BITABLE_WRITE };
        if (attempt < retry.maxAttempts) await sleep(nextDelay(retry, attempt));
      }
    }
    if (seq !== null) wal.markPendingSync(seq);
    return { ...last, lark_msg: RUN_REGISTRY_ERROR_CODES.E_BITABLE_RETRY_EXHAUSTED };
  }

  async function findByRunId(runId: string): Promise<RunRecord | null> {
    return (await searchByRunId(client, config, runId))?.record ?? null;
  }

  async function queryRuns(query: RunQuery): Promise<RunQueryResult> {
    const parsed = RunQuerySchema.parse(query);
    const response = await client.bitable.appTableRecord.search(buildSearchPayload(config, parsed));
    return {
      runs: (response.data?.items ?? [])
        .filter((item): item is { fields: Record<string, unknown> } => Boolean(item.fields))
        .map((item) => parseRunRecord(item.fields)),
      next_cursor: response.data?.has_more ? (response.data?.page_token ?? null) : null,
      total_hint: response.data?.total ?? null,
    };
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
    syncTimer = setInterval(() => {
      if (!wal.listFiles().length) return;
      void syncOnce();
    }, options._syncIntervalMs ?? 60_000);
    return syncTimer;
  }

  function stopSyncWorker(): void {
    if (!syncTimer) return;
    clearInterval(syncTimer);
    syncTimer = null;
  }

  return {
    config,
    wal,
    validateSchema,
    upsert,
    findByRunId,
    queryRuns,
    syncOnce,
    startSyncWorker,
    stopSyncWorker,
  };
}
