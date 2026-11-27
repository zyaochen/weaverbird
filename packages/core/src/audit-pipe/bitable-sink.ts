import * as Lark from '@larksuiteoapi/node-sdk';
import type { AuditRecord, BitableWriteResult, RetryPolicy } from './contracts.js';
import { AUDIT_PIPE_ERROR_CODES } from './contracts.js';
import type { Wal } from './wal.js';

type BitableFieldValue = string | number | boolean;
export type BitableBatchCreatePayload = { data: { records: Array<{ fields: Record<string, BitableFieldValue> }> }; params?: { client_token?: string }; path: { app_token: string; table_id: string } };
export type BitableBatchCreateResponse = { code?: number; msg?: string; data?: { records?: Array<{ record_id?: string }> } };
export interface BitableClientLike { bitable: { appTableRecord: { batchCreate(payload?: BitableBatchCreatePayload): Promise<BitableBatchCreateResponse> } } }
export type BitableSink = { flush(): Promise<BitableWriteResult> };
export type CreateBitableSinkOptions = { dataDir: string; baseId: string; tableId: string; appId: string; appSecret: string; larkDomain: string; retry: RetryPolicy; wal: Wal; _client?: BitableClientLike };

type ErrorRecord = Record<string, unknown>;

type SDKLogger = {
  error: (...msg: unknown[]) => void;
  warn: (...msg: unknown[]) => void;
  info: (...msg: unknown[]) => void;
  debug: (...msg: unknown[]) => void;
  trace: (...msg: unknown[]) => void;
};

function isRecord(value: unknown): value is ErrorRecord {
  return typeof value === 'object' && value !== null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatSDKLogArg(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function flattenSDKLogArgs(values: unknown[]): string[] {
  if (values.length === 1 && Array.isArray(values[0])) {
    return flattenSDKLogArgs(values[0] as unknown[]);
  }
  return values.map(formatSDKLogArg);
}

function writeSDKLog(level: 'error' | 'warn' | 'info' | 'debug' | 'trace', values: unknown[]): void {
  const body = flattenSDKLogArgs(values).join(' ');
  const tokenLike = /request token|use cache token|get tenant access token|tenant_access_token/i.test(body);
  const prefix = tokenLike ? `[lark-sdk:tenant_access_token:${level}]` : `[lark-sdk:${level}]`;
  const safeBody = tokenLike ? '<redacted>' : body;
  const message = `${prefix} ${safeBody}`;
  if (level === 'error') {
    console.error(message);
    return;
  }
  if (level === 'warn') {
    console.warn(message);
    return;
  }
  if (level === 'trace') {
    console.trace(message);
    return;
  }
  console.log(message);
}

const SDK_LOGGER: SDKLogger = {
  error: (...msg) => writeSDKLog('error', msg),
  warn: (...msg) => writeSDKLog('warn', msg),
  info: (...msg) => writeSDKLog('info', msg),
  debug: (...msg) => writeSDKLog('debug', msg),
  trace: (...msg) => writeSDKLog('trace', msg),
};

function createClient({ appId, appSecret, larkDomain }: CreateBitableSinkOptions): BitableClientLike {
  // Domain comes from config audit.lark_domain, e.g. https://open.larkoffice.com.
  return new Lark.Client({
    appId,
    appSecret,
    domain: larkDomain,
    loggerLevel: Lark.LoggerLevel.debug,
    logger: SDK_LOGGER,
  }) as unknown as BitableClientLike;
}

function formatFields(record: AuditRecord): Record<string, BitableFieldValue> {
  return {
    audit_record_id: record.audit_record_id,
    session_id: record.session_id,
    run_id: record.run_id,
    revision: record.revision,
    actor: record.actor,
    action: record.action,
    resource: record.resource.slice(0, 500),
    ts: Date.parse(record.ts),
    entry_form: record.entry_form,
    entry_detail: JSON.stringify(record.entry_detail),
    agent_id: record.agent_id,
    raw_tool_use_id: record.raw_tool_use_id,
    raw_tool_name: record.raw_tool_name,
  };
}

function isRetryableCode(code: number): boolean {
  return code === 99991663 || code === 99991661 || code >= 99990000;
}

function httpStatusFromError(error: unknown): number | undefined {
  if (!isRecord(error) || !isRecord(error['response'])) return undefined;
  const status = error['response']['status'];
  return typeof status === 'number' ? status : undefined;
}

function nextDelay(retry: RetryPolicy, attempt: number): number {
  const base = Math.min(retry.baseMs * retry.factor ** (attempt - 1), retry.capMs);
  const spread = base * retry.jitterRatio;
  return Math.max(0, Math.round(base + (Math.random() * 2 - 1) * spread));
}

export function createBitableSink(options: CreateBitableSinkOptions): BitableSink {
  const client = options._client ?? createClient(options);
  return {
    async flush(): Promise<BitableWriteResult> {
      const recordIds: string[] = [];
      let last: BitableWriteResult = { ok: true, record_ids: recordIds, attempt: 0 };
      for await (const entry of options.wal.replay()) {
        const payload: BitableBatchCreatePayload = {
          path: { app_token: options.baseId, table_id: options.tableId },
          params: { client_token: entry.record.audit_record_id },
          data: { records: [{ fields: formatFields(entry.record) }] },
        };
        let delivered = false;
        for (let attempt = 1; attempt <= options.retry.maxAttempts; attempt += 1) {
          last = { ok: false, record_ids: recordIds, attempt };
          try {
            const response = await client.bitable.appTableRecord.batchCreate(payload);
            const code = typeof response.code === 'number' ? response.code : 0;
            const msg = typeof response.msg === 'string' ? response.msg : undefined;
            if (code === 0) {
              options.wal.ack(entry.seq);
              delivered = true;
              const ids = response.data?.records?.flatMap((item) => item.record_id ? [item.record_id] : [] ) ?? [];
              recordIds.push(...ids);
              last = { ok: true, record_ids: recordIds, lark_code: code, lark_msg: msg, attempt };
              break;
            }
            if (isRetryableCode(code)) {
              options.wal.bumpAttempts(entry.seq);
              last = { ok: false, record_ids: recordIds, lark_code: code, lark_msg: msg, attempt };
              if (attempt < options.retry.maxAttempts) await sleep(nextDelay(options.retry, attempt));
              continue;
            }
            options.wal.markPendingSync(entry.seq);
            last = { ok: false, record_ids: recordIds, lark_code: code, lark_msg: msg, attempt };
            delivered = true;
            break;
          } catch (error) {
            const status = httpStatusFromError(error);
            if (typeof status === 'number' && status >= 400 && status < 500) {
              options.wal.markPendingSync(entry.seq);
              last = { ok: false, record_ids: recordIds, http_status: status, lark_msg: AUDIT_PIPE_ERROR_CODES.E_BITABLE_HTTP_4XX, attempt };
              delivered = true;
              break;
            }
            options.wal.bumpAttempts(entry.seq);
            last = { ok: false, record_ids: recordIds, http_status: status, lark_msg: AUDIT_PIPE_ERROR_CODES.E_BITABLE_HTTP_5XX, attempt };
            if (attempt < options.retry.maxAttempts) await sleep(nextDelay(options.retry, attempt));
          }
        }
        if (!delivered) {
          options.wal.markPendingSync(entry.seq);
          last = { ok: false, record_ids: recordIds, lark_msg: AUDIT_PIPE_ERROR_CODES.E_BITABLE_RETRY_EXHAUSTED, attempt: options.retry.maxAttempts };
        }
      }
      return last;
    },
  };
}
