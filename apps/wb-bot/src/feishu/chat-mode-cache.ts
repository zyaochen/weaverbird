/**
 * 话题群判定. 消息事件里不带群模式, 只能 `im.v1.chat.get` 查一次; 群模式在群的生命周期内不变,
 * 按 chat_id 缓存. 查询失败按普通群处理且不写缓存, 下一条消息再试.
 */

export type ChatMode = 'group' | 'topic';

export type ChatInfo = { chat_mode?: string; group_message_type?: string };

export class ChatModeCache {
  private readonly cache = new Map<string, ChatMode>();

  constructor(
    private readonly fetchChat: (chatId: string) => Promise<ChatInfo | undefined>,
    private readonly onError: (chatId: string, error: unknown) => void = () => {},
  ) {}

  async resolve(chatId: string): Promise<ChatMode> {
    const hit = this.cache.get(chatId);
    if (hit) return hit;
    try {
      const info = await this.fetchChat(chatId);
      // 老话题群 chat_mode=topic; 新版 "话题模式" 群是 chat_mode=group + group_message_type=thread.
      const mode: ChatMode = info?.chat_mode === 'topic' || info?.group_message_type === 'thread' ? 'topic' : 'group';
      this.cache.set(chatId, mode);
      return mode;
    } catch (error) {
      this.onError(chatId, error);
      return 'group';
    }
  }
}

/** 回复要挂进话题: 消息本身在话题里, 或者所在群是话题群. */
export async function shouldReplyInThread(
  message: { chatType?: string; chatId?: string; threadId?: string },
  cache: Pick<ChatModeCache, 'resolve'>,
): Promise<boolean> {
  if (message.chatType === 'p2p') return false;
  if (message.threadId) return true;
  if (!message.chatType || !message.chatId) return false;
  return (await cache.resolve(message.chatId)) === 'topic';
}
