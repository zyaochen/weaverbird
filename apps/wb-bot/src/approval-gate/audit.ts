import { randomUUID } from 'node:crypto';
import type { AuditRecord, EntryDetail } from '../../../../packages/core/src/audit-pipe/contracts.js';
import { createMirrorSink } from '../../../../packages/core/src/audit-pipe/mirror-sink.js';
import type { ApprovalRequestRecord } from '../../../../packages/core/src/approval-gate/contracts.js';

function entryDetail(request: ApprovalRequestRecord): EntryDetail {
  return {
    source_message_id: request.sourceMessageId,
    user_open_id: request.userOpenId,
    thread_id: request.threadId,
  };
}

function buildResource(request: ApprovalRequestRecord, phase: string): string {
  const result = request.status;
  const reason = request.resolutionReason ? `:reason=${request.resolutionReason.replace(/[:\s]/g, '_')}` : '';
  const carrier = request.carrier ? `:carrier=${request.carrier}` : '';
  return `approval-gate:${phase}:anchor=${request.anchor}:request=${request.requestId}:result=${result}${carrier}${reason}`.slice(0, 256);
}

export function writeApprovalAudit(options: {
  dataDir: string;
  request: ApprovalRequestRecord;
  phase: 'created' | 'dispatched' | 'resolved';
  nowIso?: string;
}): void {
  const sink = createMirrorSink({ dataDir: options.dataDir });
  const record: AuditRecord = {
    audit_record_id: randomUUID(),
    session_id: requestSessionId(options.request),
    run_id: options.request.runId,
    revision: 0,
    actor: options.request.userOpenId,
    action: 'other',
    resource: buildResource(options.request, options.phase),
    ts: options.nowIso ?? new Date().toISOString(),
    entry_form: 'im',
    entry_detail: entryDetail(options.request),
    agent_id: 'claude-code',
    raw_tool_use_id: `approval-gate:${options.request.requestId}:${options.phase}`,
    raw_tool_name: 'approval-gate',
  };
  sink.write(record);
}

function requestSessionId(request: ApprovalRequestRecord): string {
  return request.sessionId;
}
