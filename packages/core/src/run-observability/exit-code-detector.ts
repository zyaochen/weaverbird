import { AlertPayloadSchema, type AlertPayload } from './contracts.js';

export type ExitMeta = {
  exit_code?: number | null;
  signal?: string | null;
};

export function detectExitError(input: {
  runId: string;
  sessionId: string;
  status: string;
  cancelled: boolean;
  elapsedS: number;
  exitMeta?: ExitMeta;
}): AlertPayload | null {
  if (input.cancelled) return null;
  if (input.status !== 'failed') return null;

  return AlertPayloadSchema.parse({
    run_id: input.runId,
    session_id: input.sessionId,
    reason: 'exit_nonzero',
    last_output_at: null,
    elapsed_s: input.elapsedS,
    exit_code: input.exitMeta?.exit_code ?? null,
    signal: input.exitMeta?.signal ?? null,
  });
}
