import { existsSync, readFileSync } from 'node:fs';
import type { Logger } from 'pino';
import { botHeartbeatPath } from '../../../../packages/core/src/paths.js';
import { loadBotEnvFromFile } from '../config/bot-env.js';
import { discoverBots, type DiscoveryWarning, type DiscoveredBot } from '../multi/discovery.js';

export interface BotStatus {
  botId: string;
  configPath: string;
  online: boolean;
  lastHeartbeatAt: number | null;
  agentAllowed?: string[];
}

export interface CaptainDiscoveryOptions {
  configDir: string;
  dataDir: string;
  staleMs?: number;
  nowFn?: () => number;
  logger?: Pick<Logger, 'warn' | 'info'>;
}

export interface CaptainDiscoveryResult {
  bots: BotStatus[];
  warnings: DiscoveryWarning[];
}

export function discoverBotsWithStatus(opts: CaptainDiscoveryOptions): CaptainDiscoveryResult {
  const discovered = discoverBots(opts.configDir, opts.logger);
  const staleMs = opts.staleMs ?? 30_000;
  const now = (opts.nowFn ?? Date.now)();
  const bots = discovered.bots.map((bot) => probeBotStatus(bot, opts.dataDir, now, staleMs, opts.logger));
  return { bots, warnings: discovered.warnings };
}

function probeBotStatus(
  bot: DiscoveredBot,
  dataDir: string,
  now: number,
  staleMs: number,
  logger?: Pick<Logger, 'warn' | 'info'>,
): BotStatus {
  const heartbeatPath = botHeartbeatPath(dataDir, bot.botId);
  let lastHeartbeatAt: number | null = null;
  let online = false;

  if (existsSync(heartbeatPath)) {
    try {
      const tsSec = parseInt(readFileSync(heartbeatPath, 'utf8').trim(), 10);
      if (!Number.isNaN(tsSec)) {
        lastHeartbeatAt = tsSec * 1000;
        online = (now - lastHeartbeatAt) < staleMs;
      }
    } catch (error) {
      logger?.warn?.({ botId: bot.botId, heartbeatPath, error }, 'failed to read bot heartbeat');
    }
  }

  let agentAllowed: string[] | undefined;
  try {
    agentAllowed = loadBotEnvFromFile(bot.configPath).agentAllowed;
  } catch (error) {
    logger?.warn?.({ botId: bot.botId, configPath: bot.configPath, error }, 'failed to load bot env during captain discovery');
  }

  return {
    botId: bot.botId,
    configPath: bot.configPath,
    online,
    lastHeartbeatAt,
    agentAllowed,
  };
}
