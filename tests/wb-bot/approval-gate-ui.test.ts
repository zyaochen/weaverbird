import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BindingStore } from '../../apps/wb-bot/src/binding/store.js';
import { EventHandler } from '../../apps/wb-bot/src/feishu/event-handler.js';
import { createInitialState } from '../../apps/wb-bot/src/feishu/stream-state.js';
import { ApprovalRequestStore } from '../../apps/wb-bot/src/approval-gate/store.js';
import { APPROVAL_REQUEST_STATUS } from '../../packages/core/src/approval-gate/contracts.js';

const roots: string[] = [];

function mkRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'wb-approval-ui-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  delete process.env['WB_DATA_DIR'];
});

describe('approval gate card actions', () => {
  it('resolves approval requests via dedicated card actions and writes audit', async () => {
    const dataDir = mkRoot();
    process.env['WB_DATA_DIR'] = dataDir;
    const store = new BindingStore(join(dataDir, 'wb-bot.db'));
    const handler = new EventHandler({
      register() {},
      lookup() { return null; },
      list() { return []; },
      async isAvailable() { return null; },
    }, store, {
      async replyCard() { return 'reply-approval'; },
      async updateCard() {},
      async replyText() { return 'msg-1'; },
    });

    const approvalStore = new ApprovalRequestStore(dataDir, () => '2026-06-26T00:00:00.000Z');
    const request = approvalStore.create({
      runId: 'run-approval-1',
      botId: 'default',
      sessionId: 'default:ou_owner:grp',
      userOpenId: 'ou_owner',
      threadId: 'grp',
      sourceMessageId: 'm1',
      replyMessageId: 'reply-1',
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
      allowedApproverOpenIds: ['ou_owner', 'ou_code_owner_1'],
      carrier: 'group_card',
    });
    approvalStore.markDispatched(request.requestId, 'group_card', 'reply-approval');

    const scopeKey = 'ou_owner:grp:claude-code';
    const session = {
      scopeKey,
      sourceMessageId: 'm1',
      replyMessageId: 'reply-1',
      run: null,
      runId: 'run-approval-1',
      pipeline: { force: vi.fn(async () => undefined), flush: vi.fn(async () => undefined) },
      state: { ...createInitialState('claude-code', 'Claude Code', 'Claude Code'), cwd: '/repo' },
      extraMessageIds: [],
      startedAt: Date.now(),
      agentId: 'claude-code',
      sessionId: 'default:ou_owner:grp',
    };
    (handler as any).activeSessions.set(scopeKey, session);
    (handler as any).activeSessionsByMessageId.set('reply-1', session);

    const approved = await handler.handleCardAction({
      eventId: 'evt-approve',
      userOpenId: 'ou_owner',
      threadId: 'grp',
      messageId: 'reply-approval',
      action: 'approval_gate_approve',
      requestId: request.requestId,
    });
    expect((approved as { toast?: { content?: string } }).toast?.content).toBe('已批准');

    const deniedRequest = approvalStore.create({
      runId: 'run-approval-2',
      botId: 'default',
      sessionId: 'default:ou_owner:grp',
      userOpenId: 'ou_owner',
      threadId: 'grp',
      sourceMessageId: 'm2',
      replyMessageId: 'reply-2',
      agentId: 'claude-code',
      cwd: '/repo',
      match: {
        anchor: 'externalDepUpgrade',
        approverPolicy: 'owner',
        timeoutMs: 60 * 60 * 1000,
        toolName: 'Bash',
        toolInput: { command: 'pnpm add zod' },
        summary: 'pnpm add zod',
        resource: 'pnpm add zod',
      },
      allowedApproverOpenIds: ['ou_owner'],
      carrier: 'group_card',
    });
    approvalStore.markDispatched(deniedRequest.requestId, 'group_card', 'reply-approval-2');

    const denied = await handler.handleCardAction({
      eventId: 'evt-deny',
      userOpenId: 'ou_owner',
      threadId: 'grp',
      messageId: 'reply-approval-2',
      action: 'approval_gate_deny',
      requestId: deniedRequest.requestId,
    });
    expect((denied as { toast?: { content?: string } }).toast?.content).toBe('已拒绝');

    const unauthorized = await handler.handleCardAction({
      eventId: 'evt-deny-unauthorized',
      userOpenId: 'ou_outsider',
      threadId: 'grp',
      messageId: 'reply-approval-2',
      action: 'approval_gate_deny',
      requestId: deniedRequest.requestId,
    });
    expect((unauthorized as { toast?: { content?: string } }).toast?.content).toBe('你无权处理该审批');

    const auditText = readFileSync(join(dataDir, 'audit-mirror.ndjson'), 'utf8');
    expect(auditText).toContain('approval-gate:resolved');
    expect(auditText).toContain('anchor=envVarChange');
    expect(auditText).toContain('anchor=externalDepUpgrade');

    const resolvedApprove = new ApprovalRequestStore(dataDir).get(request.requestId);
    const resolvedDeny = new ApprovalRequestStore(dataDir).get(deniedRequest.requestId);
    expect(resolvedApprove?.status).toBe(APPROVAL_REQUEST_STATUS.APPROVED);
    expect(resolvedDeny?.status).toBe(APPROVAL_REQUEST_STATUS.DENIED);

    store.close();
  });
});
