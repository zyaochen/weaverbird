import * as Lark from '@larksuiteoapi/node-sdk';
import type { ApiMessageItem } from '@larksuiteoapi/node-sdk';
import pino from 'pino';
import { z } from 'zod';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { captainSocketPath, captainStatePath, resolveDataDir } from '../../../../packages/core/src/paths.js';
import type { AgentRegistry } from '../../../../packages/core/src/index.js';
import { createGuardedCliCalendarTransport, createMockCalendarTransport, loadCalendarHookConfig, startCalendarScheduler, type CalendarCommandReceived } from '../../../../packages/core/src/calendar-hook/index.js';
import { EchoTailer } from '../../../../packages/core/src/reverse-channel/echo-tailer.js';
import type { SessionRecord } from '../../../../packages/core/src/captain/contracts.js';
import type { EchoPayload } from '../../../../packages/core/src/reverse-channel/contracts.js';
import { createGuardedCliGroupSyncTransport, createMockGroupSyncTransport, loadGroupSyncConfig, startGroupSyncScheduler, type GroupSyncCommandReceived } from '../../../../packages/core/src/group-sync/index.js';
import { BindingStore } from '../binding/store.js';
import type { TaskIndex } from '../binding/task-index.js';
import { readEnv } from '../config/env.js';
import { createLarkBotIdentityFetcher } from './bot-identity.js';
import { sendAdminAlert } from './admin-alert.js';
import {
  createLarkReverseAtAdminRoleResolver,
  parseReverseAtAdminWhitelist,
  type ReverseAtOperatorNotifier,
} from './reverse-at-im-handler.js';
import { EventHandler, type WsClientStatusSnapshot } from './event-handler.js';
import { normalizeTopic } from './topic-key.js';
import { parseInboundMessage, type InboundResource, type ParseInboundOptions } from './message-parser.js';
import { InboundDebouncer, debounceMsFromEnv } from './pending-queue.js';
import { FeishuCardTransport, cardStreamingEnabled, createCardKitApi } from './card-transport.js';
import { withoutStreaming } from './card-renderer.js';
import { ChatModeCache, shouldReplyInThread } from './chat-mode-cache.js';
import { Keepalive, httpProbe } from './keepalive.js';
import { uploadKind } from './artifacts.js';
import { DocCommentChannel, createDocCommentApi } from './doc-comment.js';
import { CaptainService, createCaptainConcurrencyContainer, createCaptainSessionStore, type CaptainConcurrencyContainer } from '../../../../packages/core/src/captain/index.js';
import { ConcurrencyQueueEntryStatus } from '../../../../packages/core/src/captain/concurrency-queue-store.js';
import { IpcServer } from '../../../../packages/core/src/reverse-channel/index.js';
import { wireUpReverseChannel } from '../server/wire-up.js';

/**
 * 决定 wb-runner main path. 优先 build dist (.js · 走原生 node 跑); 没 build 就
 * fallback src .ts (走 tsx loader · wb-runner-spawner 自动 detect 后缀).
 *
 * 用 `WB_RUNNER_MAIN` env override 显式指定 (e.g. e2e test 用 specific path).
 *
 * 背景: W2.5-G.B 实施时 hard-code 指向 src `.ts`, 真 spawn 时父 tsx loader 不传给
 * child node → child 报 ERR_MODULE_NOT_FOUND. 现在 dist 优先, 走 build-once 模式.
 */
function resolveWbRunnerMainPath(): string {
  const override = process.env['WB_RUNNER_MAIN'];
  if (override) return override;
  const distPath = new URL('../../../../dist/packages/core/src/runner/wb-runner-main.js', import.meta.url).pathname;
  if (existsSync(distPath)) return distPath;
  // Dev mode: 没 build, 走 src .ts (wb-runner-spawner 会用 tsx loader 起 child)
  return new URL('../../../../packages/core/src/runner/wb-runner-main.ts', import.meta.url).pathname;
}

export type WsClientStatus = WsClientStatusSnapshot;

const SenderSchema = z.object({
  sender_id: z.object({ open_id: z.string().optional() }).optional(),
  sender_type: z.string().optional(),
}).optional();

const MentionSchema = z.object({
  key: z.string().optional(),
  name: z.string().optional(),
  id: z.object({
    open_id: z.string().optional(),
    user_id: z.string().nullable().optional(),
    union_id: z.string().optional(),
  }).optional(),
});

const MessageSchema = z.object({
  message_id: z.string().optional(),
  chat_id: z.string().optional(),
  root_id: z.string().optional(),
  parent_id: z.string().optional(),
  thread_id: z.string().optional(),
  message_type: z.string().optional(),
  create_time: z.string().optional(),
  content: z.string().optional(),
  chat_type: z.string().optional(),
  mentions: z.array(MentionSchema).optional(),
}).optional();

const OperatorSchema = z.object({ open_id: z.string().optional() }).optional();
const ContextSchema = z.object({ open_message_id: z.string().optional(), open_chat_id: z.string().optional() }).optional();
const ActionValueSchema = z.object({
  action: z.string().optional(),
  shortId: z.string().optional(),
  requestId: z.string().optional(),
  index: z.number().optional(),
}).passthrough();
const ActionSchema = z.object({ value: ActionValueSchema.optional() }).optional();

const MessageEventSchema = z.object({
  header: z.object({ event_id: z.string().optional() }).optional(),
  sender: SenderSchema,
  message: MessageSchema,
  event: z.object({
    sender: SenderSchema,
    message: MessageSchema,
  }).optional(),
});

const CardActionSchema = z.object({
  header: z.object({ event_id: z.string().optional() }).optional(),
  operator: OperatorSchema,
  context: ContextSchema,
  action: ActionSchema,
  event: z.object({
    operator: OperatorSchema,
    context: ContextSchema,
    action: ActionSchema,
  }).optional(),
});

export type LarkMessagePayload = z.infer<typeof MessageEventSchema>;
export type LarkCardActionPayload = z.infer<typeof CardActionSchema>;

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function parseLarkMessagePayload(data: unknown): LarkMessagePayload {
  return MessageEventSchema.parse(data);
}

export function parseLarkCardActionPayload(data: unknown): LarkCardActionPayload {
  return CardActionSchema.parse(data);
}

const logger = pino({ level: process.env['LOG_LEVEL'] ?? 'info' });
class BoundedSet {
  private readonly items = new Set<string>();
  constructor(private readonly limit: number) {}
  add(item: string): void {
    this.items.add(item);
    if (this.items.size > this.limit) {
      const oldest = this.items.values().next().value;
      if (oldest !== undefined) this.items.delete(oldest);
    }
  }
  has(item: string): boolean {
    return this.items.has(item);
  }
}

const FEISHU_OPEN_DOMAIN = 'https://open.feishu.cn';

/** CardKit 实体映射只为运行中和重启恢复服务, 保留 7 天足够. */
const CARD_ENTITY_TTL_MS = 7 * 24 * 3600 * 1000;

function extractErrorDetails(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { error: String(error) };
  const record = error as Error & {
    response?: { status?: number; data?: unknown; headers?: unknown };
    config?: { url?: string; method?: string; data?: unknown };
  };
  return {
    name: record.name,
    message: record.message,
    status: record.response?.status,
    data: record.response?.data,
    headers: record.response?.headers,
    url: record.config?.url,
    method: record.config?.method,
    requestData: record.config?.data,
  };
}

type ParsedSender = {
  openId: string;
  messageId: string;
  threadId: string;
  chatId: string;
  rootId: string;
  text: string;
  rawContent: string;
  msgType: string;
  resources: InboundResource[];
  parentId?: string;
  chatType: string;
  /** 飞书 thread_id (消息在话题里时有), 与 scope 用的 threadId 不同. */
  larkThreadId: string;
};

export async function readSender(data: LarkMessagePayload, botOpenId: string, fetchSubMessages?: ParseInboundOptions['fetchSubMessages']): Promise<ParsedSender> {
  const message = data.message ?? data.event?.message;
  const sender = data.sender ?? data.event?.sender;
  const messageId = asString(message?.message_id);
  const chatId = asString(message?.chat_id);
  const rootId = asString(message?.root_id);
  const threadId = normalizeTopic({
    chatId,
    rootId,
    messageId,
    chatType: typeof message?.chat_type === 'string' ? message.chat_type : null,
  });
  const openId = asString(sender?.sender_id?.open_id);
  const parsed = await parseInboundMessage(message ?? {}, { botOpenId, senderOpenId: openId, fetchSubMessages });
  // 话题里的每条消息 parent_id 都指向话题根, 那是结构不是引用; 只有显式回复别的消息才算引用.
  const larkThreadId = asString(message?.thread_id);
  const parentId = parsed.parentId && !(larkThreadId && parsed.parentId === rootId) ? parsed.parentId : undefined;
  return {
    openId,
    messageId,
    threadId,
    chatId,
    rootId,
    text: parsed.text,
    rawContent: asString(message?.content),
    msgType: parsed.msgType,
    resources: parsed.resources,
    parentId,
    chatType: asString(message?.chat_type),
    larkThreadId,
  };
}

function readCardAction(data: LarkCardActionPayload): { openId: string; messageId: string; threadId: string; chatId: string; action: string; shortId: string; requestId: string; index?: number } {
  const operator = data.operator ?? data.event?.operator;
  const context = data.context ?? data.event?.context;
  const action = data.action ?? data.event?.action;
  const chatId = asString(context?.open_chat_id);
  return {
    openId: asString(operator?.open_id),
    messageId: asString(context?.open_message_id),
    threadId: chatId,
    chatId,
    action: asString(action?.value?.action),
    shortId: asString(action?.value?.shortId),
    requestId: asString(action?.value?.requestId),
    ...(typeof action?.value?.index === 'number' ? { index: action.value.index } : {}),
  };
}

export function readRecalledMessageId(data: unknown): string {
  if (typeof data !== 'object' || data === null) return '';
  const record = data as { message_id?: unknown; event?: { message_id?: unknown } };
  return asString(record.message_id ?? record.event?.message_id);
}

export function readChatType(data: LarkMessagePayload): string | undefined {
  const message = data.message ?? data.event?.message;
  return typeof message?.chat_type === 'string' ? message.chat_type : undefined;
}

export function readMentions(data: LarkMessagePayload): Array<{ id?: { open_id?: string } }> {
  const message = data.message ?? data.event?.message;
  return Array.isArray(message?.mentions) ? message.mentions : [];
}

/**
 * 群消息默认只响应 @bot. 群里用 `/require-mention off` 关掉后, 不 @ 也响应, 但仍跳过
 * 机器人发的消息 (防互相触发) 和只 @ 了别人的消息 (那是在跟别人说话).
 */
export function shouldDispatchMessageForBot(
  data: LarkMessagePayload,
  botOpenId: string,
  requireMention: (chatId: string) => boolean = () => true,
): boolean {
  const chatType = readChatType(data);
  if (chatType === 'p2p') return true;
  if (!chatType) return false;
  const mentions = readMentions(data);
  if (mentions.some((mention) => mention?.id?.open_id === botOpenId)) return true;
  const message = data.message ?? data.event?.message;
  const sender = data.sender ?? data.event?.sender;
  const chatId = asString(message?.chat_id);
  if (!chatId || requireMention(chatId)) return false;
  if (sender?.sender_type && sender.sender_type !== 'user') return false;
  return mentions.length === 0;
}

export type TransportHandle = {
  handler: EventHandler;
  close(): Promise<void>;
  wsClientStatus(): WsClientStatus;
};

export type TransportOptions = {
  botId: string;
  taskIndex: TaskIndex;
  logFilePath: string;
  /**
   * M12-E (2026-08-04 owner-authorized): cli 起任务的 F19 home-group 首张卡.
   * 默认 true — PRD §5.4 "cli 起任务后 home group 必收首卡" 是默认行为。
   * 设成 false 可以在多 bot 部署调试期把 daemon 单独关掉。
   */
  enableEchoDaemon?: boolean;
  echoDaemonIntervalMs?: number;
};

export function replayCaptainQueueOrAlert(captainConcurrency: CaptainConcurrencyContainer | undefined, dataDir: string | undefined): void {
  if (!captainConcurrency || !dataDir) return;
  try {
    captainConcurrency.index.replay(captainConcurrency.store.readAll());
  } catch (error) {
    logger.error({ error: extractErrorDetails(error) }, 'captain queue replay failed during transport boot');
    void sendAdminAlert(null, dataDir, `captain queue replay failed during boot: ${error instanceof Error ? error.message : String(error)}`, 'error');
  }
}

export function reconcileOrphanCaptainRunsOrAlert(
  captainConcurrency: CaptainConcurrencyContainer | undefined,
  captainService: CaptainService | undefined,
  store: BindingStore,
  dataDir: string | undefined,
  botId: string,
): void {
  if (!captainConcurrency || !dataDir) return;
  const inflightRunIds = new Set(
    store.listInflightCards(botId)
      .map((card) => card.runId)
      .filter((runId): runId is string => typeof runId === 'string' && runId.length > 0),
  );
  const sessionIds = new Set(captainConcurrency.store.readAll().map((entry) => entry.session_id));

  for (const sessionId of sessionIds) {
    for (const entry of captainConcurrency.index.listRunningEntries(sessionId)) {
      if (inflightRunIds.has(entry.run_id)) continue;
      try {
        const ts = new Date().toISOString();
        captainConcurrency.store.append({
          session_id: sessionId,
          run_id: entry.run_id,
          status: ConcurrencyQueueEntryStatus.ENDED,
          ts,
          reason: 'cancelled',
        });
        captainConcurrency.index.markEnded(sessionId, entry.run_id, ts);
        const session = captainService?.getSession(sessionId);
        if (session && (session.record.status === 'active' || session.record.status === 'suspended')) {
          captainService?.closeSession(sessionId);
        }
        void sendAdminAlert(null, dataDir, `orphan running reconciled during boot replay: ${entry.run_id}`, 'warn');
      } catch (error) {
        logger.error({ sessionId, runId: entry.run_id, error: extractErrorDetails(error) }, 'orphan running reconcile failed during boot');
        void sendAdminAlert(null, dataDir, `orphan running reconcile failed during boot: ${entry.run_id}`, 'warn');
      }
    }
  }
}

export async function startTransport(
  registry: AgentRegistry,
  store: BindingStore,
  defaultCwd: string | undefined,
  claudeConsentLevel: string | undefined,
  dataDir: string | undefined,
  options: TransportOptions,
): Promise<TransportHandle> {
  const env = readEnv();
  const wsStatus: WsClientStatus = { lastEventAt: null, lastReconnectAt: null };
  const createWsClient = () => new Lark.WSClient({
    appId: env.LARK_APP_ID,
    appSecret: env.LARK_APP_SECRET,
    loggerLevel: Lark.LoggerLevel.info,
    onReconnected: () => {
      wsStatus.lastReconnectAt = Date.now();
      logger.info({ botId: options.botId }, 'feishu ws reconnected');
    },
    onError: (error) => logger.error({ botId: options.botId, error: extractErrorDetails(error) }, 'feishu ws gave up reconnecting'),
  });
  let wsClient = createWsClient();
  const client = new Lark.Client({ appId: env.LARK_APP_ID, appSecret: env.LARK_APP_SECRET });
  const identityFetcher = createLarkBotIdentityFetcher(client);
  const fetchSubMessages = async (messageId: string): Promise<ApiMessageItem[]> => {
    const result = await client.im.v1.message.get({ path: { message_id: messageId } });
    return (result.data?.items ?? []) as ApiMessageItem[];
  };
  let botOpenId: string;
  try {
    const botIdentity = await identityFetcher.fetch();
    botOpenId = botIdentity.openId;
    logger.info({ botId: options.botId, openIdBotSelf: botIdentity.openId, appName: botIdentity.appName }, '✅ bot identity verified');
  } catch (error) {
    const details = extractErrorDetails(error);
    logger.error({ botId: options.botId, error: details }, 'bot identity fetch failed during transport boot');
    const message = error instanceof Error ? error.message : String(error);
    const status = typeof details['status'] === 'number' ? ` (status=${details['status']})` : '';
    throw new Error(`bot identity fetch failed for botId=${options.botId}: ${message}${status}`);
  }
  const captainEnabled = process.env['WB_MODE'] === 'multi-bot' && options.botId === 'default' && process.env['WB_DISABLE_CAPTAIN'] !== 'true' && process.env['WB_DISABLE_CAPTAIN'] !== '1';
  const captainStore = captainEnabled ? createCaptainSessionStore({ env: { ...process.env, WB_DATA_DIR: dataDir ?? '' } }) : undefined;
  if (captainStore) await captainStore.validateSchema();
  const captainService = captainEnabled ? new CaptainService({ dataDir: dataDir ?? '', store: captainStore }) : undefined;
  const captainConcurrency = captainEnabled && dataDir ? createCaptainConcurrencyContainer(dataDir) : undefined;
  replayCaptainQueueOrAlert(captainConcurrency, dataDir);
  reconcileOrphanCaptainRunsOrAlert(captainConcurrency, captainService, store, dataDir, options.botId);
  const ipcServer = captainEnabled && dataDir ? new IpcServer(captainSocketPath(dataDir)) : undefined;
  if (ipcServer && captainService) {
    await ipcServer.start();
    wireUpReverseChannel(ipcServer, captainService, dataDir ?? '', options.botId);
  }
  const reverseAtAdminWhitelist = parseReverseAtAdminWhitelist(process.env['WB_REVERSE_AT_ADMIN_OPEN_IDS']);
  const reverseAtAdminRoleResolver = createLarkReverseAtAdminRoleResolver(client, reverseAtAdminWhitelist);
  const reverseAtOperatorNotifier: ReverseAtOperatorNotifier = async (payload) => {
    const roleLabel = payload.actorRole === 'owner'
      ? '群主'
      : payload.actorRole === 'group_admin'
        ? '群管理员'
        : '白名单管理员';
    const actionLabel = payload.result === 'cancelled' ? '叫停' : '尝试叫停（目标已结束）';
    await client.im.v1.message.create({
      params: { receive_id_type: 'open_id' },
      data: {
        receive_id: payload.operatorOpenId,
        msg_type: 'text',
        content: JSON.stringify({ text: `你的 session #${payload.shortId} 已被 ${roleLabel} ${payload.actorOpenId} ${actionLabel}` }),
      },
    });
  };
  const calendarHookConfig = loadCalendarHookConfig({ env: { WB_DATA_DIR: dataDir ?? '' } });
  const calendarTransport = calendarHookConfig.transport === 'mock'
    ? createMockCalendarTransport(dataDir ?? '')
    : createGuardedCliCalendarTransport();
  const groupSyncConfig = loadGroupSyncConfig({ env: { WB_DATA_DIR: dataDir ?? '' } });
  const groupSyncTransport = groupSyncConfig.transport === 'mock'
    ? createMockGroupSyncTransport(dataDir ?? '')
    : groupSyncConfig.transport === 'guarded'
      ? createGuardedCliGroupSyncTransport()
      : { syncCommand: async () => undefined };
  const keepalive = new Keepalive({
    connectionState: () => wsClient.getConnectionStatus().state,
    probe: () => httpProbe(FEISHU_OPEN_DOMAIN),
    forceReconnect: async () => {
      const stale = wsClient;
      stale.close({ force: true });
      wsClient = createWsClient();
      await wsClient.start({ eventDispatcher: dispatcher });
      wsStatus.lastReconnectAt = Date.now();
    },
    logger,
  });
  const cardTransport = new FeishuCardTransport(createCardKitApi(client), {
    get: (messageId) => store.getCardEntity(options.botId, messageId),
    save: (messageId, entity) => store.saveCardEntity(options.botId, messageId, entity),
  }, { streaming: cardStreamingEnabled(), logger });
  store.pruneCardEntities(CARD_ENTITY_TTL_MS);
  const chatModes = new ChatModeCache(
    async (chatId) => (await client.im.v1.chat.get({ path: { chat_id: chatId } })).data,
    (chatId, error) => logger.warn({ chatId, error: extractErrorDetails(error) }, 'chat mode lookup failed, treating as normal group'),
  );
  // 需要挂进话题回复的源消息 (话题里的消息 / 话题群消息), 回复时带 reply_in_thread.
  const threadedReplies = new BoundedSet(2000);
  const handler = new EventHandler(registry, store, {
    async replyCard(messageId, card) {
      try {
        const replyMessageId = await cardTransport.reply(messageId, card, threadedReplies.has(messageId));
        logger.info({ messageId, replyMessageId }, 'replied with card');
        return replyMessageId;
      } catch (error) {
        logger.error({ messageId, card, error: extractErrorDetails(error) }, 'replyCard failed');
        throw error;
      }
    },
    async updateCard(messageId, card) {
      try {
        await cardTransport.update(messageId, card);
      } catch (error) {
        logger.error({ messageId, card, error: extractErrorDetails(error) }, 'updateCard failed');
        throw error;
      }
    },
    isStreamingCard: (messageId) => cardTransport.isStreamingCard(messageId),
    async sendLocalFile(replyToMessageId, path) {
      const content = await readFile(path);
      const kind = uploadKind(path, content.length);
      let message: { msg_type: string; content: string };
      if (kind.kind === 'image') {
        const uploaded = await client.im.v1.image.create({ data: { image_type: 'message', image: content } });
        if (!uploaded?.image_key) throw new Error('im.image.create returned no image_key');
        message = { msg_type: 'image', content: JSON.stringify({ image_key: uploaded.image_key }) };
      } else {
        const uploaded = await client.im.v1.file.create({ data: { file_type: kind.fileType, file_name: basename(path), file: content } });
        if (!uploaded?.file_key) throw new Error('im.file.create returned no file_key');
        message = { msg_type: 'file', content: JSON.stringify({ file_key: uploaded.file_key }) };
      }
      await client.im.v1.message.reply({
        path: { message_id: replyToMessageId },
        data: { ...message, ...(threadedReplies.has(replyToMessageId) ? { reply_in_thread: true } : {}) },
      });
      logger.info({ replyToMessageId, path, kind: kind.kind }, 'sent artifact');
    },
    async replyText(messageId, text) {
      try {
        const result = await client.im.v1.message.reply({
          path: { message_id: messageId },
          data: { msg_type: 'text', content: JSON.stringify({ text }), ...(threadedReplies.has(messageId) ? { reply_in_thread: true } : {}) },
        });
        logger.info({ messageId, replyMessageId: result.data?.message_id }, 'replied with text');
        return result.data?.message_id ?? messageId;
      } catch (error) {
        logger.error({ messageId, text, error: extractErrorDetails(error) }, 'replyText failed');
        throw error;
      }
    },
    async replyCardInThread(messageId, card) {
      try {
        await client.im.v1.message.reply({
          path: { message_id: messageId },
          data: { msg_type: 'interactive', content: JSON.stringify(withoutStreaming(card)), reply_in_thread: true },
        });
      } catch (error) {
        logger.error({ messageId, card, error: extractErrorDetails(error) }, 'replyCardInThread failed');
        throw error;
      }
    },
    async sendCard(chatId, card) {
      try {
        await client.im.v1.message.create({
          params: { receive_id_type: 'chat_id' },
          data: { receive_id: chatId, msg_type: 'interactive', content: JSON.stringify(withoutStreaming(card)) },
        });
      } catch (error) {
        logger.error({ chatId, card, error: extractErrorDetails(error) }, 'sendCard failed');
        throw error;
      }
    },
    async downloadResource(messageId, fileKey, type) {
      try {
        const result = await client.im.v1.messageResource.get({
          path: { message_id: messageId, file_key: fileKey },
          params: { type },
        });
        const chunks: Buffer[] = [];
        for await (const chunk of result.getReadableStream()) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
        }
        return Buffer.concat(chunks);
      } catch (error) {
        logger.error({ messageId, fileKey, type, error: extractErrorDetails(error) }, 'downloadResource failed');
        throw error;
      }
    },
    fetchMessage: fetchSubMessages,
    async addReaction(messageId, emojiType) {
      const result = await client.im.v1.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      });
      return result.data?.reaction_id;
    },
    async removeReaction(messageId, reactionId) {
      await client.im.v1.messageReaction.delete({ path: { message_id: messageId, reaction_id: reactionId } });
    },
    async sendDm(openId, text) {
      try {
        await client.im.v1.message.create({
          params: { receive_id_type: 'open_id' },
          data: { receive_id: openId, msg_type: 'text', content: JSON.stringify({ text }) },
        });
      } catch (error) {
        logger.error({ openId, error: extractErrorDetails(error) }, 'sendDm failed');
        throw error;
      }
    },
  }, defaultCwd, claudeConsentLevel, dataDir ? {
    dataDir,
    wbRunnerMainPath: resolveWbRunnerMainPath(),
    botId: options.botId,
  } : undefined, {
    botId: options.botId,
    dataDir: dataDir ?? '',
    taskIndex: options.taskIndex,
    logFilePath: options.logFilePath,
    wsClientStatus: () => ({ ...wsStatus, state: wsClient.getConnectionStatus().state, forcedReconnects: keepalive.forcedReconnects }),
  }, captainService, captainConcurrency, reverseAtAdminRoleResolver, reverseAtOperatorNotifier, {
    config: calendarHookConfig,
    transport: calendarTransport,
  });
  await handler.recoverInflightCards();
  const calendarScheduler = startCalendarScheduler({
    dataDir: dataDir ?? '',
    config: calendarHookConfig,
    onCommand: async (command: CalendarCommandReceived) => {
      await handler.dispatchCommandReceived({
        source: command.source,
        requestId: command.request_id,
        sessionId: command.session_id,
        runId: command.run_id,
        revision: command.revision,
        text: command.text,
        userOpenId: command.user_open_id ?? 'calendar',
        threadId: command.thread_id ?? command.session_id,
        messageId: command.message_id ?? command.request_id,
        scheduledAt: command.scheduled_at,
      });
    },
    // M11-C C2: 日历块超期后,the IM-visible 降级通道直接走 handler 的现有 home-group
    // 路由;主成功路径不影响,失败包 try 防卡 sweep.
    onOverdueEscalated: async (payload) => {
      try {
        await handler.notifyCalendarOverdue({
          runId: payload.run_id,
          sessionId: payload.session_id,
          dueAt: payload.due_at,
        });
      } catch (notifyError) {
        logger.warn({ runId: payload.run_id, notifyError }, 'calendar overdue notify failed');
      }
    },
  });
  const groupSyncScheduler = startGroupSyncScheduler({
    dataDir: dataDir ?? '',
    config: groupSyncConfig,
    transport: groupSyncTransport,
    onCommand: async (command: GroupSyncCommandReceived) => {
      await handler.dispatchCommandReceived({
        // Reuse the existing automated-ingress source bucket instead of widening
        // EventHandler.CommandReceived for a single transport-specific source.
        source: 'periodic',
        requestId: command.request_id,
        sessionId: command.session_id,
        runId: command.run_id,
        revision: command.revision,
        text: command.text,
        userOpenId: command.user_open_id ?? 'group-sync',
        threadId: command.thread_id ?? command.session_id,
        messageId: command.message_id ?? command.request_id,
        scheduledAt: command.scheduled_at,
      });
    },
  });
  // 连发合并: 同一 user+thread 的消息在静默窗口内合并成一条 (WB_MESSAGE_DEBOUNCE_MS, 0 关闭).
  const debouncer = new InboundDebouncer(debounceMsFromEnv(), (event) => {
    handler.handleMessage(event).catch((err) => {
      logger.error({ err, eventId: event.eventId }, 'handleMessage error');
    });
  });
  // WB_DOC_COMMENTS=0 关闭; 开着也只有在开发者后台订阅了评论事件时才会收到.
  const docComments = process.env['WB_DOC_COMMENTS'] === '0' ? null : new DocCommentChannel({
    api: createDocCommentApi(client),
    botOpenId,
    run: (input) => handler.runHeadless(input),
    logger,
  });
  const dispatcher = new Lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data: unknown) => {
      wsStatus.lastEventAt = Date.now();
      const raw = parseLarkMessagePayload(data);
      const eventId = asString(raw.header?.event_id);
      const chatType = readChatType(raw);
      const mentions = readMentions(raw);
      if (!shouldDispatchMessageForBot(raw, botOpenId, (chatId) => store.getRequireMention(options.botId, chatId))) {
        logger.debug({ eventId, chatType, mentionsCount: mentions.length, botOpenId }, 'skipping non-mentioned group message');
        return;
      }
      // Dispatch asynchronously so lark-oapi can ack the event within 3 seconds.
      // 解析 (含 merge_forward 子消息拉取) 也放进异步段, 不占 ack 窗口.
      setImmediate(() => {
        void (async () => {
          const parsed = await readSender(raw, botOpenId, fetchSubMessages);
          if (await shouldReplyInThread({ chatType: parsed.chatType, chatId: parsed.chatId, threadId: parsed.larkThreadId }, chatModes)) {
            threadedReplies.add(parsed.messageId);
          }
          logger.info({
            eventId,
            userOpenId: parsed.openId,
            threadId: parsed.threadId,
            messageId: parsed.messageId,
            msgType: parsed.msgType,
            resources: parsed.resources.length,
            parentId: parsed.parentId,
            text: parsed.text,
            rawContent: parsed.rawContent,
          }, 'received lark message');
          debouncer.push({
            eventId,
            userOpenId: parsed.openId,
            threadId: parsed.threadId,
            messageId: parsed.messageId,
            text: parsed.text,
            chatId: parsed.chatId || undefined,
            rootId: parsed.rootId || undefined,
            ...(parsed.chatType ? { chatType: parsed.chatType } : {}),
            ...(parsed.resources.length > 0 ? { resources: parsed.resources } : {}),
            ...(parsed.parentId ? { parentId: parsed.parentId } : {}),
          });
        })().catch((err) => {
          logger.error({ err, eventId }, 'handleMessage error');
        });
      });
    },
    'drive.notice.comment_add_v1': async (data: unknown) => {
      wsStatus.lastEventAt = Date.now();
      if (!docComments) return;
      const evt = Lark.normalizeComment(data as Parameters<typeof Lark.normalizeComment>[0]);
      if (!evt) return;
      setImmediate(() => {
        docComments.handle(evt).catch((error: unknown) => {
          logger.error({ fileType: evt.fileType, commentId: evt.commentId, error: extractErrorDetails(error) }, 'doc comment handling failed');
        });
      });
    },
    'im.message.recalled_v1': async (data: unknown) => {
      wsStatus.lastEventAt = Date.now();
      const messageId = readRecalledMessageId(data);
      if (!messageId) return;
      const pending = debouncer.drop(messageId);
      const queued = pending ? false : await handler.handleMessageRecalled(messageId);
      logger.info({ messageId, pending, queued }, 'received lark message recall');
    },
    'card.action.trigger': async (data: unknown) => {
      wsStatus.lastEventAt = Date.now();
      const raw = parseLarkCardActionPayload(data);
      const parsed = readCardAction(raw);
      logger.info({
        eventId: asString(raw.header?.event_id),
        userOpenId: parsed.openId,
        threadId: parsed.threadId,
        messageId: parsed.messageId,
        action: parsed.action,
      }, 'received lark card action');
      return handler.handleCardAction({
        eventId: asString(raw.header?.event_id),
        userOpenId: parsed.openId,
        threadId: parsed.threadId,
        messageId: parsed.messageId,
        action: parsed.action,
        shortId: parsed.shortId || undefined,
        requestId: parsed.requestId || undefined,
        chatId: parsed.chatId || undefined,
        ...(parsed.index !== undefined ? { artifactIndex: parsed.index } : {}),
      });
    },
  });
  void wsClient.start({ eventDispatcher: dispatcher });
  keepalive.start();

  // M12-E: F19 cli 起任务必投首卡到 home group 的 mini-Daemon.
  // 轮询 captain-state.ndjson mirror,发现 session 的 latest_run_id 从未见过,
  // 就调 EchoTailer 发首卡(由 EchoTailer 内置的 30s 去重窗 + ECHO_MAX_PER_RUN
  // 上限防 spam)。 默认 disabled; 只在 owner 明确打开时跑。
  let echoDaemonTimer: NodeJS.Timeout | null = null;
  let seenRunIds = new Set<string>();
  if (options.enableEchoDaemon !== false) {
    const echoDataDir = resolveDataDir({ dataDir });
    const mirrorPath = captainStatePath(echoDataDir);
    const echoTailer = new EchoTailer(async (payload: EchoPayload) => {
      if (!payload.home_group_id) return;
      const card = {
        schema: '2.0',
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: `🚀 Echo · ${payload.run_id.slice(0, 12)}` } },
        body: {
          elements: [
            { tag: 'markdown', content: `run_id: ${payload.run_id}\ncmd: ${payload.cmd_preview}\ncwd: ${payload.cwd}\ncreated_at: ${payload.created_at}\nstatus: ${payload.status}\noperator: <at user_id="${payload.operator_open_id}" />` },
          ],
        },
      };
      try {
        await handler.sendHomeGroupCard(payload.home_group_id, card);
      } catch (error) {
        logger.warn({ runId: payload.run_id, error }, 'echo daemon sendCard failed');
      }
    });
    const tickEcho = async (): Promise<void> => {
      if (!existsSync(mirrorPath)) return;
      let text: string;
      try {
        text = readFileSync(mirrorPath, 'utf8');
      } catch {
        return;
      }
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as { op: string; session: SessionRecord };
          const session = entry.session;
          if (!session?.latest_run_id) continue;
          if (seenRunIds.has(session.latest_run_id)) continue;
          seenRunIds.add(session.latest_run_id);
          await echoTailer.onRunUpserted({
            run_id: session.latest_run_id,
            cmd: 'cli-start',
            cwd: session.cwd,
            created_at: session.last_active_at,
            status: session.status,
            session,
            operator_open_id: session.operator,
          });
        } catch {
          continue;
        }
      }
    };
    echoDaemonTimer = setInterval(() => { void tickEcho(); }, options.echoDaemonIntervalMs ?? 10_000);
    echoDaemonTimer.unref?.();
  }

  return {
    handler,
    async close() {
      if (echoDaemonTimer) clearInterval(echoDaemonTimer);
      echoDaemonTimer = null;
      seenRunIds = new Set();
      calendarScheduler.stop();
      groupSyncScheduler.stop();
      debouncer.flushAll();
      handler.dispose();
      keepalive.stop();
      wsClient.close({ force: true });
      if (ipcServer) {
        await ipcServer.stop();
      }
    },
    wsClientStatus: () => ({ ...wsStatus, state: wsClient.getConnectionStatus().state, forcedReconnects: keepalive.forcedReconnects }),
  };
}
