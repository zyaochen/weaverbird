import type { ApiMessageItem } from '@larksuiteoapi/node-sdk';
import { parseApiMessageItem, type InboundResource } from './message-parser.js';
import type { MediaCache } from './media-cache.js';

/**
 * 把一条飞书消息组装成 agent 输入: 引用的父消息 + 本地化的附件路径.
 *
 * 只做"把飞书里的东西搬成 agent 能读的形态", 不加指令性 prompt (product-strategy B3):
 * - 引用回复: 父消息正文以 `> ` 引用块放在用户正文之前, 只取一层
 * - 附件: 下载到本地后把正文里的资源 key 替换为本地绝对路径, 图片路径另外进 images
 *   (codex 走 `--image`), 其他进 attachments
 * - 任一步失败写进 notices, 由调用方展示在卡片上 (fail loud), 不中断本次运行
 */

export type InboundContextDeps = {
  botOpenId: string;
  fetchMessage?: (messageId: string) => Promise<ApiMessageItem[]>;
  media?: MediaCache;
};

export type AgentInput = {
  text: string;
  images: string[];
  attachments: string[];
  notices: string[];
};

function quoteBlock(text: string): string {
  return text.split('\n').map((line) => `> ${line}`).join('\n');
}

export async function buildAgentInput(
  event: { messageId: string; text: string; resources?: InboundResource[]; parentId?: string },
  deps: InboundContextDeps,
): Promise<AgentInput> {
  const notices: string[] = [];
  let quoted: { text: string; messageId: string; resources: InboundResource[] } | null = null;

  if (event.parentId) {
    if (!deps.fetchMessage) {
      notices.push('引用的消息未读取: 当前通道不支持拉取消息');
    } else {
      try {
        const items = await deps.fetchMessage(event.parentId);
        const parent = items.find((item) => item.message_id === event.parentId) ?? items[0];
        if (!parent) throw new Error('消息不存在或无权限');
        const parsed = await parseApiMessageItem(parent, { botOpenId: deps.botOpenId, fetchSubMessages: deps.fetchMessage });
        quoted = { text: parsed.text, messageId: event.parentId, resources: parsed.resources };
      } catch (error) {
        notices.push(`引用的消息读取失败: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  let body = event.text;
  let quotedText = quoted?.text ?? '';
  const images: string[] = [];
  const attachments: string[] = [];
  const groups = [
    { messageId: event.messageId, resources: event.resources ?? [], apply: (from: string, to: string) => { body = body.split(from).join(to); } },
    ...(quoted ? [{ messageId: quoted.messageId, resources: quoted.resources, apply: (from: string, to: string) => { quotedText = quotedText.split(from).join(to); } }] : []),
  ];
  for (const group of groups) {
    if (group.resources.length === 0) continue;
    if (!deps.media) {
      notices.push(`${group.resources.length} 个附件未下载: 当前通道不支持下载资源`);
      continue;
    }
    const { resolved, failures } = await deps.media.resolve(group.messageId, group.resources);
    for (const item of resolved) {
      group.apply(`key="${item.resource.fileKey}"`, `path="${item.path}"`);
      group.apply(item.resource.fileKey, item.path);
      (item.resource.type === 'image' ? images : attachments).push(item.path);
    }
    for (const failure of failures) {
      notices.push(`附件 ${failure.resource.fileName ?? failure.resource.fileKey} ${failure.reason}`);
    }
  }

  const text = quoted ? `${quoteBlock(`引用消息:\n${quotedText}`)}\n\n${body}` : body;
  return { text, images, attachments, notices };
}
