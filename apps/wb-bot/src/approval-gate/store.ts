import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { appendNdjsonLine, readNdjsonSegments } from '../../../../packages/core/src/util/ndjson-rotation.js';
import { approvalRequestsPath, approvalResolutionPath } from '../../../../packages/core/src/paths.js';
import {
  APPROVAL_CARRIER,
  APPROVAL_REQUEST_STATUS,
  type ApprovalCarrier,
  type ApprovalGateMatch,
  type ApprovalMirrorEntry,
  type ApprovalRequestRecord,
  type ApprovalResolutionRecord,
} from '../../../../packages/core/src/approval-gate/contracts.js';

export type ApprovalRequestCreateInput = {
  runId: string;
  botId: string;
  sessionId: string;
  userOpenId: string;
  threadId: string;
  sourceMessageId: string;
  replyMessageId: string;
  agentId: string;
  cwd: string;
  match: ApprovalGateMatch;
  allowedApproverOpenIds?: string[];
  carrier?: ApprovalCarrier;
  nowIso?: string;
};

export class ApprovalRequestStore {
  private readonly requests = new Map<string, ApprovalRequestRecord>();

  constructor(
    private readonly dataDir: string,
    private readonly nowFn: () => string = () => new Date().toISOString(),
  ) {
    this.replay();
  }

  create(input: ApprovalRequestCreateInput): ApprovalRequestRecord {
    const createdAt = input.nowIso ?? this.nowFn();
    const deadlineAt = new Date(Date.parse(createdAt) + input.match.timeoutMs).toISOString();
    const request: ApprovalRequestRecord = {
      requestId: randomUUID(),
      runId: input.runId,
      botId: input.botId,
      sessionId: input.sessionId,
      userOpenId: input.userOpenId,
      threadId: input.threadId,
      sourceMessageId: input.sourceMessageId,
      replyMessageId: input.replyMessageId,
      agentId: input.agentId,
      cwd: input.cwd,
      createdAt,
      deadlineAt,
      status: APPROVAL_REQUEST_STATUS.PENDING_DISPATCH,
      anchor: input.match.anchor,
      approverPolicy: input.match.approverPolicy,
      timeoutMs: input.match.timeoutMs,
      toolName: input.match.toolName,
      toolInput: input.match.toolInput,
      resource: input.match.resource,
      summary: input.match.summary,
      allowedApproverOpenIds: [...new Set(input.allowedApproverOpenIds ?? [input.userOpenId])].sort(),
      carrier: input.carrier,
    };
    this.requests.set(request.requestId, request);
    this.writeMirror({ ts: createdAt, op: 'request_created', request });
    return request;
  }

  markDispatched(requestId: string, carrier: ApprovalCarrier, carrierMessageId?: string, nowIso = this.nowFn()): ApprovalRequestRecord {
    const request = this.requireRequest(requestId);
    const next: ApprovalRequestRecord = {
      ...request,
      status: APPROVAL_REQUEST_STATUS.PENDING_APPROVAL,
      carrier,
      carrierMessageId,
    };
    this.requests.set(requestId, next);
    this.writeMirror({ ts: nowIso, op: 'request_dispatched', request: next });
    return next;
  }

  resolve(requestId: string, resolution: Omit<ApprovalResolutionRecord, 'requestId' | 'runId'>): ApprovalRequestRecord {
    const request = this.requireRequest(requestId);
    const next: ApprovalRequestRecord = {
      ...request,
      status: resolution.status,
      resolutionReason: resolution.reason,
      resolvedAt: resolution.resolvedAt,
      resolvedBy: resolution.resolvedBy,
    };
    this.requests.set(requestId, next);
    this.writeResolution({
      requestId,
      runId: request.runId,
      status: resolution.status,
      reason: resolution.reason,
      resolvedAt: resolution.resolvedAt,
      resolvedBy: resolution.resolvedBy,
    });
    this.writeMirror({ ts: resolution.resolvedAt, op: 'request_resolved', request: next });
    return next;
  }

  /**
   * M13-B (2026-08-04 owner-authorized): 真正的 transfer 语义 = 保留原 request,
   * 把 allowedApproverOpenIds 整表替换为新的 pending 名单。**不** DENIED 原
   * record,也**不**新建行。后续的 approve/deny/expire 走的都是原 requestId,
   * audit 上以一次"request_dispatched (re-targeted)" 镜像登记 (含 approver 列表 diff).
   */
  transferInPlace(requestId: string, newApproverOpenIds: string[], nowIso = this.nowFn()): ApprovalRequestRecord {
    const previous = this.requireRequest(requestId);
    if (previous.status !== APPROVAL_REQUEST_STATUS.PENDING_DISPATCH && previous.status !== APPROVAL_REQUEST_STATUS.PENDING_APPROVAL) {
      throw new Error(`approval request ${requestId} is not pending (status=${previous.status})`);
    }
    const next: ApprovalRequestRecord = {
      ...previous,
      allowedApproverOpenIds: [...new Set(newApproverOpenIds)].sort(),
    };
    this.requests.set(requestId, next);
    this.writeMirror({ ts: nowIso, op: 'request_dispatched', request: next });
    return next;
  }

  get(requestId: string): ApprovalRequestRecord | undefined {
    this.replay();
    const request = this.requests.get(requestId);
    return request ? { ...request } : undefined;
  }

  listPending(): ApprovalRequestRecord[] {
    this.replay();
    return [...this.requests.values()]
      .filter((request) => request.status === APPROVAL_REQUEST_STATUS.PENDING_DISPATCH || request.status === APPROVAL_REQUEST_STATUS.PENDING_APPROVAL)
      .map((request) => ({ ...request }));
  }

  expireOverdue(nowIso = this.nowFn()): ApprovalRequestRecord[] {
    const expired: ApprovalRequestRecord[] = [];
    for (const request of this.requests.values()) {
      if (request.status !== APPROVAL_REQUEST_STATUS.PENDING_DISPATCH && request.status !== APPROVAL_REQUEST_STATUS.PENDING_APPROVAL) continue;
      if (Date.parse(request.deadlineAt) > Date.parse(nowIso)) continue;
      expired.push(this.resolve(request.requestId, {
        status: APPROVAL_REQUEST_STATUS.EXPIRED,
        reason: 'approval timeout',
        resolvedAt: nowIso,
      }));
    }
    return expired;
  }

  private requireRequest(requestId: string): ApprovalRequestRecord {
    const request = this.requests.get(requestId);
    if (!request) throw new Error(`approval request not found: ${requestId}`);
    return request;
  }

  private replay(): void {
    const path = approvalRequestsPath(this.dataDir);
    if (!existsSync(path)) return;
    for (const line of readNdjsonSegments(path)) {
      const entry = JSON.parse(line) as ApprovalMirrorEntry;
      this.requests.set(entry.request.requestId, entry.request);
    }
  }

  private writeMirror(entry: ApprovalMirrorEntry): void {
    appendNdjsonLine(approvalRequestsPath(this.dataDir), JSON.stringify(entry), { fsync: true });
  }

  private writeResolution(entry: ApprovalResolutionRecord): void {
    const path = approvalResolutionPath(this.dataDir, entry.requestId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(entry, null, 2));
  }
}

export function defaultApprovalCarrier(isApprovalAppAvailable: boolean): ApprovalCarrier {
  return isApprovalAppAvailable ? APPROVAL_CARRIER.APPROVAL_APP : APPROVAL_CARRIER.GROUP_CARD;
}

export function readApprovalResolution(dataDir: string, requestId: string): ApprovalResolutionRecord | null {
  const path = approvalResolutionPath(dataDir, requestId);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as ApprovalResolutionRecord;
}
