import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { APPROVAL_REQUEST_STATUS } from '../../packages/core/src/approval-gate/contracts.js';
import { ApprovalRequestStore, defaultApprovalCarrier, readApprovalResolution } from '../../apps/wb-bot/src/approval-gate/store.js';

const roots: string[] = [];

function mkRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'wb-approval-store-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('approval request store', () => {
  it('creates requests and persists dispatch + resolution', () => {
    const root = mkRoot();
    const store = new ApprovalRequestStore(root, () => '2026-06-26T00:00:00.000Z');
    const request = store.create({
      runId: 'run-001',
      botId: 'default',
      sessionId: 'default:ou_1:grp',
      userOpenId: 'ou_1',
      threadId: 'grp',
      sourceMessageId: 'm1',
      replyMessageId: 'r1',
      agentId: 'claude-code',
      cwd: '/repo',
      match: {
        anchor: 'envVarChange',
        approverPolicy: 'owner',
        timeoutMs: 30 * 60 * 1000,
        toolName: 'Edit',
        toolInput: { file_path: '/repo/.env' },
        summary: '/repo/.env',
        resource: '/repo/.env',
      },
      allowedApproverOpenIds: ['ou_1', 'ou_code_owner_1'],
    });

    expect(request.status).toBe(APPROVAL_REQUEST_STATUS.PENDING_DISPATCH);
    expect(request.allowedApproverOpenIds).toEqual(['ou_1', 'ou_code_owner_1']);
    const dispatched = store.markDispatched(request.requestId, 'group_card', 'msg-1');
    expect(dispatched.status).toBe(APPROVAL_REQUEST_STATUS.PENDING_APPROVAL);

    const resolved = store.resolve(request.requestId, {
      status: APPROVAL_REQUEST_STATUS.DENIED,
      reason: 'approval denied',
      resolvedAt: '2026-06-26T00:05:00.000Z',
      resolvedBy: 'ou_owner',
    });
    expect(resolved.status).toBe(APPROVAL_REQUEST_STATUS.DENIED);
    expect(readApprovalResolution(root, request.requestId)?.reason).toBe('approval denied');
  });

  it('expires overdue pending requests fail-closed', () => {
    const store = new ApprovalRequestStore(mkRoot(), () => '2026-06-26T00:00:00.000Z');
    const request = store.create({
      runId: 'run-002',
      botId: 'default',
      sessionId: 'default:ou_1:grp',
      userOpenId: 'ou_1',
      threadId: 'grp',
      sourceMessageId: 'm2',
      replyMessageId: 'r2',
      agentId: 'claude-code',
      cwd: '/repo',
      match: {
        anchor: 'writeToMainBranch',
        approverPolicy: 'owner_and_code_owner',
        timeoutMs: 10 * 60 * 1000,
        toolName: 'Bash',
        toolInput: { command: 'git push origin HEAD:main' },
        summary: 'git push origin HEAD:main',
        resource: 'git push origin HEAD:main',
      },
    });

    store.markDispatched(request.requestId, 'group_card');
    const expired = store.expireOverdue('2026-06-26T00:11:00.000Z');
    expect(expired).toHaveLength(1);
    expect(expired[0]?.status).toBe(APPROVAL_REQUEST_STATUS.EXPIRED);
    expect(expired[0]?.resolutionReason).toBe('approval timeout');
  });

  it('transferInPlace keeps requestId / status pending and rewrites approver list', () => {
    const store = new ApprovalRequestStore(mkRoot(), () => '2026-06-26T00:00:00.000Z');
    const request = store.create({
      runId: 'run-003',
      botId: 'default',
      sessionId: 'default:ou_1:grp',
      userOpenId: 'ou_1',
      threadId: 'grp',
      sourceMessageId: 'm3',
      replyMessageId: 'r3',
      agentId: 'claude-code',
      cwd: '/repo',
      match: {
        anchor: 'envVarChange',
        approverPolicy: 'owner',
        timeoutMs: 30 * 60 * 1000,
        toolName: 'Edit',
        toolInput: { file_path: '/repo/.env' },
        summary: '.env',
        resource: '/repo/.env',
      },
      allowedApproverOpenIds: ['ou_1', 'ou_2'],
    });

    store.markDispatched(request.requestId, 'group_card', 'msg-x');
    const next = store.transferInPlace(request.requestId, ['ou_2'], '2026-06-26T00:06:00.000Z');
    // M13-B: requestId 不变 / status 保 pending / allow-list 已重写为剩余审批人
    expect(next.requestId).toBe(request.requestId);
    expect(next.status).toBe(APPROVAL_REQUEST_STATUS.PENDING_APPROVAL);
    expect(next.allowedApproverOpenIds).toEqual(['ou_2']);
    expect(next.carrierMessageId).toBe('msg-x');
    expect(next.createdAt).toBe(request.createdAt);
    expect(next.deadlineAt).toBe(request.deadlineAt);

    const persisted = store.get(request.requestId);
    expect(persisted?.allowedApproverOpenIds).toEqual(['ou_2']);
  });

  it('transferInPlace throws when request is already resolved', () => {
    const store = new ApprovalRequestStore(mkRoot(), () => '2026-06-26T00:00:00.000Z');
    const request = store.create({
      runId: 'run-004',
      botId: 'default',
      sessionId: 'default:ou_1:grp',
      userOpenId: 'ou_1',
      threadId: 'grp',
      sourceMessageId: 'm4',
      replyMessageId: 'r4',
      agentId: 'claude-code',
      cwd: '/repo',
      match: {
        anchor: 'envVarChange',
        approverPolicy: 'owner',
        timeoutMs: 30 * 60 * 1000,
        toolName: 'Edit',
        toolInput: { file_path: '/repo/.env' },
        summary: '.env',
        resource: '/repo/.env',
      },
      allowedApproverOpenIds: ['ou_1', 'ou_2'],
    });
    store.resolve(request.requestId, {
      status: APPROVAL_REQUEST_STATUS.APPROVED,
      reason: 'ok',
      resolvedAt: '2026-06-26T00:05:00.000Z',
    });
    expect(() => store.transferInPlace(request.requestId, ['ou_2'])).toThrow(/not pending/);
  });

  it('chooses approval app first, otherwise group card', () => {
    expect(defaultApprovalCarrier(true)).toBe('approval_app');
    expect(defaultApprovalCarrier(false)).toBe('group_card');
  });
});
