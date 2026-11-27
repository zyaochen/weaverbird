import { ATTACH_TIMEOUT_MS, REVERSE_CHANNEL_ERROR_CODES, ReverseChannelError, type AttachRequest, type AttachResult, type SessionRecord } from './contracts.js';
import { CaptainService, CAPTAIN_ERROR_CODES, CaptainError } from '../captain/index.js';
import { encodeAuditResource } from './audit-encoder.js';

export async function handleAttachRequest(captainService: CaptainService, request: AttachRequest): Promise<AttachResult> {
  const current = captainService.getSession(request.session_id);
  if (!current) {
    return { outcome: 'not_found', session_id: request.session_id, candidates: [] };
  }

  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new ReverseChannelError(REVERSE_CHANNEL_ERROR_CODES.E_ATTACH_TIMEOUT, 'attach timed out')), ATTACH_TIMEOUT_MS);
  });
  const existing = current.record;
  const work = (async (): Promise<AttachResult> => {
    if (existing.captain_id !== request.requester_captain_id && !request.force) {
      return {
        outcome: 'mutex_conflict',
        session_id: request.session_id,
        current_captain_id: existing.captain_id,
        conflict_since: existing.last_active_at,
        suggestion: 'use --force to take over',
      };
    }
    const patched: Partial<SessionRecord> = {
      captain_id: request.requester_captain_id,
      status: 'active',
      last_active_at: request.requested_at,
    };
    captainService.updateSession(request.session_id, patched);
    try {
      await captainService.flush();
    } catch (error) {
      throw new ReverseChannelError(
        REVERSE_CHANNEL_ERROR_CODES.E_ATTACH_FLUSH_FAILED,
        `attach flush failed: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    }
    return {
      outcome: 'attached',
      session_id: request.session_id,
      session: captainService.getSession(request.session_id)?.record,
      run_ids: captainService.getSession(request.session_id)?.run_ids ?? [],
    };
  })();
  return Promise.race([work, timeout]);
}

/**
 * M11-D D2 (2026-08-04 owner-authorized): 同样的 attach 语义,但把 updated 提交到
 * `CaptainSessionStore.upsertWithRevision` 而不是普通 upsert。在远端 session-store 已经
 * 把 revision 推过别的值时,会抛 `CaptainError(E_REVISION_MISMATCH)`, 这里转换成
 * `mutex_conflict` 让调用方端到端处理 (建议先 reconcile 再 force attach)。
 *
 * 返回 `expected` / `actual` 供 CLI 端把冲突状态写化到日志;调用方拿到该结果后通常
 * 要么 reconcile 要么 force,不需要再额外索 store。
 */
export async function handleAttachRequestWithRevision(
  captainService: CaptainService,
  request: AttachRequest & { expected_revision?: number },
): Promise<AttachResult> {
  const current = captainService.getSession(request.session_id);
  if (!current) {
    return { outcome: 'not_found', session_id: request.session_id, candidates: [] };
  }
  const existing = current.record;
  if (existing.captain_id !== request.requester_captain_id && !request.force) {
    return {
      outcome: 'mutex_conflict',
      session_id: request.session_id,
      current_captain_id: existing.captain_id,
      conflict_since: existing.last_active_at,
      suggestion: 'use --force to take over',
    };
  }

  const expectedRevision = request.expected_revision ?? existing.revision;
  const patched: SessionRecord = {
    ...existing,
    captain_id: request.requester_captain_id,
    status: 'active',
    last_active_at: request.requested_at,
    revision: expectedRevision,
  };

  try {
    captainService.updateSession(request.session_id, patched);
    await captainService.flush();
    return {
      outcome: 'attached',
      session_id: request.session_id,
      session: captainService.getSession(request.session_id)?.record,
      run_ids: captainService.getSession(request.session_id)?.run_ids ?? [],
    };
  } catch (error) {
    if (error instanceof CaptainError && error.code === CAPTAIN_ERROR_CODES.E_REVISION_MISMATCH) {
      const match = /actual=(\d+)/.exec(error.message);
      const actual = match ? Number.parseInt(match[1]!, 10) : existing.revision;
      return {
        outcome: 'revision_mismatch',
        session_id: request.session_id,
        expected_revision: expectedRevision,
        actual_revision: actual,
        suggestion: 'run reconcile or use --force',
      };
    }
    throw error;
  }
}

export function attachAuditResource(sessionId: string, previousCaptainId: string): string {
  return encodeAuditResource({ verb: 'attach', targetId: sessionId, result: 'ok', fromCaptainId: previousCaptainId });
}

export function attachRevisionMismatchAuditResource(sessionId: string, expected: number, actual: number): string {
  // Salt the fromCaptainId slot with the revisions so the audit sink keeps
  // the conflict evidence without inventing a new field on the encoder.
  return encodeAuditResource({ verb: 'attach', targetId: sessionId, result: 'fail', fromCaptainId: `rev_${expected}_to_${actual}` });
}
