/**
 * W3.2 F15 Run Registry — SPEC contracts
 * ≤200 lines · zod schemas + derived TS types · no runtime imports
 *
 * Import-only from W3.1 runtime (do NOT modify):
 *   EVENT_TYPES, ENTRY_FORMS, DEFAULT_RETRY_POLICY, AuditRecord, RunSpec
 */

import { z } from 'zod';
import type { AuditRecord, RunSpec } from '../audit-pipe/contracts.js';
import { ENTRY_FORMS, DEFAULT_RETRY_POLICY } from '../audit-pipe/contracts.js';

export type { AuditRecord, RunSpec };
export { ENTRY_FORMS, DEFAULT_RETRY_POLICY };

export const RUN_STATUS = {
  PENDING: 'pending',
  ACTIVE: 'active',
  FINALIZING: 'finalizing',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
} as const;
export type RunStatus = typeof RUN_STATUS[keyof typeof RUN_STATUS];
const RunStatusSchema = z.enum([
  'pending', 'active', 'finalizing', 'succeeded', 'failed', 'cancelled',
]);

export const RunRecordSchema = z.object({
  run_id: z.string().min(1),
  created_at: z.string().datetime(),
  operator: z.string(),
  project: z.string().nullable(),
  cwd: z.string(),
  scope: z.string(),
  agent: z.string(),
  cmd: z.string(),
  status: RunStatusSchema,
  cost_tokens: z.number().int().nullable(),
  cost_minutes: z.number().nullable(),
  produced_doc_urls: z.array(z.string().url()),
  commit_shas: z.array(z.string()),
  doc_sink_failed: z.boolean(),
  calendar_block_id: z.string().nullable(),
  calendar_hook_failed: z.boolean(),
  risk_level: z.enum(['unknown', 'low', 'medium', 'high']),
  home_group_id: z.string().nullable(),
  entry_form: z.enum(ENTRY_FORMS),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

export const RunUpsertedSchema = z.object({
  event: z.literal('RunUpserted'),
  run_id: z.string().min(1),
  session_id: z.string(),
  revision: z.number().int().min(0),
  status: RunStatusSchema,
  cost_tokens: z.number().int().nullable(),
  cost_minutes: z.number().nullable(),
  produced_doc_urls: z.array(z.string().url()),
  commit_shas: z.array(z.string()),
  doc_sink_failed: z.boolean(),
  calendar_block_id: z.string().nullable(),
  calendar_hook_failed: z.boolean(),
  updated_at: z.string().datetime(),
});
export type RunUpserted = z.infer<typeof RunUpsertedSchema>;

export const RunQuerySchema = z.object({
  keyword: z.string().optional(),
  operator: z.string().optional(),
  project: z.string().optional(),
  agent: z.string().optional(),
  entry_form: z.enum(ENTRY_FORMS).optional(),
  status: RunStatusSchema.optional(),
  after: z.string().datetime().optional(),
  before: z.string().datetime().optional(),
  limit: z.number().int().min(1).max(50).default(20),
  cursor: z.string().optional(),
});
export type RunQuery = z.infer<typeof RunQuerySchema>;

export const RunQueryResultSchema = z.object({
  runs: z.array(RunRecordSchema),
  next_cursor: z.string().nullable(),
  total_hint: z.number().int().nullable(),
});
export type RunQueryResult = z.infer<typeof RunQueryResultSchema>;

export const RunInheritSpecSchema = z.object({
  from_run_id: z.string().min(1),
  inherit_fields: z.array(z.enum([
    'project', 'cwd', 'scope', 'agent', 'home_group_id', 'entry_form',
  ])),
  new_run_id: z.string().min(1),
});
export type RunInheritSpec = z.infer<typeof RunInheritSpecSchema>;

export const RunRegistryConfigSchema = z.object({
  bitable_base_id: z.string().min(1),
  bitable_table_id: z.string().min(1),
  app_id: z.string().min(1),
  app_secret: z.string().min(1),
  lark_domain: z.string().url(),
  run_finalize_grace_ms: z.number().int().positive().default(30_000),
  doc_url_allowlist: z.array(z.string()).default([
    '*.larkoffice.com', '*.feishu.cn', 'github.com',
  ]),
});
export type RunRegistryConfig = z.infer<typeof RunRegistryConfigSchema>;

export const RUN_REGISTRY_ERROR_CODES = {
  E_CFG_MISSING: 'registry.config.missing',
  E_CFG_INVALID: 'registry.config.invalid',
  E_SCHEMA_MISMATCH: 'registry.schema.mismatch',
  E_BITABLE_WRITE: 'registry.bitable.write_failed',
  E_BITABLE_RETRY_EXHAUSTED: 'registry.bitable.retry_exhausted',
  E_WAL_WRITE: 'registry.wal.write_failed',
  E_TAILER_READ: 'registry.tailer.read_error',
  E_INHERIT_NOT_FOUND: 'registry.inherit.run_not_found',
  E_QUERY_TIMEOUT: 'registry.query.timeout',
  E_DOC_SINK_WRITE: 'registry.doc_sink.write_failed',
} as const;
export type RunRegistryErrorCode = typeof RUN_REGISTRY_ERROR_CODES[keyof typeof RUN_REGISTRY_ERROR_CODES];

export class RunRegistryError extends Error {
  constructor(
    public readonly code: RunRegistryErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'RunRegistryError';
  }
}

export type TailerState = 'IDLE' | 'ACTIVE' | 'FINALIZING' | 'DONE';

export interface RunTailerEntry {
  run_id: string;
  state: TailerState;
  first_event_ts: number;
  last_event_ts: number;
  event_count: number;
  produced_doc_urls: string[];
  commit_shas: string[];
  doc_sink_failed: boolean;
  calendar_block_id: string | null;
  calendar_hook_failed: boolean;
  spec: RunSpec | null;
}

export interface RunWalEntry {
  seq: number;
  run_id: string;
  record: RunRecord;
  attempts: number;
  state: 'queued' | 'pending-sync';
  enqueued_at: string;
}
