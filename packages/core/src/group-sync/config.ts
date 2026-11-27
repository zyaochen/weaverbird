import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../config/registry.js';
import { configFile, legacyConfigJsonPath, resolveDataDir } from '../paths.js';
import { GroupSyncConfigSchema, type GroupSyncConfig } from './contracts.js';

function validateMode(path: string): void {
  const stat = statSync(path);
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`${path} permissions are too open (${(stat.mode & 0o777).toString(8)}), expected 600`);
  }
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseLegacyConfig(path: string): GroupSyncConfig {
  const parsed = readJson(path);
  if (!isRecord(parsed) || !isRecord(parsed['group_sync'])) {
    throw new Error('config.json must contain a group_sync object');
  }
  return GroupSyncConfigSchema.parse(parsed['group_sync']);
}

export function resolveGroupSyncDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolveDataDir({ dataDir: env['WB_DATA_DIR'] });
}

export function resolveGroupSyncConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(configFile(resolveGroupSyncDataDir(env), 'group-sync'));
}

export function loadGroupSyncConfig(options: { configPath?: string; env?: NodeJS.ProcessEnv } = {}): GroupSyncConfig {
  const env = options.env ?? process.env;
  const dataDir = resolveGroupSyncDataDir(env);
  const configPath = resolve(options.configPath ?? resolveGroupSyncConfigPath(env));
  const legacyPath = resolve(legacyConfigJsonPath(dataDir));

  if (existsSync(configPath)) {
    validateMode(configPath);
    return GroupSyncConfigSchema.parse(loadConfig(dataDir, 'group-sync', GroupSyncConfigSchema, {}));
  }

  if (existsSync(legacyPath)) {
    validateMode(legacyPath);
    return parseLegacyConfig(legacyPath);
  }

  return GroupSyncConfigSchema.parse({});
}

