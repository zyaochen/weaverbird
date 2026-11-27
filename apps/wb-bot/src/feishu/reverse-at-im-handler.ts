import { randomUUID } from 'node:crypto';
import * as Lark from '@larksuiteoapi/node-sdk';
import { captainSocketPath } from '../../../../packages/core/src/paths.js';
import type { CaptainService, SessionEntry } from '../../../../packages/core/src/captain/index.js';
import type { ConcurrencyQueueIndex } from '../../../../packages/core/src/captain/concurrency-queue-index.js';
import type { ConcurrencyQueueStore } from '../../../../packages/core/src/captain/concurrency-queue-store.js';
import { ConcurrencyQueueEntryStatus } from '../../../../packages/core/src/captain/concurrency-queue-store.js';
import type { QueueMetricsAggregator } from '../../../../packages/core/src/captain/queue-metrics/aggregator.js';
import type { AuditRecord } from '../../../../packages/core/src/audit-pipe/contracts.js';
import { createMirrorSink } from '../../../../packages/core/src/audit-pipe/mirror-sink.js';
import { IpcClient, type IpcSessionConnection } from '../../../../packages/core/src/reverse-channel/ipc-client.js';
import {
  REVERSE_CHANNEL_ERROR_CODES,
  ReverseChannelError,
  type IpcMessage,
  type ReverseAtCommand,
} from '../../../../packages/core/src/reverse-channel/contracts.js';
import { validateReverseAtRun } from '../../../../packages/core/src/reverse-channel/reverse-at-handler.js';
import { renderCard } from './card-renderer.js';
import { createInitialState } from './stream-state.js';

export type ReverseAtMessageContext = {
  messageId: string;
  threadId: string;
  userOpenId: string;
};

export type ReverseAtFeishuClient = {
  replyCard(messageId: string, card: Record<string, unknown>): Promise<string>;
  replyText?(messageId: string, text: string): Promise<string>;
};

export type ReverseAtAdminRole = 'owner' | 'group_admin' | 'whitelist';
export type ReverseAtAdminRoleResolver = (context: ReverseAtMessageContext) => Promise<ReverseAtAdminRole | null>;
export type ReverseAtCancelTarget = { runId: string; shortId: string; label: string };
export type ReverseAtCancelResolver = (identifier: string) => ReverseAtCancelTarget | null;
export type ReverseAtCancelExecutor = (runId: string) => Promise<'cancelled' | 'noop_already_ended'>;
export type ReverseAtCancelableListProvider = () => string[];
export type ReverseAtOperatorNotifier = (payload: {
  runId: string;
  shortId: string;
  actorOpenId: string;
  actorRole: ReverseAtAdminRole;
  operatorOpenId: string;
  result: 'cancelled' | 'noop_already_ended';
}) => Promise<void>;

type ReverseAtConnection = Pick<IpcSessionConnection, 'send' | 'close'>;
export type ReverseAtIpcClientFactory = (socketPath: string) => {
  openSession(options?: { runId?: string; pid?: number }): Promise<ReverseAtConnection>;
};

type CaptainConcurrencyDeps = {
  index: ConcurrencyQueueIndex;
  store: Pick<ConcurrencyQueueStore, 'append'>;
  metrics?: Pick<QueueMetricsAggregator, 'record'>;
  now?: () => string;
  sessionId?: string;
};

type ReverseAtLikeCommand = ReverseAtCommand | {
  command: '/queue' | '/cancel-all' | '/preempt' | '/cancel';
  run_id: string;
  requester_open_id: string;
  requested_at: string;
  message_id: string;
};

type ReverseAtCaptainServiceLike = Pick<CaptainService, 'listActiveSessions'>;

type ReverseAtAuthorizationResult = {
  role: 'operator' | ReverseAtAdminRole;
} | {
  role: 'denied';
  reason: 'not_authorized' | 'fail_closed';
};

function findSessionByRunId(captainService: ReverseAtCaptainServiceLike, runId: string): SessionEntry | undefined {
  return captainService.listActiveSessions().find((entry) => entry.run_ids.includes(runId));
}

function sessionIdFor(botId: string, userOpenId: string, threadId: string): string {
  return `${botId}:${userOpenId}:${threadId}`;
}

function renderSystemCard(text: string, terminalState: 'done' | 'error'): Record<string, unknown> {
  return renderCard({
    ...createInitialState('system', 'Weaverbird', 'bot'),
    text,
    includeMeta: false,
    terminalState,
  });
}

function formatCancelableList(items: string[]): string {
  return items.length > 0
    ? `可叫停列表:\n${items.map((item) => `- ${item}`).join('\n')}`
    : '当前没有可叫停的运行';
}

export function parseReverseAtAdminWhitelist(value: string | undefined): Set<string> {
  return new Set((value ?? '').split(',').map((item) => item.trim()).filter(Boolean));
}

export function createLarkReverseAtAdminRoleResolver(
  client: InstanceType<typeof Lark.Client>,
  whitelistOpenIds: ReadonlySet<string> = new Set(),
): ReverseAtAdminRoleResolver {
  return async (context): Promise<ReverseAtAdminRole | null> => {
    if (whitelistOpenIds.has(context.userOpenId)) return 'whitelist';
    const response = await client.im.v1.chat.get({
      path: { chat_id: context.threadId },
      params: { user_id_type: 'open_id' },
    });
    const ownerId = response.data?.owner_id;
    if (ownerId === context.userOpenId) return 'owner';
    if ((response.data?.user_manager_id_list ?? []).includes(context.userOpenId)) return 'group_admin';
    return null;
  };
}

async function replyPlainText(feishu: ReverseAtFeishuClient, messageId: string, text: string): Promise<void> {
  if (feishu.replyText) {
    await feishu.replyText(messageId, text);
    return;
  }
  await feishu.replyCard(messageId, renderSystemCard(text, 'done'));
}

function formatQueueList(title: string, items: string[]): string {
  if (items.length === 0) return `${title}\n- (empty)`;
  return `${title}\n${items.map((item) => `- ${item}`).join('\n')}`;
}

function recordQueueCommandMetric(
  metrics: CaptainConcurrencyDeps['metrics'],
  sessionId: string,
  command: 'queue' | 'cancel_all' | 'preempt',
): void {
  metrics?.record({
    metric: 'captain_queue_commands_total',
    value: 1,
    labels: { session_id: sessionId, command },
  });
}

async function handleConcurrencyCommand(
  cmd: string,
  context: ReverseAtMessageContext,
  options: { captainConcurrency: CaptainConcurrencyDeps; feishu: ReverseAtFeishuClient },
): Promise<boolean> {
  const now = options.captainConcurrency.now ?? (() => new Date().toISOString());
  const sessionId = options.captainConcurrency.sessionId ?? context.threadId;
  const index = options.captainConcurrency.index;
  const store = options.captainConcurrency.store;
  const metrics = options.captainConcurrency.metrics;

  if (cmd === '/queue') {
    const running = index.listRunning(sessionId);
    const queued = index.listQueued(sessionId);
    await replyPlainText(
      options.feishu,
      context.messageId,
      `${formatQueueList('running', running)}\n${formatQueueList('queued', queued)}`,
    );
    recordQueueCommandMetric(metrics, sessionId, 'queue');
    return true;
  }

  if (cmd === '/cancel-all') {
    const queued = index.listQueuedEntries(sessionId);
    for (const entry of queued) {
      const ts = now();
      store.append({
        session_id: sessionId,
        run_id: entry.run_id,
        status: ConcurrencyQueueEntryStatus.ENDED,
        ts,
        reason: 'cancelled',
      });
      index.markEnded(sessionId, entry.run_id, ts);
    }
    await replyPlainText(options.feishu, context.messageId, `cancelled ${queued.length} queued run(s)`);
    recordQueueCommandMetric(metrics, sessionId, 'cancel_all');
    if (queued.length > 0) {
      metrics?.record({
        metric: 'captain_queue_cancelled_runs_total',
        value: queued.length,
        labels: { session_id: sessionId },
      });
    }
    return true;
  }

  if (cmd === '/preempt') {
    const running = index.listRunningEntries(sessionId);
    for (const entry of running) {
      const ts = now();
      store.append({
        session_id: sessionId,
        run_id: entry.run_id,
        status: ConcurrencyQueueEntryStatus.ENDED,
        ts,
        reason: 'preempted',
      });
      index.markEnded(sessionId, entry.run_id, ts);
    }

    const nextQueued = index.listQueuedEntries(sessionId)[0];
    if (nextQueued) {
      const ts = now();
      store.append({
        session_id: sessionId,
        run_id: nextQueued.run_id,
        status: ConcurrencyQueueEntryStatus.RUNNING,
        ts,
      });
      index.markRunning(sessionId, nextQueued.run_id, ts);
      await replyPlainText(options.feishu, context.messageId, `preempted ${running.length} running run(s)\n- promoted ${nextQueued.run_id}`);
      recordQueueCommandMetric(metrics, sessionId, 'preempt');
      if (running.length > 0) {
        metrics?.record({
          metric: 'captain_queue_preempted_runs_total',
          value: running.length,
          labels: { session_id: sessionId },
        });
      }
      metrics?.record({
        metric: 'captain_queue_promoted_by_preempt_total',
        value: 1,
        labels: { session_id: sessionId },
      });
      return true;
    }

    await replyPlainText(options.feishu, context.messageId, `preempted ${running.length} running run(s)`);
    recordQueueCommandMetric(metrics, sessionId, 'preempt');
    if (running.length > 0) {
      metrics?.record({
        metric: 'captain_queue_preempted_runs_total',
        value: running.length,
        labels: { session_id: sessionId },
      });
    }
    return true;
  }

  return false;
}

function writeReverseAtAudit(dataDir: string, session: SessionEntry, command: string, context: ReverseAtMessageContext, resource: string): void {
  const sink = createMirrorSink({ dataDir });
  const record: AuditRecord = {
    audit_record_id: randomUUID(),
    session_id: session.record.session_id,
    run_id: session.record.latest_run_id ?? command,
    revision: 0,
    actor: context.userOpenId,
    action: 'other',
    resource,
    ts: new Date().toISOString(),
    entry_form: 'im',
    entry_detail: {
      source_message_id: context.messageId,
      user_open_id: context.userOpenId,
      thread_id: context.threadId,
    },
    agent_id: 'claude-code',
    raw_tool_use_id: `reverse-at:${context.messageId}:${command}`,
    raw_tool_name: `reverse-at:${command}`,
  };
  sink.write(record);
}

function writeAdminCancelAudit(
  dataDir: string,
  session: SessionEntry,
  context: ReverseAtMessageContext,
  payload: {
    actorRole: ReverseAtAdminRole;
    shortId: string;
    result: 'cancelled' | 'noop_already_ended' | 'denied_not_authorized' | 'denied_target_not_found' | 'denied_fail_closed';
  },
): void {
  const sink = createMirrorSink({ dataDir });
  const record: AuditRecord = {
    audit_record_id: randomUUID(),
    session_id: session.record.session_id,
    run_id: session.record.latest_run_id ?? payload.shortId,
    revision: 0,
    actor: context.userOpenId,
    action: 'other',
    resource: `event=admin_cancel:actor_role=${payload.actorRole}:target_session=${payload.shortId}:result=${payload.result}`,
    ts: new Date().toISOString(),
    entry_form: 'im',
    entry_detail: {
      source_message_id: context.messageId,
      user_open_id: context.userOpenId,
      thread_id: context.threadId,
    },
    agent_id: 'claude-code',
    raw_tool_use_id: `admin_cancel:${context.messageId}:${payload.shortId}`,
    raw_tool_name: 'admin_cancel',
  };
  sink.write(record);
}

async function authorizeReverseAtCommand(
  session: SessionEntry,
  context: ReverseAtMessageContext,
  resolveAdminRole?: ReverseAtAdminRoleResolver,
): Promise<ReverseAtAuthorizationResult> {
  if (session.record.operator === context.userOpenId) {
    return { role: 'operator' };
  }
  if (!resolveAdminRole) {
    return { role: 'denied', reason: 'not_authorized' };
  }
  try {
    const role = await resolveAdminRole(context);
    if (role) return { role };
    return { role: 'denied', reason: 'not_authorized' };
  } catch {
    return { role: 'denied', reason: 'fail_closed' };
  }
}

async function executeAdminCancel(
  identifier: string,
  context: ReverseAtMessageContext,
  options: {
    feishu: ReverseAtFeishuClient;
    resolveCancelTarget?: ReverseAtCancelResolver;
    listCancelableTargets?: ReverseAtCancelableListProvider;
    executeCancel?: ReverseAtCancelExecutor;
  },
): Promise<boolean> {
  if (!identifier) return false;
  if (!options.resolveCancelTarget || !options.executeCancel) {
    await options.feishu.replyCard(
      context.messageId,
      renderSystemCard(`❌ /cancel ${identifier}: 未配置叫停解析器`, 'error'),
    );
    return true;
  }
  const target = options.resolveCancelTarget(identifier);
  if (!target) {
    const list = options.listCancelableTargets?.() ?? [];
    await options.feishu.replyCard(
      context.messageId,
      renderSystemCard(`❌ /cancel ${identifier}: 未找到目标\n${formatCancelableList(list)}`, 'error'),
    );
    return true;
  }
  const result = await options.executeCancel(target.runId);
  const text = result === 'cancelled'
    ? `✅ /cancel ${target.shortId}: 已叫停 ${target.label}`
    : `✅ /cancel ${target.shortId}: ${target.label} 已结束，无需再叫停`;
  await options.feishu.replyCard(context.messageId, renderSystemCard(text, 'done'));
  return true;
}

export async function handleReverseAtImCommand(
  cmd: ReverseAtLikeCommand,
  context: ReverseAtMessageContext,
  options: {
    captainService: ReverseAtCaptainServiceLike;
    dataDir: string;
    feishu: ReverseAtFeishuClient;
    createIpcClient?: ReverseAtIpcClientFactory;
    resolveAdminRole?: ReverseAtAdminRoleResolver;
    resolveCancelTarget?: ReverseAtCancelResolver;
    executeCancel?: ReverseAtCancelExecutor;
    notifyOperator?: ReverseAtOperatorNotifier;
    listCancelableTargets?: ReverseAtCancelableListProvider;
    captainConcurrency?: CaptainConcurrencyDeps;
  },
): Promise<void> {
  const createIpcClient = options.createIpcClient ?? ((socketPath: string) => new IpcClient(socketPath));

  if ((cmd.command === '/queue' || cmd.command === '/cancel-all' || cmd.command === '/preempt') && options.captainConcurrency) {
    const handled = await handleConcurrencyCommand(cmd.command, context, {
      captainConcurrency: options.captainConcurrency,
      feishu: options.feishu,
    });
    if (handled) return;
  }

  if (cmd.command === '/cancel') {
    const cancelTarget = options.resolveCancelTarget?.(cmd.run_id);
    if (!cancelTarget) {
      const list = options.listCancelableTargets?.() ?? [];
      await options.feishu.replyCard(
        context.messageId,
        renderSystemCard(`❌ /cancel ${cmd.run_id}: 未找到目标\n${formatCancelableList(list)}`, 'error'),
      );
      return;
    }
    try {
      validateReverseAtRun(options.captainService, cancelTarget.runId);
    } catch (error) {
      const reason = error instanceof ReverseChannelError
        ? error.code
        : REVERSE_CHANNEL_ERROR_CODES.E_REVERSE_AT_RUN_GONE;
      await options.feishu.replyCard(
        context.messageId,
        renderSystemCard(`❌ /cancel ${cancelTarget.shortId}: ${reason}`, 'error'),
      );
      return;
    }
    const session = findSessionByRunId(options.captainService, cancelTarget.runId);
    if (!session) {
      await options.feishu.replyCard(
        context.messageId,
        renderSystemCard(`❌ /cancel ${cancelTarget.shortId}: ${REVERSE_CHANNEL_ERROR_CODES.E_REVERSE_AT_RUN_GONE}`, 'error'),
      );
      return;
    }
    if (session.record.operator === context.userOpenId) {
      await options.feishu.replyCard(
        context.messageId,
        renderSystemCard(`❌ /cancel ${cancelTarget.shortId}: 该入口仅用于 admin 止损，请使用现有 operator 控制路径`, 'error'),
      );
      return;
    }
    const auth = await authorizeReverseAtCommand(session, context, options.resolveAdminRole);
    if (auth.role === 'denied') {
      writeReverseAtAudit(options.dataDir, session, 'denied', context, auth.reason === 'fail_closed'
        ? 'reverse-channel:reverse-at:denied_fail_closed'
        : 'reverse-channel:reverse-at:denied');
      await options.feishu.replyCard(
        context.messageId,
        renderSystemCard(
          auth.reason === 'fail_closed'
            ? `❌ 无权操作 ${cancelTarget.shortId} (群角色查询失败，已按 fail-closed 拒绝)`
            : `❌ 无权操作 ${cancelTarget.shortId} (非发起人/管理员)`,
          'error',
        ),
      );
      return;
    }
    if (auth.role === 'operator') {
      await options.feishu.replyCard(
        context.messageId,
        renderSystemCard(`❌ /cancel ${cancelTarget.shortId}: operator 不应进入 admin cancel 分支`, 'error'),
      );
      return;
    }
    const result = options.executeCancel ? await options.executeCancel(cancelTarget.runId) : 'cancelled';
    await options.feishu.replyCard(
      context.messageId,
      renderSystemCard(
        result === 'cancelled'
          ? `✅ /cancel ${cancelTarget.shortId}: 已叫停 ${cancelTarget.label}`
          : `✅ /cancel ${cancelTarget.shortId}: ${cancelTarget.label} 已结束，无需再叫停`,
        'done',
      ),
    );
    writeAdminCancelAudit(options.dataDir, session, context, {
      actorRole: auth.role,
      shortId: cancelTarget.shortId,
      result,
    });
    await options.notifyOperator?.({
      runId: cancelTarget.runId,
      shortId: cancelTarget.shortId,
      actorOpenId: context.userOpenId,
      actorRole: auth.role,
      operatorOpenId: session.record.operator,
      result,
    });
    return;
  }

  const session = findSessionByRunId(options.captainService, cmd.run_id);
  if (!session) {
    await options.feishu.replyCard(
      context.messageId,
      renderSystemCard(`❌ ${cmd.command} ${cmd.run_id}: ${REVERSE_CHANNEL_ERROR_CODES.E_REVERSE_AT_RUN_GONE}`, 'error'),
    );
    return;
  }

  const auth = await authorizeReverseAtCommand(session, context, options.resolveAdminRole);
  if (auth.role === 'denied') {
    writeReverseAtAudit(options.dataDir, session, 'denied', context, auth.reason === 'fail_closed'
      ? 'reverse-channel:reverse-at:denied_fail_closed'
      : 'reverse-channel:reverse-at:denied');
    await options.feishu.replyCard(
      context.messageId,
      renderSystemCard(
        auth.reason === 'fail_closed'
          ? `❌ 无权操作 ${cmd.run_id} (群角色查询失败，已按 fail-closed 拒绝)`
          : `❌ 无权操作 ${cmd.run_id} (非发起人/管理员)`,
        'error',
      ),
    );
    return;
  }

  const client = createIpcClient(captainSocketPath(options.dataDir));
  const connection = await client.openSession({ runId: cmd.run_id });
  try {
    const ack = await connection.send({ kind: 'control', command: cmd.command as ReverseAtCommand['command'], run_id: cmd.run_id });
    writeReverseAtAudit(options.dataDir, session, cmd.command, context, `reverse-channel:reverse-at:${cmd.command}`);
    if (ack.kind === 'ack' && ack.ok) {
      await options.feishu.replyCard(
        context.messageId,
        renderSystemCard(`✅ ${cmd.command} ${cmd.run_id}`, 'done'),
      );
      return;
    }
    const reason = ack.kind === 'ack' ? (ack.reason ?? 'unknown') : 'non-ack response';
    await options.feishu.replyCard(
      context.messageId,
      renderSystemCard(`❌ ${cmd.command} ${cmd.run_id}: ${reason}`, 'error'),
    );
  } catch (error) {
    const text = error instanceof ReverseChannelError && error.code === REVERSE_CHANNEL_ERROR_CODES.E_IPC_SEND_TIMEOUT
      ? `⏱ ${cmd.command} ${cmd.run_id}: ipc timeout`
      : `❌ ${cmd.command} ${cmd.run_id}: ${error instanceof Error ? error.message : String(error)}`;
    await options.feishu.replyCard(context.messageId, renderSystemCard(text, 'error'));
  } finally {
    await connection.close();
  }
}
