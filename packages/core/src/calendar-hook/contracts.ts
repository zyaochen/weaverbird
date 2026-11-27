import { z } from 'zod';

export const CALENDAR_TRIGGER_SOURCES = ['calendar'] as const;
export type CalendarTriggerSource = typeof CALENDAR_TRIGGER_SOURCES[number];

export const CalendarHookConfigSchema = z.object({
  enabled: z.boolean().default(false),
  transport: z.enum(['disabled', 'mock', 'cli']).default('mock'),
  calendar_id: z.string().min(1).optional(),
  rpc_timeout_ms: z.number().int().positive().default(15_000),
  overdue_after_ms: z.number().int().positive().default(60 * 60 * 1000),
  sweep_interval_ms: z.number().int().positive().default(15_000),
});
export type CalendarHookConfig = z.infer<typeof CalendarHookConfigSchema>;

export const CalendarHookStateSchema = z.object({
  run_id: z.string().min(1),
  session_id: z.string().min(1).nullable().default(null),
  open_revision_applied: z.number().int().min(0).nullable(),
  close_revision_applied: z.number().int().min(0).nullable(),
  calendar_block_id: z.string().nullable(),
  calendar_hook_failed: z.boolean().default(false),
  desired_state: z.enum(['open', 'closed']).default('open'),
  due_at: z.string().datetime().nullable(),
  overdue_escalated_at: z.string().datetime().nullable(),
  last_error: z.string().nullable(),
  updated_at: z.string().datetime(),
});
export type CalendarHookState = z.infer<typeof CalendarHookStateSchema>;

export const CalendarBlockRequestSchema = z.object({
  run_id: z.string().min(1),
  session_id: z.string().min(1),
  revision: z.number().int().min(0),
  title: z.string().min(1),
  starts_at: z.string().datetime(),
  ends_at: z.string().datetime(),
});
export type CalendarBlockRequest = z.infer<typeof CalendarBlockRequestSchema>;

export const CalendarBlockResultSchema = z.object({
  calendar_block_id: z.string().min(1),
});
export type CalendarBlockResult = z.infer<typeof CalendarBlockResultSchema>;

export interface CalendarTransport {
  openBlock(input: CalendarBlockRequest): Promise<CalendarBlockResult>;
  closeBlock(input: { run_id: string; revision: number; calendar_block_id: string }): Promise<void>;
}

export const CalendarCommandReceivedSchema = z.object({
  source: z.enum(['calendar', 'periodic']),
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
export type CalendarCommandReceived = z.infer<typeof CalendarCommandReceivedSchema>;

export const CalendarTriggerRecordSchema = z.object({
  request_id: z.string().min(1),
  session_id: z.string().min(1),
  run_id: z.string().min(1),
  revision: z.number().int().min(0),
  text: z.string().min(1),
  scheduled_at: z.string().datetime(),
  user_open_id: z.string().optional(),
  thread_id: z.string().optional(),
  message_id: z.string().optional(),
  fired_at: z.string().datetime().nullable().default(null),
});
export type CalendarTriggerRecord = z.infer<typeof CalendarTriggerRecordSchema>;

export const CalendarRunStateChangedSchema = z.object({
  event: z.literal('RunStateChanged'),
  reason: z.literal('calendar_overdue'),
  run_id: z.string().min(1),
  session_id: z.string().min(1),
  revision: z.number().int().min(0),
  ts: z.string().datetime(),
});
export type CalendarRunStateChanged = z.infer<typeof CalendarRunStateChangedSchema>;
