import type { ApprovalRequestRecord } from '../../../../packages/core/src/approval-gate/contracts.js';
import type { MuteRegistry } from '../../../../packages/core/src/reverse-channel/index.js';

export type ApprovalNotifier = {
  /**
   * Notify all configured approvers about a new approval request. Implementations
   * should be idempotent — repeated calls with the same requestId must not fan out
   * multiple times for the same terminal state.
   *
   * PRD §2.7 反向 @ 礼仪第 4 条：命中 MuteRegistry 的 session 只刷卡片、不 @ 人。
   * 卡片本身已包含 <at user_id=...>, 真正的 @ 行为已嵌入卡片渲染；本通道 (额外
   * sendCard 一次) 仅确保 @ 真实 ping 到 user, 所以当 MuteRegistry 命中时
   * 应直接 skip, 让 Worker/Watchdog 后续在卡片上 patch 状态即可。
   */
  notifyApprovers(request: ApprovalRequestRecord): Promise<void>;
};

/**
 * Card-driven notifier: the actual @通知 is embedded in the approval card itself
 * via `<at user_id=... />` markup, so dispatch 只走 `renderApprovalRequestCard`
 * 的 patch/reply 路径；这里保留一个 hook 让上层 (wb-bot event-handler) 可以
 * 在不改 cards.ts 的情况下追加额外通道 (例如 IM 私聊 owner / dm)，并统一做
 * "只 @ 一次" 节流。
 *
 * 启用 muteRegistry 时: 命中 session 静音 → skip sendCard, 卡片已由主流程先 reply,
 * 后续状态推进走 patch. 这样实现 PRD §2.7(4) 礼仪第 4 条.
 */
export function createCardApprovalNotifier(opts: {
  sendCard: (chatId: string, card: Record<string, unknown>) => Promise<void>;
  cardFor: (request: ApprovalRequestRecord) => Record<string, unknown>;
  resolveChatId: (request: ApprovalRequestRecord) => string;
  notifyOncePerRequest?: boolean;
  muteRegistry?: MuteRegistry;
  /** 提取 session id 用来查 mute (默认 request.sessionId) */
  sessionIdOf?: (request: ApprovalRequestRecord) => string;
}): ApprovalNotifier {
  const seen = new Set<string>();
  return {
    async notifyApprovers(request) {
      if (opts.notifyOncePerRequest !== false && seen.has(request.requestId)) return;
      seen.add(request.requestId);

      const sessionId = opts.sessionIdOf ? opts.sessionIdOf(request) : request.sessionId;
      if (opts.muteRegistry && sessionId) {
        const record = opts.muteRegistry.isMuted({ sessionId });
        if (record.muted) {
          // 静音 → 只让卡片由后续流程 patch, 不再发一次独立通知
          return;
        }
      }

      await opts.sendCard(opts.resolveChatId(request), opts.cardFor(request));
    },
  };
}
