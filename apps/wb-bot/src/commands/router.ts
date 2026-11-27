import type { AgentCapabilities, AgentRegistry } from '../../../../packages/core/src/index.js';
import type { MetricsSnapshot } from '../../../../packages/core/src/captain/queue-metrics/contracts.js';
import { BindingStore } from '../binding/store.js';
import { isCaptainEnabled } from '../captain/captain-gate.js';
import { resolveCaptainContext } from '../captain/captain-context.js';
import { renderListBotsCard } from '../captain/list-bots.js';
import { renderCaptainStatusCard } from '../captain/captain-status.js';
import { captainStopAll, renderCaptainStopAllCard } from '../captain/captain-stop-all.js';
import type { ActiveSessionSnapshot, ControlPlaneConfig } from '../feishu/event-handler.js';
import { parseCommand } from './parser.js';
import { renderStatus } from './status.js';
import { renderLogs } from './logs.js';
import { renderHealth } from './health.js';
import { handleHistory } from './history.js';
import { renderQueueMetrics } from './queue-metrics.js';
import { handleResume } from './resume.js';
import { handleWbSync } from './wb-sync.js';
import { handleWbAudit } from './wb-audit.js';
import { handleWbApproval } from './wb-approval.js';
import { handleWbMute, handleWbUnmute } from './wb-mute.js';
import type { MuteRegistry } from '../../../../packages/core/src/reverse-channel/index.js';
import { renderTasks } from './tasks.js';
import { validateCwd, CWD_DENYLIST } from '../security/cwd-guard.js';

export type CommandContext = {
  userOpenId: string;
  threadId: string;
  registry: AgentRegistry;
  store: BindingStore;
  botId: string;
  controlPlane?: ControlPlaneConfig;
  activeSessions?: () => ActiveSessionSnapshot[];
  stopAllSessions?: () => Promise<void>;
  activeSessionsForThread?: (userOpenId: string, threadId: string) => Array<{ agentId: string }>;
  setFollowFlag?: (threadId: string) => void;
  queueMetricsSnapshot?: () => MetricsSnapshot;
  muteRegistry?: MuteRegistry;
};

function summarizeCapabilities(caps: AgentCapabilities): string {
  const parts: string[] = [caps.type, caps.context.costClass];
  if (caps.output.streaming) parts.push('streaming');
  if (caps.output.thinking) parts.push('thinking');
  if (caps.output.toolUse) parts.push('tool-use');
  parts.push(caps.session.resumable ? 'resumable' : 'stateless');
  return parts.join('/');
}

// Per-context cache keyed by (botId, agentAllowed) — 避免不同 bot / 不同 agent 白名单互相覆盖结果.
// 行为不变量: TTL 仍 10_000 ms, resetAgentListCache() 仍清整个 cache. (W2.5-Hotfix-batch-D D2)
const cachedAgentList = new Map<string, { value: string; expiresAt: number }>();

function agentListCacheKey(ctx: CommandContext): string {
  const agentIds = ctx.registry.list().map((a) => a.id).slice().sort().join(',');
  return `${ctx.botId}|${agentIds}`;
}

export function resetAgentListCache(): void {
  cachedAgentList.clear();
}

/**
 * /help 分模式输出 (W2.5-Hotfix-batch-C P1-5):
 *  - single mode: 不暴露 /list-bots 等 Captain-only 命令, 不写 "W2.5 启用后..." 之类
 *    multi-bot 心智泄漏 (符合 docs/product-strategy.md §3 "单 agent 视图不暴露 multi 概念").
 *  - Captain mode (multi-bot + default + 未禁用): 增加 [Captain 跨 bot] 分组,
 *    把跨 bot 控制面命令清晰隔离.
 *
 * 不影响命令本身是否被路由处理 — 没 Captain 时用户输 /list-bots 依然有 degrade
 * fallback, 这里只是 /help 默认展示面收紧.
 */
function renderHelp(ctx: CommandContext): string {
  const captainEnabled = isCaptainEnabled({
    mode: process.env['WB_MODE'] === 'multi-bot' ? 'multi-bot' : 'single',
    botId: ctx.botId,
    disableCaptainEnv: process.env['WB_DISABLE_CAPTAIN'],
  });

  const core = [
    '[核心]',
    '/use <agent>',
    '/list-agents (alias: /agents)',
    '/now',
    '/reset-context',
    '/stop',
    '/follow — 标记当前 thread, 完成时通过新消息额外通知',
    '/help',
  ];

  const cwd = [
    '',
    '[工作目录]',
    '/cwd <abs-or-alias>',
    '/cwd-add <name> <abs-path>',
    '/cwd-list',
    '/cwd-rm <name>',
  ];

  const group = [
    '',
    '[群设置]',
    '/require-mention on|off — 本群是否必须 @bot 才响应 (群主 / 群管理员)',
  ];

  const localControl = [
    '',
    '[本 bot 控制]',
    '/status — 本 bot active run 摘要',
    '/stop-all — 给本 bot 所有 active run 发 stop 信号',
    '/logs [tail=N] — 本 bot 最近日志',
    '/health — 本 bot 控制面 + WAL 健康',
    '/tasks [N] [<agentId>] — 本 bot 任务历史',
    '/queue-metrics — 当前 session 队列指标',
    '/wb mute <sid> <duration> — session 维度静音 (30s/15m/2h/7d)',
    '/wb unmute <sid> — 解除 session 静音',
    '/wb mute list — 查看当前静音列表',
  ];

  if (!captainEnabled) {
    return [...core, ...cwd, ...group, ...localControl].join('\n');
  }

  const captain = [
    '',
    '[Captain 跨 bot]',
    '/status — 所有 bot 汇总摘要 (per-bot 摘要视图)',
    '/stop-all — 给所有 bot 异步派发 stop 信号',
    '/health — Captain CP + 其它 bot 心跳状态',
    '/list-bots — 列出所有已配置 bot 及在线状态',
  ];

  return [...core, ...cwd, ...group, ...localControl, ...captain].join('\n');
}

async function renderAgents(ctx: CommandContext): Promise<string> {
  const now = Date.now();
  const key = agentListCacheKey(ctx);
  const hit = cachedAgentList.get(key);
  if (hit && hit.expiresAt > now) return hit.value;
  const items = await Promise.all(ctx.registry.list().map(async (agent) => {
    const [caps, available] = await Promise.all([
      agent.getCapabilities(),
      ctx.registry.isAvailable(agent.id),
    ]);
    return `- ${agent.displayName} (${agent.id}) · ${available ? 'available' : 'unavailable'} · ${summarizeCapabilities(caps)}`;
  }));
  const value = items.join('\n');
  cachedAgentList.set(key, { value, expiresAt: now + 10_000 });
  return value;
}

export async function runCommand(input: string, ctx: CommandContext): Promise<string | null> {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith('/')) return null;
  const [command, ...args] = parseCommand(trimmed);
  if (!command) return null;
  if (command === '/list-agents' || command === '/agents') return renderAgents(ctx);
  if (command === '/help') {
    return renderHelp(ctx);
  }
  if (command === '/status') {
    const captain = resolveCaptainContext({ botId: ctx.botId });
    if (!captain.enabled) {
      const sessions = ctx.activeSessions ? ctx.activeSessions() : [];
      return renderStatus(sessions, ctx.controlPlane);
    }
    return renderCaptainStatusCard({ bots: captain.bots, store: ctx.store, dataDir: captain.dataDir, captainBotId: ctx.botId });
  }
  if (command === '/stop-all') {
    const captain = resolveCaptainContext({ botId: ctx.botId });
    if (!captain.enabled) {
      if (!ctx.stopAllSessions || !ctx.activeSessions) {
        return '⚠️ stop-all 不可用 (control plane 未启动)';
      }
      const before = ctx.activeSessions();
      if (before.length === 0) {
        return '✅ 当前没有 active run';
      }
      await ctx.stopAllSessions();
      const lines = ['✅ 已向 ' + before.length + ' 个 active run 发送 stop 信号', '─────────────────────────────────────'];
      for (const session of before) {
        const runShort = session.runId ? session.runId.slice(0, 12) : '(no run)';
        lines.push(`- ${session.agentId} / ${runShort} : signal sent`);
      }
      return lines.join('\n');
    }
    const result = captainStopAll({ bots: captain.bots, store: ctx.store, dataDir: captain.dataDir });
    return renderCaptainStopAllCard(result);
  }
  if (command === '/logs') {
    if (!ctx.controlPlane) return '⚠️ /logs 不可用 (control plane 未启动)';
    return renderLogs(args, ctx.controlPlane);
  }
  if (command === '/health') {
    if (!ctx.controlPlane) return '⚠️ /health 不可用 (control plane 未启动)';
    const captain = resolveCaptainContext({ botId: ctx.botId });
    if (!captain.enabled) {
      return await renderHealth(ctx.controlPlane, ctx.store);
    }
    const otherBots = captain.bots.filter((bot) => bot.botId !== ctx.botId);
    return await renderHealth({ cp: ctx.controlPlane, store: ctx.store, bots: otherBots });
  }
  if (command === '/tasks') {
    if (!ctx.controlPlane) return '⚠️ /tasks 不可用 (control plane 未启动)';
    return renderTasks(args, ctx.controlPlane, ctx.registry);
  }
  if (command === '/queue-metrics') {
    if (args.includes('--all')) return 'queue-metrics unavailable';
    if (!ctx.queueMetricsSnapshot) return 'queue-metrics unavailable';
    return renderQueueMetrics(ctx.queueMetricsSnapshot());
  }
  if (command === '/wb' && args[0] === 'history') {
    return handleHistory(args.slice(1), ctx);
  }
  if (command === '/wb' && args[0] === 'resume') {
    return handleResume(args, ctx);
  }
  if (command === '/wb' && args[0] === 'sync') {
    return handleWbSync(args, ctx);
  }
  if (command === '/wb' && args[0] === 'audit') {
    return handleWbAudit(args.slice(1), ctx);
  }
  if (command === '/wb' && args[0] === 'approval') {
    return handleWbApproval(args.slice(1), ctx);
  }
  if (command === '/wb' && args[0] === 'mute') {
    if (!ctx.muteRegistry) return '⚠️ /wb mute 不可用 (MuteRegistry 未注入)';
    return handleWbMute(args.slice(1), ctx, ctx.muteRegistry);
  }
  if (command === '/wb' && args[0] === 'unmute') {
    if (!ctx.muteRegistry) return '⚠️ /wb unmute 不可用 (MuteRegistry 未注入)';
    return handleWbUnmute(args.slice(1), ctx, ctx.muteRegistry);
  }
  if (command === '/list-bots') {
    const captain = resolveCaptainContext({ botId: ctx.botId });
    if (!captain.enabled) {
      const botId = ctx.controlPlane?.botId ?? 'default';
      const agentNames = ctx.registry.list().map((a) => a.id).join(', ') || '(none)';
      return [
        '📋 已配置 bot (single-bot mode)',
        '─────────────────────────────────────',
        `${botId} (Captain) · agents=[${agentNames}] · 在线 ✓ (本进程)`,
        '─────────────────────────────────────',
        '(当前为 single-bot 模式 · 启用 multi-bot 后会列出全部已配置 bot)',
      ].join('\n');
    }
    return renderListBotsCard(captain.bots, ctx.botId);
  }
  if (command === '/use') {
    const agentId = args[0] ?? '';
    if (!ctx.registry.lookup(agentId)) return `未知 agent: ${agentId}`;
    ctx.store.setCurrentAgent(ctx.botId, ctx.userOpenId, ctx.threadId, agentId);
    const token = ctx.store.getContinuation(ctx.botId, ctx.userOpenId, ctx.threadId, agentId);
    return token ? `已切换到 ${agentId}; 继续之前 ${agentId} 会话` : `已切换到 ${agentId}; ${agentId} 上下文从头开始`;
  }
  if (command === '/now') {
    const binding = ctx.store.getThreadBinding(ctx.botId, ctx.userOpenId, ctx.threadId);
    return `agent: ${binding?.agentId ?? 'claude-code'}\ncwd: ${binding?.cwd ?? '-'}\n上下文: ${binding && ctx.store.getContinuation(ctx.botId, ctx.userOpenId, ctx.threadId, binding.agentId) ? '有' : '无'}`;
  }
  if (command === '/reset-context') {
    const binding = ctx.store.getThreadBinding(ctx.botId, ctx.userOpenId, ctx.threadId);
    const agentId = binding?.agentId ?? 'claude-code';
    const cleared = ctx.store.clearContinuation(ctx.botId, ctx.userOpenId, ctx.threadId, agentId);
    return cleared ? `已清空 ${agentId} 上下文` : `${agentId} 当前没有可清空的上下文`;
  }
  if (command === '/cwd-add') {
    const [name, ...rest] = args;
    const path = rest.join(' ');
    if (!name || !path) return 'Usage: /cwd-add <name> <abs-path>';
    // /cwd-add extends the allowlist, so we only check against the denylist (not the allowlist)
    const result = validateCwd(path, [path], CWD_DENYLIST);
    if (!result.ok) return `❌ 路径不允许: ${path}. ${result.reason}`;
    ctx.store.setAlias(ctx.userOpenId, name, result.path);
    return `已保存 cwd alias: ${name} -> ${result.path}`;
  }
  if (command === '/cwd-list') {
    const aliases = ctx.store.listAliases(ctx.userOpenId);
    return aliases.length > 0 ? aliases.map((item) => `- ${item.name}: ${item.path}`).join('\n') : '没有已保存的 cwd alias';
  }
  if (command === '/cwd-rm') {
    const name = args[0] ?? '';
    return ctx.store.removeAlias(ctx.userOpenId, name) ? `已删除 alias: ${name}` : `alias 不存在: ${name}`;
  }
  if (command === '/cwd') {
    const raw = args.join(' ');
    if (!raw) return 'Usage: /cwd <abs-or-alias>';
    const alias = ctx.store.listAliases(ctx.userOpenId).find((item) => item.name === raw);
    const target = alias?.path ?? raw;
    // If the path came from a saved alias it was already denylist-checked at /cwd-add time;
    // for raw paths apply the full allowlist check so operators must explicitly /cwd-add first.
    const result = alias
      ? validateCwd(target, [target], CWD_DENYLIST)
      : validateCwd(target);
    if (!result.ok) return `❌ 路径不允许: ${target}. ${result.reason}`;
    ctx.store.setCurrentCwd(ctx.botId, ctx.userOpenId, ctx.threadId, result.path);
    return `已设置 cwd: ${result.path}`;
  }
  if (command === '/stop') return '当前没有可停止的运行';
  if (command === '/follow') {
    if (!ctx.activeSessionsForThread || !ctx.setFollowFlag) {
      return '⚠️ /follow 不可用';
    }
    const sessions = ctx.activeSessionsForThread(ctx.userOpenId, ctx.threadId);
    if (sessions.length === 0) {
      return '⚠️ 当前 thread 无 active run, 请先发任务再 `/follow`';
    }
    ctx.setFollowFlag(ctx.threadId);
    return `⏰ /follow 已设置, 当前 thread (${sessions.length} 个 active run) 完成时将额外通知`;
  }
  return `未知命令 ${command}, 支持的命令: /use /list-agents /agents /now /reset-context /stop /stop-all /follow /cwd /cwd-add /cwd-list /cwd-rm /status /logs /health /tasks /queue-metrics /list-bots /help`;
}
