import { z } from 'zod';

export const PERIODIC_REENTRY_POLICY = ['skip', 'queue_one'] as const;
export type PeriodicReentryPolicy = typeof PERIODIC_REENTRY_POLICY[number];

export const PeriodicTaskConfigSchema = z.object({
  task_id: z.string().min(1),
  enabled: z.boolean().default(true),
  owner_open_id: z.string().min(1),
  schedule: z.union([
    z.object({ type: z.literal('interval'), interval_ms: z.number().int().positive(), anchor_at: z.string().datetime().optional() }),
    z.object({ type: z.literal('cron'), expr: z.string().min(1), timezone: z.string().optional() }),
  ]),
  target: z.object({
    home_group_id: z.string().min(1),
    user_open_id: z.string().min(1),
    cwd: z.string().min(1),
    agent_id: z.string().optional(),
  }),
  run_template: z.object({
    text: z.string().min(1),
  }),
  reentry: z.object({
    policy: z.enum(PERIODIC_REENTRY_POLICY).default('skip'),
    timeout_ms: z.number().int().positive().optional(),
  }).default({ policy: 'skip' }),
});
export type PeriodicTaskConfig = z.infer<typeof PeriodicTaskConfigSchema>;

export const PeriodicTasksConfigSchema = z.object({
  enabled: z.boolean().default(true),
  tasks: z.array(PeriodicTaskConfigSchema).default([]),
});
export type PeriodicTasksConfig = z.infer<typeof PeriodicTasksConfigSchema>;

export const PeriodicOccurrenceSchema = z.object({
  task_id: z.string().min(1),
  occurrence_id: z.string().min(1),
  window_start: z.string().datetime(),
  window_end: z.string().datetime(),
  scheduled_at: z.string().datetime(),
  request_id: z.string().min(1),
  run_id: z.string().min(1),
});
export type PeriodicOccurrence = z.infer<typeof PeriodicOccurrenceSchema>;

export const PeriodicStateEntrySchema = z.object({
  last_window_start: z.string().datetime().nullable().default(null),
  active_occurrence_id: z.string().nullable().default(null),
  active_run_id: z.string().nullable().default(null),
  active_started_at: z.string().datetime().nullable().default(null),
  queued_occurrence_id: z.string().nullable().default(null),
  queued_run_id: z.string().nullable().default(null),
  last_decision: z.enum(['spawned', 'skipped_busy', 'queued', 'dequeued_spawned', 'timed_out', 'dispatch_failed', 'terminal']).nullable().default(null),
  last_decision_at: z.string().datetime().nullable().default(null),
  last_error: z.string().nullable().default(null),
  last_terminal_status: z.enum(['succeeded', 'failed', 'cancelled', 'timed_out']).nullable().default(null),
  last_terminal_at: z.string().datetime().nullable().default(null),
});
export type PeriodicStateEntry = z.infer<typeof PeriodicStateEntrySchema>;

export const PeriodicStateSchema = z.object({
  version: z.literal(1),
  tasks: z.record(PeriodicStateEntrySchema).default({}),
});
export type PeriodicState = z.infer<typeof PeriodicStateSchema>;

export const PeriodicOccurrenceLedgerRecordSchema = z.object({
  task_id: z.string().min(1),
  occurrence_id: z.string().min(1),
  window_start: z.string().datetime(),
  window_end: z.string().datetime(),
  scheduled_at: z.string().datetime(),
  request_id: z.string().min(1),
  run_id: z.string().min(1),
  decision: z.enum(['spawned', 'skipped_busy', 'queued', 'dequeued_spawned', 'timed_out', 'dispatch_failed', 'terminal']),
  reason: z.string().nullable().default(null),
  ts: z.string().datetime(),
});
export type PeriodicOccurrenceLedgerRecord = z.infer<typeof PeriodicOccurrenceLedgerRecordSchema>;

export const PeriodicTaskRunSidecarSchema = z.object({
  task_id: z.string().min(1),
  occurrence_id: z.string().min(1),
  window_start: z.string().datetime(),
  window_end: z.string().datetime(),
  scheduled_at: z.string().datetime(),
  policy: z.enum(PERIODIC_REENTRY_POLICY),
  home_group_id: z.string().min(1),
});
export type PeriodicTaskRunSidecar = z.infer<typeof PeriodicTaskRunSidecarSchema>;
