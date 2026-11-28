import pino from 'pino';
import { errorSerializers } from './log-redact.js';

/**
 * 收到消息即在原消息上打一个「敲键盘」(Typing) 表情, run 结束后撤掉.
 * 运行卡要等 reply 回来才出现, 表情是更早、手机通知里也看得到的"我收到了".
 *
 * 纯装饰: add / remove 失败只 warn, 不影响主流程. 只能撤 bot 自己打的表情, 所以要记 reaction_id.
 */

export const ACK_EMOJI = 'Typing';

export type ReactionClient = {
  addReaction?(messageId: string, emojiType: string): Promise<string | undefined>;
  removeReaction?(messageId: string, reactionId: string): Promise<void>;
};

const logger = pino({ level: process.env['LOG_LEVEL'] ?? 'info', serializers: errorSerializers });

export class AckReactions {
  private readonly pending = new Map<string, Promise<string | undefined>>();

  constructor(private readonly client: ReactionClient) {}

  add(messageId: string): void {
    if (!this.client.addReaction || !messageId || this.pending.has(messageId)) return;
    const added = this.client.addReaction(messageId, ACK_EMOJI).catch((error: unknown) => {
      logger.warn({ messageId, error: error instanceof Error ? error.message : String(error) }, 'ack reaction add failed');
      return undefined;
    });
    this.pending.set(messageId, added);
  }

  async clear(messageId: string): Promise<void> {
    const added = this.pending.get(messageId);
    if (!added) return;
    this.pending.delete(messageId);
    const reactionId = await added;
    if (!reactionId || !this.client.removeReaction) return;
    try {
      await this.client.removeReaction(messageId, reactionId);
    } catch (error) {
      logger.warn({ messageId, reactionId, error: error instanceof Error ? error.message : String(error) }, 'ack reaction remove failed');
    }
  }

  has(messageId: string): boolean {
    return this.pending.has(messageId);
  }
}
