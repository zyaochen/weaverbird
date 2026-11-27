import { z } from 'zod';

export const EVENT_TYPES = ['file_read', 'file_write', 'shell_exec', 'network_call', 'env_access', 'git_op', 'other'] as const;
export type EventType = typeof EVENT_TYPES[number];
export const ENTRY_FORMS = ['im', 'cli'] as const;
export type EntryForm = typeof ENTRY_FORMS[number];

export interface ToolUseEvent { type: 'tool_use'; id: string; name: string; input: unknown; subagentId?: string; }
export interface RunSpec {
  runId: string; botId: string; agentId: string; userOpenId: string; threadId: string; sourceMessageId: string;
  replyMessageId: string; cwd: string; model: string | null; consentLevel: string; startedAt: string; schemaVersion: number; host: string;
}
export interface EntryDetailIm { source_message_id: string; user_open_id: string; thread_id: string; }
export interface EntryDetailCli { user_open_id: string; host: string; }
export type EntryDetail = EntryDetailIm | EntryDetailCli;
export interface AuditRecord {
  audit_record_id: string; session_id: string; run_id: string; revision: number; actor: string; action: EventType; resource: string; ts: string;
  entry_form: EntryForm; entry_detail: EntryDetail; agent_id: 'claude-code'; raw_tool_use_id: string; raw_tool_name: string;
  /**
   * M12-C (2026-08-04 owner-authorized): envFilter 命中独立标记。
   * Bash / tool input 里出现 $VAR / ${VAR} 引用即命中;bitable sink 应能
   * 按这列过滤 alert,与 action='env_access' 互补而不是互斥。
   */
  env_filter_hit?: boolean;
}
export interface RejectedRecord {
  audit_record_id: string; status: 'rejected'; reason: 'parse_error' | 'missing_spec' | 'invalid_entry_form' | 'unknown_tool';
  raw_line: string; ts: string; run_id: string | null;
}
export interface WalEntry { seq: number; record: AuditRecord; attempts: number; state: 'queued' | 'pending-sync'; enqueued_at: string; }
export interface BitableWriteResult { ok: boolean; record_ids: string[]; http_status?: number; lark_code?: number; lark_msg?: string; attempt: number; }
export const RetryPolicySchema = z.object({ maxAttempts: z.literal(5), baseMs: z.number().int().positive(), factor: z.number().positive(), capMs: z.number().int().positive(), jitterRatio: z.number().min(0).max(1) });
export type RetryPolicy = z.infer<typeof RetryPolicySchema>;
export const DEFAULT_RETRY_POLICY: RetryPolicy = { maxAttempts: 5, baseMs: 1000, factor: 2, capMs: 30_000, jitterRatio: 0.2 };

const EnabledAuditConfigSchema = z.object({ audit: z.object({ enabled: z.literal(true), bitable_base_id: z.string().min(1), bitable_table_id: z.string().min(1), app_id: z.string().min(1), app_secret: z.string().min(1), lark_domain: z.string().url() }) });
const DisabledAuditConfigSchema = z.object({ audit: z.object({ enabled: z.literal(false) }) });
export const AuditPipeConfigSchema = z.union([EnabledAuditConfigSchema, DisabledAuditConfigSchema]);
export type AuditPipeConfig = z.infer<typeof AuditPipeConfigSchema>;
export type ConfigSource = { type: 'literal'; value: string } | { type: 'env'; name: string };

export const AUDIT_PIPE_ERROR_CODES = {
  E_CFG_MISSING_FILE: 'audit.config.missing_file',
  E_CFG_INVALID_JSON: 'audit.config.invalid_json',
  E_CFG_MISSING_ENV: 'audit.config.missing_env',
  E_CFG_PLACEHOLDER: 'audit.config.placeholder',
  E_CFG_BAD_SOURCE_TYPE: 'audit.config.bad_source_type',
  E_CFG_PERM_TOO_OPEN: 'audit.config.perm_too_open',
  E_PARSE_BAD_LINE: 'audit.parse.bad_line',
  E_NORM_MISSING_SPEC: 'audit.normalizer.missing_spec',
  E_NORM_INVALID_ENTRY_FORM: 'audit.normalizer.invalid_entry_form',
  E_MIRROR_WRITE_FATAL: 'audit.mirror.write_fatal',
  E_WAL_WRITE: 'audit.wal.write',
  E_BITABLE_HTTP_4XX: 'audit.bitable.http_4xx',
  E_BITABLE_HTTP_5XX: 'audit.bitable.http_5xx',
  E_BITABLE_LARK_CODE: 'audit.bitable.lark_code_nonzero',
  E_BITABLE_RETRY_EXHAUSTED: 'audit.bitable.retry_exhausted',
} as const;
export type AuditPipeErrorCode = typeof AUDIT_PIPE_ERROR_CODES[keyof typeof AUDIT_PIPE_ERROR_CODES];
export class AuditPipeError extends Error {
  constructor(public readonly code: AuditPipeErrorCode, message: string) { super(`[${code}] ${message}`); this.name = 'AuditPipeError'; }
}

export interface AuditPipeController {
  reload(): Promise<void>;
  stop(): Promise<void>;
  status(): { tailers: number; walPending: number; lastBitableOk: string | null };
}
