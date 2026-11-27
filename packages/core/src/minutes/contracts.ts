import { z } from 'zod';

export const MinutesContentKindSchema = z.enum(['summary', 'notes', 'transcript']);
export type MinutesContentKind = z.infer<typeof MinutesContentKindSchema>;

export const MinutesFetchRequestSchema = z.object({
  request_id: z.string().min(1),
  session_id: z.string().min(1),
  run_id: z.string().min(1),
  revision: z.number().int().min(0),
  minute_id: z.string().min(1),
  content_kind: MinutesContentKindSchema.default('summary'),
  requested_at: z.string().datetime(),
});
export type MinutesFetchRequest = z.infer<typeof MinutesFetchRequestSchema>;

export const MinutesContentSchema = z.object({
  minute_id: z.string().min(1),
  title: z.string().min(1),
  content: z.string().min(1),
  source_url: z.string().url().nullable().default(null),
  fetched_at: z.string().datetime(),
});
export type MinutesContent = z.infer<typeof MinutesContentSchema>;

export const MinutesRunArtifactSchema = MinutesFetchRequestSchema.extend({
  attach_id: z.string().min(1),
  minute_title: z.string().min(1),
  source_url: z.string().url().nullable().default(null),
  fetched_at: z.string().datetime().nullable().default(null),
  artifact_path: z.string().min(1).nullable().default(null),
  content_digest: z.string().min(1).nullable().default(null),
  attached_at: z.string().datetime(),
  attach_failed: z.boolean().default(false),
  last_error: z.string().nullable().default(null),
});
export type MinutesRunArtifact = z.infer<typeof MinutesRunArtifactSchema>;

export const MinutesRunStateSchema = z.object({
  session_id: z.string().min(1),
  run_id: z.string().min(1),
  last_revision: z.number().int().min(0),
  updated_at: z.string().datetime(),
  artifacts: z.array(MinutesRunArtifactSchema).default([]),
});
export type MinutesRunState = z.infer<typeof MinutesRunStateSchema>;

export interface MinutesClient {
  fetchMinutes(request: MinutesFetchRequest): Promise<MinutesContent>;
}
