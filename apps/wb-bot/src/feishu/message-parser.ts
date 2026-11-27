import { normalize, type ApiMessageItem, type RawMessageEvent, type ResourceDescriptor } from '@larksuiteoapi/node-sdk';

/**
 * 入站消息解析: 把飞书 `im.message.receive_v1` 的原始 message 交给 SDK `normalize()`,
 * 统一拿到可读文本 + 资源清单.
 *
 * 为什么不自己写: 飞书 msg_type 有 20+ 种 (post 富文本 / merge_forward 合并转发 /
 * interactive 卡片 / image / file / audio …), SDK converter 已覆盖且每个 converter
 * 自带异常兜底. weaverbird 只取它的"解析"能力, 不用 LarkChannel 的连接 / 去重 /
 * 队列 (那些 weaverbird 自己有, 见 event-handler.ts isDuplicate 与 Captain 队列).
 *
 * normalize 的文本约定 (SDK 1.66):
 * - bot 自己的 @ 被剥掉, 其他人的 `@_user_N` 占位符替换成 `@名字`
 * - image → `![image](<image_key>)`; file → `<file key="<file_key>" name="..."/>`
 * - merge_forward → `<forwarded_messages>…</forwarded_messages>` (需 fetchSubMessages)
 */

export type InboundResource = ResourceDescriptor;

export type RawLarkMessage = {
  message_id?: string;
  chat_id?: string;
  root_id?: string;
  parent_id?: string;
  thread_id?: string;
  chat_type?: string;
  message_type?: string;
  content?: string;
  create_time?: string;
  mentions?: Array<{
    key?: string;
    name?: string;
    id?: { open_id?: string; user_id?: string | null; union_id?: string };
  }>;
};

export type ParsedInbound = {
  text: string;
  msgType: string;
  resources: InboundResource[];
  parentId?: string;
  mentionAll: boolean;
};

export type ParseInboundOptions = {
  botOpenId: string;
  senderOpenId?: string;
  fetchSubMessages?: (messageId: string) => Promise<ApiMessageItem[]>;
};

function legacyText(content: string): string {
  try {
    const parsed = JSON.parse(content) as { text?: unknown };
    return typeof parsed.text === 'string' ? parsed.text : '';
  } catch {
    return content;
  }
}

function toRawEvent(message: RawLarkMessage, senderOpenId: string | undefined): RawMessageEvent {
  return {
    sender: { sender_id: { open_id: senderOpenId } },
    message: {
      message_id: message.message_id ?? '',
      root_id: message.root_id,
      parent_id: message.parent_id,
      create_time: message.create_time,
      chat_id: message.chat_id ?? '',
      thread_id: message.thread_id,
      chat_type: message.chat_type === 'p2p' ? 'p2p' : 'group',
      message_type: message.message_type ?? 'text',
      content: message.content ?? '',
      mentions: (message.mentions ?? []).map((mention) => ({
        key: mention.key ?? '',
        id: {
          open_id: mention.id?.open_id,
          user_id: mention.id?.user_id ?? undefined,
          union_id: mention.id?.union_id,
        },
        name: mention.name,
      })),
    },
  };
}

export async function parseInboundMessage(message: RawLarkMessage, opts: ParseInboundOptions): Promise<ParsedInbound> {
  const msgType = message.message_type ?? 'text';
  const content = message.content ?? '';
  const parentId = message.parent_id || undefined;
  // 老 payload / 测试桩可能缺 message_type: 只有 text 一种形态, 走原解析, 不进 SDK.
  if (!message.message_type) {
    return { text: legacyText(content), msgType, resources: [], parentId, mentionAll: false };
  }
  const normalized = await normalize(toRawEvent(message, opts.senderOpenId), {
    botIdentity: { openId: opts.botOpenId, name: '' },
    stripBotMentions: true,
    fetchSubMessages: opts.fetchSubMessages,
  });
  return {
    text: normalized.content,
    msgType,
    resources: normalized.resources,
    parentId,
    mentionAll: normalized.mentionAll,
  };
}

/**
 * 把父消息 (引用回复的对象) 的 ApiMessageItem 转成可读文本.
 * merge_forward 的子消息展开同样走 fetchSubMessages.
 */
export async function parseApiMessageItem(item: ApiMessageItem, opts: ParseInboundOptions): Promise<ParsedInbound> {
  return parseInboundMessage({
    message_id: item.message_id,
    message_type: item.msg_type ?? 'text',
    content: item.body?.content ?? '',
    mentions: (item.mentions ?? []).map((mention) => ({ key: mention.key, name: mention.name, id: mention.id })),
  }, opts);
}
