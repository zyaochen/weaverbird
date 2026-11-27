import type { CaptainService } from '../../../../packages/core/src/captain/captain-service.js';
import { handleAttachRequest } from '../../../../packages/core/src/reverse-channel/attach-handler.js';
import {
  REVERSE_CHANNEL_ERROR_CODES,
  ReverseChannelError,
  type AttachResult,
  type IpcMessage,
} from '../../../../packages/core/src/reverse-channel/contracts.js';
import { sendControlSignal } from '../../../../packages/core/src/reverse-channel/ipc-control-handler.js';
import type { IpcServer } from '../../../../packages/core/src/reverse-channel/ipc-server.js';
import { resolveCliPid } from '../../../../packages/core/src/reverse-channel/pid-resolver.js';

type AttachAck = Extract<IpcMessage, { kind: 'ack' }>;

const OUTCOME_REASON: Record<AttachResult['outcome'], string | undefined> = {
  attached: undefined,
  mutex_conflict: REVERSE_CHANNEL_ERROR_CODES.E_ATTACH_MUTEX,
  not_found: REVERSE_CHANNEL_ERROR_CODES.E_ATTACH_NOT_FOUND,
  timed_out: REVERSE_CHANNEL_ERROR_CODES.E_ATTACH_TIMEOUT,
  revision_mismatch: REVERSE_CHANNEL_ERROR_CODES.E_ATTACH_MUTEX,
};

function attachResultToAck(result: AttachResult, runId: string): AttachAck {
  return {
    kind: 'ack',
    command: 'attach',
    run_id: runId,
    ok: result.outcome === 'attached',
    reason: OUTCOME_REASON[result.outcome],
    payload: result,
  };
}

function attachThrowToAck(err: unknown, runId: string): AttachAck {
  if (err instanceof ReverseChannelError) {
    const code = err.code;
    const reason = code === REVERSE_CHANNEL_ERROR_CODES.E_ATTACH_TIMEOUT
      ? REVERSE_CHANNEL_ERROR_CODES.E_ATTACH_TIMEOUT
      : REVERSE_CHANNEL_ERROR_CODES.E_ATTACH_FLUSH_FAILED;
    return {
      kind: 'ack',
      command: 'attach',
      run_id: runId,
      ok: false,
      reason,
      payload: { outcome: 'error', code },
    };
  }
  return {
    kind: 'ack',
    command: 'attach',
    run_id: runId,
    ok: false,
    reason: REVERSE_CHANNEL_ERROR_CODES.E_ATTACH_FLUSH_FAILED,
    payload: {
      outcome: 'error',
      code: 'E_UNKNOWN',
      message: err instanceof Error ? err.message : String(err),
    },
  };
}

export function wireUpReverseChannel(ipcServer: IpcServer, captainService: CaptainService, dataDir: string, selfCaptainId: string): void {
  ipcServer.on('attach', async (msg) => {
    try {
      const result = await handleAttachRequest(captainService, {
        session_id: msg.session_id,
        requester_captain_id: msg.requester_captain_id,
        force: msg.force ?? false,
        requested_at: new Date().toISOString(),
      });
      const sent = ipcServer.send(msg.run_id, attachResultToAck(result, msg.run_id));
      if (!sent) {
        console.warn(`[wire-up] attach ack lost: no connection registered for run_id=${msg.run_id}`);
      }
    } catch (err) {
      const sent = ipcServer.send(msg.run_id, attachThrowToAck(err, msg.run_id));
      if (!sent) {
        console.warn(`[wire-up] attach ack lost: no connection registered for run_id=${msg.run_id}`);
      }
    }
  });

  ipcServer.on('control', async (msg) => {
    const session = captainService.listActiveSessions().find((entry) => entry.run_ids.includes(msg.run_id));
    if (session && session.record.captain_id !== selfCaptainId) {
      const sent = ipcServer.send(msg.run_id, {
        kind: 'ack',
        command: msg.command,
        run_id: msg.run_id,
        ok: false,
        reason: REVERSE_CHANNEL_ERROR_CODES.E_CAPTAIN_HANDED_OVER,
      });
      if (!sent) {
        console.warn(`[wire-up] control ack lost: no connection registered for run_id=${msg.run_id}`);
      }
      return;
    }

    const pid = resolveCliPid(dataDir, msg.run_id);
    if (!pid) {
      const sent = ipcServer.send(msg.run_id, {
        kind: 'ack',
        command: msg.command,
        run_id: msg.run_id,
        ok: false,
        reason: REVERSE_CHANNEL_ERROR_CODES.E_REVERSE_AT_RUN_GONE,
      });
      if (!sent) {
        console.warn(`[wire-up] control ack lost: no connection registered for run_id=${msg.run_id}`);
      }
      return;
    }
    try {
      await sendControlSignal(msg.command, pid);
      const sent = ipcServer.send(msg.run_id, {
        kind: 'ack',
        command: msg.command,
        run_id: msg.run_id,
        ok: true,
      });
      if (!sent) {
        console.warn(`[wire-up] control ack lost: no connection registered for run_id=${msg.run_id}`);
      }
    } catch {
      const sent = ipcServer.send(msg.run_id, {
        kind: 'ack',
        command: msg.command,
        run_id: msg.run_id,
        ok: false,
        reason: REVERSE_CHANNEL_ERROR_CODES.E_SIGNAL_FAILED,
      });
      if (!sent) {
        console.warn(`[wire-up] control ack lost: no connection registered for run_id=${msg.run_id}`);
      }
    }
  });
}
