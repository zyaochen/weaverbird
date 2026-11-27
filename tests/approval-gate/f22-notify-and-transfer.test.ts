import { APPROVAL_REQUEST_STATUS, type ApprovalRequestRecord } from '../../packages/core/src/approval-gate/contracts.js';
import { describe, expect, it } from 'vitest';
import { renderApprovalCountdownText, renderApprovalRequestCard, renderApprovalResolvedCard } from '../../apps/wb-bot/src/approval-gate/cards.js';
import { createCardApprovalNotifier } from '../../apps/wb-bot/src/approval-gate/notifier.js';

function makeRequest(overrides: Partial<ApprovalRequestRecord> = {}): ApprovalRequestRecord {
  return {
    requestId: 'req-1',
    runId: 'run-1',
    botId: 'default',
    sessionId: 'sess-1',
    userOpenId: 'ou-owner',
    threadId: 'oc_home',
    sourceMessageId: 'm1',
    replyMessageId: 'm1',
    agentId: 'codex',
    cwd: '/repo',
    createdAt: '2026-08-04T08:00:00Z',
    deadlineAt: '2026-08-04T08:30:00Z',
    status: APPROVAL_REQUEST_STATUS.PENDING_APPROVAL,
    anchor: 'writeToMainBranch',
    approverPolicy: 'owner',
    timeoutMs: 1_800_000,
    toolName: 'shell',
    toolInput: { command: 'git push' },
    resource: 'main',
    summary: 'push to main',
    allowedApproverOpenIds: ['ou-owner', 'ou-admin'],
    carrier: 'group_card',
    carrierMessageId: 'm2',
    ...overrides,
  };
}

describe('approval-gate card rendering', () => {
  it('renders all approver open ids as <at> tags', () => {
    const card = renderApprovalRequestCard(makeRequest());
    const body = card['body'] as { elements: Array<{ tag: string; content?: string }> };
    const hasMention = body.elements.some((element) =>
      element.tag === 'markdown' && (element.content ?? '').includes('<at user_id="ou-owner" />') && (element.content ?? '').includes('<at user_id="ou-admin" />'),
    );
    expect(hasMention).toBe(true);
  });

  it('M13-E: card header uses the verb-form headline (not raw anchor name)', () => {
    const card = renderApprovalRequestCard(makeRequest());
    const header = card['header'] as { title: { content: string } };
    expect(header.title.content).toBe('🚀 准备往 main 提交代码 — 需要审批');
  });

  it('M13-E: mention line gives the "why + next step" alongside the @ 列表', () => {
    const card = renderApprovalRequestCard(makeRequest());
    const body = card['body'] as { elements: Array<{ tag: string; content?: string }> };
    const mentionLine = body.elements.find((element) => (element.content ?? '').includes('<at user_id="ou-owner" />'));
    expect(mentionLine?.content).toContain('批准 = 放行这次 push · 拒绝 = 终止这个 run');
  });

  it('hides mention row when no approvers configured', () => {
    const card = renderApprovalRequestCard(makeRequest({ allowedApproverOpenIds: [] }));
    const body = card['body'] as { elements: Array<{ tag: string; content?: string }> };
    const hasMention = body.elements.some((element) => (element.content ?? '').includes('<at user_id='));
    expect(hasMention).toBe(false);
  });

  it('includes approve / deny / transfer buttons', () => {
    const card = JSON.stringify(renderApprovalRequestCard(makeRequest()));
    expect(card).toContain('approval_gate_approve');
    expect(card).toContain('approval_gate_deny');
    expect(card).toContain('approval_gate_transfer');
  });

  it('countdown shows mm:ss while inside window, "已超时" afterwards', () => {
    const request = makeRequest();
    const inWindow = renderApprovalCountdownText(request, Date.parse(request.createdAt) + 60_000);
    expect(inWindow).toMatch(/^⏱️ 剩余 \d+m\d\ds$/);
    const atDeadline = renderApprovalCountdownText(request, Date.parse(request.deadlineAt));
    expect(atDeadline).toContain('已超时');
  });

  it('resolved card shows status label + resolved_by', () => {
    const card = JSON.stringify(renderApprovalResolvedCard(makeRequest({
      status: APPROVAL_REQUEST_STATUS.APPROVED,
      resolutionReason: 'ok',
      resolvedBy: 'ou-admin',
    })));
    expect(card).toContain('已批准');
    expect(card).toContain('ou-admin');
  });
});

describe('approval-gate notifier', () => {
  it('sends the card once per requestId by default', async () => {
    const sent: Array<{ chatId: string }> = [];
    const notifier = createCardApprovalNotifier({
      sendCard: async (chatId) => { sent.push({ chatId }); },
      cardFor: () => ({ schema: '2.0' }),
      resolveChatId: (request) => request.threadId,
    });
    await notifier.notifyApprovers(makeRequest());
    await notifier.notifyApprovers(makeRequest()); // same id, should dedupe
    await notifier.notifyApprovers(makeRequest({ requestId: 'req-2' }));
    expect(sent).toHaveLength(2);
    expect(sent[0]?.chatId).toBe('oc_home');
  });

  it('does not throw when both sendCard fails', async () => {
    const notifier = createCardApprovalNotifier({
      sendCard: async () => { throw new Error('rate limited'); },
      cardFor: () => ({}),
      resolveChatId: () => 'oc_home',
    });
    await expect(notifier.notifyApprovers(makeRequest())).rejects.toThrow('rate limited');
  });
});
