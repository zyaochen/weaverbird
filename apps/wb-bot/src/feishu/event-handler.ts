import pino from 'pino';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { AgentAdapter, AgentRegistry, AgentRun, ConsentLevel } from '../../../../packages/core/src/index.js';
import { CODEX_PASSTHROUGH_KEYS } from '../../../../packages/core/src/index.js';
import { CLAUDE_PARTIAL_MESSAGES_FLAG } from '../../../../packages/core/src/agent/claude-code.js';
import {
  resolveDataDir,
  runDir as resolveRunDir,
  runEventsPath,
  runSpecPath,
  runStopSignalPath,
} from '../../../../packages/core/src/paths.js';
import type { CaptainService, CaptainConcurrencyContainer } from '../../../../packages/core/src/captain/index.js';
import { createCaptainConcurrencyContainer } from '../../../../packages/core/src/captain/index.js';
import { ConcurrencyQueueEntryStatus } from '../../../../packages/core/src/captain/concurrency-queue-store.js';
import { enqueueOrSpawn } from '../../../../packages/core/src/captain/enqueue-or-spawn.js';
import { isCaptainEnabled } from '../captain/captain-gate.js';
import { BindingStore, type InflightCard } from '../binding/store.js';
import type { TaskIndex } from '../binding/task-index.js';
import { runCommand } from '../commands/router.js';
import { allocateSessionShortId, createInitialState, reduceStreamState, type StreamState } from './stream-state.js';
import { RUN_FOLLOW_UP_ACTIONS, SEND_ARTIFACT_ACTION, answerChunks, renderCard, renderContinuationCard } from './card-renderer.js';
import { ARTIFACT_MAX_BYTES, artifactLabel, findArtifacts } from './artifacts.js';
import { CardPipeline } from './card-pipeline.js';
import { validateCwd } from '../security/cwd-guard.js';
import { replayEventsFromNdjson } from '../../../../packages/core/src/runner/event-replay.js';
import { EventsFileReader } from './events-file-reader.js';
import { readEventsSync, extractLatestContinuationToken, runnerEventMapper } from './events-file-reader.js';
import { spawnWbRunner, generateRunId, buildRunSpec } from './wb-runner-spawner.js';
import { buildFilteredEnv } from '../security/env-whitelist.js';
import { buildApprovalHookEnv } from '../approval-gate/hook-env.js';
import { sendAdminAlert, type AlertSink } from './admin-alert.js';
import { shouldPushOnDone, parsePushThresholdMs, formatCompletionMessage } from './completion-push.js';
import { judgeRunState as judgeRunStatePure } from './run-state.js';
import {
  handleReverseAtImCommand,
  type ReverseAtAdminRoleResolver,
  type ReverseAtCancelExecutor,
  type ReverseAtCancelResolver,
  type ReverseAtCancelableListProvider,
  type ReverseAtOperatorNotifier,
} from './reverse-at-im-handler.js';
import { resolveReverseAtCancelTargetFromSession } from './session-short-id.js';
import { parseReverseAt } from '../../../../packages/core/src/reverse-channel/reverse-at-handler.js';
import { resolveCliPid } from '../../../../packages/core/src/reverse-channel/pid-resolver.js';
import { sendControlSignal } from '../../../../packages/core/src/reverse-channel/ipc-control-handler.js';
import { ProgressStore, ProgressCollector } from '../../../../packages/core/src/run-observability/index.js';
import { wireRunObservability } from '../run-observability/orchestrator.js';
import { closeCalendarBlock, openCalendarBlock } from '../../../../packages/core/src/calendar-hook/service.js';
import type { CalendarHookConfig, CalendarTransport } from '../../../../packages/core/src/calendar-hook/contracts.js';
import { ApprovalRequestStore } from '../approval-gate/store.js';
import { renderApprovalRequestCard, renderApprovalResolvedCard, renderApprovalCountdownText } from '../approval-gate/cards.js';
import { createCardApprovalNotifier, type ApprovalNotifier } from '../approval-gate/notifier.js';
import { writeApprovalAudit } from '../approval-gate/audit.js';
import { APPROVAL_REQUEST_STATUS } from '../../../../packages/core/src/approval-gate/contracts.js';
import { prepareApprovalHookFiles, type ApprovalHookFiles } from '../approval-gate/hook-files.js';
import { toChatTopicKey } from './topic-key.js';
import type { ApiMessageItem } from '@larksuiteoapi/node-sdk';
import type { InboundResource } from './message-parser.js';
import { MediaCache, type ResourceDownloadType } from './media-cache.js';
import { buildAgentInput } from './inbound-context.js';
import { AckReactions } from './reaction.js';
import { mergeMessageEvents } from './pending-queue.js';
import {
  MuteRegistry,
  defaultMuteRegistryPath,
} from '../../../../packages/core/src/reverse-channel/index.js';
import { errorSerializers } from './log-redact.js';
import { feishuErrorCode } from './card-transport.js';

const PREFERRED_AGENT_ORDER = ['claude-code', 'codex'] as const;
const STALE_SELF_HEAL_MAX_ATTEMPTS = 1;
const RUNNER_STARTUP_GRACE_MS = 5_000;

/**
 * 飞书 mention 占位符正则: `@_user_<n>` 单个用户 mention, `@_all` 全员 mention.
 * 当用户在群里 `@bot` 时, 飞书 message content 会用这种占位符表示 mention.
 *
 * 实测形态 (主设计师 lark log 2026-06-03):
 *   raw content: {"text":"@_user_1"}       # 只 @bot 没附文字
 *   raw content: {"text":"@_user_1 hello"} # @bot + 文字
 */
const LARK_MENTION_PLACEHOLDER_RE = /@_user_\d+|@_all/g;

/**
 * Strip 所有飞书 mention 占位符. 仅做 placeholder replace, **不 trim 不 collapse 空白**:
 * - 不 trim: 保留 trailing whitespace 让 caller 内部 regex (例如 `AGENT_PREFIX` 的
 *   `\s+(.+)$`) 仍能解析 user 的 trailing-whitespace + empty prompt body 这种边界
 * - 不 collapse: prompt body 内的多空白让 caller 决定怎么处理
 *
 * 用途:
 * - 用户只 `@bot` 不附文字: helper 返回 '', caller 用 `.trim() === ''` 判 empty
 * - 用户 `@bot + 文字`: helper 返回 ' 文字...' (含 leading space), caller 内的
 *   `.trimStart()` 已经处理
 *
 * 背景: 不 strip placeholder 直接把 `@_user_1` 当 prompt 传 claude code, claude 会
 * 把 `@<id>` 解释成 file ref / sigil, 在 --print 模式报 "Input must be provided
 * either through stdin or as a prompt argument".
 *
 * 测试见 `tests/wb-bot/lark-mention-strip.test.ts`.
 */
export function stripLarkMentionPlaceholders(text: string): string {
  return text.replace(LARK_MENTION_PLACEHOLDER_RE, '');
}

/**
 * 从 args 数组里抽 `--model` 的值. 支持 4 种 form:
 *   --model gpt-5.4         (separated)
 *   --model=gpt-5.4         (equal-sign)
 *   -m gpt-5.4              (short)
 *   -mgpt-5.4               (short concat)
 *
 * 用于把用户在 `WB_CLAUDE_COMMAND` 里写的 model 自动 propagate 到 child env
 * 作 `ANTHROPIC_MODEL`. 背景: claude-code `--print --output-format stream-json`
 * mode 某些版本不 honor CLI `--model` flag, 需要 env var 兜底. 同时 wrapper
 * `claude-w` wrapper 在 has_model_flag=1 path 下不 export ANTHROPIC_MODEL,
 * 所以 wb-bot 必须自己补这一步, 让用户单一 source of truth (WB_CLAUDE_COMMAND).
 *
 * 测试见 `tests/wb-bot/build-agent-args.test.ts`.
 */
export function extractModelFromArgs(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a) continue;
    if (a === '--model' || a === '-m') {
      const next = args[i + 1];
      if (next && !next.startsWith('-')) return next;
    }
    if (a.startsWith('--model=')) return a.slice('--model='.length) || undefined;
    if (a.startsWith('-m') && a.length > 2 && !a.startsWith('--')) return a.slice(2);
  }
  return undefined;
}

/**
 * 从 args 数组里把 `--model` / `-m` (含 4 种 form) 移除. 用于 codex 路径:
 * `WB_CODEX_COMMAND="codex --model X"` 时, head=`codex`, prepend=[`--model`,`X`].
 * core CodexAgent 把 `--model` splice 进 `exec` 子命令的固定位置, prepend 里再带一份就
 * 重复且位置错. 抽出 model 到 buildAgentArgs 的 6th 参数后, 必须把 prepend 里的剥掉.
 *
 * 与 `extractModelFromArgs` 解析规则保持对称. 测试见 `tests/wb-bot/codex-argv-alignment.test.ts`.
 */
export function stripModelArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a) { out.push(a as unknown as string); continue; }
    if (a === '--model' || a === '-m') {
      const next = args[i + 1];
      if (next && !next.startsWith('-')) {
        i++;
        continue;
      }
      continue;
    }
    if (a.startsWith('--model=')) continue;
    if (a.startsWith('-m') && a.length > 2 && !a.startsWith('--')) continue;
    out.push(a);
  }
  return out;
}

/**
 * 构造传给 claude-code / codex CLI 的 argv.
 *
 * **wb-bot invariant**: wb-bot 永远 backend 进程, 通过 `spawn` + `stdio: ['ignore', file, file]`
 * + `detached: true` 起 agent CLI 子进程, **永远无 TTY 无 stdin**. 任何 claude / codex 自身的
 * startup-phase interactive prompt (workspace trust / model picker / etc) 都会 hang 子进程,
 * 导致主进程 `for await events.ndjson` 永远阻塞 → 飞书卡片冻在 "running · 00:00".
 *
 * 因此 claude-code 路径下, 除 `consentLevel === 'plan-only'` 之外, 一律附加
 * `--dangerously-skip-permissions` 屏蔽所有 startup-phase prompt. consent gating
 * 由 wb-bot 自身的 `ConsentLevel` contract 统一管 (per `AgentAdapter`), 不依赖
 * claude 自身的 trust/permission UI.
 *
 * 例外 `plan-only`: 该模式 claude 仅产 plan 不执行任何工具, trust 风险 = 0, 保留
 * `--permission-mode plan` 即足够.
 *
 * `strict` consent (core ConsentLevel 5 档之一) 在 wb-bot 入口 (config/bot-env.ts
 * normalizeBotConsentLevel) 已 alias 为 `plan-only` — 因为 strict 语义 = "ask me
 * for everything" 在无 TTY 环境无法兑现. 这里 buildAgentArgs 只看到 4 档,
 * 不需要单独处理 strict. 完整 contract 说明: docs/product-strategy.md
 * "Consent contract in wb-bot (no-TTY invariant)".
 *
 * 测试见 `tests/wb-bot/build-agent-args.test.ts`.
 */
export function buildAgentArgs(
  agentId: string,
  prompt: string,
  cwd: string,
  continuationToken?: string,
  consentLevel?: string,
  model?: string,
  images: readonly string[] = [],
): string[] {
  void cwd;
  if (agentId === 'claude-code') {
    const args = ['--print', '--output-format', 'stream-json', '--verbose', CLAUDE_PARTIAL_MESSAGES_FLAG];
    if (continuationToken) args.push('--resume', continuationToken);
    const claudeModel = process.env['ANTHROPIC_MODEL'];
    if (claudeModel) args.push('--model', claudeModel);
    args.push(
      '--permission-mode',
      consentLevel === 'auto'
        ? 'bypassPermissions'
        : consentLevel === 'relaxed'
          ? 'acceptEdits'
          : consentLevel === 'plan-only'
            ? 'plan'
            : 'default',
    );
    if (consentLevel !== 'plan-only') {
      args.push('--dangerously-skip-permissions');
    }
    // Append optional system prompt from env (e.g. fail-fast guidance for
    // internal-auth tools 这类). 不动 contract (RunRequest/ConsentLevel), pure
    // claude CLI passthrough. 多行 prompt 用 dotenv multi-line 语法或 \\n escape.
    const appendSysPrompt = process.env['WB_CLAUDE_APPEND_SYSTEM_PROMPT'];
    if (appendSysPrompt && appendSysPrompt.trim()) {
      args.push('--append-system-prompt', appendSysPrompt);
    }
    args.push(prompt);
    return args;
  }
  // codex: mirror core CodexAgent.buildProcessSpec (packages/core/src/agent/codex.ts:186-196).
  // 1. argv 形态: `exec [--model M] --json --skip-git-repo-check -`
  //    或 resume: `exec resume --json [--model M] --skip-git-repo-check <token> -`
  // 2. prompt **不在 argv**, 由 caller 通过 stdin pipe 写给 grandchild
  //    (RunSpec.stdinInput → wb-runner stdio[0]='pipe' + child.stdin.end(prompt+'\n')).
  // 3. trailing `-` 是 codex 约定: read prompt from stdin.
  // 之前 `--quiet -p <prompt>` argv 是 latent bug — codex 在该模式不吐 JSON stream,
  // wb-runner 的 events.ndjson 永远拿不到 done event, 卡片冻在 running.
  // 不要在此 build prompt; prompt 由 handleMessageViaWbRunner 走 stdinInput.
  void prompt;
  if (agentId === 'codex') {
    const args = continuationToken
      ? ['exec', 'resume', '--json', '--skip-git-repo-check', continuationToken, '-']
      : ['exec', '--json', '--skip-git-repo-check', '-'];
    if (model) args.splice(continuationToken ? 3 : 2, 0, '--model', model);
    // `--image <FILE>...` 是变长参数, 必须紧跟子命令、后面接 `--json` 之类的 flag 截断,
    // 否则会吞掉末尾的 `-`. 图片路径同时已写进 prompt 正文.
    if (images.length > 0) args.splice(continuationToken ? 2 : 1, 0, ...images.flatMap((path) => ['--image', path]));
    return args;
  }
  // unknown agent: fallback to legacy form so 测试/未来 agents 不会无 args 卡住
  return ['--quiet', '-p', prompt];
}

function injectCodexExecArgs(args: string[], extraArgs: string[]): string[] {
  if (extraArgs.length === 0) return args;
  if (args[0] !== 'exec') return [...extraArgs, ...args];
  return [args[0], ...extraArgs, ...args.slice(1)];
}

export type WbRunnerConfig = {
  dataDir: string;
  wbRunnerMainPath: string;
  botId?: string;
};

export type WsClientStatusSnapshot = {
  lastEventAt: number | null;
  /** SDK getConnectionStatus().state; 缺省时 /health 退回只看最近事件时间. */
  state?: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed';
  lastReconnectAt?: number | null;
  forcedReconnects?: number;
};

export type ControlPlaneConfig = {
  botId: string;
  dataDir: string;
  taskIndex: TaskIndex;
  logFilePath: string;
  wsClientStatus: () => WsClientStatusSnapshot;
};

export type ActiveSessionSnapshot = {
  scopeKey: string;
  agentId: string;
  runId: string | undefined;
  sessionShortId?: string;
  startedAt: number;
  stopState: string;
  terminalState: string;
  replyMessageId: string;
};

async function resolveDefaultAgent(registry: AgentRegistry): Promise<AgentAdapter | null> {
  for (const id of PREFERRED_AGENT_ORDER) {
    const agent = registry.lookup(id);
    if (agent && await agent.isAvailable()) return agent;
  }
  for (const agent of registry.list()) {
    if (await agent.isAvailable()) return agent;
  }
  return null;
}

export type MessageEvent = {
  eventId: string;
  userOpenId: string;
  threadId: string;
  messageId: string;
  text: string;
  chatId?: string;
  rootId?: string;
  /** 飞书 chat_type (p2p / group / topic); 群级命令据此判断. */
  chatType?: string;
  /** 消息里的图片 / 文件 / 音视频 (message-parser.ts 解析), 进 agent 前下载到本地. */
  resources?: InboundResource[];
  /** 引用回复的父消息 id; 进 agent 前取父消息正文作为引用上下文. */
  parentId?: string;
  /** buildAgentInput 之后的本地附件路径 (images 给 codex `--image`, 二者都已写进 text). */
  images?: string[];
  attachments?: string[];
  /** 组装输入时的告警 (附件下载失败 / 引用读取失败), 展示在运行卡上. */
  notices?: string[];
  /** 合并进本条的其他消息 id (连发合并 / 排队合并), 用于撤 Typing 回执. */
  mergedMessageIds?: string[];
};

export type CardActionEvent = {
  eventId: string;
  userOpenId: string;
  threadId: string;
  messageId: string;
  action: string;
  shortId?: string;
  requestId?: string;
  chatId?: string;
  /** send_artifact 按钮的产物序号. */
  artifactIndex?: number;
};

export type FeishuClient = {
  replyCard(messageId: string, card: Record<string, unknown>): Promise<string>;
  updateCard(messageId: string, card: Record<string, unknown>): Promise<void>;
  replyText(messageId: string, text: string): Promise<string>;
  replyCardInThread?(messageId: string, card: Record<string, unknown>): Promise<void>;
  sendCard?(chatId: string, card: Record<string, unknown>): Promise<void>;
  /** M13-C: owner DM 通道 (`im.v1.message.create` w/ receive_id_type='open_id')。缺省时不存在 */
  sendDm?(openId: string, text: string): Promise<void>;
  /** 下载用户消息里的资源 (`im.v1.messageResource.get`)。缺省时附件只提示不下载 */
  downloadResource?(messageId: string, fileKey: string, type: ResourceDownloadType): Promise<Buffer>;
  /** 拉取单条消息 (`im.v1.message.get`), 用于引用回复与合并转发展开 */
  fetchMessage?(messageId: string): Promise<ApiMessageItem[]>;
  /** 消息表情回执 (`im.v1.messageReaction.*`); 返回 reaction_id 供撤回 */
  addReaction?(messageId: string, emojiType: string): Promise<string | undefined>;
  removeReaction?(messageId: string, reactionId: string): Promise<void>;
  /** 该消息是 CardKit 流式卡时为 true, 运行卡刷新间隔随之缩短 */
  isStreamingCard?(messageId: string): boolean;
  /** 上传本地文件 / 图片并回复到该消息下 (产物回传按钮) */
  sendLocalFile?(replyToMessageId: string, path: string): Promise<void>;
};

type RunCardOrigin = { sourceMessageId: string; userOpenId: string; threadId: string; agentId: string; cwd: string };

const FOLLOW_UP_MEMORY = 200;
/** 无卡片运行 (云文档评论) 没有停止按钮, 超过这个时长自动停. */
const HEADLESS_RUN_TIMEOUT_MS = 15 * 60 * 1000;

function rememberBounded<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > FOLLOW_UP_MEMORY) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

type ActiveSession = {
  scopeKey: string;
  threadId: string;
  homeGroupId: string | null;
  sourceMessageId: string;
  replyMessageId: string;
  run: AgentRun | null;
  runId?: string;
  pipeline: CardPipeline;
  state: StreamState;
  extraMessageIds: string[];
  eventsReader?: EventsFileReader;
  startedAt: number;
  agentId: string;
  sessionId?: string;
};

type FollowUp = {
  event: MessageEvent;
  agent: AgentAdapter;
  cwd: string;
  isAgentOverride: boolean;
  noticeMessageId?: string;
};

type PendingCaptainRun = {
  event: MessageEvent;
  agent: AgentAdapter;
  cwd: string;
  scopeKey: string;
  skipBindingUpdate: boolean;
  runId: string;
};

type CommandReceived = {
  source: 'im' | 'calendar' | 'periodic';
  requestId: string;
  sessionId: string;
  runId: string;
  revision: number;
  text: string;
  userOpenId: string;
  threadId: string;
  messageId: string;
  scheduledAt?: string;
};

type CaptainEndReason = 'succeeded' | 'failed' | 'cancelled' | 'preempted';

const logger = pino({ level: process.env['LOG_LEVEL'] ?? 'info', serializers: errorSerializers });
/** 回复 / 引用的消息已被撤回. */
const MESSAGE_WITHDRAWN = 230011;

function summarizeState(state: StreamState): Record<string, unknown> {
  return {
    agentId: state.agentId,
    cwd: state.cwd ?? '-',
    hasContext: state.hasContext,
    stopState: state.stopState,
    terminalState: state.terminalState,
    model: state.model ?? '-',
    toolCount: state.tools.length,
    textLength: state.text.length,
    errorMessage: state.errorMessage,
  };
}

function renderRestartedCard(mode: 'resumed' | 'lost', runIdShort?: string, agentId?: string, displayName?: string): Record<string, unknown> {
  if (mode === 'resumed') {
    const name = displayName ?? agentId ?? 'Weaverbird';
    const text = `⏳ 服务重启, ${name} 任务 ${runIdShort ?? ''} 仍在运行中, 请稍候`;
    return renderCard({
      ...createInitialState(agentId ?? 'system', name, name),
      text,
      stopState: 'running',
      terminalState: 'running',
    });
  }
  // M13-I: "lost" 卡也带 dismiss, 避免"请重发"死胡同.
  const text = '⚠️ 服务重启了, 这次卡已经断了。\n把你刚才的 prompt 再发一次, 我会当新任务跑。';
  return renderCardWithButtons({
    ...createInitialState('system', 'Weaverbird', 'bot'),
    text,
    stopState: 'running',
    terminalState: 'error',
    errorMessage: '服务重启',
  }, [
    { action: 'watchdog_dismiss', label: '知道了', value: runIdShort ? { runId: runIdShort } : {} },
  ]);
}

// M13-D (2026-08-04): watchdog/restart 卡带"下一步"按钮 — PRD §2.7 礼仪 "@ 必
// 带'下一步动作'"。按钮 callback 由 handleCardAction 处理:
//   - action='watchdog_dismiss': 关卡片
//   - action='watchdog_retry':  重发原 prompt(当前版本 toast 提示重发;未来接
//     session/operator 壳回到 handleMessage).
function renderActionButtons(actions: Array<{ action: string; label: string; primary?: boolean; value?: Record<string, unknown> }>): Record<string, unknown> {
  return {
    tag: 'column_set',
    columns: actions.map((button) => ({
      tag: 'column',
      width: 'weighted',
      weight: 1,
      elements: [{
        tag: 'button',
        text: { tag: 'plain_text', content: button.label },
        type: button.primary ? 'primary_filled' : 'default',
        behaviors: [{ type: 'callback', value: { action: button.action, ...button.value } }],
      }],
    })),
  };
}

function renderCardWithButtons(state: StreamState, actions: Array<{ action: string; label: string; primary?: boolean; value?: Record<string, unknown> }>): Record<string, unknown> {
  const base = renderCard(state);
  const baseBody = (base['body'] as { elements?: Array<Record<string, unknown>> }) ?? { elements: [] };
  baseBody.elements = [...(baseBody.elements ?? []), renderActionButtons(actions)];
  return base;
}

function renderWatchdogRecoveredCard(runIdShort?: string, runId?: string): Record<string, unknown> {
  const text = `⚠️ 任务 ${runIdShort ?? ''} 卡死了, 我帮你把它停了。\n如果想重跑, 直接再发一次 prompt 即可, 不用手动清现场。`;
  return renderCardWithButtons({
    ...createInitialState('system', 'Weaverbird', 'bot'),
    text,
    stopState: 'stopped',
    terminalState: 'error',
    errorMessage: 'watchdog auto-recovered stale run',
  }, [
    { action: 'watchdog_dismiss', label: '知道了', value: runId ? { runId } : {} },
  ]);
}

function renderWatchdogEscalatedCard(runIdShort?: string, runId?: string): Record<string, unknown> {
  const text = `⛔ 任务 ${runIdShort ?? ''} 这个人反复卡死, 我已停了自动重试并通知 bot 拥有者。\n需要的话你点下面重试, 或者等 owner 看一下后台。`;
  return renderCardWithButtons({
    ...createInitialState('system', 'Weaverbird', 'bot'),
    text,
    stopState: 'stopped',
    terminalState: 'error',
    errorMessage: 'watchdog auto-recovery disabled after repeated stale detection',
  }, [
    { action: 'watchdog_retry', label: '重试', primary: true, value: runId ? { runId } : {} },
    { action: 'watchdog_dismiss', label: '先这样', value: runId ? { runId } : {} },
  ]);
}

export class EventHandler {
  private readonly seen = new Map<string, number>();
  private readonly activeSessions = new Map<string, ActiveSession>();
  private readonly activeSessionsByMessageId = new Map<string, ActiveSession>();
  private readonly activeSessionsByShortId = new Map<string, ActiveSession>();
  private readonly reservedSessionShortIds = new Set<string>();
  private readonly pendingCaptainRuns = new Map<string, PendingCaptainRun>();
  private readonly injectedRunIds = new Map<string, string>();
  private readonly pushThresholdMs: number;
  private readonly followFlags = new Set<string>();
  private readonly staleRunSweepMs: number;
  private readonly approvalRequests: ApprovalRequestStore;
  private readonly approvalNotifier: ApprovalNotifier;
  private readonly approvalHookFiles?: ApprovalHookFiles;
  private readonly calendarHookConfig?: CalendarHookConfig;
  private readonly calendarTransport?: CalendarTransport;
  private readonly muteRegistry: MuteRegistry;
  private mediaCache: MediaCache | null = null;
  private readonly ackReactions: AckReactions;
  private readonly followUps = new Map<string, FollowUp[]>();
  /** 已进入 startAgentRun、session 还没注册的 scope; 值是起跑标记, 防止前一轮的收尾误清后一轮. */
  private readonly startingScopes = new Map<string, symbol>();
  private readonly mergedAckIds = new Map<string, string[]>();
  /** 结束卡按钮要用: 最近处理过的原始消息 (重试) 与运行卡 → 发起上下文 (校验发起人 / 定位 scope). */
  private readonly recentInputs = new Map<string, MessageEvent>();
  private readonly runCards = new Map<string, RunCardOrigin>();
  private readonly runArtifacts = new Map<string, string[]>();
  private readonly headlessScopes = new Set<string>();
  private staleRunSweepTimer: ReturnType<typeof setInterval> | null = null;
  private staleRunSweepInFlight = false;
  private draining = false;

  constructor(
    private readonly registry: AgentRegistry,
    private readonly store: BindingStore,
    private readonly feishu: FeishuClient,
    private readonly defaultCwd?: string,
    private readonly claudeConsentLevel?: string,
    private readonly runnerConfig?: WbRunnerConfig,
    private readonly controlPlane?: ControlPlaneConfig,
    private readonly captainService?: CaptainService,
    private readonly captainConcurrency?: CaptainConcurrencyContainer,
    private readonly reverseAtAdminRoleResolver?: ReverseAtAdminRoleResolver,
    private readonly reverseAtOperatorNotifier?: ReverseAtOperatorNotifier,
    calendarHook?: { config: CalendarHookConfig; transport: CalendarTransport },
  ) {
    this.ackReactions = new AckReactions(this.feishu);
    this.pushThresholdMs = parsePushThresholdMs(process.env['WB_PUSH_THRESHOLD_MS']);
    this.staleRunSweepMs = 5_000;
    this.approvalRequests = new ApprovalRequestStore(this.alertDataDir);
    this.muteRegistry = new MuteRegistry(defaultMuteRegistryPath(this.alertDataDir));
    this.calendarHookConfig = calendarHook?.config;
    this.calendarTransport = calendarHook?.transport;
    this.approvalNotifier = createCardApprovalNotifier({
      sendCard: async (chatId, card) => {
        if (!this.feishu.sendCard) return;
        await this.feishu.sendCard(chatId, card);
      },
      cardFor: (request) => renderApprovalRequestCard(request),
      resolveChatId: (request) => request.threadId,
      muteRegistry: this.muteRegistry,
    });
    this.approvalHookFiles = this.runnerConfig ? prepareApprovalHookFiles({
      dataDir: this.alertDataDir,
      hookScriptPath: new URL('../approval-gate/hook-main.ts', import.meta.url).pathname,
    }) : undefined;
    if (this.runnerConfig) {
      this.staleRunSweepTimer = setInterval(() => {
        void this.sweepStaleRuns();
      }, this.staleRunSweepMs);
      this.staleRunSweepTimer.unref?.();
    }
  }

  private get botId(): string {
    return this.runnerConfig?.botId ?? this.controlPlane?.botId ?? 'default';
  }

  /**
   * M12-E (2026-08-04 owner-authorized): echo 首卡回写 home group。
   * sendCard 缺失时本机 EchoDaemon 不应 throw;所以这里 fallback 成 warn,让上层
   * EchoTailer 的 try 有机会记录失败但是不打断 daemon tick。
   */
  async sendHomeGroupCard(chatId: string | null, card: Record<string, unknown>): Promise<void> {
    if (!chatId) return;
    if (this.feishu.sendCard) {
      await this.feishu.sendCard(chatId, card);
      return;
    }
    logger.warn({ chatId, card }, 'sendHomeGroupCard skipped: feishu.sendCard unavailable on this surface');
  }

  getControlPlane(): ControlPlaneConfig | undefined {
    return this.controlPlane;
  }

  /**
   * M11-C C2 (2026-08-04 owner-authorized): calendar overdue escalation 回流
   * 到 home group。发一张简单的"超时"提卡，让群成员知道这个 run 的时间块没关；
   * 卡片同时被 audit mirror 记录,后续调度去重靠 `overdue_escalated_at` 或一次性
   * sweep。
   */
  async notifyCalendarOverdue(payload: { runId: string; sessionId: string; dueAt: string }): Promise<void> {
    // session_id 前缀结构是 `${botId}:${userOpenId}:${threadId}`;拆出 threadId
    // 告诉 home-group 标签;没 home group => 整段静音失败 (不打扰 owner).
    const parts = payload.sessionId.split(':');
    const threadId = parts.length >= 3 ? parts.slice(2).join(':') : payload.sessionId;
    const homeGroupId = this.homeGroupIdFor({ threadId });
    if (!homeGroupId) {
      logger.warn({ payload }, 'calendar overdue notify skipped: no home group');
      return;
    }
    const card = renderCard({
      ...createInitialState('system', 'Weaverbird', 'bot'),
      text: `⏰ run ${payload.runId.slice(0, 12)} 超过 ${payload.dueAt} 仍未结束`,
      stopState: 'running',
      terminalState: 'running',
      errorMessage: undefined,
    });
    try {
      await this.feishu.sendCard?.(homeGroupId, card);
    } catch (error) {
      logger.warn({ payload, error }, 'calendar overdue sendCard failed');
      throw error;
    }
  }

  dispose(): void {
    if (this.staleRunSweepTimer) {
      clearInterval(this.staleRunSweepTimer);
      this.staleRunSweepTimer = null;
    }
  }

  private reserveVisibleSessionShortId(value: string): string {
    const shortId = allocateSessionShortId(value, this.reservedSessionShortIds);
    this.reservedSessionShortIds.add(shortId);
    return shortId;
  }

  activeSessionsSnapshot(): ActiveSessionSnapshot[] {
    const out: ActiveSessionSnapshot[] = [];
    for (const session of this.activeSessions.values()) {
      out.push({
        scopeKey: session.scopeKey,
        agentId: session.agentId,
        runId: session.runId,
        sessionShortId: session.state.sessionShortId,
        startedAt: session.startedAt,
        stopState: session.state.stopState,
        terminalState: session.state.terminalState,
        replyMessageId: session.replyMessageId,
      });
    }
    return out;
  }

  activeSessionSnapshotByShortId(shortId: string): ActiveSessionSnapshot | undefined {
    const session = this.activeSessionsByShortId.get(shortId);
    if (!session) return undefined;
    return {
      scopeKey: session.scopeKey,
      agentId: session.agentId,
      runId: session.runId,
      sessionShortId: session.state.sessionShortId,
      startedAt: session.startedAt,
      stopState: session.state.stopState,
      terminalState: session.state.terminalState,
      replyMessageId: session.replyMessageId,
    };
  }

  private resolveReverseAtCancelTarget: ReverseAtCancelResolver = (identifier) => {
    const session = this.activeSessionsByShortId.get(identifier);
    return resolveReverseAtCancelTargetFromSession(session ? {
      agentId: session.agentId,
      runId: session.runId,
      sessionShortId: session.state.sessionShortId,
    } : undefined);
  };

  private buildCaptainConcurrencyDeps(context: { userOpenId: string; threadId: string }): {
    index: CaptainConcurrencyContainer['index'];
    store: CaptainConcurrencyContainer['store'];
    metrics: CaptainConcurrencyContainer['metrics'];
    now: CaptainConcurrencyContainer['now'];
    sessionId: string;
  } | undefined {
    if (!this.captainConcurrency) return undefined;
    return {
      index: this.captainConcurrency.index,
      store: this.captainConcurrency.store,
      metrics: this.captainConcurrency.metrics,
      now: this.captainConcurrency.now,
      sessionId: this.sessionIdFor(context.userOpenId, context.threadId),
    };
  }

  private listReverseAtCancelableTargets: ReverseAtCancelableListProvider = () => {
    return this.activeSessionsSnapshot()
      .filter((session) => session.sessionShortId)
      .map((session) => `${session.sessionShortId} · ${session.agentId}`)
      .sort();
  };

  private get alertSink(): AlertSink {
    return {
      sendText: async (chatId, text) => {
        await this.feishu.replyCard(chatId, renderCard({
          ...createInitialState('system', '系统通知', 'bot'),
          text,
          terminalState: 'error',
          includeMeta: false,
        }));
      },
      sendDm: async (openId, text) => {
        // M13-C: DM owner 通道. FeishuClient surface 上 sendDm 是可选的;缺时让
        // admin-alert 走 cluster-fallback,避免踩到不支持 DM 的 bot。
        if (this.feishu.sendDm) {
          await this.feishu.sendDm(openId, text);
          return;
        }
        throw new Error('feishu.sendDm unavailable on this surface');
      },
    };
  }

  /** CardKit 元素流式更新便宜且有打字机缓冲, 刷得勤一些; 消息 patch 维持 800ms 以免频控. */
  private cardIntervalMs(replyMessageId: string): number {
    return this.feishu.isStreamingCard?.(replyMessageId) ? 300 : 800;
  }

  private resolveMediaCache(): MediaCache | undefined {
    if (!this.feishu.downloadResource) return undefined;
    if (!this.mediaCache) {
      const download = this.feishu.downloadResource.bind(this.feishu);
      this.mediaCache = new MediaCache({ rootDir: join(this.alertDataDir, 'media'), download });
    }
    return this.mediaCache;
  }

  private get alertDataDir(): string {
    return resolveDataDir({ dataDir: this.runnerConfig?.dataDir ?? this.controlPlane?.dataDir });
  }

  private sessionIdFor(userOpenId: string, threadId: string): string {
    return `${this.botId}:${userOpenId}:${threadId}`;
  }

  private homeGroupIdFor(event: { chatId?: string; threadId: string }): string | null {
    if (event.chatId && event.chatId.trim()) return event.chatId;
    if (!event.threadId) return null;
    if (event.threadId.startsWith('chat:')) return event.threadId.slice('chat:'.length) || null;
    if (event.threadId.startsWith('root:')) return null;
    return event.threadId.trim() || null;
  }

  private reverseAtThreadIdFor(event: { chatId?: string; threadId: string }): string {
    return this.homeGroupIdFor(event) ?? event.threadId;
  }

  private linkThreadTopicAlias(event: MessageEvent): void {
    if (!event.rootId) return;
    const chatKey = toChatTopicKey(event.chatId);
    if (!chatKey || chatKey === event.threadId) return;
    this.store.upsertThreadAlias(this.botId, event.userOpenId, event.threadId, chatKey);
  }

  private async replyCardInThread(messageId: string, card: Record<string, unknown>): Promise<void> {
    if (this.feishu.replyCardInThread) {
      await this.feishu.replyCardInThread(messageId, card);
      return;
    }
    await this.feishu.replyCard(messageId, card).then(() => undefined);
  }

  private async sendCard(chatId: string | null, card: Record<string, unknown>): Promise<void> {
    if (!chatId) return;
    if (this.feishu.sendCard) {
      await this.feishu.sendCard(chatId, card);
      return;
    }
    await this.feishu.replyCard(chatId, card).then(() => undefined);
  }

  async dispatchCommandReceived(command: CommandReceived): Promise<void> {
    if (this.isDuplicate(`${command.source}:${command.requestId}:${command.revision}`)) return;
    this.injectedRunIds.set(command.requestId, command.runId);
    const text = command.text.trimStart();
    const commandResult = await runCommand(text, {
      userOpenId: command.userOpenId,
      threadId: command.threadId,
      registry: this.registry,
      store: this.store,
      botId: this.botId,
      controlPlane: this.controlPlane,
      activeSessions: () => this.activeSessionsSnapshot(),
      stopAllSessions: () => this.stopAllSessions(),
      activeSessionsForThread: (uid: string, tid: string) => this.activeSessionsForThread(uid, tid).map((s) => ({ agentId: s.agentId })),
      setFollowFlag: (tid: string) => this.followFlags.add(tid),
      queueMetricsSnapshot: this.captainConcurrency
        ? () => this.captainConcurrency!.metrics.snapshot({ session_id: `${this.botId}:${command.userOpenId}:${command.threadId}` })
        : undefined,
      muteRegistry: this.muteRegistry,
    });
    if (commandResult !== null) {
      await this.feishu.replyCard(command.messageId, renderCard({
        ...createInitialState('system', 'Weaverbird', 'bot'),
        text: commandResult,
        includeMeta: false,
        terminalState: 'done',
      }));
      return;
    }

    await this.handleMessage({
      eventId: command.requestId,
      userOpenId: command.userOpenId,
      threadId: command.threadId,
      messageId: command.messageId,
      text: command.text,
    });
  }

  async handleMessage(rawEvent: MessageEvent): Promise<void> {
    if (this.isDuplicate(this.messageDedupKey(rawEvent))) return;
    rememberBounded(this.recentInputs, rawEvent.messageId, rawEvent);

    if (this.draining) {
      await this.feishu.replyCard(rawEvent.messageId, renderCard({
        ...createInitialState('system', 'Weaverbird', 'bot'),
        text: '⚠️ bot 正在 shutdown drain，当前不接收新请求，请稍后重试',
        includeMeta: false,
        terminalState: 'done',
      }));
      return;
    }

    // Strip 飞书 mention 占位符 (@_user_<n>, @_all) + empty-prompt guard.
    // 用户只 `@bot` 不附文字时, cleanedText.trim() === '', friendly reply 不 spawn agent.
    // 不 strip 直接把 `@_user_1` 当 prompt 传给 claude --print 会报
    // "Input must be provided either through stdin or as a prompt argument".
    // helper 不 trim 不 collapse, 保 trailing whitespace 给后续 AGENT_PREFIX 解析.
    const cleanedText = stripLarkMentionPlaceholders(rawEvent.text);
    if (!cleanedText.trim()) {
      await this.feishu.replyCard(rawEvent.messageId, renderCard({
        ...createInitialState('system', 'Weaverbird', 'bot'),
        text: '请在 `@bot` 后面写要执行的指令, 例如:\n• `@bot 帮我看一下这段代码`\n• `@bot /help` 看支持的命令',
        includeMeta: false,
        terminalState: 'done',
      }));
      return;
    }
    const event: MessageEvent = { ...rawEvent, text: cleanedText };
    this.linkThreadTopicAlias(event);

    const trimmedText = event.text.trimStart();
    const reverseAtThreadId = this.reverseAtThreadIdFor(event);
    const captainEnabled = isCaptainEnabled({
      mode: process.env['WB_MODE'] === 'multi-bot' ? 'multi-bot' : 'single',
      botId: this.botId,
      disableCaptainEnv: process.env['WB_DISABLE_CAPTAIN'],
    });

    if (captainEnabled && this.captainService) {
      const cancelMatch = trimmedText.match(/^\/cancel\s+([a-zA-Z0-9._-]{1,64})$/);
      if (cancelMatch) {
        await handleReverseAtImCommand({
          command: '/cancel',
          run_id: cancelMatch[1]!,
          requester_open_id: event.userOpenId,
          requested_at: new Date().toISOString(),
          message_id: event.messageId,
        }, {
          messageId: event.messageId,
          threadId: reverseAtThreadId,
          userOpenId: event.userOpenId,
        }, {
          captainService: this.captainService,
          dataDir: this.alertDataDir,
          feishu: this.feishu,
          resolveAdminRole: this.reverseAtAdminRoleResolver,
          resolveCancelTarget: this.resolveReverseAtCancelTarget,
          executeCancel: this.executeReverseAtCancel,
          listCancelableTargets: this.listReverseAtCancelableTargets,
          captainConcurrency: this.buildCaptainConcurrencyDeps(event),
          notifyOperator: this.reverseAtOperatorNotifier,
        });
        return;
      }

      const reverseAt = parseReverseAt(trimmedText, event.userOpenId, event.messageId);
      if (reverseAt) {
        await handleReverseAtImCommand(reverseAt, {
          messageId: event.messageId,
          threadId: reverseAtThreadId,
          userOpenId: event.userOpenId,
        }, {
          captainService: this.captainService,
          dataDir: this.alertDataDir,
          feishu: this.feishu,
          resolveAdminRole: this.reverseAtAdminRoleResolver,
          resolveCancelTarget: this.resolveReverseAtCancelTarget,
          executeCancel: this.executeReverseAtCancel,
          listCancelableTargets: this.listReverseAtCancelableTargets,
          captainConcurrency: this.buildCaptainConcurrencyDeps(event),
          notifyOperator: this.reverseAtOperatorNotifier,
        });
        return;
      }
    }

    // C5.1: typed /stop handling (before agent resolution, operates on thread-level sessions)
    if (trimmedText === '/stop') {
      const matching = this.activeSessionsForThread(event.userOpenId, event.threadId);
      if (matching.length === 0) {
        // fall through to router (returns "当前没有可停止的运行")
      } else if (matching.length === 1) {
        matching[0]!.state = { ...matching[0]!.state, stopState: 'stopping' };
        await this.stopSession(matching[0]!);
        return;
      } else {
        const names = matching.map((s) => s.agentId).join(' / ');
        for (const s of matching) s.state = { ...s.state, stopState: 'stopping' };
        await Promise.allSettled(matching.map((s) => this.stopSession(s)));
        await this.feishu.replyCard(event.messageId, renderCard({
          ...createInitialState('system', 'Weaverbird', 'bot'),
          text: `已停止 ${matching.length} 个任务: ${names}`,
          includeMeta: false,
          terminalState: 'done',
        }));
        return;
      }
    }

    // C5.1: typed /stop <id> (stop specific agent)
    const stopMatch = trimmedText.match(/^\/stop\s+([a-z][a-z0-9_-]{0,31})$/);
    if (stopMatch) {
      const targetAgentId = stopMatch[1]!;
      const targetScopeKey = this.scopeKey(event.userOpenId, event.threadId, targetAgentId);
      const session = this.activeSessions.get(targetScopeKey);
      if (session) {
        session.state = { ...session.state, stopState: 'stopping' };
        await this.stopSession(session);
        return;
      }
      await this.feishu.replyCard(event.messageId, renderCard({
        ...createInitialState('system', 'Weaverbird', 'bot'),
        text: `${targetAgentId} 未在运行`,
        includeMeta: false,
        terminalState: 'done',
      }));
      return;
    }

    const requireMentionMatch = trimmedText.match(/^\/require-mention(?:\s+(on|off))?\s*$/);
    if (requireMentionMatch) {
      await this.replySystemCard(event.messageId, await this.handleRequireMention(event, requireMentionMatch[1] as 'on' | 'off' | undefined));
      return;
    }

    // C5: /agent <id> <prompt> parsing (must be BEFORE command router, AFTER /stop)
    const AGENT_PREFIX = /^\/agent\s+([a-z][a-z0-9_-]{0,31})\s+(.+)$/s;
    const agentMatch = trimmedText.match(AGENT_PREFIX);
    let agentOverride: AgentAdapter | null = null;
    let promptText = event.text;
    if (agentMatch) {
      const requestedAgentId = agentMatch[1]!;
      const promptBody = agentMatch[2]!;
      const candidate = this.registry.lookup(requestedAgentId);
      if (!candidate) {
        const registered = this.registry.list().map((a) => a.id).join(' / ');
        await this.feishu.replyCard(event.messageId, renderCard({
          ...createInitialState('system', 'Weaverbird', 'bot'),
          text: `❌ 未注册 agent: ${requestedAgentId}; 已注册: ${registered}`,
          includeMeta: false,
          terminalState: 'error',
        }));
        return;
      }
      if (!promptBody.trim()) {
        await this.feishu.replyCard(event.messageId, renderCard({
          ...createInitialState('system', 'Weaverbird', 'bot'),
          text: '请在 /agent <id> 后面写要执行的指令',
          includeMeta: false,
          terminalState: 'error',
        }));
        return;
      }
      agentOverride = candidate;
      promptText = promptBody;
    }

    // Route through command router (Batch-W2-E commands: /status, /stop-all, /logs, etc.)
    // Skip router if /agent was matched (it starts with /, but it's weaverbird syntax, not a router command)
    if (!agentOverride) {
      const commandResult = await runCommand(event.text, {
        userOpenId: event.userOpenId,
        threadId: event.threadId,
        registry: this.registry,
        store: this.store,
        botId: this.botId,
        controlPlane: this.controlPlane,
        activeSessions: () => this.activeSessionsSnapshot(),
        stopAllSessions: () => this.stopAllSessions(),
        activeSessionsForThread: (uid: string, tid: string) => this.activeSessionsForThread(uid, tid).map((s) => ({ agentId: s.agentId })),
        setFollowFlag: (tid: string) => this.followFlags.add(tid),
        queueMetricsSnapshot: this.captainConcurrency
          ? () => this.captainConcurrency!.metrics.snapshot({ session_id: `${this.botId}:${event.userOpenId}:${event.threadId}` })
          : undefined,
        muteRegistry: this.muteRegistry,
      });
      if (commandResult !== null) {
        await this.feishu.replyCard(event.messageId, renderCard({
          ...createInitialState('system', 'Weaverbird', 'bot'),
          text: commandResult,
          includeMeta: false,
          terminalState: 'done',
        }));
        return;
      }
    }

    // Resolve agent (override from /agent or binding/default)
    let agent: AgentAdapter | null;
    if (agentOverride) {
      agent = agentOverride;
    } else {
      const binding = this.store.getThreadBinding(this.botId, event.userOpenId, event.threadId);
      agent = binding?.agentId
        ? (this.registry.lookup(binding.agentId) ?? await resolveDefaultAgent(this.registry))
        : await resolveDefaultAgent(this.registry);
    }
    if (!agent) {
      logger.warn({ messageId: event.messageId, agents: this.registry.list().map((a) => a.id) }, 'no available agent');
      await this.replySystemCard(event.messageId, '❌ 没有可用的 agent: 检测不到 claude / codex 命令。检查 `WB_CLAUDE_COMMAND` / `WB_CODEX_COMMAND` 指向的命令是否在 PATH 上。');
      return;
    }

    // Now that agent is resolved, compute scopeKey (C1: contains agentId)
    const scopeKey = this.scopeKey(event.userOpenId, event.threadId, agent.id);

    // Resolve cwd
    const binding = this.store.getThreadBinding(this.botId, event.userOpenId, event.threadId);
    let cwd: string;
    if (binding?.cwd) {
      cwd = binding.cwd;
    } else if (this.defaultCwd) {
      cwd = this.defaultCwd;
    } else {
      const fallback = process.cwd();
      const cwdResult = validateCwd(fallback);
      if (!cwdResult.ok) {
        await this.feishu.replyCard(event.messageId, renderCard({
          ...createInitialState('system', 'Weaverbird', 'bot'),
          text: '⚠️ bot 当前工作目录不在允许范围, 请先 `/cwd <dir>` 设置',
          includeMeta: false,
          terminalState: 'error',
          errorMessage: cwdResult.reason,
        }));
        return;
      }
      cwd = cwdResult.path;
    }

    let inputExtras: Pick<MessageEvent, 'images' | 'attachments' | 'notices'> = {};
    if ((event.resources && event.resources.length > 0) || event.parentId) {
      const input = await buildAgentInput({
        messageId: event.messageId,
        text: promptText,
        resources: event.resources,
        parentId: event.parentId,
      }, {
        botOpenId: '',
        fetchMessage: this.feishu.fetchMessage?.bind(this.feishu),
        media: this.resolveMediaCache(),
      });
      promptText = input.text;
      inputExtras = { images: input.images, attachments: input.attachments, notices: input.notices };
      if (input.notices.length > 0) logger.warn({ messageId: event.messageId, notices: input.notices }, 'agent input assembled with notices');
    }

    if (captainEnabled && this.captainService) {
      const sessionId = this.sessionIdFor(event.userOpenId, event.threadId);
      const homeGroupId = this.homeGroupIdFor(event);
      const existingSession = this.captainService.getSession(sessionId);
      const normalizedAgent: 'claude-code' | 'codex' | 'other' = agent.id === 'claude-code' || agent.id === 'codex' ? agent.id : 'other';
      const record = {
        session_id: sessionId,
        captain_id: this.botId,
        created_at: new Date().toISOString(),
        last_active_at: new Date().toISOString(),
        cwd,
        scope: 'dev' as const,
        project: 'weaverbird' as const,
        home_group_id: homeGroupId,
        agent: normalizedAgent,
        latest_run_id: null,
        operator: event.userOpenId,
        entry_form: 'im' as const,
      };
      if (existingSession) {
        this.captainService.updateSession(sessionId, {
          cwd,
          last_active_at: new Date().toISOString(),
          agent: record.agent,
          operator: event.userOpenId,
          home_group_id: homeGroupId,
          entry_form: 'im',
        });
      } else {
        this.captainService.createSession(record);
      }
    }

    const captainSessionId = this.sessionIdFor(event.userOpenId, event.threadId);
    let forcedRunId: string | undefined = this.injectedRunIds.get(rawEvent.eventId);
    if (captainEnabled && this.captainConcurrency) {
      const decision = await enqueueOrSpawn({
        config: this.captainConcurrency.config,
        index: this.captainConcurrency.index,
        store: this.captainConcurrency.store,
        metrics: this.captainConcurrency.metrics,
        now: this.captainConcurrency.now ?? (() => new Date().toISOString()),
        genRunId: this.captainConcurrency.genRunId ?? generateRunId,
      }, {
        session_id: captainSessionId,
      });

      if (decision.kind === 'queued') {
        this.pendingCaptainRuns.set(decision.run_id, {
          event: { ...event, ...inputExtras, text: promptText },
          agent,
          cwd,
          scopeKey,
          skipBindingUpdate: agentOverride !== null,
          runId: decision.run_id,
        });
        this.ackReactions.add(event.messageId);
        await this.feishu.replyText(event.messageId, `queued at position ${decision.position}`);
        return;
      }
      if (decision.kind === 'rejected') {
        await this.feishu.replyText(event.messageId, 'queue full');
        return;
      }
      forcedRunId = decision.run_id;
    } else {
      // C3: busy check per (user, thread, agent). 进行中就排队, 本轮结束后合并成下一轮.
      // 起跑中 (卡片还在创建、session 还没注册) 和等待接续排队消息的 scope 同样算忙, 否则会并发起两轮.
      if (this.activeSessions.has(scopeKey) || this.startingScopes.has(scopeKey) || this.followUps.has(scopeKey)) {
        await this.enqueueFollowUp(scopeKey, {
          event: { ...event, ...inputExtras, text: promptText },
          agent,
          cwd,
          isAgentOverride: agentOverride !== null,
        });
        return;
      }
    }

    // Use promptText (may be overridden by /agent) via modified event
    const effectiveEvent: MessageEvent = { ...event, ...inputExtras, text: promptText };
    await this.startAgentRun(effectiveEvent, agent, cwd, scopeKey, agentOverride !== null, forcedRunId);
  }

  private async startAgentRun(
    effectiveEvent: MessageEvent,
    agent: AgentAdapter,
    cwd: string,
    scopeKey: string,
    isAgentOverride: boolean,
    forcedRunId?: string,
  ): Promise<void> {
    const startToken = Symbol(scopeKey);
    this.startingScopes.set(scopeKey, startToken);
    try {
      this.ackReactions.add(effectiveEvent.messageId);
      if (effectiveEvent.mergedMessageIds && effectiveEvent.mergedMessageIds.length > 0) {
        this.mergedAckIds.set(effectiveEvent.messageId, effectiveEvent.mergedMessageIds);
      }
      const replyMessageId = await this.feishu.replyCard(effectiveEvent.messageId, renderCard(createInitialState(agent.id, agent.displayName, agent.displayName)));
      rememberBounded(this.runCards, replyMessageId, {
        sourceMessageId: effectiveEvent.messageId,
        userOpenId: effectiveEvent.userOpenId,
        threadId: effectiveEvent.threadId,
        agentId: agent.id,
        cwd,
      });

      if (this.runnerConfig) {
        await this.handleMessageViaWbRunner(effectiveEvent, agent, cwd, replyMessageId, scopeKey, isAgentOverride, forcedRunId);
      } else {
        await this.handleMessageViaPipe(effectiveEvent, agent, cwd, replyMessageId, scopeKey, isAgentOverride, forcedRunId);
      }
    } catch (error) {
      // 起跑就失败 (没注册 session, 不会走 cleanupSession): 起跑窗口里排进来的消息要接着处理, 不能一直挂着.
      if (!this.activeSessions.has(scopeKey) && this.followUps.has(scopeKey)) {
        setImmediate(() => {
          this.drainFollowUps(scopeKey).catch((drainError: unknown) => logger.error({ scopeKey, error: drainError }, 'follow-up drain failed'));
        });
      }
      throw error;
    } finally {
      // 排队消息的下一轮可能已经在本调用返回前起跑, 只清自己设的标记.
      if (this.startingScopes.get(scopeKey) === startToken) this.startingScopes.delete(scopeKey);
    }
  }

  /** 注册运行中的 session, 并接上起跑窗口里已经排进来的消息 (排队数 + 排队提示卡). */
  private registerSession(scopeKey: string, session: ActiveSession): void {
    this.activeSessions.set(scopeKey, session);
    const queue = this.followUps.get(scopeKey);
    if (!queue || queue.length === 0) return;
    session.state = { ...session.state, queuedCount: queue.length };
    for (const item of queue) {
      if (!item.noticeMessageId) continue;
      session.extraMessageIds.push(item.noticeMessageId);
      this.activeSessionsByMessageId.set(item.noticeMessageId, session);
    }
  }

  private async enqueueFollowUp(scopeKey: string, item: FollowUp): Promise<void> {
    const queue = this.followUps.get(scopeKey) ?? [];
    queue.push(item);
    this.followUps.set(scopeKey, queue);
    this.ackReactions.add(item.event.messageId);
    // 起跑中还没有 session: 运行卡上的排队数在 session 注册时补上.
    const activeSession = this.activeSessions.get(scopeKey);
    if (activeSession) {
      activeSession.state = { ...activeSession.state, queuedCount: queue.length };
      void activeSession.pipeline.flush(renderCard(activeSession.state));
    }
    const noticeId = await this.feishu.replyCard(item.event.messageId, renderCard({
      ...createInitialState('system', 'Weaverbird', 'bot'),
      text: `⏳ ${item.agent.id} 正在处理上一条, 这条已排队 (第 ${queue.length} 条), 结束后自动接着处理`,
      includeMeta: false,
      stopState: 'running',
      terminalState: 'running',
    }));
    item.noticeMessageId = noticeId;
    const current = this.activeSessions.get(scopeKey);
    if (current) {
      current.extraMessageIds.push(noticeId);
      this.activeSessionsByMessageId.set(noticeId, current);
    }
  }

  /**
   * 用户撤回消息. 只处理还没开始跑的排队消息: 从队列移除并改写它的排队提示卡;
   * 已经在跑的 run 不动 (撤回不等于叫停, 要停请点停止).
   */
  async handleMessageRecalled(messageId: string): Promise<boolean> {
    for (const [scopeKey, queue] of this.followUps) {
      const index = queue.findIndex((item) => item.event.messageId === messageId);
      if (index === -1) continue;
      const [item] = queue.splice(index, 1);
      if (queue.length === 0) this.followUps.delete(scopeKey);
      void this.ackReactions.clear(messageId);
      const active = this.activeSessions.get(scopeKey);
      if (active) {
        active.state = { ...active.state, queuedCount: queue.length };
        void active.pipeline.flush(renderCard(active.state));
      }
      if (item?.noticeMessageId) {
        await this.feishu.updateCard(item.noticeMessageId, renderCard({
          ...createInitialState('system', 'Weaverbird', 'bot'),
          text: '↩️ 消息已撤回, 不再处理',
          includeMeta: false,
          terminalState: 'done',
        }));
      }
      logger.info({ scopeKey, messageId }, 'dropped recalled follow-up');
      return true;
    }
    return false;
  }

  /** 停止 = 这个 scope 不再处理: 排队消息一起丢弃, 不在停止后自动起新 run. */
  private dropFollowUps(scopeKey: string): void {
    const queue = this.followUps.get(scopeKey);
    if (!queue) return;
    this.followUps.delete(scopeKey);
    for (const item of queue) {
      void this.ackReactions.clear(item.event.messageId);
      if (!item.noticeMessageId) continue;
      void this.feishu.updateCard(item.noticeMessageId, renderCard({
        ...createInitialState('system', 'Weaverbird', 'bot'),
        text: '⏹ 已随上一条一起停止, 需要的话重新发送',
        includeMeta: false,
        terminalState: 'done',
      })).catch((error: unknown) => logger.warn({ noticeId: item.noticeMessageId, error }, 'follow-up notice update failed'));
    }
  }

  /** 本轮结束后把排队的消息合并成下一轮. 关停 drain 中则丢弃并撤回执. */
  private async drainFollowUps(scopeKey: string): Promise<void> {
    const queue = this.followUps.get(scopeKey);
    if (!queue || queue.length === 0) return;
    if (this.activeSessions.has(scopeKey)) return;
    this.followUps.delete(scopeKey);
    const notices = queue.map((item) => item.noticeMessageId).filter((id): id is string => Boolean(id));
    if (this.draining) {
      for (const item of queue) void this.ackReactions.clear(item.event.messageId);
      return;
    }
    for (const noticeId of notices) {
      void this.feishu.updateCard(noticeId, renderCard({
        ...createInitialState('system', 'Weaverbird', 'bot'),
        text: queue.length > 1 ? `▶️ 已合并 ${queue.length} 条排队消息开始处理` : '▶️ 已开始处理这条',
        includeMeta: false,
        terminalState: 'done',
      })).catch((error: unknown) => logger.warn({ noticeId, error }, 'follow-up notice update failed'));
    }
    // 运行卡回复在最后一条上. 它已被撤回 (没订阅撤回事件, 或事件晚到) 时回复会报 230011:
    // 去掉这条, 用剩下的重来.
    let items = queue;
    while (items.length > 0) {
      const last = items[items.length - 1]!;
      try {
        await this.startAgentRun(mergeMessageEvents(items.map((item) => item.event)), last.agent, last.cwd, scopeKey, last.isAgentOverride);
        return;
      } catch (error) {
        if (feishuErrorCode(error) !== MESSAGE_WITHDRAWN) throw error;
        logger.info({ scopeKey, messageId: last.event.messageId }, 'queued message was withdrawn before its turn, skipping');
        void this.ackReactions.clear(last.event.messageId);
        if (last.noticeMessageId) {
          void this.feishu.updateCard(last.noticeMessageId, renderCard({
            ...createInitialState('system', 'Weaverbird', 'bot'),
            text: '↩️ 消息已撤回, 不再处理',
            includeMeta: false,
            terminalState: 'done',
          })).catch((noticeError: unknown) => logger.warn({ noticeId: last.noticeMessageId, error: noticeError }, 'follow-up notice update failed'));
        }
        items = items.slice(0, -1);
      }
    }
  }

  private async handleMessageViaWbRunner(
    event: MessageEvent,
    agent: AgentAdapter,
    cwd: string,
    replyMessageId: string,
    scopeKey: string,
    skipBindingUpdate = false,
    forcedRunId?: string,
  ): Promise<void> {
    const captainEnabled = isCaptainEnabled({
      mode: process.env['WB_MODE'] === 'multi-bot' ? 'multi-bot' : 'single',
      botId: this.botId,
      disableCaptainEnv: process.env['WB_DISABLE_CAPTAIN'],
    });
    const config = this.runnerConfig!;
    const runId = forcedRunId ?? generateRunId();
    const sessionId = this.sessionIdFor(event.userOpenId, event.threadId);
    const homeGroupId = this.homeGroupIdFor(event);
    const botId = config.botId ?? 'default';
    const continuationToken = this.store.getContinuation(this.botId, event.userOpenId, event.threadId, agent.id) ?? undefined;
    const consentLevel = (this.claudeConsentLevel && agent.id === 'claude-code') ? this.claudeConsentLevel : undefined;

    // D1: codex 路径 env passthrough 复用 core CodexAgent 的 CODEX_PASSTHROUGH_KEYS,
    // 不在此重复 keys 列表 (单一 source of truth). claude-code 路径维持原 ANTHROPIC_* 透传.
    const passthroughKeys: readonly string[] = agent.id === 'claude-code'
      ? ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL']
      : agent.id === 'codex'
        ? CODEX_PASSTHROUGH_KEYS
        : [];
    let agentEnv = buildFilteredEnv('agent-cli', process.env, passthroughKeys);

    const claudeRaw = (process.env['WB_CLAUDE_COMMAND'] ?? '').trim();
    const codexRaw = (process.env['WB_CODEX_COMMAND'] ?? '').trim();
    const [claudeHead, ...claudePrepend] = claudeRaw ? claudeRaw.split(/\s+/) : ['claude'];
    const [codexHead, ...codexPrepend] = codexRaw ? codexRaw.split(/\s+/) : ['codex'];

    const agentCommand = agent.id === 'claude-code' ? claudeHead! : codexHead!;
    const prependArgs = agent.id === 'claude-code' ? claudePrepend : codexPrepend;

    // Single source of truth for model: 如果 WB_CLAUDE_COMMAND 写了 `--model X`,
    // 自动 propagate 到 child env 作 ANTHROPIC_MODEL (claude --print stream-json
    // mode 不 honor CLI --model flag, 必须 env var; wrapper 在
    // has_model_flag=1 path 下不 export 该 env, 所以 wb-bot 必须补).
    // 父进程已显式 set ANTHROPIC_MODEL 时优先尊重父进程.
    if (agent.id === 'claude-code' && !agentEnv['ANTHROPIC_MODEL']) {
      const modelFromCommand = extractModelFromArgs(claudePrepend);
      if (modelFromCommand) {
        agentEnv['ANTHROPIC_MODEL'] = modelFromCommand;
      }
    }

    // D1: 对称 claude 的 model 抽取. WB_CODEX_COMMAND="codex --model X" 时
    // `--model X` 必须以 `exec --model X` 形式 splice 进 codex argv (core CodexAgent
    // 同位置), 不能放到 codex 子命令前. 这里把它从 prepend 抽出, 由 buildAgentArgs splice 进位.
    const codexModel = agent.id === 'codex' ? extractModelFromArgs(codexPrepend) : undefined;
    const codexPrependWithoutModel = agent.id === 'codex' && codexModel
      ? stripModelArgs(codexPrepend)
      : codexPrepend;
    const effectivePrepend = agent.id === 'codex' ? codexPrependWithoutModel : prependArgs;

    const builtArgs = this.buildAgentArgs(agent.id, event.text, cwd, continuationToken, consentLevel, codexModel, event.images);
    const codexApprovalArgs = agent.id === 'codex' && this.approvalHookFiles
      ? this.approvalHookFiles.codexRuntimeArgs
      : [];
    const agentArgs = agent.id === 'codex'
      ? [...effectivePrepend, ...injectCodexExecArgs(builtArgs, codexApprovalArgs)]
      : [...effectivePrepend, ...builtArgs];

    // D1: codex 走 stdin (codex `exec --json ... -` 约定从 stdin 读 prompt).
    // claude-code 维持原 argv 末尾 prompt + stdio[0]='ignore' 不变.
    const stdinInput = agent.id === 'codex' ? `${event.text}\n` : undefined;

    if (agent.id === 'claude-code' && this.approvalHookFiles) {
      agentEnv['CLAUDE_CONFIG_DIR'] = dirname(this.approvalHookFiles.claudeSettingsPath);
      agentArgs.unshift('--settings', this.approvalHookFiles.claudeSettingsPath);
      agentArgs.unshift('--bare');
    }
    if (agent.id === 'codex' && this.approvalHookFiles) {
      agentEnv['CODEX_HOME'] = this.approvalHookFiles.codexHome;
    }

    agentEnv = buildApprovalHookEnv(agentEnv, {
      dataDir: config.dataDir,
      runId,
      botId,
      sessionId,
      userOpenId: event.userOpenId,
      threadId: event.threadId,
      sourceMessageId: event.messageId,
      replyMessageId,
      agentId: agent.id,
      codeOwnerConfigPath: process.env['WB_APPROVAL_CODE_OWNER_CONFIG_PATH'],
    });

    const spec = buildRunSpec({
      runId,
      botId,
      agentId: agent.id,
      agentCommand,
      agentArgs,
      cwd,
      env: agentEnv,
      userOpenId: event.userOpenId,
      threadId: event.threadId,
      sourceMessageId: event.messageId,
      replyMessageId,
      continuationToken,
      consentLevel,
      ...(stdinInput !== undefined ? { stdinInput } : {}),
    });

    let runDir: string;
    try {
      ({ runDir } = spawnWbRunner({
        dataDir: config.dataDir,
        spec,
        wbRunnerMainPath: config.wbRunnerMainPath,
      }));
      if (captainEnabled && this.captainService) {
        this.captainService.bindRun(sessionId, runId);
      }
      if (captainEnabled && this.captainConcurrency) {
        this.captainConcurrency.index.markRunning(sessionId, runId, new Date().toISOString());
      }
      if (this.calendarHookConfig?.enabled && this.calendarTransport) {
        void openCalendarBlock({
          dataDir: config.dataDir,
          botId,
          runId,
          sessionId,
          revision: 0,
          title: `Weaverbird Run ${runId}`,
          startsAt: new Date().toISOString(),
          endsAt: new Date(Date.now() + this.calendarHookConfig.overdue_after_ms).toISOString(),
          config: this.calendarHookConfig,
          transport: this.calendarTransport,
        });
      }
    } catch (err) {
      void sendAdminAlert(this.alertSink, this.alertDataDir, `wb-runner spawn failed for ${agent.id}: ${err}`, 'fatal');
      throw err;
    }

    const pipeline = new CardPipeline((card) => this.feishu.updateCard(replyMessageId, card), {
      logger,
      label: `reply:${replyMessageId}`,
      minIntervalMs: this.cardIntervalMs(replyMessageId),
    });
    const progressStore = new ProgressStore({
      dataDir: config.dataDir,
      botId,
      runId,
      sessionId,
      originMessageId: event.messageId,
      cardMessageId: replyMessageId,
      homeGroupId,
    });
    const progressCollector = new ProgressCollector(progressStore);
    // 运行卡只有一个写者: 下面按 AgentEvent 渲染的 renderCard(state).
    // run-observability 仍负责 progress.ndjson / store / 告警 / doc-sink, 但不再往同一张卡上
    // 刷 "Run Progress" 进度卡, 也不在结束时用 "Run Finalized" 原始输出覆盖答案并重复回一张卡.
    const silentCards = { updateCard: async () => {}, replyCard: async () => {}, sendCard: async () => {} };
    const observability = wireRunObservability(runDir, {
      collector: progressCollector,
      store: progressStore,
      finalizerClient: silentCards,
      dataDir: config.dataDir,
      alertContext: {
        session: {
          session_id: sessionId,
          home_group_id: homeGroupId,
          operator: event.userOpenId,
          agent: 'claude-code',
        },
        dataDir: config.dataDir,
        client: {
          sendMessage: (chatId, card) => this.sendCard(chatId, card),
        },
        alertEnabled: true,
        alreadyAlerted: false,
      },
    });
    const shortId = this.reserveVisibleSessionShortId(runId);
    let state: StreamState = {
      ...createInitialState(agent.id, agent.displayName, agent.displayName),
      sessionShortId: shortId,
      adminCancelEnabled: captainEnabled,
      ...(event.notices && event.notices.length > 0 ? { notices: event.notices } : {}),
    };
    const eventsReader = new EventsFileReader(join(runDir, 'events.ndjson'), 0, runnerEventMapper(agent.id, { cwd, model: codexModel }));
    const activeSession: ActiveSession = {
      scopeKey,
      threadId: event.threadId,
      homeGroupId,
      sourceMessageId: event.messageId,
      replyMessageId,
      run: null,
      runId,
      pipeline,
      state,
      extraMessageIds: [],
      eventsReader,
      startedAt: Date.now(),
      agentId: agent.id,
      sessionId,
    };
    this.registerSession(scopeKey, activeSession);
    this.activeSessionsByMessageId.set(event.messageId, activeSession);
    this.activeSessionsByMessageId.set(replyMessageId, activeSession);
    this.activeSessionsByShortId.set(shortId, activeSession);
    this.store.upsertInflightCard(this.botId, {
      userOpenId: event.userOpenId,
      threadId: event.threadId,
      sourceMessageId: event.messageId,
      replyMessageId,
      runId,
      agentId: agent.id,
    });
    logger.info({ scopeKey, runId, agentId: agent.id, replyMessageId }, 'spawned wb-runner session');

    eventsReader.start();
    try {
      const outputLogPath = join(runDir, 'output.log');
      const outputErrPath = join(runDir, 'output.err');
      let stdoutOffset = 0;
      let stderrOffset = 0;
      let lastLogReadAt = 0;
      for await (const output of eventsReader.events()) {
        // 流式下每个 delta 都是一个事件, 每次整读 output.log 会退化成 O(n²); 节流到 1s, 终态必读.
        const isTerminal = output.type === 'done' || output.type === 'error';
        if (isTerminal || Date.now() - lastLogReadAt >= 1000) {
          lastLogReadAt = Date.now();
          try {
            const stdoutRaw = readFileSync(outputLogPath, 'utf8');
            const stderrRaw = readFileSync(outputErrPath, 'utf8');
            const nextStdout = stdoutRaw.slice(stdoutOffset);
            const nextStderr = stderrRaw.slice(stderrOffset);
            if (nextStdout) observability.onStdout(nextStdout);
            if (nextStderr) observability.onStderr(nextStderr);
            stdoutOffset = stdoutRaw.length;
            stderrOffset = stderrRaw.length;
          } catch {
            // logs may not exist yet
          }
        }
        state = reduceStreamState(activeSession.state, output);
        activeSession.state = state;
        if ((output.type === 'done' || output.type === 'system') && (output as any).continuationToken) {
          this.store.upsertContinuation(this.botId, event.userOpenId, event.threadId, agent.id, (output as any).continuationToken);
        }
        await (output.type === 'tool_use' || output.type === 'tool_result' || output.type === 'done' || output.type === 'error'
          ? pipeline.force(renderCard(state))
          : pipeline.flush(renderCard(state)));
        if (output.type === 'done') {
          await observability.onExit({
            status: 'succeeded',
            cancelled: false,
            elapsedS: Math.max(0, Math.floor((Date.now() - activeSession.startedAt) / 1000)),
          });
          if (captainEnabled && this.captainService) {
            this.captainService.closeSession(sessionId);
          }
          if (this.calendarHookConfig?.enabled && this.calendarTransport) {
            void closeCalendarBlock({
              dataDir: config.dataDir,
              botId,
              runId,
              revision: 1,
              config: this.calendarHookConfig,
              transport: this.calendarTransport,
            });
          }
          await this.onCaptainRunEnded(event.userOpenId, event.threadId, runId, 'succeeded');
          await this.handleCompletionPush(activeSession, agent, event.userOpenId, event.threadId);
          break;
        }
        if (output.type === 'error') {
          const reason = activeSession.state.stopState === 'stopping' ? 'cancelled' : 'failed';
          await observability.onExit({
            status: reason,
            cancelled: activeSession.state.stopState === 'stopping',
            elapsedS: Math.max(0, Math.floor((Date.now() - activeSession.startedAt) / 1000)),
            exitMeta: /^child exited with code (?<exitCode>-?\d+)$/.test(output.message)
              ? { exit_code: Number(/^child exited with code (?<exitCode>-?\d+)$/.exec(output.message)?.groups?.['exitCode'] ?? null), signal: null }
              : undefined,
          });
          if (captainEnabled && this.captainService) {
            this.captainService.closeSession(sessionId);
          }
          if (this.calendarHookConfig?.enabled && this.calendarTransport) {
            void closeCalendarBlock({
              dataDir: config.dataDir,
              botId,
              runId,
              revision: 1,
              config: this.calendarHookConfig,
              transport: this.calendarTransport,
            });
          }
          await this.onCaptainRunEnded(event.userOpenId, event.threadId, runId, reason);
          break;
        }
      }
      if (!skipBindingUpdate) {
        this.store.upsertThreadBinding(this.botId, {
          userOpenId: event.userOpenId,
          threadId: event.threadId,
          agentId: agent.id,
          cwd,
        });
      }
    } finally {
      eventsReader.stop();
      this.cleanupSession(activeSession, event.userOpenId, event.threadId);
    }
  }

  private async handleMessageViaPipe(
    event: MessageEvent,
    agent: AgentAdapter,
    cwd: string,
    replyMessageId: string,
    scopeKey: string,
    skipBindingUpdate = false,
    forcedRunId?: string,
  ): Promise<void> {
    const captainEnabled = isCaptainEnabled({
      mode: process.env['WB_MODE'] === 'multi-bot' ? 'multi-bot' : 'single',
      botId: this.botId,
      disableCaptainEnv: process.env['WB_DISABLE_CAPTAIN'],
    });
    const runId = forcedRunId ?? generateRunId();
    const sessionId = this.sessionIdFor(event.userOpenId, event.threadId);
    const homeGroupId = this.homeGroupIdFor(event);
    const run = agent.run({
      prompt: event.text,
      cwd,
      ...(event.images && event.images.length > 0 ? { images: event.images } : {}),
      ...(event.attachments && event.attachments.length > 0 ? { attachments: event.attachments } : {}),
      continuationToken: this.store.getContinuation(this.botId, event.userOpenId, event.threadId, agent.id) ?? undefined,
      ...(this.claudeConsentLevel && agent.id === 'claude-code' ? { consentLevel: this.claudeConsentLevel as ConsentLevel } : {}),
    });
    const pipeline = new CardPipeline((card) => this.feishu.updateCard(replyMessageId, card), {
      logger,
      label: `reply:${replyMessageId}`,
      minIntervalMs: this.cardIntervalMs(replyMessageId),
    });
    const shortId = this.reserveVisibleSessionShortId(forcedRunId ?? event.messageId);
    let state: StreamState = {
      ...createInitialState(agent.id, agent.displayName, agent.displayName),
      sessionShortId: shortId,
      adminCancelEnabled: captainEnabled,
      ...(event.notices && event.notices.length > 0 ? { notices: event.notices } : {}),
    };
    const activeSession: ActiveSession = {
      scopeKey,
      threadId: event.threadId,
      homeGroupId,
      sourceMessageId: event.messageId,
      replyMessageId,
      run,
      runId,
      pipeline,
      state,
      extraMessageIds: [],
      startedAt: Date.now(),
      agentId: agent.id,
      sessionId: captainEnabled ? sessionId : undefined,
    };
    this.registerSession(scopeKey, activeSession);
    this.activeSessionsByMessageId.set(event.messageId, activeSession);
    this.activeSessionsByMessageId.set(replyMessageId, activeSession);
    if (shortId) this.activeSessionsByShortId.set(shortId, activeSession);
    this.store.upsertInflightCard(this.botId, {
      userOpenId: event.userOpenId,
      threadId: event.threadId,
      sourceMessageId: event.messageId,
      replyMessageId,
      runId,
      agentId: agent.id,
    });
    if (this.calendarHookConfig?.enabled && this.calendarTransport) {
      void openCalendarBlock({
        dataDir: this.alertDataDir,
        botId: this.botId,
        runId,
        sessionId,
        revision: 0,
        title: `Weaverbird Run ${runId}`,
        startsAt: new Date().toISOString(),
        endsAt: new Date(Date.now() + this.calendarHookConfig.overdue_after_ms).toISOString(),
        config: this.calendarHookConfig,
        transport: this.calendarTransport,
      });
    }
    logger.info({
      scopeKey,
      sourceMessageId: event.messageId,
      replyMessageId,
      activeSessionKeys: Array.from(this.activeSessionsByMessageId.keys()),
      state: summarizeState(state),
    }, 'registered active session');
    try {
      for await (const output of run.events) {
        state = reduceStreamState(activeSession.state, output);
        activeSession.state = state;
        logger.info({
          scopeKey,
          outputType: output.type,
          sourceMessageId: activeSession.sourceMessageId,
          replyMessageId: activeSession.replyMessageId,
          state: summarizeState(state),
        }, 'updated active session state');
        if ((output.type === 'done' || output.type === 'system') && (output as any).continuationToken) {
          this.store.upsertContinuation(this.botId, event.userOpenId, event.threadId, agent.id, (output as any).continuationToken);
        }
        await (output.type === 'tool_use' || output.type === 'tool_result' || output.type === 'done' || output.type === 'error'
          ? pipeline.force(renderCard(state))
          : pipeline.flush(renderCard(state)));
        if (output.type === 'done') {
          if (captainEnabled && this.captainService) {
            this.captainService.closeSession(sessionId);
          }
          if (this.calendarHookConfig?.enabled && this.calendarTransport) {
            void closeCalendarBlock({
              dataDir: this.alertDataDir,
              botId: this.botId,
              runId,
              revision: 1,
              config: this.calendarHookConfig,
              transport: this.calendarTransport,
            });
          }
          await this.onCaptainRunEnded(event.userOpenId, event.threadId, runId, 'succeeded');
          await this.handleCompletionPush(activeSession, agent, event.userOpenId, event.threadId);
          break;
        }
        if (output.type === 'error') {
          if (captainEnabled && this.captainService) {
            this.captainService.closeSession(sessionId);
          }
          if (this.calendarHookConfig?.enabled && this.calendarTransport) {
            void closeCalendarBlock({
              dataDir: this.alertDataDir,
              botId: this.botId,
              runId,
              revision: 1,
              config: this.calendarHookConfig,
              transport: this.calendarTransport,
            });
          }
          await this.onCaptainRunEnded(event.userOpenId, event.threadId, runId, activeSession.state.stopState === 'stopping' ? 'cancelled' : 'failed');
          break;
        }
      }
      if (!skipBindingUpdate) {
        this.store.upsertThreadBinding(this.botId, {
          userOpenId: event.userOpenId,
          threadId: event.threadId,
          agentId: agent.id,
          cwd: cwd,
        });
      }
    } finally {
      logger.info({
        scopeKey,
        sourceMessageId: activeSession.sourceMessageId,
        replyMessageId: activeSession.replyMessageId,
        state: summarizeState(activeSession.state),
      }, 'cleaning up active session');
      this.cleanupSession(activeSession, event.userOpenId, event.threadId);
    }
  }

  private buildAgentArgs(agentId: string, prompt: string, cwd: string, continuationToken?: string, consentLevel?: string, model?: string, images?: readonly string[]): string[] {
    return buildAgentArgs(agentId, prompt, cwd, continuationToken, consentLevel, model, images);
  }

  private reconcileLostCaptainRun(userOpenId: string, threadId: string, runId: string): void {
    if (!this.captainConcurrency) return;
    const sessionId = `${this.botId}:${userOpenId}:${threadId}`;
    if (!this.captainConcurrency.index.listRunning(sessionId).includes(runId)) return;

    try {
      const session = this.captainService?.getSession(sessionId);
      if (session && (session.record.status === 'active' || session.record.status === 'suspended')) {
        this.captainService?.closeSession(sessionId);
      }
    } catch (error) {
      logger.error({ sessionId, runId, error }, 'failed to close captain session during lost-run recovery');
      void sendAdminAlert(this.alertSink, this.alertDataDir, `lost-run session close failed: ${runId}`, 'warn');
    }

    try {
      const ts = new Date().toISOString();
      this.captainConcurrency.store.append({
        session_id: sessionId,
        run_id: runId,
        status: ConcurrencyQueueEntryStatus.ENDED,
        ts,
        reason: 'cancelled',
      });
      this.captainConcurrency.index.markEnded(sessionId, runId, ts);
    } catch (error) {
      logger.error({ sessionId, runId, error }, 'failed to reconcile lost captain run');
      void sendAdminAlert(this.alertSink, this.alertDataDir, `lost-run queue reconcile failed: ${runId}`, 'warn');
    }
  }

  private async onCaptainRunEnded(
    userOpenId: string,
    threadId: string,
    endedRunId: string,
    reason: CaptainEndReason,
  ): Promise<void> {
    if (!this.captainConcurrency) return;
    const sessionId = `${this.botId}:${userOpenId}:${threadId}`;
    const ts = new Date().toISOString();
    this.captainConcurrency.metrics.record({
      metric: 'captain_run_ended_total',
      value: 1,
      labels: { session_id: sessionId, reason },
    });
    this.captainConcurrency.store.append({
      session_id: sessionId,
      run_id: endedRunId,
      status: ConcurrencyQueueEntryStatus.ENDED,
      ts,
      ...(reason === 'cancelled' || reason === 'preempted' ? { reason } : {}),
    });
    this.captainConcurrency.index.markEnded(sessionId, endedRunId, ts);

    const nextQueued = this.captainConcurrency.index.listQueuedEntries(sessionId)[0];
    if (!nextQueued) return;

    const waitDurationSeconds = Math.max(0, (Date.parse(ts) - Date.parse(nextQueued.ts)) / 1000);
    this.captainConcurrency.metrics.record({
      metric: 'captain_queue_wait_duration_seconds',
      value: waitDurationSeconds,
      labels: { session_id: sessionId },
    });
    this.captainConcurrency.metrics.record({
      metric: 'captain_queue_promotions_total',
      value: 1,
      labels: { session_id: sessionId, trigger_reason: reason },
    });
    this.captainConcurrency.store.append({
      session_id: sessionId,
      run_id: nextQueued.run_id,
      status: ConcurrencyQueueEntryStatus.RUNNING,
      ts,
    });
    this.captainConcurrency.index.markRunning(sessionId, nextQueued.run_id, ts);

    const pending = this.pendingCaptainRuns.get(nextQueued.run_id);
    if (!pending) {
      this.captainConcurrency.metrics.record({
        metric: 'captain_queue_promotion_failures_total',
        value: 1,
        labels: { session_id: sessionId },
      });
      return;
    }
    this.pendingCaptainRuns.delete(nextQueued.run_id);

    const replyMessageId = await this.feishu.replyCard(
      pending.event.messageId,
      renderCard(createInitialState(pending.agent.id, pending.agent.displayName, pending.agent.displayName)),
    );

    if (this.runnerConfig) {
      await this.handleMessageViaWbRunner(
        pending.event,
        pending.agent,
        pending.cwd,
        replyMessageId,
        pending.scopeKey,
        pending.skipBindingUpdate,
        pending.runId,
      );
      return;
    }

    await this.handleMessageViaPipe(
      pending.event,
      pending.agent,
      pending.cwd,
      replyMessageId,
      pending.scopeKey,
      pending.skipBindingUpdate,
      pending.runId,
    );
  }

  // Waits for the sweep to settle, then confirms the runner process actually stopped before
  // clearing state. If the CLI subprocess is still alive (e.g. it ignored the cancel signal or
  // the heartbeat writer stalled while the agent kept running), keep the session/card so the
  // busy check blocks duplicate runs and the next sweep can retry instead of orphaning them.
  private finalizeLostRun(activeSession: ActiveSession | undefined, card: InflightCard, stopResult: { pid: number | null }): 'cleared' | 'still-running' {
    if (!this.isRunnerProcessStopped(stopResult.pid)) {
      logger.warn({ runId: card.runId, pid: stopResult.pid }, 'watchdog keeping state: runner process still alive after cancel signal');
      void sendAdminAlert(
        this.alertSink,
        this.alertDataDir,
        `watchdog retained stale-run state, runner ${stopResult.pid ?? 'unknown'} still alive: ${card.runId}`,
        'warn',
      );
      return 'still-running';
    }
    if (activeSession) {
      this.cleanupSession(activeSession, card.userOpenId, card.threadId);
    } else {
      this.store.clearInflightCard(this.botId, card.userOpenId, card.threadId, card.agentId);
    }
    return 'cleared';
  }

  private isRunnerProcessStopped(pid: number | null | undefined): boolean {
    if (!pid) return true;
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      // ESRCH = no such process -> stopped; EPERM = exists but not ours -> still alive.
      return (error as NodeJS.ErrnoException).code === 'ESRCH';
    }
  }

  private cleanupSession(session: ActiveSession, userOpenId: string, threadId: string): void {
    void this.ackReactions.clear(session.sourceMessageId);
    for (const id of this.mergedAckIds.get(session.sourceMessageId) ?? []) void this.ackReactions.clear(id);
    this.mergedAckIds.delete(session.sourceMessageId);
    this.store.clearInflightCard(this.botId, userOpenId, threadId, session.agentId);
    this.activeSessions.delete(session.scopeKey);
    this.activeSessionsByMessageId.delete(session.sourceMessageId);
    this.activeSessionsByMessageId.delete(session.replyMessageId);
    if (session.state.sessionShortId) {
      this.activeSessionsByShortId.delete(session.state.sessionShortId);
      this.reservedSessionShortIds.delete(session.state.sessionShortId);
    }
    for (const id of session.extraMessageIds) {
      this.activeSessionsByMessageId.delete(id);
    }
    // 续卡发完再接排队消息, 保证话题里先看到完整答案再看到下一轮.
    void this.finishRunCard(session).finally(() => {
      if (!this.followUps.has(session.scopeKey)) return;
      setImmediate(() => {
        this.drainFollowUps(session.scopeKey).catch((error: unknown) => {
          logger.error({ scopeKey: session.scopeKey, error }, 'follow-up drain failed');
        });
      });
    });
  }

  private async finishRunCard(session: ActiveSession): Promise<void> {
    const origin = this.runCards.get(session.replyMessageId);
    const { state } = session;
    if (origin && this.feishu.sendLocalFile && state.agentId !== 'system' && state.terminalState !== 'running' && state.stopState === 'running') {
      const cwd = state.cwd ?? origin.cwd;
      const found = findArtifacts({ tools: state.tools, text: state.text, cwd, startedAt: session.startedAt });
      if (found.length > 0) {
        rememberBounded(this.runArtifacts, session.replyMessageId, found);
        session.state = { ...state, artifacts: found.map((path) => ({ path, label: artifactLabel(path, cwd) })) };
        try {
          await session.pipeline.force(renderCard(session.state));
        } catch (error) {
          logger.error({ scopeKey: session.scopeKey, error }, 'artifact card update failed');
        }
      }
    }
    await this.sendContinuationCards(session);
  }

  /** 产物按钮: 只有发起人能发, 每个文件只发一次; 点击时再检查一遍文件仍在且没超限. */
  private async handleSendArtifact(event: CardActionEvent): Promise<Record<string, unknown>> {
    const origin = this.runCards.get(event.messageId);
    const path = event.artifactIndex === undefined ? undefined : this.runArtifacts.get(event.messageId)?.[event.artifactIndex];
    if (!origin || !path || !this.feishu.sendLocalFile) return { toast: { type: 'info', content: '这张卡的产物已失效 (bot 重启过)' } };
    if (origin.userOpenId !== event.userOpenId) return { toast: { type: 'error', content: '只有发起人可以发送产物' } };
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      return { toast: { type: 'error', content: '文件已不存在' } };
    }
    if (size > ARTIFACT_MAX_BYTES) return { toast: { type: 'error', content: '文件超过 20MB, 不发送' } };
    if (this.isDuplicate(`send-artifact:${event.messageId}:${path}`)) return { toast: { type: 'info', content: '已经发送过了' } };
    const send = this.feishu.sendLocalFile.bind(this.feishu);
    setImmediate(() => {
      send(origin.sourceMessageId, path).catch(async (error: unknown) => {
        logger.error({ path, error }, 'send artifact failed');
        await this.feishu.replyText(origin.sourceMessageId, `发送 ${basename(path)} 失败: ${error instanceof Error ? error.message : String(error)}`)
          .catch((replyError: unknown) => logger.error({ replyError }, 'send artifact failure notice failed'));
      });
    });
    return { toast: { type: 'success', content: `正在发送 ${basename(path)}` } };
  }

  private async sendContinuationCards(session: ActiveSession): Promise<void> {
    if (session.state.terminalState === 'running') return;
    const chunks = answerChunks(session.state);
    for (let index = 1; index < chunks.length; index++) {
      try {
        const messageId = await this.feishu.replyCard(
          session.sourceMessageId,
          renderContinuationCard(session.state, chunks[index]!, index + 1, chunks.length),
        );
        session.extraMessageIds.push(messageId);
      } catch (error) {
        logger.error({ scopeKey: session.scopeKey, index, total: chunks.length, error }, 'continuation card failed');
        return;
      }
    }
  }

  private findActiveSessionByRunId(runId: string): ActiveSession | undefined {
    for (const session of this.activeSessions.values()) {
      if (session.runId === runId) return session;
    }
    return undefined;
  }

  private isFreshRunnerStartupSession(session: ActiveSession, now = Date.now()): boolean {
    // wb-runner sessions persist the inflight card before the detached runner process finishes
    // writing spec/status/heartbeat. Skip the first watchdog window so a new run is not
    // misclassified as lost during this startup race.
    if (session.run !== null) return false;
    if (session.state.terminalState !== 'running') return false;
    return (now - session.startedAt) < RUNNER_STARTUP_GRACE_MS;
  }

  private isFreshRunnerStartupRun(runId: string, botId: string, now = Date.now()): boolean {
    try {
      const specRaw = readFileSync(runSpecPath(this.alertDataDir, runId, botId), 'utf8');
      const spec = JSON.parse(specRaw) as { startedAt?: string };
      if (!spec.startedAt) return false;
      const startedAt = Date.parse(spec.startedAt);
      if (!Number.isFinite(startedAt)) return false;
      return (now - startedAt) < RUNNER_STARTUP_GRACE_MS;
    } catch {
      return false;
    }
  }

  private staleSelfHealStore(card: InflightCard): ProgressStore | null {
    if (!card.runId) return null;
    return new ProgressStore({
      dataDir: this.alertDataDir,
      botId: this.botId,
      runId: card.runId,
      sessionId: `${this.botId}:${card.userOpenId}:${card.threadId}`,
      originMessageId: card.sourceMessageId,
      cardMessageId: card.replyMessageId,
    });
  }

  private reserveStaleSelfHeal(card: InflightCard): {
    kind: 'allowed';
    attempts: number;
  } | {
    kind: 'blocked';
    attempts: number;
    shouldEscalate: boolean;
  } {
    const store = this.staleSelfHealStore(card);
    const now = new Date().toISOString();
    if (!store) return { kind: 'allowed', attempts: 0 };

    const entry = store.readOrInitEntry(now);
    if (entry.stale_self_heal_attempts >= STALE_SELF_HEAL_MAX_ATTEMPTS) {
      const shouldEscalate = entry.stale_self_heal_escalated_at == null;
      if (shouldEscalate) {
        entry.stale_self_heal_escalated_at = now;
        store.saveEntry(entry);
      }
      return {
        kind: 'blocked',
        attempts: entry.stale_self_heal_attempts,
        shouldEscalate,
      };
    }

    entry.stale_self_heal_attempts += 1;
    entry.stale_self_heal_last_attempt_at = now;
    store.saveEntry(entry);
    return {
      kind: 'allowed',
      attempts: entry.stale_self_heal_attempts,
    };
  }

  private async handleBlockedStaleSelfHeal(
    card: InflightCard,
    source: 'watchdog' | 'restart',
    attempts: number,
    shouldEscalate: boolean,
  ): Promise<void> {
    if (!card.runId) return;
    await this.feishu.updateCard(card.replyMessageId, renderWatchdogEscalatedCard(card.runId.slice(0, 12), card.runId));
    if (!shouldEscalate) return;
    const sourceLabel = source === 'watchdog' ? 'watchdog' : 'restart recovery';
    await sendAdminAlert(
      this.alertSink,
      this.alertDataDir,
      `${sourceLabel} stale-run auto-recovery disabled after limit: ${card.runId} (attempts=${attempts}/${STALE_SELF_HEAL_MAX_ATTEMPTS})`,
      'error',
    );
  }

  private async bestEffortStopLostRun(runId: string): Promise<{ pid: number | null; stopSignalWritten: boolean; signalSent: boolean }> {
    const botId = this.botId;
    const stopSignalPath = runStopSignalPath(this.alertDataDir, runId, botId);
    let stopSignalWritten = false;
    if (!existsSync(stopSignalPath)) {
      writeFileSync(stopSignalPath, String(Date.now()));
      stopSignalWritten = true;
    }

    const pid = resolveCliPid(this.alertDataDir, runId);
    let signalSent = false;
    if (pid) {
      try {
        await sendControlSignal('cancel', pid);
        signalSent = true;
      } catch (error) {
        logger.warn({ runId, pid, error }, 'watchdog cancel signal failed');
      }
    }

    return { pid, stopSignalWritten, signalSent };
  }

  private async sweepApprovalRequests(): Promise<void> {
    for (const request of this.approvalRequests.listPending()) {
      if (request.status !== APPROVAL_REQUEST_STATUS.PENDING_DISPATCH) continue;
      try {
        const approvalMessageId = await this.feishu.replyCard(request.replyMessageId, renderApprovalRequestCard(request));
        const dispatched = this.approvalRequests.markDispatched(request.requestId, request.carrier ?? 'group_card', approvalMessageId);
        writeApprovalAudit({ dataDir: this.alertDataDir, request: dispatched, phase: 'dispatched', nowIso: dispatched.createdAt });
        // F22: 通知所有 allowed approvers。卡片本身已经渲染了 <at user_id=...>，
        // 但 approval card 挂在 replyMessageId 下，只有 requester 会被 ping；让 notifier
        // 用 home-group sendCard 再发一条让其他审批人真收到 @。
        await this.approvalNotifier.notifyApprovers(dispatched).catch((notifyError) => {
          logger.warn({ requestId: dispatched.requestId, notifyError }, 'approval approver notify failed');
        });
      } catch (approvalError) {
        const failed = this.approvalRequests.resolve(request.requestId, {
          status: APPROVAL_REQUEST_STATUS.FAILED_CLOSED,
          reason: 'approval dispatch failed',
          resolvedAt: new Date().toISOString(),
        });
        writeApprovalAudit({ dataDir: this.alertDataDir, request: failed, phase: 'resolved', nowIso: failed.resolvedAt });
        logger.error({ requestId: request.requestId, approvalError }, 'approval gate card dispatch failed');
      }
    }

    // F22 countdown self-update: 对所有还在 PENDING_APPROVAL 的卡，每一次 sweep
    // 都 patch 一次倒计时，让卡片始终显示剩余秒数，到点显示默认拒绝文案。失败不阻塞。
    for (const request of this.approvalRequests.listPending()) {
      if (request.status !== APPROVAL_REQUEST_STATUS.PENDING_APPROVAL) continue;
      if (!request.carrierMessageId) continue;
      try {
        await this.feishu.updateCard(request.carrierMessageId, renderApprovalRequestCard(request));
      } catch (countdownError) {
        logger.warn({ requestId: request.requestId, countdownError }, 'approval countdown card refresh failed');
      }
    }

    for (const request of this.approvalRequests.expireOverdue()) {
      writeApprovalAudit({ dataDir: this.alertDataDir, request, phase: 'resolved', nowIso: request.resolvedAt });
      const session = this.findActiveSessionByRunId(request.runId);
      if (request.carrierMessageId) {
        // 超时卡翻新为 resolved 文案，让审批人看到"已默认拒绝"，而不是一直 pending。
        try {
          await this.feishu.updateCard(request.carrierMessageId, renderApprovalResolvedCard(request));
        } catch (patchError) {
          logger.warn({ requestId: request.requestId, patchError }, 'approval expiry card refresh failed');
        }
      }
      if (!session) continue;
      session.state = {
        ...session.state,
        terminalState: 'error',
        errorMessage: request.resolutionReason ?? 'approval timeout',
      };
      await session.pipeline.force(renderCard(session.state));
      // Expire = fail-closed deny: the run must not linger as a zombie holding the scopeKey
      // busy check. Signal the runner to stop; the events-stream finally cleans the session up
      // once the runner drains its terminal event.
      await this.stopSession(session);
    }
  }

  private async sweepStaleRuns(): Promise<void> {
    if (!this.runnerConfig || this.draining || this.staleRunSweepInFlight) return;
    await this.sweepApprovalRequests();
    this.staleRunSweepInFlight = true;
    try {
      const botId = this.botId;
      const now = Date.now();
      const cards = this.store.listInflightCards(botId);
      for (const card of cards) {
        if (!card.runId) continue;
        const activeSession = this.findActiveSessionByRunId(card.runId);
        if (activeSession && activeSession.state.terminalState !== 'running') continue;
        if ((activeSession && this.isFreshRunnerStartupSession(activeSession, now)) || this.isFreshRunnerStartupRun(card.runId, botId, now)) continue;
        if (this.judgeRunState(card.runId, botId) !== 'lost') continue;
        activeSession?.eventsReader?.stop();

        try {
          const gate = this.reserveStaleSelfHeal(card);
          if (gate.kind === 'blocked') {
            await this.handleBlockedStaleSelfHeal(card, 'watchdog', gate.attempts, gate.shouldEscalate);
            logger.warn({ runId: card.runId, attempts: gate.attempts, replyMessageId: card.replyMessageId }, 'watchdog stale-run auto-recovery disabled after attempt limit');
            // Blocked escalation still tears the run down. If the runner is actually gone,
            // drop the card now; if it is alive beyond the attempt limit, leave state so a
            // human-approved retry has something to act on.
            this.finalizeLostRun(activeSession, card, { pid: resolveCliPid(this.alertDataDir, card.runId) });
            continue;
          }

          const stopResult = await this.bestEffortStopLostRun(card.runId);
          this.reconcileLostCaptainRun(card.userOpenId, card.threadId, card.runId);
          await this.feishu.updateCard(card.replyMessageId, renderWatchdogRecoveredCard(card.runId.slice(0, 12), card.runId));
          await sendAdminAlert(
            this.alertSink,
            this.alertDataDir,
            `watchdog auto-recovered stale run: ${card.runId} (attempt=${gate.attempts}/${STALE_SELF_HEAL_MAX_ATTEMPTS} signalSent=${stopResult.signalSent} stopSignalWritten=${stopResult.stopSignalWritten}${stopResult.pid ? ` pid=${stopResult.pid}` : ''})`,
            'warn',
          );
          logger.info({ runId: card.runId, stopResult, replyMessageId: card.replyMessageId, attempts: gate.attempts }, 'watchdog auto-recovered stale run');
          this.finalizeLostRun(activeSession, card, stopResult);
        } catch (error) {
          logger.error({ runId: card.runId, replyMessageId: card.replyMessageId, error }, 'watchdog stale-run recovery failed');
          void sendAdminAlert(this.alertSink, this.alertDataDir, `watchdog stale-run recovery failed: ${card.runId}`, 'warn');
          // Best-effort stop already ran (or pid-file lookup failed). Only drop the card once
          // the runner is actually gone; a live runner must keep state so the scope stays armed.
          const pid = resolveCliPid(this.alertDataDir, card.runId);
          this.finalizeLostRun(activeSession, card, { pid });
        }
      }
    } finally {
      this.staleRunSweepInFlight = false;
    }
  }

  private async stopSession(session: ActiveSession): Promise<void> {
    this.dropFollowUps(session.scopeKey);
    if (session.run) {
      await session.run.stop();
    } else if (session.runId && this.runnerConfig) {
      const botId = this.runnerConfig.botId ?? 'default';
      const stopSignalPath = runStopSignalPath(this.runnerConfig.dataDir, session.runId, botId);
      writeFileSync(stopSignalPath, String(Date.now()));
    }
  }

  private executeReverseAtCancel: ReverseAtCancelExecutor = async (runId) => {
    const session = this.findActiveSessionByRunId(runId);
    if (!session) return 'noop_already_ended';
    if (session.state.stopState === 'stopping' || session.state.stopState === 'stopped' || session.state.terminalState !== 'running') {
      return 'noop_already_ended';
    }
    session.state = {
      ...session.state,
      stopState: 'stopping',
    };
    await session.pipeline.force(renderCard(session.state));
    await this.stopSession(session);
    return 'cancelled';
  };

  private async handleCompletionPush(
    session: ActiveSession,
    agent: { displayName: string },
    userOpenId: string,
    threadId: string,
  ): Promise<void> {
    if (session.state.stopState === 'stopped' || session.state.stopState === 'stopping') return;
    const durationMs = Date.now() - session.startedAt;
    const hasFollow = this.followFlags.has(threadId);
    if (!shouldPushOnDone({ durationMs, thresholdMs: this.pushThresholdMs, hasFollow })) return;
    const cwd = session.state.cwd ?? '-';
    const message = formatCompletionMessage(agent.displayName, cwd, durationMs);
    try {
      await this.feishu.replyText(session.replyMessageId, message);
    } catch (err) {
      logger.error({ err, threadId, message }, 'completion push replyText failed');
    }
    if (hasFollow && this.activeSessionsForThread(userOpenId, threadId).length <= 1) {
      this.followFlags.delete(threadId);
    }
  }

  /**
   * 没有卡片的运行 (云文档评论): 按 (用户, threadId) 解析 agent / cwd / 上下文, 跑完返回纯文本.
   * 同一 scope 同时只跑一个; 没有停止按钮, 超时自动停.
   */
  async runHeadless(input: { userOpenId: string; threadId: string; prompt: string }): Promise<{ text: string; error?: string }> {
    if (this.draining) return { text: '', error: 'bot 正在重启, 请稍后再试' };
    const binding = this.store.getThreadBinding(this.botId, input.userOpenId, input.threadId);
    const agent = (binding?.agentId ? this.registry.lookup(binding.agentId) : null) ?? await resolveDefaultAgent(this.registry);
    if (!agent) return { text: '', error: '没有可用的 agent' };
    const scopeKey = this.scopeKey(input.userOpenId, input.threadId, agent.id);
    if (this.headlessScopes.has(scopeKey) || this.activeSessions.has(scopeKey)) {
      return { text: '', error: '上一条还在处理, 请稍后再 @ 我' };
    }
    let cwd = binding?.cwd ?? this.defaultCwd;
    if (!cwd) {
      const fallback = validateCwd(process.cwd());
      if (!fallback.ok) return { text: '', error: `bot 工作目录不在允许范围: ${fallback.reason}` };
      cwd = fallback.path;
    }
    this.headlessScopes.add(scopeKey);
    const run = agent.run({
      prompt: input.prompt,
      cwd,
      continuationToken: this.store.getContinuation(this.botId, input.userOpenId, input.threadId, agent.id) ?? undefined,
      ...(this.claudeConsentLevel && agent.id === 'claude-code' ? { consentLevel: this.claudeConsentLevel as ConsentLevel } : {}),
    });
    const timer = setTimeout(() => { void run.stop(); }, HEADLESS_RUN_TIMEOUT_MS);
    timer.unref?.();
    let state = createInitialState(agent.id, agent.displayName, agent.displayName);
    try {
      for await (const output of run.events) {
        state = reduceStreamState(state, output);
        if (output.type === 'done' && output.continuationToken) {
          this.store.upsertContinuation(this.botId, input.userOpenId, input.threadId, agent.id, output.continuationToken);
        }
        if (output.type === 'done' || output.type === 'error') break;
      }
    } finally {
      clearTimeout(timer);
      this.headlessScopes.delete(scopeKey);
    }
    return state.terminalState === 'error' ? { text: state.text, error: state.errorMessage ?? 'agent 出错' } : { text: state.text };
  }

  private async replySystemCard(messageId: string, text: string): Promise<void> {
    await this.feishu.replyCard(messageId, renderCard({
      ...createInitialState('system', 'Weaverbird', 'bot'),
      text,
      includeMeta: false,
      terminalState: 'done',
    }));
  }

  /** 群级开关; 关掉 @ 要求会让 bot 响应群里所有人, 所以只允许群主 / 群管理员 / 白名单改. */
  private async handleRequireMention(event: MessageEvent, value: 'on' | 'off' | undefined): Promise<string> {
    if (!event.chatId || !event.chatType || event.chatType === 'p2p') return '私聊不需要 @bot, 这个设置只在群里有效';
    const current = this.store.getRequireMention(this.botId, event.chatId);
    if (!value) return `本群当前${current ? '需要' : '不需要'} @bot 才响应。修改: /require-mention on|off`;
    if (!this.reverseAtAdminRoleResolver) return '当前环境无法校验群管理员身份, 不能修改群设置';
    let role: Awaited<ReturnType<ReverseAtAdminRoleResolver>>;
    try {
      role = await this.reverseAtAdminRoleResolver({ messageId: event.messageId, userOpenId: event.userOpenId, threadId: event.chatId });
    } catch (error) {
      logger.warn({ chatId: event.chatId, error }, 'require-mention role lookup failed');
      return '查询群管理员身份失败, 请稍后再试';
    }
    if (!role) return '只有群主 / 群管理员可以修改这个设置';
    this.store.setRequireMention(this.botId, event.chatId, value === 'on', event.userOpenId);
    return value === 'on'
      ? '已开启: 本群需要 @bot 才响应'
      : '已关闭 @ 要求: 本群所有人的消息都会被处理 (机器人消息和只 @ 了别人的消息除外)。需要应用开通 im:message.group_msg 权限, 否则飞书只推送 @bot 的消息。恢复: /require-mention on';
  }

  /**
   * 结束卡上的 继续 / 重试 / 新会话. 只有发起人能点; 生成的消息照常走 handleMessage,
   * 所以排队、绑定、上下文续接都和手动发消息一致.
   */
  private async handleRunFollowUpAction(event: CardActionEvent): Promise<Record<string, unknown>> {
    const origin = this.runCards.get(event.messageId);
    if (!origin) return { toast: { type: 'info', content: '这张卡的上下文已失效 (bot 重启过), 请直接发消息' } };
    if (origin.userOpenId !== event.userOpenId) return { toast: { type: 'error', content: '只有发起人可以操作这张卡' } };
    // 连点只认第一次; 卡片回调的 event_id 每次点击都不同, 不能用来去重.
    if (this.isDuplicate(`run-follow-up:${event.messageId}:${event.action}`)) {
      return { toast: { type: 'info', content: '已经处理过了' } };
    }
    if (event.action === RUN_FOLLOW_UP_ACTIONS.reset) {
      const cleared = this.store.clearContinuation(this.botId, origin.userOpenId, origin.threadId, origin.agentId);
      return { toast: { type: 'success', content: cleared ? `已清空 ${origin.agentId} 上下文, 下一条消息开新会话` : `${origin.agentId} 当前没有上下文` } };
    }
    const base = {
      eventId: `card:${event.action}:${event.messageId}`,
      userOpenId: origin.userOpenId,
      threadId: origin.threadId,
      messageId: origin.sourceMessageId,
    };
    let next: MessageEvent;
    if (event.action === RUN_FOLLOW_UP_ACTIONS.retry) {
      const input = this.recentInputs.get(origin.sourceMessageId);
      if (!input) return { toast: { type: 'info', content: '原消息已不在缓存里, 请重新发送' } };
      next = { ...input, eventId: base.eventId };
    } else {
      next = { ...base, text: `/agent ${origin.agentId} 继续` };
    }
    // 回调要在 3 秒内返回, run 放到后台.
    setImmediate(() => {
      this.handleMessage(next).catch((error: unknown) => {
        logger.error({ action: event.action, messageId: event.messageId, error }, 'run follow-up action failed');
      });
    });
    return { toast: { type: 'success', content: event.action === RUN_FOLLOW_UP_ACTIONS.retry ? '重新执行中' : '继续执行中' } };
  }

  async handleCardAction(event: CardActionEvent): Promise<Record<string, unknown>> {
    // Use messageId+action as dedup key when eventId is empty (Feishu omits it for card callbacks).
    // 同一张卡上的多个「发送」按钮 action 相同, 要带上序号, 否则第二个文件会被当成重复点击.
    const artifactSuffix = event.artifactIndex === undefined ? '' : `:${event.artifactIndex}`;
    const dedupKey = event.eventId || `card-action:${event.messageId}:${event.action}${artifactSuffix}`;
    if (this.isDuplicate(dedupKey)) {
      logger.info({ dedupKey, action: event.action }, 'duplicate card action ignored');
      return { toast: { type: 'info', content: 'duplicate' } };
    }
    // M13-H: 未知 action 提前动手, 给用户真话不是 "duplicate".
    const KNOWN_ACTIONS = new Set(['stop', 'admin_cancel', 'approval_gate_approve', 'approval_gate_deny', 'approval_gate_transfer', 'watchdog_retry', 'watchdog_dismiss', SEND_ARTIFACT_ACTION, ...Object.values(RUN_FOLLOW_UP_ACTIONS)]);
    if (!KNOWN_ACTIONS.has(event.action)) {
      logger.warn({ action: event.action, messageId: event.messageId }, 'unknown card action');
      return { toast: { type: 'error', content: `未知操作: ${event.action}, 请联系 owner` } };
    }
    if ((Object.values(RUN_FOLLOW_UP_ACTIONS) as string[]).includes(event.action)) {
      return this.handleRunFollowUpAction(event);
    }
    if (event.action === SEND_ARTIFACT_ACTION) return this.handleSendArtifact(event);
    const reverseAtThreadId = this.reverseAtThreadIdFor(event);
    const clickedSession = this.activeSessionsByMessageId.get(event.messageId);
    logger.info({
      eventId: event.eventId,
      userOpenId: event.userOpenId,
      threadId: event.threadId,
      messageId: event.messageId,
      action: event.action,
      activeSessionKeys: Array.from(this.activeSessionsByMessageId.keys()),
    }, 'handling card action');
    // M13-D: watchdog 卡按钮. dismiss= 消化提示即可, retry= 给出重发提示让 owner
    // 决定 (跨 run 拿不到原 prompt 是常态, 当前版本只返 toast, 不重发 run).
    if (event.action === 'watchdog_dismiss') {
      return { toast: { type: 'success', content: '知道了' } };
    }
    if (event.action === 'watchdog_retry') {
      return { toast: { type: 'info', content: '请把原 prompt 再发一次, 我会当新任务跑' } };
    }
    if (event.action === 'approval_gate_approve' || event.action === 'approval_gate_deny') {
      if (!event.requestId) return { toast: { type: 'info', content: '当前没有可处理的审批' } };
      const request = this.approvalRequests.get(event.requestId);
      if (!request) return { toast: { type: 'info', content: '当前没有可处理的审批' } };
      if (!request.allowedApproverOpenIds.includes(event.userOpenId)) {
        return { toast: { type: 'error', content: '你无权处理该审批' } };
      }
      const resolved = this.approvalRequests.resolve(event.requestId, {
        status: event.action === 'approval_gate_approve' ? APPROVAL_REQUEST_STATUS.APPROVED : APPROVAL_REQUEST_STATUS.DENIED,
        reason: event.action === 'approval_gate_approve' ? 'approved by configured approver' : 'denied by configured approver',
        resolvedAt: new Date().toISOString(),
        resolvedBy: event.userOpenId,
      });
      writeApprovalAudit({ dataDir: this.alertDataDir, request: resolved, phase: 'resolved', nowIso: resolved.resolvedAt });
      if (resolved.carrierMessageId) {
        try {
          await this.feishu.updateCard(resolved.carrierMessageId, renderApprovalResolvedCard(resolved));
        } catch (patchError) {
          logger.warn({ requestId: resolved.requestId, patchError }, 'approval resolved card patch failed');
        }
      }
      return { toast: { type: 'success', content: event.action === 'approval_gate_approve' ? '已批准' : '已拒绝' } };
    }
    if (event.action === 'approval_gate_transfer') {
      if (!event.requestId) return { toast: { type: 'info', content: '没有可转派的审批' } };
      const request = this.approvalRequests.get(event.requestId);
      if (!request) return { toast: { type: 'info', content: '没有可转派的审批' } };
      if (!request.allowedApproverOpenIds.includes(event.userOpenId)) {
        return { toast: { type: 'error', content: '你无权转派该审批' } };
      }
      // 选择面板未落(W3.4 范围之外); 让 transfer 退化为 @全员重发 (发起者被本轮排除,
      // 其他审批人会被 allow-list 重新编辑).
      const remaining = request.allowedApproverOpenIds.filter((id) => id !== event.userOpenId);
      if (remaining.length === 0) {
        return { toast: { type: 'error', content: '没有其他审批人可接收转派' } };
      }
      // M13-B: transfer 保留原 request pending, 不 DENIED 重建. 原卡 patch 一次以
      // 更新 @ 提及集合; audit 用 'dispatched' (re-targeted)。
      const next = this.approvalRequests.transferInPlace(event.requestId, remaining);
      writeApprovalAudit({ dataDir: this.alertDataDir, request: next, phase: 'dispatched' });
      if (next.carrierMessageId) {
        try {
          await this.feishu.updateCard(next.carrierMessageId, renderApprovalRequestCard(next));
        } catch (patchError) {
          logger.warn({ requestId: next.requestId, patchError }, 'approval transfer card patch failed');
        }
      }
      try {
        await this.approvalNotifier.notifyApprovers(next);
      } catch (notifyError) {
        logger.warn({ requestId: next.requestId, notifyError }, 'approval transfer notify failed');
      }
      return { toast: { type: 'success', content: '已转派,等待新审批人处理' } };
    }
    if (event.action === 'admin_cancel') {
      if (!event.shortId || !this.captainService) {
        return { toast: { type: 'info', content: '当前没有可叫停的目标' } };
      }
      const target = this.resolveReverseAtCancelTarget(event.shortId);
      if (!target) {
        return { toast: { type: 'info', content: '当前没有可叫停的目标' } };
      }
      const session = this.findActiveSessionByRunId(target.runId);
      if (!session) {
        return { toast: { type: 'info', content: '当前没有可叫停的目标' } };
      }
      const operatorOwnsSession = session.sessionId
        ? this.captainService.getSession(session.sessionId)?.record.operator === event.userOpenId
        : false;
      if (clickedSession?.runId === session.runId && operatorOwnsSession) {
        session.state = { ...session.state, stopState: 'stopping' };
        await session.pipeline.force(renderCard(session.state));
        void this.stopSession(session).then(() => {
          logger.info({
            scopeKey: session.scopeKey,
            state: summarizeState(session.state),
          }, 'operator short-circuit stop request resolved');
        }).catch((error) => {
          logger.error({ scopeKey: session.scopeKey, error }, 'operator short-circuit stop failed');
          void sendAdminAlert(this.alertSink, this.alertDataDir, `operator stop failed for ${session.scopeKey}`, 'warn');
        });
        return { toast: { type: 'success', content: '停止中...' } };
      }
      await handleReverseAtImCommand({
        command: '/cancel',
        run_id: event.shortId,
        requester_open_id: event.userOpenId,
        requested_at: new Date().toISOString(),
        message_id: event.messageId,
      }, {
        messageId: event.messageId,
        threadId: reverseAtThreadId,
        userOpenId: event.userOpenId,
      }, {
        captainService: this.captainService,
        dataDir: this.alertDataDir,
        feishu: this.feishu,
        resolveAdminRole: this.reverseAtAdminRoleResolver,
        resolveCancelTarget: this.resolveReverseAtCancelTarget,
        executeCancel: this.executeReverseAtCancel,
        listCancelableTargets: this.listReverseAtCancelableTargets,
        captainConcurrency: this.buildCaptainConcurrencyDeps({
          userOpenId: event.userOpenId,
          threadId: clickedSession?.threadId ?? event.threadId,
        }),
        notifyOperator: this.reverseAtOperatorNotifier,
      });
      return { toast: { type: 'info', content: '已提交' } };
    }
    if (event.action === 'stop') {
      // Only match by the specific card's message ID — do NOT fall back to scopeKey.
      // A stale STOP from an old card must not stop a newly started session.
      const session = this.activeSessionsByMessageId.get(event.messageId);
      if (!session) {
        logger.warn({
          eventId: event.eventId,
          userOpenId: event.userOpenId,
          threadId: event.threadId,
          messageId: event.messageId,
          activeSessionKeys: Array.from(this.activeSessionsByMessageId.keys()),
        }, 'stop action ignored because no active session matched');
        return { toast: { type: 'info', content: '当前没有可停止的运行' } };
      }
      session.state = { ...session.state, stopState: 'stopping' };
      logger.info({
        scopeKey: session.scopeKey,
        sourceMessageId: session.sourceMessageId,
        replyMessageId: session.replyMessageId,
        state: summarizeState(session.state),
      }, 'marked active session as stopping');
      await session.pipeline.force(renderCard(session.state));
      void this.stopSession(session).then(() => {
        logger.info({
          scopeKey: session.scopeKey,
          sourceMessageId: session.sourceMessageId,
          replyMessageId: session.replyMessageId,
          state: summarizeState(session.state),
        }, 'stop request resolved');
      }).catch((error) => {
        logger.error({
          scopeKey: session.scopeKey,
          sourceMessageId: session.sourceMessageId,
          replyMessageId: session.replyMessageId,
          state: summarizeState(session.state),
          error,
        }, 'stop request failed');
        void sendAdminAlert(this.alertSink, this.alertDataDir, `stop request failed for ${session.scopeKey}`, 'warn');
      });
      return { toast: { type: 'success', content: '停止中...' } };
    }
    return { toast: { type: 'info', content: 'ignored' } };
  }

  async markRestarted(messageId: string): Promise<string> {
    return this.feishu.replyCard(messageId, renderRestartedCard('lost'));
  }

  beginDraining(): void {
    this.draining = true;
  }

  async stopAllSessions(deadlineMs?: number): Promise<void> {
    const sessions = Array.from(this.activeSessions.values());
    await Promise.allSettled(sessions.map((session) => this.stopSession(session).catch((err) => {
      logger.error({ scopeKey: session.scopeKey, err }, 'stop failed during shutdown');
      void sendAdminAlert(this.alertSink, this.alertDataDir, `stop failed during shutdown: ${session.scopeKey}`, 'error');
    })));

    const waitUntil = Date.now() + (deadlineMs ?? 0);
    while (this.activeSessions.size > 0 && Date.now() < waitUntil) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  async recoverInflightCards(): Promise<void> {
    const cards = this.store.listInflightCards(this.botId);
    for (const card of cards) {
      try {
        if (card.runId) {
          const dataDir = resolveDataDir({ dataDir: this.runnerConfig?.dataDir });
          const botId = this.runnerConfig?.botId ?? 'default';
          const runDir = resolveRunDir(dataDir, card.runId, botId);
          const recovered = this.judgeRunState(card.runId, botId);

          let agentId: string | undefined = card.agentId;
          let displayName: string | undefined;
          let runStartedAt: number | undefined;
          try {
            const specRaw = readFileSync(runSpecPath(dataDir, card.runId, botId), 'utf8');
            const spec = JSON.parse(specRaw) as Record<string, unknown>;
            agentId = (spec['agentId'] as string) ?? agentId;
            const specStartedAt = typeof spec['startedAt'] === 'string' ? Date.parse(spec['startedAt']) : Number.NaN;
            if (Number.isFinite(specStartedAt)) runStartedAt = specStartedAt;
            const agent = agentId ? this.registry.lookup(agentId) : null;
            displayName = agent?.displayName;
          } catch { /* spec.json may not exist */ }

          if (recovered === 'resumed') {
            const shortId = card.runId.slice(0, 12);
            await this.feishu.updateCard(card.replyMessageId, renderRestartedCard('resumed', shortId, agentId, displayName));
            logger.info({ runId: card.runId, agentId, replyMessageId: card.replyMessageId }, 'run resumed after restart (heartbeat fresh)');

            if (this.runnerConfig) {
              const agent = agentId ? this.registry.lookup(agentId) : null;
              const caps = agent ? await agent.getCapabilities() : null;
              if (caps?.tokenRotation === 'rotating' && agentId) {
                const mapEvent = runnerEventMapper(agentId, { cwd: dataDir });
                const historicalEvents = readEventsSync(runEventsPath(dataDir, card.runId, botId))
                  .flatMap((raw) => mapEvent(raw) as unknown as Array<Record<string, unknown>>);
                const latestToken = extractLatestContinuationToken(historicalEvents);
                if (latestToken) {
                  this.store.upsertContinuation(this.botId, card.userOpenId, card.threadId, agentId, latestToken);
                  logger.info({
                    runId: card.runId,
                    agentId,
                    tokenSuffix: latestToken.slice(-8),
                  }, 'F6 backfill: updated store with latest continuationToken from events.ndjson');
                }
              }
              this.reattachEventsStream(card, runDir, agentId, runStartedAt);
            }
          } else {
            const gate = this.reserveStaleSelfHeal(card);
            if (gate.kind === 'blocked') {
              await this.handleBlockedStaleSelfHeal(card, 'restart', gate.attempts, gate.shouldEscalate);
              logger.warn({ runId: card.runId, attempts: gate.attempts, replyMessageId: card.replyMessageId }, 'restart recovery stale-run auto-recovery disabled after attempt limit');
            } else {
              writeFileSync(runStopSignalPath(dataDir, card.runId, botId), String(Date.now()));
              this.reconcileLostCaptainRun(card.userOpenId, card.threadId, card.runId);
              await this.feishu.updateCard(card.replyMessageId, renderRestartedCard('lost'));
              await sendAdminAlert(
                this.alertSink,
                this.alertDataDir,
                `restart recovery auto-stopped stale run: ${card.runId} (attempt=${gate.attempts}/${STALE_SELF_HEAL_MAX_ATTEMPTS})`,
                'warn',
              );
              logger.info({ runId: card.runId, replyMessageId: card.replyMessageId, attempts: gate.attempts }, 'run lost after restart (heartbeat stale), stop.signal written');
            }
          }
        } else {
          await this.feishu.updateCard(card.replyMessageId, renderRestartedCard('lost'));
          logger.info({
            sourceMessageId: card.sourceMessageId,
            replyMessageId: card.replyMessageId,
            threadId: card.threadId,
          }, 'patched pre-W2 stale in-flight card after restart');
        }
      } catch (error) {
        logger.error({
          sourceMessageId: card.sourceMessageId,
          replyMessageId: card.replyMessageId,
          threadId: card.threadId,
          error,
        }, 'failed to patch stale in-flight card after restart');
        void sendAdminAlert(this.alertSink, this.alertDataDir, `recover inflight card failed: ${card.replyMessageId}`, 'error');
      } finally {
        if (this.activeSessionsForThread(card.userOpenId, card.threadId).length === 0) {
          this.store.clearInflightCard(this.botId, card.userOpenId, card.threadId, card.agentId);
        }
      }
    }
  }

  private reattachEventsStream(
    card: { userOpenId: string; threadId: string; runId?: string | null; replyMessageId: string },
    runDir: string,
    agentId?: string,
    runStartedAt?: number,
  ): void {
    const ndjsonPath = join(runDir, 'events.ndjson');
    const eventsReader = new EventsFileReader(ndjsonPath, 0, runnerEventMapper(agentId, { cwd: runDir }));
    const scopeKey = this.scopeKey(card.userOpenId, card.threadId, agentId ?? 'system');
    const pipeline = new CardPipeline((c) => this.feishu.updateCard(card.replyMessageId, c), {
      logger,
      label: `reply:${card.replyMessageId}`,
      minIntervalMs: this.cardIntervalMs(card.replyMessageId),
    });
    const agent = agentId ? this.registry.lookup(agentId) : null;
    // 耗时和完成推送门槛按 run 真正的开始时间算, 不从 bot 重启那一刻重新计.
    const startedAt = runStartedAt ?? Date.now();
    const state = {
      ...createInitialState(agentId ?? 'system', agent?.displayName ?? 'Weaverbird', agent?.displayName ?? 'Weaverbird'),
      startedAt,
    };
    const activeSession: ActiveSession = {
      scopeKey,
      threadId: card.threadId,
      homeGroupId: null,
      sourceMessageId: card.replyMessageId,
      replyMessageId: card.replyMessageId,
      run: null,
      runId: card.runId ?? undefined,
      pipeline,
      state,
      extraMessageIds: [],
      eventsReader,
      startedAt,
      agentId: agentId ?? 'system',
      sessionId: this.sessionIdFor(card.userOpenId, card.threadId),
    };
    this.activeSessions.set(scopeKey, activeSession);
    this.activeSessionsByMessageId.set(card.replyMessageId, activeSession);

    eventsReader.start();
    void (async () => {
      try {
        for await (const output of eventsReader.events()) {
          const newState = reduceStreamState(activeSession.state, output);
          activeSession.state = newState;
          if ((output.type === 'done' || output.type === 'system') && (output as any).continuationToken && agentId) {
            this.store.upsertContinuation(this.botId, card.userOpenId, card.threadId, agentId, (output as any).continuationToken);
          }
          await (output.type === 'tool_use' || output.type === 'tool_result' || output.type === 'done' || output.type === 'error'
            ? pipeline.force(renderCard(newState))
            : pipeline.flush(renderCard(newState)));
          if (output.type === 'done') {
            const recoveryAgent = agentId ? this.registry.lookup(agentId) : null;
            if (recoveryAgent) {
              await this.handleCompletionPush(activeSession, recoveryAgent, card.userOpenId, card.threadId);
            }
            break;
          }
          if (output.type === 'error') break;
        }
      } finally {
        eventsReader.stop();
        this.cleanupSession(activeSession, card.userOpenId, card.threadId);
      }
    })();
  }

  private judgeRunState(runId: string, botId: string): 'resumed' | 'lost' {
    const staleMs = parseInt(process.env['WB_HEARTBEAT_STALE_MS'] ?? '240000', 10);
    return judgeRunStatePure(botId, runId, { dataDir: this.alertDataDir, staleMs });
  }

  private isL1HeartbeatFresh(runDir: string, now: number, staleMs: number): boolean {
    const hbPath = join(runDir, 'heartbeat');
    if (!existsSync(hbPath)) return false;
    try {
      const ts = parseInt(readFileSync(hbPath, 'utf8').trim(), 10) * 1000;
      return (now - ts) < staleMs;
    } catch {
      return false;
    }
  }

  private isL2HeartbeatFresh(runDir: string, now: number, staleMs: number): boolean {
    const ndjsonPath = join(runDir, 'events.ndjson');
    if (!existsSync(ndjsonPath)) return false;
    try {
      const stat = statSync(ndjsonPath);
      return (now - stat.mtimeMs) < staleMs;
    } catch {
      return false;
    }
  }

  private isDuplicate(key: string): boolean {
    if (!key) return false;
    if (this.seen.has(key)) return true;
    this.seen.set(key, Date.now());
    if (this.seen.size > 2000) {
      const oldest = this.seen.keys().next().value;
      if (oldest) this.seen.delete(oldest);
    }
    return false;
  }

  private messageDedupKey(event: MessageEvent): string {
    return event.eventId || `${event.threadId}:${event.messageId}`;
  }

  private scopeKey(userOpenId: string, threadId: string, agentId: string): string {
    return `${userOpenId}:${threadId}:${agentId}`;
  }

  private activeSessionsForThread(userOpenId: string, threadId: string): ActiveSession[] {
    const prefix = `${userOpenId}:${threadId}:`;
    const result: ActiveSession[] = [];
    for (const [key, session] of this.activeSessions) {
      if (key.startsWith(prefix)) result.push(session);
    }
    return result;
  }
}
