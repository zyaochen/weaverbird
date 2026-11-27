import type * as lark from '@larksuiteoapi/node-sdk';
import type { CommentEvent } from '@larksuiteoapi/node-sdk';
import { FeishuApiError, feishuErrorCode } from './card-transport.js';

/**
 * 云文档评论通道: 用户在文档评论里 @bot, 把评论线程交给 agent, 答案以纯文本回在同一线程.
 *
 * 边界 (product-strategy B3 / B5):
 * - 只读评论线程, 不读写文档正文; agent 需要正文时自己用 lark-cli 等工具
 * - 不给 agent 加文档相关的提示词; 评论框不渲染 markdown, 由这里把常见标记去掉
 * - 过程用评论上的 Typing 表情回执, 没有卡片, 也没有停止按钮 (超时由 runHeadless 兜)
 */

const SUPPORTED_FILE_TYPES = new Set(['doc', 'docx', 'sheet', 'file']);
const REPLY_MAX_CHARS = 2000;
const THREAD_CONTEXT_REPLIES = 10;
/** 整篇评论没有线程, 不能回复 (只能另起一条评论). */
const WHOLE_COMMENT_NO_REPLY = 1069302;

type ReplyElement = { type?: string; text_run?: { text?: string }; docs_link?: { url?: string }; person?: { user_id?: string } };
export type CommentReply = { reply_id?: string; user_id?: string; content?: { elements?: ReplyElement[] } };
export type CommentThread = { replies: CommentReply[]; quote?: string; isWhole: boolean };

export type DocCommentApi = {
  getThread(fileToken: string, fileType: string, commentId: string): Promise<CommentThread>;
  replyInThread(fileToken: string, fileType: string, commentId: string, text: string): Promise<string | undefined>;
  createComment(fileToken: string, fileType: string, text: string): Promise<string | undefined>;
  setTyping(fileToken: string, fileType: string, replyId: string, on: boolean): Promise<void>;
};

export type HeadlessRunner = (input: { userOpenId: string; threadId: string; prompt: string }) => Promise<{ text: string; error?: string }>;

type Logger = { info(obj: object, msg: string): void; warn(obj: object, msg: string): void; error(obj: object, msg: string): void };

export function replyText(reply: CommentReply): string {
  return (reply.content?.elements ?? []).map((element) => {
    if (element.type === 'text_run') return element.text_run?.text ?? '';
    if (element.type === 'docs_link') return element.docs_link?.url ?? '';
    return '';
  }).join('').trim();
}

/** 评论框是纯文本: 去掉标题 / 粗斜体 / 引用 / 行内代码 / 代码块围栏等标记, 保留文字. */
export function stripMarkdown(text: string): string {
  return text
    .replace(/^```[^\n]*\n?/gm, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function buildCommentInput(evt: Pick<CommentEvent, 'fileToken' | 'fileType'>, thread: CommentThread, target: CommentReply): string {
  const lines = [`> 云文档评论 · https://feishu.cn/${evt.fileType}/${evt.fileToken}`];
  if (thread.quote) lines.push(`> 选中原文: ${thread.quote.replace(/\s*\n\s*/g, ' ')}`);
  const earlier = thread.replies.filter((reply) => reply !== target).slice(-THREAD_CONTEXT_REPLIES).map(replyText).filter(Boolean);
  if (earlier.length > 0) {
    lines.push('> 评论线程:');
    for (const text of earlier) lines.push(`> - ${text.replace(/\s*\n\s*/g, ' ')}`);
  }
  return `${lines.join('\n')}\n\n${replyText(target)}`;
}

export class DocCommentChannel {
  /** 自己发出的评论回复, 用来挡住回推给自己的事件. */
  private readonly ownReplyIds = new Set<string>();
  private readonly seen = new Set<string>();

  constructor(private readonly deps: { api: DocCommentApi; botOpenId: string; run: HeadlessRunner; logger: Logger }) {}

  async handle(evt: CommentEvent): Promise<void> {
    const { api, logger } = this.deps;
    const key = `${evt.fileToken}:${evt.commentId}:${evt.replyId ?? ''}`;
    if (!evt.mentionedBot || this.seen.has(key)) return;
    if (evt.operator.openId === this.deps.botOpenId || (evt.replyId && this.ownReplyIds.has(evt.replyId))) return;
    if (!SUPPORTED_FILE_TYPES.has(evt.fileType)) {
      logger.info({ fileType: evt.fileType }, 'doc comment skipped: unsupported file type');
      return;
    }
    this.remember(this.seen, key);

    const thread = await api.getThread(evt.fileToken, evt.fileType, evt.commentId);
    const target = (evt.replyId ? thread.replies.find((reply) => reply.reply_id === evt.replyId) : undefined) ?? thread.replies.at(-1);
    if (!target || !replyText(target)) {
      logger.info({ commentId: evt.commentId }, 'doc comment skipped: empty question');
      return;
    }
    const typingOn = target.reply_id ? await this.typing(evt, target.reply_id, true) : false;
    try {
      const result = await this.deps.run({
        userOpenId: evt.operator.openId,
        threadId: `doc:${evt.fileToken}`,
        prompt: buildCommentInput(evt, thread, target),
      });
      let answer = result.error ? `⚠️ ${result.error}` : stripMarkdown(result.text) || '(没有输出内容)';
      if (answer.length > REPLY_MAX_CHARS) answer = `${answer.slice(0, REPLY_MAX_CHARS - 1)}…`;
      await this.post(evt, thread, answer);
    } finally {
      if (typingOn && target.reply_id) await this.typing(evt, target.reply_id, false);
    }
  }

  private async post(evt: CommentEvent, thread: CommentThread, text: string): Promise<void> {
    const { api } = this.deps;
    if (!thread.isWhole) {
      try {
        const replyId = await api.replyInThread(evt.fileToken, evt.fileType, evt.commentId, text);
        if (replyId) this.remember(this.ownReplyIds, replyId);
        return;
      } catch (error) {
        if (feishuErrorCode(error) !== WHOLE_COMMENT_NO_REPLY) throw error;
      }
    }
    const commentReplyId = await api.createComment(evt.fileToken, evt.fileType, text);
    if (commentReplyId) this.remember(this.ownReplyIds, commentReplyId);
  }

  /** 表情回执是装饰性的: 失败只记日志. */
  private async typing(evt: CommentEvent, replyId: string, on: boolean): Promise<boolean> {
    try {
      await this.deps.api.setTyping(evt.fileToken, evt.fileType, replyId, on);
      return true;
    } catch (error) {
      this.deps.logger.warn({ replyId, on, code: feishuErrorCode(error) }, 'doc comment typing reaction failed');
      return false;
    }
  }

  private remember(set: Set<string>, value: string): void {
    set.add(value);
    if (set.size > 1000) {
      const oldest = set.values().next().value;
      if (oldest !== undefined) set.delete(oldest);
    }
  }
}

type DriveFileType = 'doc' | 'docx' | 'sheet' | 'file';
type ApiResponse<T> = { code?: number; msg?: string; data?: T } | null | undefined;

function assertOk(operation: string, response: ApiResponse<unknown>): void {
  if (response && typeof response.code === 'number' && response.code !== 0) {
    throw new FeishuApiError(operation, response.code, response.msg ?? '');
  }
}

function textContent(text: string) {
  return { elements: [{ type: 'text_run' as const, text_run: { text } }] };
}

export function createDocCommentApi(client: lark.Client): DocCommentApi {
  return {
    async getThread(fileToken, fileType, commentId) {
      const response = await client.drive.v1.fileComment.get({
        params: { file_type: fileType as DriveFileType },
        path: { file_token: fileToken, comment_id: commentId },
      });
      const data = response?.data;
      return {
        replies: (data?.reply_list?.replies ?? []) as CommentReply[],
        ...(data?.quote ? { quote: data.quote } : {}),
        isWhole: Boolean(data?.is_whole),
      };
    },
    async replyInThread(fileToken, fileType, commentId, text) {
      // SDK 没有封装 fileCommentReply.create, 走通用 request (仍带 tenant token).
      const response = await client.request<ApiResponse<{ reply_id?: string }>>({
        method: 'POST',
        url: `/open-apis/drive/v1/files/${encodeURIComponent(fileToken)}/comments/${encodeURIComponent(commentId)}/replies`,
        params: { file_type: fileType },
        data: { content: textContent(text) },
      });
      assertOk('drive.fileCommentReply.create', response);
      return response?.data?.reply_id;
    },
    async createComment(fileToken, fileType, text) {
      const response = await client.drive.v1.fileComment.create({
        params: { file_type: fileType as 'doc' | 'docx' },
        path: { file_token: fileToken },
        data: { reply_list: { replies: [{ content: textContent(text) }] } },
      });
      return response?.data?.reply_list?.replies?.[0]?.reply_id;
    },
    async setTyping(fileToken, fileType, replyId, on) {
      const response = await client.request<ApiResponse<unknown>>({
        method: 'POST',
        url: `/open-apis/drive/v2/files/${encodeURIComponent(fileToken)}/comments/reaction`,
        params: { file_type: fileType },
        data: { action: on ? 'add' : 'delete', reply_id: replyId, reaction_type: 'Typing' },
      });
      assertOk('drive.comment.reaction', response);
    },
  };
}
