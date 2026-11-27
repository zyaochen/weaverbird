import { basename } from 'node:path';
import { homedir } from 'node:os';
import type { AgentRegistry } from '../../../../packages/core/src/index.js';
import type { ControlPlaneConfig } from '../feishu/event-handler.js';
import type { TaskEntry } from '../binding/task-index.js';

const DEFAULT_N = 20;
const MAX_N = 100;

type ParsedArgs = {
  n: number;
  agentFilter: string | null;
  botIgnored: boolean;
};

function parseTaskArgs(args: string[]): ParsedArgs {
  let n = DEFAULT_N;
  let agentFilter: string | null = null;
  let botIgnored = false;
  let positional = 0;
  for (const arg of args) {
    if (!arg) continue;
    if (arg.startsWith('bot=')) {
      botIgnored = true;
      continue;
    }
    if (positional === 0 && /^\d+$/.test(arg)) {
      n = Math.min(MAX_N, Math.max(1, parseInt(arg, 10)));
      positional++;
      continue;
    }
    if (positional <= 1) {
      agentFilter = arg;
      positional = Math.max(positional, 2);
    }
  }
  return { n, agentFilter, botIgnored };
}

function emojiForStatus(status: string): string {
  switch (status) {
    case 'done': return '✅';
    case 'stopped': return '⛔';
    case 'error': return '❌';
    case 'running': return '▶️';
    default: return '•';
  }
}

function shortCwd(cwd: string): string {
  if (!cwd) return '-';
  const home = homedir();
  if (cwd.startsWith(home)) return '~' + cwd.slice(home.length);
  return cwd;
}

function formatStartedAt(ts: string): string {
  if (!ts) return '--:--';
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return '--:--';
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function durationMin(entry: TaskEntry): string {
  if (!entry.startedAt) return '?min';
  const startMs = new Date(entry.startedAt).getTime();
  if (!Number.isFinite(startMs)) return '?min';
  const ms = Math.max(0, entry.lastModified - startMs);
  const min = Math.floor(ms / 60000);
  return min < 1 ? '<1min' : `${min}min`;
}

export function renderTasks(args: string[], cp: ControlPlaneConfig, registry: AgentRegistry): string {
  const parsed = parseTaskArgs(args);
  if (parsed.agentFilter && !registry.lookup(parsed.agentFilter)) {
    return `❌ agent ${parsed.agentFilter} 未注册. 用 /list-agents 查看可用 agent.`;
  }

  cp.taskIndex.scan();
  const all = cp.taskIndex.list();
  const filtered = parsed.agentFilter
    ? all.filter((entry) => entry.agentId === parsed.agentFilter)
    : all;
  const list = filtered.slice(0, parsed.n);

  const header = [`📋 Task History (近 7 日, tail ${parsed.n}${parsed.agentFilter ? ', agent=' + parsed.agentFilter : ''})`, '─────────────────────────────────────'];
  const body: string[] = [];
  if (list.length === 0) {
    body.push('(无任务历史; 单 bot 模式仅扫本进程 runs/ 目录)');
  } else {
    for (const entry of list) {
      const start = formatStartedAt(entry.startedAt);
      const runShort = entry.runId.slice(0, 12);
      const cwd = shortCwd(entry.cwd);
      const dur = durationMin(entry);
      const icon = emojiForStatus(entry.status);
      body.push(`${icon} ${start} ${entry.agentId} · ${cwd} · ${dur} · ${entry.status}    (${runShort})`);
    }
  }
  const footer = [
    '─────────────────────────────────────',
    '未列出:',
    '- 当前 active 任务 (用 /status 查)',
    '- 历史详情 (用 /logs 查; 当前仍是本 bot 视角)',
    '- 无 spec.json 的孤儿 run 目录',
  ];
  if (parsed.botIgnored) {
    footer.push('');
    footer.push('⚠️ single-bot 模式忽略 bot=<id> 子参数; 启用 multi-bot 后才生效');
  }
  return [...header, ...body, ...footer].join('\n');
}

// Helper not exported, kept for future test if needed
export const __test = { parseTaskArgs, formatStartedAt, durationMin, basename };
