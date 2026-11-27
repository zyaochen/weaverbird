/**
 * W3.3 wb-cli Console + 反向@ — SPEC contracts
 * ≤200 lines · zod schemas + derived TS types · no runtime imports
 *
 * Import-only from W3.1/W3.2/W3.2.5 (do NOT modify):
 *   EVENT_TYPES, ENTRY_FORMS              ← audit-pipe (W3.1)
 *   RUN_STATUS                            ← run-registry (W3.2)
 *   SESSION_STATUS, SessionRecord,
 *   CaptainConfig, CAPTAIN_ERROR_CODES    ← captain (W3.2.5)
 */

import { z } from 'zod';
import { RUN_STATUS } from '../run-registry/contracts.js';
import { ENTRY_FORMS } from '../audit-pipe/contracts.js';
import {
  SESSION_STATUS,
  type SessionRecord,
  type CaptainConfig,
  CAPTAIN_ERROR_CODES,
} from '../captain/contracts.js';

const RUN_STATUS_VALUES = Object.values(RUN_STATUS) as [string, ...string[]];

export { RUN_STATUS, ENTRY_FORMS, SESSION_STATUS, CAPTAIN_ERROR_CODES };
export type { SessionRecord, CaptainConfig };

// ── Reverse channel constants ─────────────────────────────────────────────────

export const IPC_SOCKET_PATH = '~/.weaverbird/captain.sock';
export const ECHO_DEDUP_WINDOW_MS = 30_000;
export const ATTACH_TIMEOUT_MS = 5_000;
export const HEARTBEAT_INTERVAL_MS = 30_000;
export const REVERSE_AT_PREFIX = '@wb';
export const REVERSE_AT_PATTERN = /^\s*(pause|resume|cancel)\s+([a-zA-Z0-9_-]{1,64})\s*$/i;
export const REVERSE_CHANNEL_AUDIT_RESOURCE_PREFIX = 'reverse-channel:';
export const ECHO_CMD_PREVIEW_MAX = 80;
export const ECHO_MAX_PER_RUN = 3;

export const REVERSE_COMMAND = ['pause', 'resume', 'cancel', 'attach', 'echo'] as const;
export type ReverseCommand = typeof REVERSE_COMMAND[number];

// ── F18 Attach ────────────────────────────────────────────────────────────────

export const AttachRequestSchema = z.object({
  session_id:            z.string().min(1),
  requester_captain_id:  z.string().min(1),
  requested_at:          z.string().datetime(),   // ISO8601
  force:                 z.boolean().default(false), // force attach even if mutex conflict
});
export type AttachRequest = z.infer<typeof AttachRequestSchema>;

export const AttachResultSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome:    z.literal('attached'),
    session_id: z.string(),
    session:    z.unknown(),                       // SessionRecord (avoid circular import)
    run_ids:    z.array(z.string()),
  }),
  z.object({
    outcome:            z.literal('mutex_conflict'),
    session_id:         z.string(),
    current_captain_id: z.string(),
    conflict_since:     z.string().datetime(),
    suggestion:         z.string(),               // "use --force to take over"
  }),
  z.object({
    outcome:    z.literal('not_found'),
    session_id: z.string(),
    candidates: z.array(z.string()),              // recent session_ids from local mirror
  }),
  z.object({
    outcome:    z.literal('timed_out'),
    session_id: z.string(),
    elapsed_ms: z.number().int(),
  }),
  z.object({
    outcome:           z.literal('revision_mismatch'),
    session_id:        z.string(),
    expected_revision: z.number().int().min(0),
    actual_revision:   z.number().int().min(0),
    suggestion:        z.string(),
  }),
]);
export type AttachResult = z.infer<typeof AttachResultSchema>;

// ── F19 Echo ──────────────────────────────────────────────────────────────────

export const EchoPayloadSchema = z.object({
  run_id:            z.string().min(1),
  cmd_preview:       z.string().max(ECHO_CMD_PREVIEW_MAX),  // first 80 chars of prompt
  cwd:               z.string(),
  created_at:        z.string().datetime(),
  status:            z.enum(RUN_STATUS_VALUES),
  session_id:        z.string(),
  home_group_id:     z.string(),
  operator_open_id:  z.string(),                 // for @mention in IM message
});
export type EchoPayload = z.infer<typeof EchoPayloadSchema>;

// ── F21 Reverse @ ─────────────────────────────────────────────────────────────

const CONTROL_COMMANDS = ['pause', 'resume', 'cancel'] as const;
export type ControlCommand = typeof CONTROL_COMMANDS[number];

export const ReverseAtCommandSchema = z.object({
  command:           z.enum(CONTROL_COMMANDS),
  run_id:            z.string().min(1),
  requester_open_id: z.string(),
  requested_at:      z.string().datetime(),
  message_id:        z.string(),                  // Lark message_id for reply threading
});
export type ReverseAtCommand = z.infer<typeof ReverseAtCommandSchema>;

// ── IPC message envelope ──────────────────────────────────────────────────────

export const AttachIpcMessageSchema = z.object({
  kind: z.literal('attach'),
  run_id: z.string().min(1),
  session_id: z.string().min(1),
  requester_captain_id: z.string().min(1),
  force: z.boolean().optional(),
});

export const AckIpcMessageSchema = z.object({
  kind: z.literal('ack'),
  command: z.string(),
  run_id: z.string(),
  ok: z.boolean(),
  reason: z.string().optional(),
  payload: z.unknown().optional(),
});

export const IpcMessageSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('hello'), run_id: z.string(), pid: z.number().int() }),
  z.object({ kind: z.literal('control'), command: z.enum(CONTROL_COMMANDS), run_id: z.string() }),
  AttachIpcMessageSchema,
  AckIpcMessageSchema,
  z.object({ kind: z.literal('ping') }),
  z.object({ kind: z.literal('pong') }),
  z.object({ kind: z.literal('bye'), run_id: z.string(), exit_code: z.number().int().optional() }),
]);
export type IpcMessage = z.infer<typeof IpcMessageSchema>;

// ── Error codes + Error class ─────────────────────────────────────────────────

export const REVERSE_CHANNEL_ERROR_CODES = {
  E_ATTACH_TIMEOUT:      'reverse.attach.timeout',
  E_ATTACH_NOT_FOUND:    'reverse.attach.not_found',
  E_ATTACH_MUTEX:        'reverse.attach.mutex_conflict',
  E_ATTACH_FLUSH_FAILED: 'reverse.attach.flush_failed',
  E_IPC_CONNECT_FAILED:  'reverse.ipc.connect_failed',
  E_IPC_SEND_TIMEOUT:    'reverse.ipc.send_timeout',
  E_IPC_PARSE:           'reverse.ipc.parse_error',
  E_ECHO_SEND_FAILED:    'reverse.echo.send_failed',
  E_REVERSE_AT_PARSE:    'reverse.at.parse_error',
  E_REVERSE_AT_RUN_GONE: 'reverse.at.run_not_found',
  E_SIGNAL_FAILED:       'reverse.signal.send_failed',
  E_CAPTAIN_HANDED_OVER: 'reverse.attach.handed_over',
} as const;
export type ReverseChannelErrorCode = typeof REVERSE_CHANNEL_ERROR_CODES[keyof typeof REVERSE_CHANNEL_ERROR_CODES];

export class ReverseChannelError extends Error {
  constructor(
    public readonly code: ReverseChannelErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'ReverseChannelError';
  }
}
