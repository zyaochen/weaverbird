import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { loadBotEnvFromFile } from '../config/bot-env.js';
import { validateBotId } from '../security/bot-id-validator.js';

const IGNORED_ENV_SUFFIXES = new Set([
  'local',
  'example',
  'test',
  'development',
  'production',
  'staging',
]);

export interface DiscoveredBot {
  botId: string;
  configPath: string;
}

export interface DiscoveryWarning {
  file: string;
  reason: string;
}

export interface DiscoveryResult {
  bots: DiscoveredBot[];
  warnings: DiscoveryWarning[];
}

export function discoverBots(configDir: string, logger?: Pick<Logger, 'warn' | 'info'>): DiscoveryResult {
  if (!existsSync(configDir)) {
    throw new Error(`configDir not found: ${configDir}`);
  }

  const bots: DiscoveredBot[] = [];
  const warnings: DiscoveryWarning[] = [];

  for (const entry of readdirSync(configDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!entry.name.startsWith('.env.')) continue;

    const match = entry.name.match(/^\.env\.(.+)$/);
    if (!match) continue;

    const botId = match[1]!;
    if (IGNORED_ENV_SUFFIXES.has(botId)) {
      logger?.info?.({ file: entry.name, configDir }, 'skipping reserved env suffix');
      continue;
    }

    const validation = validateBotId(botId);
    if (!validation.ok) {
      const warning = { file: entry.name, reason: validation.reason ?? 'invalid botId' };
      warnings.push(warning);
      logger?.warn({ ...warning, configDir }, 'skipping invalid bot env filename');
      continue;
    }

    const configPath = join(configDir, entry.name);
    try {
      loadBotEnvFromFile(configPath);
      bots.push({ botId, configPath });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const warning = { file: entry.name, reason };
      warnings.push(warning);
      logger?.warn({ ...warning, configDir }, 'skipping invalid bot env file');
    }
  }

  bots.sort((left, right) => left.botId.localeCompare(right.botId));
  return { bots, warnings };
}
