import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { APPROVAL_REQUEST_STATUS } from '../../packages/core/src/approval-gate/contracts.js';
import { ApprovalRequestStore } from '../../apps/wb-bot/src/approval-gate/store.js';

const roots: string[] = [];

function mkRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'wb-approval-timeout-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('approval gate timeout policy', () => {
  it('denies writeToMainBranch after 10 minutes', () => {
    const store = new ApprovalRequestStore(mkRoot(), () => '2026-06-26T00:00:00.000Z');
    const request = store.create({
      runId: 'run-main', botId: 'default', sessionId: 'sid', userOpenId: 'ou_1', threadId: 'grp', sourceMessageId: 'm1', replyMessageId: 'r1', agentId: 'claude-code', cwd: '/repo',
      match: { anchor: 'writeToMainBranch', approverPolicy: 'owner_and_code_owner', timeoutMs: 10 * 60 * 1000, toolName: 'Bash', toolInput: { command: 'git push origin main' }, summary: 'git push origin main', resource: 'git push origin main' },
    });
    store.markDispatched(request.requestId, 'group_card');
    const expired = store.expireOverdue('2026-06-26T00:10:01.000Z');
    expect(expired[0]?.status).toBe(APPROVAL_REQUEST_STATUS.EXPIRED);
  });

  it('denies envVarChange after 30 minutes', () => {
    const store = new ApprovalRequestStore(mkRoot(), () => '2026-06-26T00:00:00.000Z');
    const request = store.create({
      runId: 'run-env', botId: 'default', sessionId: 'sid', userOpenId: 'ou_1', threadId: 'grp', sourceMessageId: 'm1', replyMessageId: 'r1', agentId: 'claude-code', cwd: '/repo',
      match: { anchor: 'envVarChange', approverPolicy: 'owner', timeoutMs: 30 * 60 * 1000, toolName: 'Edit', toolInput: { file_path: '/repo/.env' }, summary: '/repo/.env', resource: '/repo/.env' },
    });
    store.markDispatched(request.requestId, 'group_card');
    const expired = store.expireOverdue('2026-06-26T00:30:01.000Z');
    expect(expired[0]?.status).toBe(APPROVAL_REQUEST_STATUS.EXPIRED);
  });

  it('denies externalDepUpgrade after 60 minutes', () => {
    const store = new ApprovalRequestStore(mkRoot(), () => '2026-06-26T00:00:00.000Z');
    const request = store.create({
      runId: 'run-dep', botId: 'default', sessionId: 'sid', userOpenId: 'ou_1', threadId: 'grp', sourceMessageId: 'm1', replyMessageId: 'r1', agentId: 'claude-code', cwd: '/repo',
      match: { anchor: 'externalDepUpgrade', approverPolicy: 'owner', timeoutMs: 60 * 60 * 1000, toolName: 'Bash', toolInput: { command: 'pnpm add zod' }, summary: 'pnpm add zod', resource: 'pnpm add zod' },
    });
    store.markDispatched(request.requestId, 'group_card');
    const expired = store.expireOverdue('2026-06-26T01:00:01.000Z');
    expect(expired[0]?.status).toBe(APPROVAL_REQUEST_STATUS.EXPIRED);
  });
});
