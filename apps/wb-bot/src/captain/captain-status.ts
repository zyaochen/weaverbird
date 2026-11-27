import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BindingStore, InflightCard } from '../binding/store.js';
import type { BotStatus } from './bot-discovery.js';

export interface CaptainStatusOptions {
  bots: BotStatus[];
  store: BindingStore;
  dataDir: string;
  captainBotId: string;
  nowFn?: () => number;
}

interface ActiveRunStats {
  earliest: { runId: string; runIdShort: string; startedAt: number };
  count: number;
}

export function renderCaptainStatusCard(opts: CaptainStatusOptions): string {
  const now = (opts.nowFn ?? Date.now)();
  const tsLine = new Date(now).toISOString().replace('T', ' ').slice(0, 19);
  const sorted = sortBots(opts.bots, opts.captainBotId);
  const lines: string[] = ['```', `📊 Weaverbird Status (${tsLine})`, '─────────────────────────────────────'];

  if (sorted.length === 0) {
    lines.push('(无 worker)');
  } else {
    for (const bot of sorted) {
      lines.push(renderBotLine(bot, opts.store, opts.dataDir, opts.captainBotId, now));
    }
  }

  lines.push('─────────────────────────────────────');
  lines.push('per-bot 摘要视图 · 单 bot 多 run 时显示最早 run + 数量');
  lines.push('完整 run 列表视图待 W3 (snapshot protocol)');
  lines.push('```');
  return lines.join('\n');
}

function sortBots(bots: BotStatus[], captainBotId: string): BotStatus[] {
  return [...bots].sort((left, right) => {
    if (left.botId === captainBotId) return -1;
    if (right.botId === captainBotId) return 1;
    return left.botId.localeCompare(right.botId);
  });
}

function renderBotLine(bot: BotStatus, store: BindingStore, dataDir: string, captainBotId: string, now: number): string {
  const name = bot.botId === captainBotId ? `${bot.botId} (Captain)` : bot.botId;
  const inflightCards = safeListInflightCards(store, bot.botId);
  const stats = collectActiveRunStats(inflightCards, dataDir, bot.botId, now);

  if (!bot.online && bot.lastHeartbeatAt !== null) {
    const ageDisplay = formatAge(now - bot.lastHeartbeatAt);
    return `🤖 ${name.padEnd(20)} : ⚠️ 离线 (最后心跳 ${ageDisplay} 前)`;
  }
  if (!bot.online) {
    return `🤖 ${name.padEnd(20)} : ⚠️ 离线 (无 heartbeat)`;
  }
  if (stats) {
    const age = formatAge(now - stats.earliest.startedAt);
    if (stats.count === 1) {
      return `🤖 ${name.padEnd(20)} : 跑中 1 · ${age} · run ${stats.earliest.runIdShort}`;
    }
    return `🤖 ${name.padEnd(20)} : 跑中 ${stats.count} · 最早 ${age} · run ${stats.earliest.runIdShort} (+${stats.count - 1} 更多)`;
  }
  const hbAge = bot.lastHeartbeatAt !== null ? formatAge(now - bot.lastHeartbeatAt) : '?';
  return `🤖 ${name.padEnd(20)} : 空闲 · 最后心跳 ${hbAge} 前`;
}

function collectActiveRunStats(cards: InflightCard[], dataDir: string, botId: string, now: number): ActiveRunStats | null {
  let earliest: ActiveRunStats['earliest'] | null = null;
  let count = 0;
  for (const card of cards) {
    if (!card.runId) continue;
    const runDir = join(dataDir, 'runs', botId, card.runId);
    const statusValue = safeReadFile(join(runDir, 'status'));
    if (statusValue && statusValue !== 'running') continue;
    count += 1;
    const hbTs = safeReadHeartbeat(join(runDir, 'heartbeat'));
    const startedAt = hbTs ?? now;
    if (!earliest || startedAt < earliest.startedAt) {
      earliest = { runId: card.runId, runIdShort: card.runId.slice(0, 12), startedAt };
    }
  }
  return earliest ? { earliest, count } : null;
}

function safeListInflightCards(store: BindingStore, botId: string): InflightCard[] {
  try {
    return store.listInflightCards(botId);
  } catch {
    return [];
  }
}

function safeReadFile(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8').trim() : null;
  } catch {
    return null;
  }
}

function safeReadHeartbeat(path: string): number | null {
  const raw = safeReadFile(path);
  if (!raw) return null;
  const tsSec = parseInt(raw, 10);
  return Number.isNaN(tsSec) ? null : tsSec * 1000;
}

function formatAge(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}min`;
  return `${Math.floor(sec / 3600)}h`;
}
