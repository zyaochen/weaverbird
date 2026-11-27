/**
 * W3.4 Run Observability & Intervention Loop — contracts
 * ≤ 200 lines · zod schemas + derived TS types
 * No runtime imports except zod and frozen contract re-exports.
 *
 * Frozen imports (read-only, do NOT modify):
 *   RUN_STATUS        ← packages/core/src/run-registry/contracts
 *   ENTRY_FORMS       ← packages/core/src/audit-pipe/contracts
 */

import { z } from 'zod';
import type { RunRecord } from '../run-registry/contracts.js';
import type { SessionRecord } from '../captain/contracts.js';
import { RUN_STATUS } from '../run-registry/contracts.js';
import { ENTRY_FORMS } from '../audit-pipe/contracts.js';
import { EchoPayloadSchema } from '../reverse-channel/contracts.js';

export type { RunRecord, SessionRecord };
export { RUN_STATUS, ENTRY_FORMS, EchoPayloadSchema };

const RUN_STATUS_VALUES = Object.values(RUN_STATUS) as [string, ...string[]];
const ALERT_REASON = ['silent_timeout', 'exit_nonzero'] as const;

export const PROGRESS_STORE_MAX_BYTES = 10 * 1024 * 1024;
export const ALERT_POLL_INTERVAL_MS = 60_000;
export const SILENT_TIMEOUT_S_DEFAULT = 300;
export const SILENT_TIMEOUT_S_MIN = 60;
export const SILENT_TIMEOUT_S_MAX = 1800;
export const OBSERVE_AT_PATTERN = /^@wb\s+obs\s+(on|off)$/i;
export const FINALIZE_OUTPUT_MAX_BYTES = 4 * 1024;
export const FINALIZE_HEAD_LINES = 10;
export const FINALIZE_TAIL_LINES = 10;
export const CARD_LINE_MAX_CHARS = 120; // 经验值；impl 阶段允许 ±20% 调整
export const RATE_LIMIT_BUCKET_CAPACITY = 1; // deprecated: C3 reuses CardPipeline(minIntervalMs=800)
export const RATE_LIMIT_REFILL_MS = 1_000; // deprecated: retained for cleanup follow-up

export const RunObservabilityEventSchema = z.object({
  run_id: z.string().min(1).describe('对应 RunRecord.run_id'),
  ts: z.string().datetime().describe('事件时间戳，ISO8601'),
  line_index: z.number().int().nonnegative().describe('行序号，从 0 起，双流共享计数'),
  text: z.string().max(65_536).describe('stdout/stderr 原始行文本，64 KB hard cap'),
  source: z.enum(['stdout', 'stderr']).describe('事件来源流'),
  truncated: z.boolean().default(false).describe('文本是否被截断'),
});
export type RunObservabilityEvent = z.infer<typeof RunObservabilityEventSchema>;

export const ObservabilityStoreEntrySchema = z.object({
  run_id: z.string().min(1).describe('对应 RunRecord.run_id'),
  session_id: z.string().min(1).describe('对应 SessionRecord.session_id'),
  step_index: z.number().int().min(0).default(0).describe('当前步骤序号，从 0 起'),
  token_usage: z.number().int().min(0).default(0).describe('累计 token 消耗'),
  status: z.enum(RUN_STATUS_VALUES).describe('与 RunRecord.status 同步'),
  updated_at: z.string().datetime().describe('最近写入时间，ISO8601'),
  last_stdout_at: z.string().datetime().nullable().describe('静默检测基准时间'),
  origin_message_id: z.string().nullable().describe('E1/E3 原始卡片锚点'),
  card_message_id: z.string().nullable().describe('E1 patch 目标 Lark message_id'),
  home_group_id: z.string().nullable().default(null).describe('E3/F24 顶层发送目标 chat_id；缺失时跳过非 reply send'),
  created_at: z.string().datetime().describe('run 观测开始时间'),
  alerted: z.boolean().default(false).describe('F26 幂等标记'),
  alert_reason: z.enum(ALERT_REASON).nullable().describe('最近一次告警原因'),
  finalized: z.boolean().default(false).describe('F27 幂等标记'),
  cancelled: z.boolean().default(false).describe('cancel 路径标记'),
  alert_enabled: z.boolean().default(true).describe('F29 per-session 推送开关'),
  store_truncated: z.boolean().default(false).describe('progress.ndjson 已达 10MB 上限'),
  stale_self_heal_attempts: z.number().int().min(0).default(0).describe('watchdog stale self-heal 已占用次数'),
  stale_self_heal_last_attempt_at: z.string().datetime().nullable().default(null).describe('最近一次 watchdog stale self-heal 尝试时间'),
  stale_self_heal_escalated_at: z.string().datetime().nullable().default(null).describe('超出 stale self-heal 次数后首次升级 admin alert 时间'),
  // M11-C C1 (2026-08-04, owner-authorized): additive fields to surface auto-doc-sink
  // behaviour on finalize runs. Defaults preserve prior behaviour for rows without these keys.
  produced_doc_urls: z.array(z.string()).default([]).describe('auto doc-sink 写出的 doc/wiki URL 列表（含历史与本次）'),
  doc_sink_attempted_at: z.string().datetime().nullable().default(null).describe('最近一次 ensureRunDoc 尝试时间'),
  doc_sink_last_reason: z.string().nullable().default(null).describe('ensureRunDoc 最近一次的 reason 字段（created/already_succeeded/failed/locked/not_longform/not_terminal）'),
});
export type ObservabilityStoreEntry = z.infer<typeof ObservabilityStoreEntrySchema>;

export type AlertReason = typeof ALERT_REASON[number];
export const AlertPayloadSchema = z.object({
  run_id: z.string().min(1).describe('对应 RunRecord.run_id'),
  session_id: z.string().min(1).describe('对应 SessionRecord.session_id'),
  reason: z.enum(ALERT_REASON).describe('告警类型'),
  last_output_at: z.string().datetime().nullable().describe('最后一条输出时间'),
  elapsed_s: z.number().nonnegative().describe('run 已运行秒数'),
  exit_code: z.number().int().nullable().describe('exit_nonzero 时的退出码'),
  signal: z.string().nullable().describe('进程终止信号，如 SIGKILL'),
});
export type AlertPayload = z.infer<typeof AlertPayloadSchema>;

export const FinalizePayloadSchema = z.object({
  run_id: z.string().min(1).describe('对应 RunRecord.run_id'),
  session_id: z.string().min(1).describe('对应 SessionRecord.session_id'),
  status: z.enum(RUN_STATUS_VALUES).describe('RUN_STATUS 终态值'),
  elapsed_s: z.number().nonnegative().describe('run 总运行秒数'),
  origin_message_id: z.string().nullable().describe('reply 锚点；缺失时降级顶层发送'),
  head_lines: z.array(z.string()).describe('output 前 N 行'),
  tail_lines: z.array(z.string()).describe('output 后 N 行'),
  output_truncated: z.boolean().default(false).describe('head+tail 合并后是否超 4KB'),
});
export type FinalizePayload = z.infer<typeof FinalizePayloadSchema>;

export const ObservabilityConfigSchema = z.object({
  enabled: z.boolean().default(true).describe('全局开关；false 时跳过所有 F22-F29'),
  alert_enabled: z.boolean().default(true).describe('默认推送开关；F29 per-session 可覆盖'),
  silent_timeout_s: z.number().int().min(SILENT_TIMEOUT_S_MIN).max(SILENT_TIMEOUT_S_MAX).default(SILENT_TIMEOUT_S_DEFAULT).describe('F24 静默超时秒数'),
  finalize_head_lines: z.number().int().positive().default(FINALIZE_HEAD_LINES).describe('E3 摘要头部行数'),
  finalize_tail_lines: z.number().int().positive().default(FINALIZE_TAIL_LINES).describe('E3 摘要尾部行数'),
}).default({});
export type ObservabilityConfig = z.infer<typeof ObservabilityConfigSchema>;

export const RUN_OBSERVABILITY_ERROR_CODES = {
  E_STORE_WRITE: 'run-observability.store.write_failed',
  E_STORE_TRUNCATED: 'run-observability.store.truncated',
  E_IM_SEND_FAILED: 'run-observability.im.send_failed',
  E_IM_PATCH_FAILED: 'run-observability.im.patch_failed',
  E_RUN_STALE_NOOP: 'run-observability.alert.stale_noop',
  E_NO_ACTIVE_SESSION: 'run-observability.session.not_found',
} as const;
export type RunObservabilityErrorCode = typeof RUN_OBSERVABILITY_ERROR_CODES[keyof typeof RUN_OBSERVABILITY_ERROR_CODES];

export class RunObservabilityError extends Error {
  constructor(public readonly code: RunObservabilityErrorCode, message: string, public readonly cause?: unknown) {
    super(`[${code}] ${message}`);
    this.name = 'RunObservabilityError';
  }
}
