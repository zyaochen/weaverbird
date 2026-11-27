/**
 * W3.2.5 Captain 权威化基建 — SPEC contracts
 * ≤250 lines · zod schemas + derived TS types · no runtime imports
 *
 * Import-only from W3.1/W3.2 (do NOT modify):
 *   ENTRY_FORMS, DEFAULT_RETRY_POLICY ← audit-pipe
 *   RUN_STATUS, RunRecord             ← run-registry
 */

import { z } from 'zod';
import type { RunRecord } from '../run-registry/contracts.js';
import { RUN_STATUS, ENTRY_FORMS } from '../run-registry/contracts.js';
import { DEFAULT_RETRY_POLICY } from '../audit-pipe/contracts.js';

export type { RunRecord };
export { RUN_STATUS, ENTRY_FORMS, DEFAULT_RETRY_POLICY };

export const SESSION_STATUS = {
  IDLE: 'idle',
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
  CLOSED: 'closed',
} as const;
export type SessionStatus = typeof SESSION_STATUS[keyof typeof SESSION_STATUS];
const SessionStatusSchema = z.enum(['idle', 'active', 'suspended', 'closed']);

export const SessionRecordSchema = z.object({
  session_id: z.string().min(1),
  captain_id: z.string().min(1),
  created_at: z.string().datetime(),
  last_active_at: z.string().datetime(),
  closed_at: z.string().datetime().nullable(),
  status: SessionStatusSchema,
  cwd: z.string(),
  scope: z.enum(['dev', 'staging', 'prod']),
  project: z.enum(['weaverbird', 'other']),
  home_group_id: z.string().nullable(),
  agent: z.enum(['claude-code', 'codex', 'other']),
  latest_run_id: z.string().nullable(),
  operator: z.string(),
  entry_form: z.enum(ENTRY_FORMS),
  // M11-D D1 (2026-08-04 owner-authorized): additive revision for optimistic
  // concurrency. Reader treats missing as 0. Cross-device attach uses this to
  // detect "my write reached the store before yours" instead of wealth wins.
  revision: z.number().int().min(0).default(0),
});
export type SessionRecord = z.infer<typeof SessionRecordSchema>;

export const CaptainMappingSchema = z.object({
  git_remote: z.string(),
  cwd_prefix: z.string().optional(),
  captain_id: z.string(),
  home_group_id: z.string().optional(),
});
export type CaptainMapping = z.infer<typeof CaptainMappingSchema>;

export const CaptainTomlSchema = z.object({
  version: z.number().int().positive().default(1),
  mapping: z.array(CaptainMappingSchema),
});
export type CaptainTomlConfig = z.infer<typeof CaptainTomlSchema>;

export const CaptainConfigSchema = z.object({
  bitable_base_id: z.string().min(1),
  sessions_table_id: z.string().min(1),
  app_id: z.string().min(1),
  app_secret: z.string().min(1),
  lark_domain: z.enum(['Lark', 'LarkSuite', 'LarkOffice']).default('LarkSuite'),
  captain_state_path: z.string().min(1),
  captain_toml_path: z.string().min(1),
});
export type CaptainConfig = z.infer<typeof CaptainConfigSchema>;
export const CaptainStoreConfigSchema = CaptainConfigSchema;
export type CaptainStoreConfig = CaptainConfig;

export const CwdInferenceResultSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('hit'),
    captain_id: z.string(),
    matched_by: z.enum(['git_remote', 'cwd_prefix']),
  }),
  z.object({
    outcome: z.literal('miss'),
    candidates: z.array(z.string()),
    suggestion: z.string(),
  }),
]);
export type CwdInferenceResult = z.infer<typeof CwdInferenceResultSchema>;

export const CommandCatalogEntrySchema = z.object({
  name: z.string(),
  aliases: z.array(z.string()).default([]),
  belongs_to: z.enum(['bot', 'cli', 'both']),
  capability_tags: z.array(z.string()).default([]),
  im_visible: z.boolean(),
  cli_visible: z.boolean(),
  description: z.string(),
});
export type CommandCatalogEntry = z.infer<typeof CommandCatalogEntrySchema>;
export type CommandCatalog = Record<string, CommandCatalogEntry>;

export const CAPTAIN_ERROR_CODES = {
  E_TOML_MISSING: 'captain.toml.missing',
  E_TOML_INVALID: 'captain.toml.invalid',
  E_INFERENCE_MISS: 'captain.cwd.inference_miss',
  E_SESSION_NOT_FOUND: 'captain.session.not_found',
  E_STORE_WRITE: 'captain.store.write_failed',
  E_STORE_RETRY_EXHAUSTED: 'captain.store.retry_exhausted',
  E_CATALOG_INCOMPLETE: 'captain.catalog.incomplete',
  E_CONFIG_MISSING: 'captain.config.missing',
  E_CONFIG_INCOMPLETE: 'captain.config.incomplete',
  E_REVISION_MISMATCH: 'captain.session.revision_mismatch',
} as const;
export type CaptainErrorCode = typeof CAPTAIN_ERROR_CODES[keyof typeof CAPTAIN_ERROR_CODES];

export class CaptainError extends Error {
  constructor(
    public readonly code: CaptainErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'CaptainError';
  }
}

export interface SessionEntry {
  record: SessionRecord;
  run_ids: string[];
  dirty: boolean;
}

export interface CaptainMirrorEntry {
  ts: string;
  op: 'upsert' | 'close';
  session: SessionRecord;
}
