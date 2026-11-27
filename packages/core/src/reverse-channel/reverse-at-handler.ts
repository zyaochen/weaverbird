import { REVERSE_AT_PATTERN, REVERSE_CHANNEL_ERROR_CODES, ReverseChannelError, type ReverseAtCommand } from './contracts.js';
import type { CaptainService } from '../captain/index.js';

type ReverseAtCaptainServiceLike = Pick<CaptainService, 'listActiveSessions'>;

export function parseReverseAt(text: string, requesterOpenId: string, messageId: string, requestedAt = new Date().toISOString()): ReverseAtCommand | null {
  const match = text.match(REVERSE_AT_PATTERN);
  if (!match) return null;
  return {
    command: match[1]!.toLowerCase() as ReverseAtCommand['command'],
    run_id: match[2]!,
    requester_open_id: requesterOpenId,
    requested_at: requestedAt,
    message_id: messageId,
  };
}

export function validateReverseAtRun(captainService: ReverseAtCaptainServiceLike, runId: string): void {
  const exists = captainService.listActiveSessions().some((entry) => entry.run_ids.includes(runId));
  if (!exists) {
    throw new ReverseChannelError(REVERSE_CHANNEL_ERROR_CODES.E_REVERSE_AT_RUN_GONE, `run ${runId} not found`);
  }
}
