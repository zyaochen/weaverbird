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

const INTERACTIVE_PLACEHOLDER = '[interactive card]';

type CardInline = { tag?: string; text?: string; href?: string; user_name?: string };

/**
 * 飞书推给 bot 的卡片消息 (含转发来的告警卡) 是简化格式 `{ title, elements: [[{tag,text,href}]] }`,
 * SDK 只给 `[interactive card]` 占位; 这里按行拼出标题和文字, 链接保留地址.
 */
export function interactiveText(content: string): string {
  let parsed: { title?: unknown; elements?: unknown };
  try {
    parsed = JSON.parse(content) as typeof parsed;
  } catch {
    return '';
  }
  const lines: string[] = [];
  if (typeof parsed.title === 'string' && parsed.title.trim()) lines.push(parsed.title.trim());
  for (const row of Array.isArray(parsed.elements) ? parsed.elements : []) {
    if (!Array.isArray(row)) continue;
    const line = (row as CardInline[]).map((item) => {
      if (item.tag === 'a') return item.href ? `${item.text ?? ''} (${item.href})` : item.text ?? '';
      if (item.tag === 'at') return `@${item.user_name ?? item.text ?? ''}`;
      return item.tag === 'text' ? item.text ?? '' : '';
    }).join('').trim();
    if (line) lines.push(line);
  }
  return lines.join('\n');
}

/** 新版客户端的部分文本消息整段包在 `<p>…</p>` 里 (例如引用回复), 去掉段落标签. */
export function stripParagraphTags(text: string): string {
  if (!/^\s*<p>[\s\S]*<\/p>\s*$/.test(text)) return text;
  return text.replace(/<\/p>\s*<p>/g, '\n').replace(/^\s*<p>/, '').replace(/<\/p>\s*$/, '').trim();
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
  let text = normalized.content;
  if (msgType === 'text') text = stripParagraphTags(text);
  if (msgType === 'interactive' && (!text.trim() || text.trim() === INTERACTIVE_PLACEHOLDER)) text = interactiveText(content) || text;
  return {
    text,
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
