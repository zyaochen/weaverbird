import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BindingStore, InflightCard } from '../binding/store.js';
import type { BotStatus } from './bot-discovery.js';

export interface CaptainStopAllOptions {
  bots: BotStatus[];
  store: BindingStore;
  dataDir: string;
  nowFn?: () => number;
}

export interface StopSignalSent {
  botId: string;
  runId: string;
  runIdShort: string;
  agentId: string;
}

export interface StopSignalFailed {
  botId: string;
  runId: string;
  reason: string;
}

export interface CaptainStopAllResult {
  sent: StopSignalSent[];
  failed: StopSignalFailed[];
}

export function captainStopAll(opts: CaptainStopAllOptions): CaptainStopAllResult {
  const now = String((opts.nowFn ?? Date.now)());
  const sent: StopSignalSent[] = [];
  const failed: StopSignalFailed[] = [];

  for (const bot of opts.bots) {
    const inflightCards = safeListInflightCards(opts.store, bot.botId);
    for (const card of inflightCards) {
      if (!card.runId) continue;
      const runDir = join(opts.dataDir, 'runs', bot.botId, card.runId);
      const statusValue = safeReadFile(join(runDir, 'status'));
      if (statusValue !== 'running') continue;
      try {
        writeFileSync(join(runDir, 'stop.signal'), now);
        sent.push({
          botId: bot.botId,
          runId: card.runId,
          runIdShort: card.runId.slice(0, 12),
          agentId: card.agentId ?? '(no agent)',
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        failed.push({ botId: bot.botId, runId: card.runId, reason });
      }
    }
  }

  return { sent, failed };
}

export function renderCaptainStopAllCard(result: CaptainStopAllResult): string {
  if (result.sent.length === 0 && result.failed.length === 0) {
    return '✅ 当前没有 active run';
  }

  const lines: string[] = ['```'];
  lines.push(`✅ 已向 ${result.sent.length} 个 active run 发送 stop 信号`);
  lines.push('─────────────────────────────────────');
  for (const item of result.sent) {
    lines.push(`- ${item.botId} / ${item.runIdShort} : signal sent`);
  }
  if (result.failed.length > 0) {
    lines.push('─────────────────────────────────────');
    lines.push(`⚠️ ${result.failed.length} 个失败:`);
    for (const item of result.failed) {
      lines.push(`- ${item.botId} / ${item.runId.slice(0, 12)} : ${item.reason}`);
    }
  }
  lines.push('─────────────────────────────────────');
  lines.push('signal 仅触发 graceful stop, 实际收敛是异步:');
  lines.push('各 bot 的 wb-runner 读到 stop.signal 后会跑完手头的 tool,');
  lines.push('完成后各自卡片更新为 "stopped". 用 /status 跟踪收敛进度.');
  lines.push('```');
  return lines.join('\n');
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
