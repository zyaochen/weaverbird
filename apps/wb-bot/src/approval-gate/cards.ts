import type { ApprovalRequestRecord } from '../../../../packages/core/src/approval-gate/contracts.js';

function mentionApproversContent(request: ApprovalRequestRecord): string | null {
  if (!request.allowedApproverOpenIds.length) return null;
  return request.allowedApproverOpenIds.map((openId) => `<at user_id="${openId}" />`).join(' ');
}

export function renderApprovalCountdownText(request: ApprovalRequestRecord, nowMs: number): string {
  const remainingMs = Date.parse(request.deadlineAt) - nowMs;
  if (remainingMs <= 0) return '⏱️ 已超时，默认拒绝';
  const totalSeconds = Math.max(0, Math.floor(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `⏱️ 剩余 ${minutes}m${String(seconds).padStart(2, '0')}s`;
}

// M13-E: PRD §2.7 "@ 必带 '为什么 @ 你 + 下一步动作'" — 卡头中文化、动词短句
// 明确告诉被 @ 审批人"这是什么、下一步该怎么做"。
const ANCHOR_HEADLINE: Record<string, { emoji: string; verb: string; explanation: string }> = {
  writeToMainBranch: { emoji: '🚀', verb: '准备往 main 提交代码', explanation: '批准 = 放行这次 push · 拒绝 = 终止这个 run' },
  envVarChange: { emoji: '🔧', verb: '准备修改 / 读取环境变量', explanation: '批准 = 放行这次 env 变更 · 拒绝 = 终止这个 run' },
  externalDepUpgrade: { emoji: '📦', verb: '准备升级外部依赖', explanation: '批准 = 放行升级 · 拒绝 = 终止这个 run' },
};

function anchorCallout(request: ApprovalRequestRecord): { emoji: string; verb: string; explanation: string } {
  return ANCHOR_HEADLINE[request.anchor] ?? { emoji: '⚠️', verb: '准备动敏感操作', explanation: '批准或拒绝即可, 可以转派' };
}

export function renderApprovalRequestCard(request: ApprovalRequestRecord): Record<string, unknown> {
  const mentions = mentionApproversContent(request);
  const nowMs = Date.now();
  const headline = anchorCallout(request);
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: `${headline.emoji} ${headline.verb} — 需要审批` } },
    body: {
      elements: [
        // 为什么 @ 你 + 下一步: PRD §2.7。
        ...(mentions ? [{ tag: 'markdown', content: `${mentions} ${headline.explanation}` }] : [{ tag: 'markdown', content: `${headline.explanation}` }]),
        { tag: 'markdown', content: `**触发的 run** ${request.agentId}\n*${request.cwd}*\n${request.summary}` },
        { tag: 'markdown', content: `${renderApprovalCountdownText(request, nowMs)}\nrequest_id: ${request.requestId}` },
        {
          tag: 'column_set',
          columns: [
            {
              tag: 'column',
              width: 'weighted',
              weight: 1,
              elements: [{
                tag: 'button',
                text: { tag: 'plain_text', content: '批准' },
                type: 'primary_filled',
                behaviors: [{ type: 'callback', value: { action: 'approval_gate_approve', requestId: request.requestId } }],
              }],
            },
            {
              tag: 'column',
              width: 'weighted',
              weight: 1,
              elements: [{
                tag: 'button',
                text: { tag: 'plain_text', content: '拒绝' },
                type: 'default',
                behaviors: [{ type: 'callback', value: { action: 'approval_gate_deny', requestId: request.requestId } }],
              }],
            },
            {
              tag: 'column',
              width: 'weighted',
              weight: 1,
              elements: [{
                tag: 'button',
                text: { tag: 'plain_text', content: '转派' },
                type: 'default',
                behaviors: [{ type: 'callback', value: { action: 'approval_gate_transfer', requestId: request.requestId } }],
              }],
            },
          ],
        },
      ],
    },
  };
}

export function renderApprovalResolvedCard(request: ApprovalRequestRecord): Record<string, unknown> {
  const statusLabel = request.status === 'approved' ? '✅ 已批准' : request.status === 'denied' ? '❌ 已拒绝' : '⌛ 已超时';
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: `${statusLabel} · ${request.anchor}` } },
    body: {
      elements: [
        { tag: 'markdown', content: `agent: ${request.agentId}\ncwd: ${request.cwd}\nsummary: ${request.summary}` },
        { tag: 'markdown', content: `resolution: ${request.resolutionReason ?? '-'}\nresolved_by: ${request.resolvedBy ?? '-'}\nrequest: ${request.requestId}` },
      ],
    },
  };
}

