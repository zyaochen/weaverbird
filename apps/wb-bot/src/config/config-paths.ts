import { homedir } from 'node:os';
import { join } from 'node:path';

export function resolveBotConfigDir(opts: { configDir?: string } = {}): string {
  if (opts.configDir && opts.configDir.trim()) return opts.configDir.trim();
  const envDir = process.env['WB_CONFIG_DIR'];
  if (envDir && envDir.trim()) return envDir.trim();
  return join(homedir(), '.weaverbird', 'configs');
}

export function resolveConfigDir(): string {
  return resolveBotConfigDir();
}

export function botEnvPath(configDir: string, botId: string): string {
  return join(configDir, `.env.${botId}`);
}
