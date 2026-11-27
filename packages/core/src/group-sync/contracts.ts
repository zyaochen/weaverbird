import { z } from 'zod';

export const GroupSyncConfigSchema = z.object({
  enabled: z.boolean().default(false),
  transport: z.enum(['disabled', 'mock', 'guarded']).default('disabled'),
  rpc_timeout_ms: z.number().int().positive().default(15_000),
  sweep_interval_ms: z.number().int().positive().default(15_000),
});
export type GroupSyncConfig = z.infer<typeof GroupSyncConfigSchema>;

export const GroupSyncCommandReceivedSchema = z.object({
  request_id: z.string().min(1),
  session_id: z.string().min(1),
  run_id: z.string().min(1),
  revision: z.number().int().min(0),
  text: z.string().min(1),
  scheduled_at: z.string().datetime(),
  user_open_id: z.string().optional(),
  thread_id: z.string().optional(),
  message_id: z.string().optional(),
});
export type GroupSyncCommandReceived = z.infer<typeof GroupSyncCommandReceivedSchema>;

export const GroupSyncStateSchema = z.object({
  request_id: z.string().min(1),
  session_id: z.string().min(1),
  run_id: z.string().min(1),
  revision: z.number().int().min(0),
  thread_id: z.string().nullable().default(null),
  message_id: z.string().nullable().default(null),
  scheduled_at: z.string().datetime(),
  last_synced_at: z.string().datetime().nullable().default(null),
  sync_failed: z.boolean().default(false),
  last_error: z.string().nullable().default(null),
  updated_at: z.string().datetime(),
});
export type GroupSyncState = z.infer<typeof GroupSyncStateSchema>;

export interface GroupSyncTransport {
  syncCommand(input: GroupSyncCommandReceived): Promise<void>;
}

export const GroupSyncArtifactKindSchema = z.enum(['run', 'session', 'diff', 'doc']);
export type GroupSyncArtifactKind = z.infer<typeof GroupSyncArtifactKindSchema>;

export const GroupSyncCrossGroupReferenceInputSchema = z.object({
  request_id: z.string().min(1),
  session_id: z.string().min(1),
  run_id: z.string().min(1),
  revision: z.number().int().min(0),
  source_thread_id: z.string().min(1),
  source_message_id: z.string().min(1).nullable().optional(),
  target_thread_id: z.string().min(1),
  target_message_id: z.string().min(1).nullable().optional(),
  artifact_kind: GroupSyncArtifactKindSchema.default('run'),
  artifact_label: z.string().min(1),
  artifact_path: z.string().min(1).nullable().optional(),
});
export type GroupSyncCrossGroupReferenceInput = z.infer<typeof GroupSyncCrossGroupReferenceInputSchema>;

export const GroupSyncCrossGroupReferenceSchema = GroupSyncCrossGroupReferenceInputSchema.extend({
  reference_id: z.string().min(1),
  created_at: z.string().datetime(),
  synced_at: z.string().datetime().nullable().default(null),
  sync_failed: z.boolean().default(false),
  last_error: z.string().nullable().default(null),
});
export type GroupSyncCrossGroupReference = z.infer<typeof GroupSyncCrossGroupReferenceSchema>;

export const GroupSyncCrossGroupReferenceSetSchema = z.object({
  session_id: z.string().min(1),
  run_id: z.string().min(1),
  last_revision: z.number().int().min(0),
  updated_at: z.string().datetime(),
  references: z.array(GroupSyncCrossGroupReferenceSchema).default([]),
});
export type GroupSyncCrossGroupReferenceSet = z.infer<typeof GroupSyncCrossGroupReferenceSetSchema>;

export interface GroupSyncReferenceTransport {
  publishReference(input: GroupSyncCrossGroupReference): Promise<void>;
}

export const GroupSyncReviewDiffReplyInputSchema = z.object({
  request_id: z.string().min(1),
  session_id: z.string().min(1),
  run_id: z.string().min(1),
  revision: z.number().int().min(0),
  source_thread_id: z.string().min(1),
  source_message_id: z.string().min(1).nullable().optional(),
  review_id: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().min(1),
  diff_paths: z.array(z.string().min(1)).default([]),
});
export type GroupSyncReviewDiffReplyInput = z.infer<typeof GroupSyncReviewDiffReplyInputSchema>;

export const GroupSyncReviewDiffReplySchema = GroupSyncReviewDiffReplyInputSchema.extend({
  reply_id: z.string().min(1),
  created_at: z.string().datetime(),
  synced_at: z.string().datetime().nullable().default(null),
  sync_failed: z.boolean().default(false),
  last_error: z.string().nullable().default(null),
});
export type GroupSyncReviewDiffReply = z.infer<typeof GroupSyncReviewDiffReplySchema>;

export const GroupSyncReviewDiffReplySetSchema = z.object({
  session_id: z.string().min(1),
  run_id: z.string().min(1),
  last_revision: z.number().int().min(0),
  updated_at: z.string().datetime(),
  replies: z.array(GroupSyncReviewDiffReplySchema).default([]),
});
export type GroupSyncReviewDiffReplySet = z.infer<typeof GroupSyncReviewDiffReplySetSchema>;

export interface GroupSyncReviewDiffTransport {
  publishReviewDiff(input: GroupSyncReviewDiffReply): Promise<void>;
}

export const GroupSyncAutoDocTerminalStatusSchema = z.enum(['succeeded', 'failed', 'cancelled']);
export type GroupSyncAutoDocTerminalStatus = z.infer<typeof GroupSyncAutoDocTerminalStatusSchema>;

export const GroupSyncAutoDocInputSchema = z.object({
  request_id: z.string().min(1),
  session_id: z.string().min(1),
  run_id: z.string().min(1),
  revision: z.number().int().min(0),
  artifact_id: z.string().min(1),
  artifact_label: z.string().min(1),
  artifact_path: z.string().min(1).nullable().optional(),
  sink_run_id: z.string().min(1),
  terminal_status: GroupSyncAutoDocTerminalStatusSchema,
  existing_doc_urls: z.array(z.string().url()).default([]),
});
export type GroupSyncAutoDocInput = z.infer<typeof GroupSyncAutoDocInputSchema>;

export const GroupSyncAutoDocReasonSchema = z.enum([
  'already_succeeded',
  'existing_registry_url',
  'not_terminal',
  'not_longform',
  'created',
  'failed',
  'locked',
]);
export type GroupSyncAutoDocReason = z.infer<typeof GroupSyncAutoDocReasonSchema>;

export const GroupSyncAutoDocArtifactSchema = GroupSyncAutoDocInputSchema.extend({
  sync_id: z.string().min(1),
  doc_urls: z.array(z.string().url()).default([]),
  doc_sink_failed: z.boolean().default(false),
  sync_failed: z.boolean().default(false),
  sink_reason: GroupSyncAutoDocReasonSchema,
  doc_state_path: z.string().min(1),
  fallback_path: z.string().min(1),
  created_at: z.string().datetime(),
  synced_at: z.string().datetime().nullable().default(null),
  last_error: z.string().nullable().default(null),
});
export type GroupSyncAutoDocArtifact = z.infer<typeof GroupSyncAutoDocArtifactSchema>;

export const GroupSyncAutoDocArtifactSetSchema = z.object({
  session_id: z.string().min(1),
  run_id: z.string().min(1),
  last_revision: z.number().int().min(0),
  updated_at: z.string().datetime(),
  artifacts: z.array(GroupSyncAutoDocArtifactSchema).default([]),
});
export type GroupSyncAutoDocArtifactSet = z.infer<typeof GroupSyncAutoDocArtifactSetSchema>;
