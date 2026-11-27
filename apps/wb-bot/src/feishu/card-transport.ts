import type * as lark from '@larksuiteoapi/node-sdk';
import type { Logger } from 'pino';
import type { CardEntity } from '../binding/store.js';
import { STREAMING_CONFIG, withoutStreaming } from './card-renderer.js';

/**
 * 卡片出口. 带 `config.streaming_mode` 的运行卡走 CardKit 卡片实体, 其余卡片照旧走消息接口.
 *
 * 降级链 (每一级失败都记日志再往下走, 不吞错):
 * - L0 元素流式: 结构没变时只把变了的槽位文本推给 `cardElement.content`, 正文是打字机效果
 * - L1 整卡更新: 结构变了 / L0 失败 / 结束时, `card.update` 整卡替换 (结束前先关流式)
 * - L2 消息接口: 创建实体失败、或实体更新出现不可重试错误时, 回到 `im.message.reply/patch`
 *
 * CardKit 的每次写都要带严格递增的 sequence; 先占号落库再调用, 重启后从库里的值往后接.
 */

export class FeishuApiError extends Error {
  constructor(readonly operation: string, readonly code: number, readonly detail: string) {
    super(`${operation} failed: code=${code} msg=${detail}`);
    this.name = 'FeishuApiError';
  }
}

export function feishuErrorCode(error: unknown): number | undefined {
  if (error instanceof FeishuApiError) return error.code;
  if (typeof error !== 'object' || error === null) return undefined;
  const record = error as { code?: unknown; response?: { data?: { code?: unknown } } };
  const code = record.response?.data?.code ?? record.code;
  return typeof code === 'number' ? code : undefined;
}

/** 流式模式超时 (默认 10 分钟自动关闭) / 已关闭: 重开后重试一次. */
const STREAMING_CLOSED_CODES = new Set([200850, 300309]);
/** 频控 / 卡片锁: 交给 CardPipeline 退避重试, 不降级. */
const RETRYABLE_CODES = new Set([230020, 230099, 99991400]);
const MAX_ELEMENT_FAILURES = 3;

export type CardKitApi = {
  createCard(cardJson: string): Promise<string>;
  updateCard(cardId: string, cardJson: string, sequence: number): Promise<void>;
  setStreaming(cardId: string, streaming: boolean, sequence: number): Promise<void>;
  setElementContent(cardId: string, elementId: string, content: string, sequence: number): Promise<void>;
  replyWithCardId(messageId: string, cardId: string, inThread: boolean): Promise<string>;
  replyMessageCard(messageId: string, card: Record<string, unknown>, inThread: boolean): Promise<string>;
  patchMessageCard(messageId: string, card: Record<string, unknown>): Promise<void>;
};

export type CardEntityStore = {
  get(messageId: string): CardEntity | null;
  save(messageId: string, entity: CardEntity): void;
};

type Entry = CardEntity & {
  /** 上一次成功写出的卡; 重启后为空, 第一次更新必然走整卡. */
  last?: Record<string, unknown>;
  lastJson?: string;
  elementFailures: number;
  /** 实体不可用后改走消息接口. */
  legacy: boolean;
};

type CardElement = { tag?: unknown; element_id?: unknown; content?: unknown };

export function isStreamingCard(card: Record<string, unknown>): boolean {
  const config = card['config'];
  return typeof config === 'object' && config !== null && (config as Record<string, unknown>)['streaming_mode'] === true;
}

function bodyElements(card: Record<string, unknown>): CardElement[] {
  const body = card['body'];
  if (typeof body !== 'object' || body === null) return [];
  const elements = (body as { elements?: unknown }).elements;
  return Array.isArray(elements) ? (elements as CardElement[]) : [];
}

function slotContents(card: Record<string, unknown>): Map<string, string> {
  const slots = new Map<string, string>();
  for (const element of bodyElements(card)) {
    if (element.tag === 'markdown' && typeof element.element_id === 'string') {
      slots.set(element.element_id, typeof element.content === 'string' ? element.content : '');
    }
  }
  return slots;
}

/** 去掉槽位文本与 config.summary 之后的骨架; 骨架相同才能只更新槽位. */
function skeleton(card: Record<string, unknown>): string {
  return JSON.stringify(card, (key, value: unknown) => {
    if (key === 'summary') return undefined;
    if (key === 'elements' && Array.isArray(value)) {
      return value.map((element: CardElement) => (
        element && element.tag === 'markdown' && typeof element.element_id === 'string' ? { ...element, content: '' } : element
      ));
    }
    return value;
  });
}

export class FeishuCardTransport {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly api: CardKitApi,
    private readonly store: CardEntityStore,
    private readonly options: { streaming: boolean; logger: Pick<Logger, 'info' | 'warn' | 'error'> },
  ) {}

  /** 该消息是否是 CardKit 流式卡 (调用方据此选更短的刷新间隔). */
  isStreamingCard(messageId: string): boolean {
    const entry = this.entry(messageId);
    return Boolean(entry && !entry.legacy && entry.streaming);
  }

  async reply(messageId: string, card: Record<string, unknown>, inThread = false): Promise<string> {
    if (!this.options.streaming || !isStreamingCard(card)) {
      return this.api.replyMessageCard(messageId, withoutStreaming(card), inThread);
    }
    let cardId: string;
    try {
      cardId = await this.api.createCard(JSON.stringify(card));
    } catch (error) {
      this.options.logger.warn({ messageId, error: describe(error) }, 'cardkit create failed, falling back to message card');
      return this.api.replyMessageCard(messageId, withoutStreaming(card), inThread);
    }
    let replyMessageId: string;
    try {
      replyMessageId = await this.api.replyWithCardId(messageId, cardId, inThread);
    } catch (error) {
      this.options.logger.warn({ messageId, cardId, error: describe(error) }, 'reply with card_id failed, falling back to message card');
      return this.api.replyMessageCard(messageId, withoutStreaming(card), inThread);
    }
    // 创建实体时 sequence 视为 0, 之后的每次写从 1 开始.
    const entry: Entry = { cardId, sequence: 0, streaming: true, last: card, lastJson: JSON.stringify(card), elementFailures: 0, legacy: false };
    this.entries.set(replyMessageId, entry);
    this.store.save(replyMessageId, { cardId, sequence: 0, streaming: true });
    this.options.logger.info({ messageId, replyMessageId, cardId }, 'replied with cardkit streaming card');
    return replyMessageId;
  }

  async update(messageId: string, card: Record<string, unknown>): Promise<void> {
    const entry = this.entry(messageId);
    if (!entry || entry.legacy) {
      await this.api.patchMessageCard(messageId, withoutStreaming(card));
      return;
    }
    const json = JSON.stringify(card);
    if (json === entry.lastJson) return;
    const live = isStreamingCard(card);

    if (live && entry.streaming && entry.last && entry.elementFailures < MAX_ELEMENT_FAILURES && skeleton(entry.last) === skeleton(card)) {
      try {
        await this.streamSlots(messageId, entry, card);
        this.remember(entry, card, json);
        return;
      } catch (error) {
        if (isRetryable(error)) throw error;
        entry.elementFailures += 1;
        this.options.logger.warn({ messageId, cardId: entry.cardId, failures: entry.elementFailures, error: describe(error) }, 'cardkit element stream failed, using full update');
      }
    }

    try {
      await this.updateFull(messageId, entry, card, live);
      this.remember(entry, card, json);
    } catch (error) {
      if (isRetryable(error)) throw error;
      this.options.logger.error({ messageId, cardId: entry.cardId, error: describe(error) }, 'cardkit full update failed, falling back to message patch');
      try {
        await this.api.patchMessageCard(messageId, withoutStreaming(card));
      } catch (patchError) {
        this.options.logger.error({ messageId, error: describe(patchError) }, 'message patch fallback failed');
        throw error;
      }
      entry.legacy = true;
    }
  }

  private entry(messageId: string): Entry | undefined {
    const cached = this.entries.get(messageId);
    if (cached) return cached;
    const stored = this.store.get(messageId);
    if (!stored) return undefined;
    const entry: Entry = { ...stored, elementFailures: 0, legacy: false };
    this.entries.set(messageId, entry);
    return entry;
  }

  private nextSequence(messageId: string, entry: Entry): number {
    entry.sequence += 1;
    this.store.save(messageId, { cardId: entry.cardId, sequence: entry.sequence, streaming: entry.streaming });
    return entry.sequence;
  }

  private setStreaming(messageId: string, entry: Entry, streaming: boolean): Promise<void> {
    entry.streaming = streaming;
    return this.api.setStreaming(entry.cardId, streaming, this.nextSequence(messageId, entry));
  }

  private async streamSlots(messageId: string, entry: Entry, card: Record<string, unknown>): Promise<void> {
    const previous = slotContents(entry.last ?? {});
    for (const [elementId, content] of slotContents(card)) {
      if (previous.get(elementId) === content) continue;
      try {
        await this.api.setElementContent(entry.cardId, elementId, content, this.nextSequence(messageId, entry));
      } catch (error) {
        if (!STREAMING_CLOSED_CODES.has(feishuErrorCode(error) ?? -1)) throw error;
        this.options.logger.info({ messageId, cardId: entry.cardId }, 'cardkit streaming closed, re-enabling');
        await this.setStreaming(messageId, entry, true);
        await this.api.setElementContent(entry.cardId, elementId, content, this.nextSequence(messageId, entry));
      }
    }
  }

  private async updateFull(messageId: string, entry: Entry, card: Record<string, unknown>, live: boolean): Promise<void> {
    if (!live && entry.streaming) {
      // 按钮等交互元素要在关掉流式之后才能改; 关失败不影响整卡替换, 只记录.
      try {
        await this.setStreaming(messageId, entry, false);
      } catch (error) {
        this.options.logger.warn({ messageId, cardId: entry.cardId, error: describe(error) }, 'cardkit disable streaming failed');
      }
    }
    const payload = JSON.stringify(live ? card : withoutStreaming(card));
    try {
      await this.api.updateCard(entry.cardId, payload, this.nextSequence(messageId, entry));
    } catch (error) {
      if (!live || !STREAMING_CLOSED_CODES.has(feishuErrorCode(error) ?? -1)) throw error;
      await this.setStreaming(messageId, entry, true);
      await this.api.updateCard(entry.cardId, payload, this.nextSequence(messageId, entry));
    }
    entry.streaming = live;
  }

  private remember(entry: Entry, card: Record<string, unknown>, json: string): void {
    entry.last = card;
    entry.lastJson = json;
  }
}

function isRetryable(error: unknown): boolean {
  return RETRYABLE_CODES.has(feishuErrorCode(error) ?? -1);
}

function describe(error: unknown): Record<string, unknown> {
  return { message: error instanceof Error ? error.message : String(error), code: feishuErrorCode(error) };
}

function assertOk(operation: string, response: { code?: number; msg?: string } | undefined | null): void {
  if (response && typeof response.code === 'number' && response.code !== 0) {
    throw new FeishuApiError(operation, response.code, response.msg ?? '');
  }
}

/** SDK → CardKitApi. 业务码非 0 统一抛 FeishuApiError, 让上面的降级逻辑按 code 判断. */
export function createCardKitApi(client: lark.Client): CardKitApi {
  return {
    async createCard(cardJson) {
      const response = await client.cardkit.v1.card.create({ data: { type: 'card_json', data: cardJson } });
      assertOk('cardkit.card.create', response);
      const cardId = response?.data?.card_id;
      if (!cardId) throw new FeishuApiError('cardkit.card.create', -1, 'no card_id in response');
      return cardId;
    },
    async updateCard(cardId, cardJson, sequence) {
      const response = await client.cardkit.v1.card.update({
        path: { card_id: cardId },
        data: { card: { type: 'card_json', data: cardJson }, sequence },
      });
      assertOk('cardkit.card.update', response);
    },
    async setStreaming(cardId, streaming, sequence) {
      const config = streaming ? { streaming_mode: true, streaming_config: STREAMING_CONFIG } : { streaming_mode: false };
      const response = await client.cardkit.v1.card.settings({
        path: { card_id: cardId },
        data: { settings: JSON.stringify({ config }), sequence },
      });
      assertOk('cardkit.card.settings', response);
    },
    async setElementContent(cardId, elementId, content, sequence) {
      const response = await client.cardkit.v1.cardElement.content({
        path: { card_id: cardId, element_id: elementId },
        data: { content, sequence },
      });
      assertOk('cardkit.cardElement.content', response);
    },
    async replyWithCardId(messageId, cardId, inThread) {
      const response = await client.im.v1.message.reply({
        path: { message_id: messageId },
        data: {
          msg_type: 'interactive',
          content: JSON.stringify({ type: 'card', data: { card_id: cardId } }),
          ...(inThread ? { reply_in_thread: true } : {}),
        },
      });
      assertOk('im.message.reply', response);
      const replyMessageId = response?.data?.message_id;
      if (!replyMessageId) throw new FeishuApiError('im.message.reply', -1, 'no message_id in response');
      return replyMessageId;
    },
    async replyMessageCard(messageId, card, inThread) {
      const response = await client.im.v1.message.reply({
        path: { message_id: messageId },
        data: { msg_type: 'interactive', content: JSON.stringify(card), ...(inThread ? { reply_in_thread: true } : {}) },
      });
      assertOk('im.message.reply', response);
      return response?.data?.message_id ?? messageId;
    },
    async patchMessageCard(messageId, card) {
      const response = await client.im.v1.message.patch({
        path: { message_id: messageId },
        data: { content: JSON.stringify(card) },
      });
      assertOk('im.message.patch', response);
    },
  };
}

export function cardStreamingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['WB_CARD_STREAMING'] !== '0';
}
