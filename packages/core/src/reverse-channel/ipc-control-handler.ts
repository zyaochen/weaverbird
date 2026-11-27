import { REVERSE_CHANNEL_ERROR_CODES, ReverseChannelError, type ReverseAtCommand } from './contracts.js';
import { encodeAuditResource } from './audit-encoder.js';

const SIGNAL_BY_COMMAND = {
  pause: 'SIGSTOP',
  resume: 'SIGCONT',
  cancel: 'SIGTERM',
} as const;

export async function sendControlSignal(command: ReverseAtCommand['command'], pid: number): Promise<{ signal: string }> {
  const signal = SIGNAL_BY_COMMAND[command];
  try {
    process.kill(pid, signal);
    return { signal };
  } catch (error) {
    throw new ReverseChannelError(REVERSE_CHANNEL_ERROR_CODES.E_SIGNAL_FAILED, `failed to send ${signal} to pid ${pid}: ${error instanceof Error ? error.message : String(error)}`, error);
  }
}

export function reverseAtAuditResource(input: {
  command: ReverseAtCommand['command'];
  runId: string;
  senderOpenId: string;
  result: 'ok' | 'fail';
  reasonCode?: keyof typeof REVERSE_CHANNEL_ERROR_CODES;
}): string {
  return encodeAuditResource({
    verb: input.command,
    targetId: input.runId,
    senderOpenId: input.senderOpenId,
    signal: SIGNAL_BY_COMMAND[input.command],
    result: input.result,
    reasonCode: input.reasonCode,
  });
}
