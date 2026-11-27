import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../config/registry.js';
import { configFile, legacyConfigJsonPath, resolveDataDir } from '../paths.js';
import { PeriodicTasksConfigSchema, type PeriodicTasksConfig } from './contracts.js';

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

function parseLegacyConfig(path: string): PeriodicTasksConfig {
  const parsed = readJson(path);
  if (!isRecord(parsed) || !isRecord(parsed['periodic_tasks'])) {
    throw new Error('config.json must contain a periodic_tasks object');
  }
  return PeriodicTasksConfigSchema.parse(parsed['periodic_tasks']);
}

export function resolvePeriodicTasksDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolveDataDir({ dataDir: env['WB_DATA_DIR'] });
}

export function resolvePeriodicTasksConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(configFile(resolvePeriodicTasksDataDir(env), 'periodic-tasks'));
}

export function loadPeriodicTasksConfig(options: { configPath?: string; env?: NodeJS.ProcessEnv } = {}): PeriodicTasksConfig {
  const env = options.env ?? process.env;
  const dataDir = resolvePeriodicTasksDataDir(env);
  const configPath = resolve(options.configPath ?? resolvePeriodicTasksConfigPath(env));
  const legacyPath = resolve(legacyConfigJsonPath(dataDir));

  if (existsSync(configPath)) {
    validateMode(configPath);
    return PeriodicTasksConfigSchema.parse(loadConfig(dataDir, 'periodic-tasks', PeriodicTasksConfigSchema, {}));
  }

  if (existsSync(legacyPath)) {
    validateMode(legacyPath);
    return parseLegacyConfig(legacyPath);
  }

  return PeriodicTasksConfigSchema.parse({});
}
