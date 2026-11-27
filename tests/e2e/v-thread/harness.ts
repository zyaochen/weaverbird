import { spawn } from 'node:child_process';
import BetterSqlite3 from 'better-sqlite3';
import { botDbPath, resolveDataDir } from '../../../packages/core/src/paths.js';
import { BindingStore, type InflightCard, type ThreadBinding } from '../../../apps/wb-bot/src/binding/store.js';
import { normalizeTopic } from '../../../apps/wb-bot/src/feishu/topic-key.js';
import { ObservabilityStoreEntrySchema } from '../../../packages/core/src/run-observability/contracts.js';
import { finalizeRun } from '../../../packages/core/src/run-observability/finalizer.js';
import { buildVThreadCases, type VThreadCaseDefinition, type VThreadCaseId } from './cases.js';

type JsonObject = Record<string, unknown>;

export type VThreadHarnessConfig = {
  botId: string;
  dataDir: string;
  dbPath: string;
  chatId: string | null;
  chatAllowlist: ReadonlySet<string>;
  ownerOpenId: string | null;
  ownerLabel: string;
  confirmActor: string | null;
  confirmChatId: string | null;
  allowRealEgress: boolean;
  allowHighRiskCleanup: boolean;
  larkIdentity: 'user' | 'bot';
  pollIntervalMs: number;
  timeoutMs: number;
  runTag: string;
};

export type TopicSnapshot = {
  binding: ThreadBinding | null;
  continuation: string | null;
  inflight: InflightCard | null;
};

export type TrackedStoreTopic = {
  botId: string;
  userOpenId: string;
  threadId: string;
  agentId: string;
  aliasThreadIds?: readonly string[];
};

export type StoreCleanupResult = {
  threadBinding: number;
  continuation: number;
  inflight: number;
  alias: number;
};

export type VThreadCaseResult = {
  id: VThreadCaseId;
  title: string;
  status: 'pass' | 'fail' | 'blocked' | 'manual';
  storeAssertion: string;
  details: string[];
};

export type VThreadCleanupSummary = {
  store: StoreCleanupResult;
  revokedMessageIds: string[];
  skippedMessageIds: string[];
};

export type VThreadSuiteResult = {
  status: 'pass' | 'fail' | 'blocked' | 'manual';
  stopPoint: 'before_first_real_egress' | 'manual_owner_card_click' | 'completed';
  reason: string;
  firstRealEgress: string;
  caseResults: readonly VThreadCaseResult[];
  cleanup: VThreadCleanupSummary;
  trackedMessageIds: readonly string[];
};

export type LarkMessageSnapshot = {
  messageId: string;
  chatId: string | null;
  rootId: string | null;
  parentId: string | null;
  messageType: string | null;
  senderOpenId: string | null;
  text: string | null;
  raw: JsonObject;
};

export type LarkCliLike = {
  sendText(chatId: string, text: string, idempotencyKey?: string): Promise<string>;
  replyText(messageId: string, text: string, options?: { replyInThread?: boolean; idempotencyKey?: string }): Promise<string>;
  sendCard(chatId: string, card: Record<string, unknown>, idempotencyKey?: string): Promise<string>;
  replyCardInThread(messageId: string, card: Record<string, unknown>, idempotencyKey?: string): Promise<string>;
  getMessages(messageIds: readonly string[]): Promise<LarkMessageSnapshot[]>;
  listChatMessages(chatId: string, startIso?: string): Promise<LarkMessageSnapshot[]>;
  revokeMessage(messageId: string): Promise<void>;
};

export type VThreadHarnessDeps = {
  cli?: LarkCliLike;
  cliRunner?: (args: readonly string[]) => Promise<unknown>;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
};

type SuiteContext = {
  config: VThreadHarnessConfig;
  cli: LarkCliLike;
  sleep: (ms: number) => Promise<void>;
  trackedMessages: Set<string>;
  trackedTopics: Map<string, TrackedStoreTopic>;
  rootMessageId: string | null;
  rootTopic: string | null;
  agentId: string | null;
  lastContinuationToken: string | null;
  lastBotReplyMessageId: string | null;
};

type FinalizerAction = {
  kind: 'send' | 'reply' | 'update';
  messageId: string | null;
  targetId: string;
};

type GuardFailure = {
  stopPoint: 'before_first_real_egress';
  reason: string;
};

function trimOrNull(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function splitCsv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readPathString(value: unknown, path: readonly string[]): string | null {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) return null;
    current = current[key];
  }
  return asString(current);
}

function parseJsonText(value: string | null): JsonObject | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readMessageText(record: JsonObject): string | null {
  const rawContent = readPathString(record, ['body', 'content'])
    ?? readPathString(record, ['message', 'body', 'content'])
    ?? readPathString(record, ['content']);
  const parsed = parseJsonText(rawContent);
  return asString(parsed?.['text']) ?? rawContent;
}

function normalizeMessageSnapshot(record: JsonObject): LarkMessageSnapshot | null {
  const messageId = asString(record['message_id']) ?? readPathString(record, ['message', 'message_id']);
  if (!messageId) return null;
  return {
    messageId,
    chatId: asString(record['chat_id']) ?? readPathString(record, ['message', 'chat_id']) ?? readPathString(record, ['conversation_id']),
    rootId: asString(record['root_id']) ?? readPathString(record, ['message', 'root_id']),
    parentId: asString(record['parent_id']) ?? readPathString(record, ['message', 'parent_id']),
    messageType: asString(record['msg_type']) ?? asString(record['message_type']) ?? readPathString(record, ['message', 'message_type']),
    senderOpenId: readPathString(record, ['sender', 'sender_id', 'open_id']) ?? readPathString(record, ['sender', 'id', 'open_id']),
    text: readMessageText(record),
    raw: record,
  };
}

function extractItems(payload: unknown): LarkMessageSnapshot[] {
  const root = isRecord(payload) ? payload : {};
  const candidates: unknown[] = [
    root['items'],
    root['messages'],
    isRecord(root['data']) ? root['data']['items'] : undefined,
    isRecord(root['data']) ? root['data']['messages'] : undefined,
  ];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    return candidate
      .map((item) => (isRecord(item) ? normalizeMessageSnapshot(item) : null))
      .filter((item): item is LarkMessageSnapshot => item !== null);
  }
  return [];
}

function extractMessageId(payload: unknown): string {
  const candidates = [
    readPathString(payload, ['data', 'message_id']),
    readPathString(payload, ['message_id']),
    readPathString(payload, ['data', 'message', 'message_id']),
  ];
  for (const candidate of candidates) {
    if (candidate) return candidate;
  }
  throw new Error('lark-cli response did not expose message_id');
}

function caseFailure(definition: VThreadCaseDefinition, details: string[]): VThreadCaseResult {
  return {
    id: definition.id,
    title: definition.title,
    status: 'fail',
    storeAssertion: definition.storeAssertion,
    details,
  };
}

function casePass(definition: VThreadCaseDefinition, details: string[]): VThreadCaseResult {
  return {
    id: definition.id,
    title: definition.title,
    status: 'pass',
    storeAssertion: definition.storeAssertion,
    details,
  };
}

function caseBlocked(definition: VThreadCaseDefinition, reason: string): VThreadCaseResult {
  return {
    id: definition.id,
    title: definition.title,
    status: 'blocked',
    storeAssertion: definition.storeAssertion,
    details: [reason],
  };
}

function caseManual(definition: VThreadCaseDefinition, details: string[]): VThreadCaseResult {
  return {
    id: definition.id,
    title: definition.title,
    status: 'manual',
    storeAssertion: definition.storeAssertion,
    details,
  };
}

function buildBlockedSuiteResult(config: VThreadHarnessConfig, failure: GuardFailure): VThreadSuiteResult {
  const cases = buildVThreadCases();
  return {
    status: 'blocked',
    stopPoint: failure.stopPoint,
    reason: failure.reason,
    firstRealEgress: cases[0]?.firstEgressSurface ?? 'lark-cli im +messages-send --as user --chat-id <chat_id> --text <prompt>',
    caseResults: cases.map((definition) => caseBlocked(definition, failure.reason)),
    cleanup: {
      store: { threadBinding: 0, continuation: 0, inflight: 0, alias: 0 },
      revokedMessageIds: [],
      skippedMessageIds: [],
    },
    trackedMessageIds: [],
  };
}

function defaultRunTag(now: Date): string {
  return now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
}

export function loadVThreadHarnessConfig(input: NodeJS.ProcessEnv = process.env, now = new Date()): VThreadHarnessConfig {
  const chatId = trimOrNull(input['WB_VTHREAD_E2E_CHAT_ID']);
  const ownerOpenId = trimOrNull(input['WB_VTHREAD_E2E_OWNER_OPEN_ID']);
  const ownerLabel = trimOrNull(input['WB_VTHREAD_E2E_OWNER_LABEL']) ?? 'owner-uat';
  const chatAllowlist = new Set(splitCsv(input['WB_VTHREAD_E2E_CHAT_ALLOWLIST']));
  const confirmActor = trimOrNull(input['WB_VTHREAD_E2E_CONFIRM_ACTOR']);
  const confirmChatId = trimOrNull(input['WB_VTHREAD_E2E_CONFIRM_CHAT_ID']);
  const allowRealEgress = !!chatId
    && !!ownerOpenId
    && chatAllowlist.has(chatId)
    && confirmChatId === chatId
    && confirmActor === ownerLabel;

  return {
    botId: trimOrNull(input['BOT_ID']) ?? 'default',
    dataDir: resolveDataDir({ dataDir: trimOrNull(input['WB_DATA_DIR']) ?? undefined }),
    dbPath: botDbPath(resolveDataDir({ dataDir: trimOrNull(input['WB_DATA_DIR']) ?? undefined })),
    chatId,
    chatAllowlist,
    ownerOpenId,
    ownerLabel,
    confirmActor,
    confirmChatId,
    allowRealEgress,
    allowHighRiskCleanup: input['WB_VTHREAD_E2E_CONFIRM_HIGH_RISK'] === 'revoke-test-messages',
    larkIdentity: trimOrNull(input['WB_VTHREAD_E2E_LARK_AS']) === 'bot' ? 'bot' : 'user',
    pollIntervalMs: Number(input['WB_VTHREAD_E2E_POLL_INTERVAL_MS'] ?? 1_000),
    timeoutMs: Number(input['WB_VTHREAD_E2E_TIMEOUT_MS'] ?? 30_000),
    runTag: trimOrNull(input['WB_VTHREAD_E2E_RUN_TAG']) ?? defaultRunTag(now),
  };
}

function validateGuard(config: VThreadHarnessConfig): GuardFailure | null {
  if (!config.chatId) {
    return { stopPoint: 'before_first_real_egress', reason: 'missing WB_VTHREAD_E2E_CHAT_ID runtime injection for the dedicated E2E group' };
  }
  if (!config.chatAllowlist.has(config.chatId)) {
    return { stopPoint: 'before_first_real_egress', reason: `chat ${config.chatId} is not present in WB_VTHREAD_E2E_CHAT_ALLOWLIST` };
  }
  if (!config.ownerOpenId) {
    return { stopPoint: 'before_first_real_egress', reason: 'missing WB_VTHREAD_E2E_OWNER_OPEN_ID required for store-side assertions' };
  }
  if (!config.allowRealEgress) {
    return {
      stopPoint: 'before_first_real_egress',
      reason: `owner confirmation missing; set WB_VTHREAD_E2E_CONFIRM_CHAT_ID=${config.chatId} and WB_VTHREAD_E2E_CONFIRM_ACTOR=${config.ownerLabel} before the first real message send`,
    };
  }
  return null;
}

export function readTopicSnapshot(dbPath: string, params: { botId: string; userOpenId: string; threadId: string; agentId?: string | null }): TopicSnapshot {
  const store = new BindingStore(dbPath);
  try {
    const binding = store.getThreadBinding(params.botId, params.userOpenId, params.threadId);
    const agentId = params.agentId ?? binding?.agentId ?? 'claude-code';
    return {
      binding,
      continuation: store.getContinuation(params.botId, params.userOpenId, params.threadId, agentId),
      inflight: store.getInflightCard(params.botId, params.userOpenId, params.threadId, agentId),
    };
  } finally {
    store.close();
  }
}

export function clearTrackedStoreRows(dbPath: string, tracked: readonly TrackedStoreTopic[]): StoreCleanupResult {
  const db = new BetterSqlite3(dbPath);
  const result: StoreCleanupResult = { threadBinding: 0, continuation: 0, inflight: 0, alias: 0 };
  try {
    const deleteBinding = db.prepare('DELETE FROM thread_binding WHERE bot_id = ? AND user_open_id = ? AND thread_id = ?');
    const deleteContinuation = db.prepare('DELETE FROM agent_continuation WHERE bot_id = ? AND user_open_id = ? AND thread_id = ? AND agent_id = ?');
    const deleteInflight = db.prepare('DELETE FROM inflight_card WHERE bot_id = ? AND user_open_id = ? AND thread_id = ? AND agent_id = ?');
    const deleteAlias = db.prepare('DELETE FROM thread_alias WHERE bot_id = ? AND user_open_id = ? AND alias_thread_id = ?');
    const deleteAliasByTarget = db.prepare('DELETE FROM thread_alias WHERE bot_id = ? AND user_open_id = ? AND target_thread_id = ?');

    for (const item of tracked) {
      result.threadBinding += deleteBinding.run(item.botId, item.userOpenId, item.threadId).changes;
      result.continuation += deleteContinuation.run(item.botId, item.userOpenId, item.threadId, item.agentId).changes;
      result.inflight += deleteInflight.run(item.botId, item.userOpenId, item.threadId, item.agentId).changes;
      result.alias += deleteAliasByTarget.run(item.botId, item.userOpenId, item.threadId).changes;
      for (const alias of item.aliasThreadIds ?? []) {
        result.alias += deleteAlias.run(item.botId, item.userOpenId, alias).changes;
      }
    }
    return result;
  } finally {
    db.close();
  }
}

async function defaultCliRunner(args: readonly string[]): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const child = spawn('lark-cli', [...args], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(`lark-cli ${args.join(' ')} failed with exit code ${code}: ${stderr || stdout}`));
        return;
      }
      const trimmed = stdout.trim();
      if (!trimmed) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(trimmed) as unknown);
      } catch (error) {
        reject(new Error(`failed to parse lark-cli JSON output for ${args.join(' ')}: ${String(error)}`));
      }
    });
  });
}

export function createLarkCliClient(config: Pick<VThreadHarnessConfig, 'larkIdentity' | 'allowHighRiskCleanup'>, runner: (args: readonly string[]) => Promise<unknown> = defaultCliRunner): LarkCliLike {
  const common = ['--as', config.larkIdentity, '--json'] as const;

  return {
    async sendText(chatId, text, idempotencyKey) {
      const payload = await runner([
        'im', '+messages-send', ...common,
        '--chat-id', chatId,
        '--text', text,
        ...(idempotencyKey ? ['--idempotency-key', idempotencyKey] : []),
      ]);
      return extractMessageId(payload);
    },
    async replyText(messageId, text, options) {
      const payload = await runner([
        'im', '+messages-reply', ...common,
        '--message-id', messageId,
        '--text', text,
        ...(options?.replyInThread ? ['--reply-in-thread'] : []),
        ...(options?.idempotencyKey ? ['--idempotency-key', options.idempotencyKey] : []),
      ]);
      return extractMessageId(payload);
    },
    async sendCard(chatId, card, idempotencyKey) {
      const payload = await runner([
        'im', '+messages-send', ...common,
        '--chat-id', chatId,
        '--msg-type', 'interactive',
        '--content', JSON.stringify(card),
        ...(idempotencyKey ? ['--idempotency-key', idempotencyKey] : []),
      ]);
      return extractMessageId(payload);
    },
    async replyCardInThread(messageId, card, idempotencyKey) {
      const payload = await runner([
        'im', '+messages-reply', ...common,
        '--message-id', messageId,
        '--msg-type', 'interactive',
        '--content', JSON.stringify(card),
        '--reply-in-thread',
        ...(idempotencyKey ? ['--idempotency-key', idempotencyKey] : []),
      ]);
      return extractMessageId(payload);
    },
    async getMessages(messageIds) {
      if (messageIds.length === 0) return [];
      const payload = await runner([
        'im', '+messages-mget', ...common,
        '--message-ids', messageIds.join(','),
      ]);
      return extractItems(payload);
    },
    async listChatMessages(chatId, startIso) {
      const payload = await runner([
        'im', '+chat-messages-list', ...common,
        '--chat-id', chatId,
        ...(startIso ? ['--start', startIso] : []),
        '--order', 'asc',
      ]);
      return extractItems(payload);
    },
    async revokeMessage(messageId) {
      if (!config.allowHighRiskCleanup) {
        throw new Error('message revoke requested without WB_VTHREAD_E2E_CONFIRM_HIGH_RISK=revoke-test-messages');
      }
      await runner([
        'im', 'messages', 'delete', ...common,
        '--message-id', messageId,
        '--yes',
      ]);
    },
  };
}

function trackTopic(ctx: SuiteContext, topic: TrackedStoreTopic): void {
  const key = `${topic.botId}:${topic.userOpenId}:${topic.threadId}:${topic.agentId}`;
  const existing = ctx.trackedTopics.get(key);
  if (!existing) {
    ctx.trackedTopics.set(key, {
      ...topic,
      aliasThreadIds: [...new Set(topic.aliasThreadIds ?? [])],
    });
    return;
  }
  const mergedAliases = new Set([...(existing.aliasThreadIds ?? []), ...(topic.aliasThreadIds ?? [])]);
  ctx.trackedTopics.set(key, { ...existing, aliasThreadIds: [...mergedAliases] });
}

async function pollUntil<T>(
  label: string,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>,
  intervalMs: number,
  reader: () => T | null,
): Promise<T> {
  const started = Date.now();
  while ((Date.now() - started) <= timeoutMs) {
    const value = reader();
    if (value !== null) return value;
    await sleep(intervalMs);
  }
  throw new Error(`timed out while waiting for ${label}`);
}

function buildPrompt(tag: string, caseId: VThreadCaseId): string {
  switch (caseId) {
    case 'E1':
      return `[V-THREAD-E2E ${tag}] E1 请只回复这串标记并保留上下文: root-${tag}`;
    case 'E2':
      return `[V-THREAD-E2E ${tag}] E2 如果你还在同一线程上下文里，请只回复: follow-${tag}`;
    case 'E3':
      return `[V-THREAD-E2E ${tag}] E3 再次确认同一会话，只回复: resume-${tag}`;
    default:
      return `[V-THREAD-E2E ${tag}] ${caseId}`;
  }
}

function createFinalizerClient(ctx: SuiteContext): {
  client: {
    updateCard(messageId: string, card: Record<string, unknown>): Promise<void>;
    replyCard(messageId: string, card: Record<string, unknown>): Promise<void>;
    sendCard(chatId: string, card: Record<string, unknown>): Promise<void>;
  };
  getLastAction(): FinalizerAction | null;
} {
  let lastAction: FinalizerAction | null = null;
  return {
    client: {
      async updateCard(messageId) {
        lastAction = { kind: 'update', messageId: null, targetId: messageId };
      },
      async replyCard(messageId, card) {
        const replyMessageId = await ctx.cli.replyCardInThread(messageId, card, `${ctx.config.runTag}:reply:${messageId}`);
        ctx.trackedMessages.add(replyMessageId);
        lastAction = { kind: 'reply', messageId: replyMessageId, targetId: messageId };
      },
      async sendCard(chatId, card) {
        const sentMessageId = await ctx.cli.sendCard(chatId, card, `${ctx.config.runTag}:send:${chatId}`);
        ctx.trackedMessages.add(sentMessageId);
        lastAction = { kind: 'send', messageId: sentMessageId, targetId: chatId };
      },
    },
    getLastAction() {
      return lastAction;
    },
  };
}

async function runE1(definition: VThreadCaseDefinition, ctx: SuiteContext): Promise<VThreadCaseResult> {
  if (!ctx.config.chatId || !ctx.config.ownerOpenId) {
    return caseBlocked(definition, 'missing chat or owner identity');
  }
  const rootMessageId = await ctx.cli.sendText(ctx.config.chatId, buildPrompt(ctx.config.runTag, 'E1'), `${ctx.config.runTag}:E1`);
  ctx.trackedMessages.add(rootMessageId);
  ctx.rootMessageId = rootMessageId;
  ctx.rootTopic = normalizeTopic({ chatId: ctx.config.chatId, messageId: rootMessageId, chatType: 'group' });

  const snapshot = await pollUntil(
    'E1 canonical binding',
    ctx.config.timeoutMs,
    ctx.sleep,
    ctx.config.pollIntervalMs,
    () => {
      const current = readTopicSnapshot(ctx.config.dbPath, {
        botId: ctx.config.botId,
        userOpenId: ctx.config.ownerOpenId!,
        threadId: ctx.rootTopic!,
      });
      return current.binding ? current : null;
    },
  );

  const agentId = snapshot.binding?.agentId ?? 'claude-code';
  ctx.agentId = agentId;
  trackTopic(ctx, {
    botId: ctx.config.botId,
    userOpenId: ctx.config.ownerOpenId,
    threadId: ctx.rootTopic,
    agentId,
    aliasThreadIds: [`chat:${ctx.config.chatId}`],
  });
  ctx.lastBotReplyMessageId = snapshot.inflight?.replyMessageId ?? null;

  if (snapshot.binding?.threadId !== ctx.rootTopic) {
    return caseFailure(definition, [
      `expected binding.threadId=${ctx.rootTopic}`,
      `actual=${snapshot.binding?.threadId ?? 'null'}`,
    ]);
  }

  return casePass(definition, [
    `root message id=${rootMessageId}`,
    `canonical topic=${ctx.rootTopic}`,
    `binding agent=${agentId}`,
    `inflight reply=${snapshot.inflight?.replyMessageId ?? 'none (run may have already completed)'}`,
  ]);
}

async function runE2(definition: VThreadCaseDefinition, ctx: SuiteContext): Promise<VThreadCaseResult> {
  if (!ctx.config.chatId || !ctx.config.ownerOpenId || !ctx.rootMessageId || !ctx.rootTopic) {
    return caseBlocked(definition, 'E1 root state missing');
  }
  const replyMessageId = await ctx.cli.replyText(ctx.rootMessageId, buildPrompt(ctx.config.runTag, 'E2'), {
    replyInThread: true,
    idempotencyKey: `${ctx.config.runTag}:E2`,
  });
  ctx.trackedMessages.add(replyMessageId);
  const replyTopic = normalizeTopic({
    chatId: ctx.config.chatId,
    rootId: ctx.rootMessageId,
    messageId: replyMessageId,
    chatType: 'group',
  });

  const snapshot = await pollUntil(
    'E2 continuation',
    ctx.config.timeoutMs,
    ctx.sleep,
    ctx.config.pollIntervalMs,
    () => {
      const current = readTopicSnapshot(ctx.config.dbPath, {
        botId: ctx.config.botId,
        userOpenId: ctx.config.ownerOpenId!,
        threadId: replyTopic,
        agentId: ctx.agentId,
      });
      return current.binding && current.continuation ? current : null;
    },
  );

  ctx.lastContinuationToken = snapshot.continuation;
  ctx.lastBotReplyMessageId = snapshot.inflight?.replyMessageId ?? ctx.lastBotReplyMessageId;

  if (replyTopic !== ctx.rootTopic || snapshot.binding?.threadId !== ctx.rootTopic) {
    return caseFailure(definition, [
      `reply topic=${replyTopic}`,
      `root topic=${ctx.rootTopic}`,
      `binding.threadId=${snapshot.binding?.threadId ?? 'null'}`,
    ]);
  }

  return casePass(definition, [
    `reply message id=${replyMessageId}`,
    `reply topic=${replyTopic}`,
    `continuation present=${snapshot.continuation ? 'yes' : 'no'}`,
    `reply card=${snapshot.inflight?.replyMessageId ?? ctx.lastBotReplyMessageId ?? 'not observed'}`,
  ]);
}

async function runE3(definition: VThreadCaseDefinition, ctx: SuiteContext): Promise<VThreadCaseResult> {
  if (!ctx.config.chatId || !ctx.config.ownerOpenId || !ctx.rootMessageId || !ctx.rootTopic) {
    return caseBlocked(definition, 'E1/E2 state missing');
  }
  const before = ctx.lastContinuationToken;
  const replyMessageId = await ctx.cli.replyText(ctx.rootMessageId, buildPrompt(ctx.config.runTag, 'E3'), {
    replyInThread: true,
    idempotencyKey: `${ctx.config.runTag}:E3`,
  });
  ctx.trackedMessages.add(replyMessageId);
  const snapshot = await pollUntil(
    'E3 continuation refresh',
    ctx.config.timeoutMs,
    ctx.sleep,
    ctx.config.pollIntervalMs,
    () => {
      const current = readTopicSnapshot(ctx.config.dbPath, {
        botId: ctx.config.botId,
        userOpenId: ctx.config.ownerOpenId!,
        threadId: ctx.rootTopic!,
        agentId: ctx.agentId,
      });
      return current.binding && current.continuation ? current : null;
    },
  );

  ctx.lastContinuationToken = snapshot.continuation;
  const sessionId = `${ctx.config.botId}:${ctx.config.ownerOpenId}:${ctx.rootTopic}`;
  if (snapshot.binding?.threadId !== ctx.rootTopic) {
    return caseFailure(definition, [
      `expected binding.threadId=${ctx.rootTopic}`,
      `actual=${snapshot.binding?.threadId ?? 'null'}`,
    ]);
  }

  return casePass(definition, [
    `follow-up reply=${replyMessageId}`,
    `session id=${sessionId}`,
    `continuation before=${before ?? 'null'}`,
    `continuation after=${snapshot.continuation ?? 'null'}`,
  ]);
}

async function runE4(definition: VThreadCaseDefinition, ctx: SuiteContext, now: Date): Promise<VThreadCaseResult> {
  if (!ctx.config.chatId || !ctx.config.ownerOpenId || !ctx.rootTopic) {
    return caseBlocked(definition, 'missing chat or owner identity');
  }
  const before = readTopicSnapshot(ctx.config.dbPath, {
    botId: ctx.config.botId,
    userOpenId: ctx.config.ownerOpenId,
    threadId: ctx.rootTopic,
    agentId: ctx.agentId,
  });
  const recording = createFinalizerClient(ctx);
  const entry = ObservabilityStoreEntrySchema.parse({
    run_id: `v-thread-e4-${ctx.config.runTag}`,
    session_id: `${ctx.config.botId}:${ctx.config.ownerOpenId}:finalizer:E4`,
    status: 'failed',
    updated_at: now.toISOString(),
    last_stdout_at: now.toISOString(),
    origin_message_id: null,
    card_message_id: null,
    home_group_id: ctx.config.chatId,
    created_at: now.toISOString(),
    alert_reason: null,
  });

  const ok = await finalizeRun(entry, [`E4 ${ctx.config.runTag}`], {
    client: recording.client,
    dataDir: ctx.config.dataDir,
    nowIso: now.toISOString(),
  });
  if (!ok) {
    return caseFailure(definition, ['finalizeRun returned false']);
  }

  const action = recording.getLastAction();
  const sentId = action?.messageId;
  if (!action || action.kind !== 'send' || !sentId) {
    return caseFailure(definition, [`expected send branch, got ${action?.kind ?? 'none'}`]);
  }

  const message = (await ctx.cli.getMessages([sentId]))[0];
  if (!message) {
    return caseFailure(definition, [`unable to read sent message ${sentId}`]);
  }
  if (message.rootId || message.parentId) {
    return caseFailure(definition, [
      `expected top-level send with no root/parent relation`,
      `root_id=${message.rootId ?? 'null'}`,
      `parent_id=${message.parentId ?? 'null'}`,
    ]);
  }

  const after = readTopicSnapshot(ctx.config.dbPath, {
    botId: ctx.config.botId,
    userOpenId: ctx.config.ownerOpenId,
    threadId: ctx.rootTopic,
    agentId: ctx.agentId,
  });
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    return caseFailure(definition, [
      'expected finalizer send branch to leave thread store state unchanged',
      `before=${JSON.stringify(before)}`,
      `after=${JSON.stringify(after)}`,
    ]);
  }

  return casePass(definition, [
    `finalizer send message=${sentId}`,
    `root_id=${message.rootId ?? 'null'}`,
    `parent_id=${message.parentId ?? 'null'}`,
    'thread store snapshot unchanged',
  ]);
}

async function runE5(definition: VThreadCaseDefinition, ctx: SuiteContext, now: Date): Promise<VThreadCaseResult> {
  if (!ctx.config.chatId || !ctx.config.ownerOpenId || !ctx.rootMessageId || !ctx.rootTopic) {
    return caseBlocked(definition, 'missing root message from E1');
  }
  const before = readTopicSnapshot(ctx.config.dbPath, {
    botId: ctx.config.botId,
    userOpenId: ctx.config.ownerOpenId,
    threadId: ctx.rootTopic,
    agentId: ctx.agentId,
  });
  const recording = createFinalizerClient(ctx);
  const entry = ObservabilityStoreEntrySchema.parse({
    run_id: `v-thread-e5-${ctx.config.runTag}`,
    session_id: `${ctx.config.botId}:${ctx.config.ownerOpenId}:finalizer:E5`,
    status: 'succeeded',
    updated_at: now.toISOString(),
    last_stdout_at: now.toISOString(),
    origin_message_id: ctx.rootMessageId,
    card_message_id: null,
    home_group_id: ctx.config.chatId,
    created_at: now.toISOString(),
    alert_reason: null,
  });

  const ok = await finalizeRun(entry, [`E5 ${ctx.config.runTag}`], {
    client: recording.client,
    dataDir: ctx.config.dataDir,
    nowIso: now.toISOString(),
  });
  if (!ok) {
    return caseFailure(definition, ['finalizeRun returned false']);
  }

  const action = recording.getLastAction();
  const replyId = action?.messageId;
  if (!action || action.kind !== 'reply' || !replyId) {
    return caseFailure(definition, [`expected reply branch, got ${action?.kind ?? 'none'}`]);
  }

  const message = (await ctx.cli.getMessages([replyId]))[0];
  if (!message) {
    return caseFailure(definition, [`unable to read reply message ${replyId}`]);
  }
  if (message.rootId !== ctx.rootMessageId) {
    return caseFailure(definition, [
      `expected root_id=${ctx.rootMessageId}`,
      `actual=${message.rootId ?? 'null'}`,
    ]);
  }

  const after = readTopicSnapshot(ctx.config.dbPath, {
    botId: ctx.config.botId,
    userOpenId: ctx.config.ownerOpenId,
    threadId: ctx.rootTopic,
    agentId: ctx.agentId,
  });
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    return caseFailure(definition, [
      'expected finalizer reply branch to leave thread store state unchanged',
      `before=${JSON.stringify(before)}`,
      `after=${JSON.stringify(after)}`,
    ]);
  }

  return casePass(definition, [
    `finalizer reply message=${replyId}`,
    `root_id=${message.rootId ?? 'null'}`,
    `parent_id=${message.parentId ?? 'null'}`,
    'thread store snapshot unchanged',
  ]);
}

function runE6(definition: VThreadCaseDefinition, ctx: SuiteContext): VThreadCaseResult {
  return caseManual(definition, [
    'owner must click the live admin_cancel button on the active card to trigger the real callback path',
    `tracked root message=${ctx.rootMessageId ?? 'missing'}`,
    `latest live reply card=${ctx.lastBotReplyMessageId ?? 'not observed from inflight store'}`,
    'after the manual click, re-run the suite with the live evidence in place or inspect audit/store side-effects directly',
  ]);
}

async function cleanupTrackedArtifacts(ctx: SuiteContext): Promise<VThreadCleanupSummary> {
  const store = clearTrackedStoreRows(ctx.config.dbPath, [...ctx.trackedTopics.values()]);
  const revokedMessageIds: string[] = [];
  const skippedMessageIds: string[] = [];
  for (const messageId of ctx.trackedMessages) {
    if (!ctx.config.allowHighRiskCleanup) {
      skippedMessageIds.push(messageId);
      continue;
    }
    await ctx.cli.revokeMessage(messageId);
    revokedMessageIds.push(messageId);
  }
  return { store, revokedMessageIds, skippedMessageIds };
}

async function runE7(definition: VThreadCaseDefinition, ctx: SuiteContext): Promise<VThreadCaseResult> {
  const first = clearTrackedStoreRows(ctx.config.dbPath, [...ctx.trackedTopics.values()]);
  const second = clearTrackedStoreRows(ctx.config.dbPath, [...ctx.trackedTopics.values()]);
  const residual = [...ctx.trackedTopics.values()].map((item) => {
    const snapshot = readTopicSnapshot(ctx.config.dbPath, {
      botId: item.botId,
      userOpenId: item.userOpenId,
      threadId: item.threadId,
      agentId: item.agentId,
    });
    return { item, snapshot };
  }).filter((entry) => entry.snapshot.binding || entry.snapshot.continuation || entry.snapshot.inflight);

  if (residual.length > 0) {
    return caseFailure(definition, residual.map((entry) => `residual topic ${entry.item.threadId}`));
  }

  return casePass(definition, [
    `first cleanup: binding=${first.threadBinding}, continuation=${first.continuation}, inflight=${first.inflight}, alias=${first.alias}`,
    `second cleanup: binding=${second.threadBinding}, continuation=${second.continuation}, inflight=${second.inflight}, alias=${second.alias}`,
  ]);
}

export async function runVThreadSuite(input: NodeJS.ProcessEnv = process.env, deps: VThreadHarnessDeps = {}): Promise<VThreadSuiteResult> {
  const now = deps.now ?? (() => new Date());
  const config = loadVThreadHarnessConfig(input, now());
  const guardFailure = validateGuard(config);
  if (guardFailure) return buildBlockedSuiteResult(config, guardFailure);

  const cli = deps.cli ?? createLarkCliClient(config, deps.cliRunner ?? defaultCliRunner);
  const sleep = deps.sleep ?? (async (ms: number) => { await new Promise((resolve) => setTimeout(resolve, ms)); });
  const ctx: SuiteContext = {
    config,
    cli,
    sleep,
    trackedMessages: new Set<string>(),
    trackedTopics: new Map<string, TrackedStoreTopic>(),
    rootMessageId: null,
    rootTopic: null,
    agentId: null,
    lastContinuationToken: null,
    lastBotReplyMessageId: null,
  };

  const cases = buildVThreadCases();
  const caseResults: VThreadCaseResult[] = [];
  let suiteStatus: VThreadSuiteResult['status'] = 'pass';
  let stopPoint: VThreadSuiteResult['stopPoint'] = 'completed';
  let reason = 'all automated cases passed';
  try {
    for (const definition of cases) {
      let result: VThreadCaseResult;
      if (definition.id === 'E1') {
        result = await runE1(definition, ctx);
      } else if (definition.id === 'E2') {
        result = await runE2(definition, ctx);
      } else if (definition.id === 'E3') {
        result = await runE3(definition, ctx);
      } else if (definition.id === 'E4') {
        result = await runE4(definition, ctx, now());
      } else if (definition.id === 'E5') {
        result = await runE5(definition, ctx, now());
      } else if (definition.id === 'E6') {
        result = runE6(definition, ctx);
      } else {
        result = await runE7(definition, ctx);
      }
      caseResults.push(result);

      if (result.status === 'fail') {
        suiteStatus = 'fail';
        reason = `${definition.id} failed`;
        break;
      }
      if (result.status === 'manual') {
        suiteStatus = 'manual';
        stopPoint = 'manual_owner_card_click';
        reason = `${definition.id} requires an owner card click on the live callback surface`;
        break;
      }
    }
  } finally {
    const cleanup = await cleanupTrackedArtifacts(ctx);
    if (suiteStatus === 'manual') {
      return {
        status: suiteStatus,
        stopPoint,
        reason,
        firstRealEgress: cases[0]?.firstEgressSurface ?? '',
        caseResults,
        cleanup,
        trackedMessageIds: [...ctx.trackedMessages],
      };
    }
    if (suiteStatus === 'fail') {
      return {
        status: suiteStatus,
        stopPoint,
        reason,
        firstRealEgress: cases[0]?.firstEgressSurface ?? '',
        caseResults,
        cleanup,
        trackedMessageIds: [...ctx.trackedMessages],
      };
    }
    return {
      status: 'pass',
      stopPoint: 'completed',
      reason,
      firstRealEgress: cases[0]?.firstEgressSurface ?? '',
      caseResults,
      cleanup,
      trackedMessageIds: [...ctx.trackedMessages],
    };
  }
}
