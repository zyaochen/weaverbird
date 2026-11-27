import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../config/registry.js';
import { configFile, legacyConfigJsonPath, resolveDataDir } from '../paths.js';
import { CalendarHookConfigSchema, type CalendarHookConfig } from './contracts.js';

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

function parseLegacyConfig(path: string): CalendarHookConfig {
  const parsed = readJson(path);
  if (!isRecord(parsed) || !isRecord(parsed['calendar_hook'])) {
    throw new Error('config.json must contain a calendar_hook object');
  }
  return CalendarHookConfigSchema.parse(parsed['calendar_hook']);
}

export function resolveCalendarHookDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolveDataDir({ dataDir: env['WB_DATA_DIR'] });
}

export function resolveCalendarHookConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(configFile(resolveCalendarHookDataDir(env), 'calendar-hook'));
}

export function loadCalendarHookConfig(options: { configPath?: string; env?: NodeJS.ProcessEnv } = {}): CalendarHookConfig {
  const env = options.env ?? process.env;
  const dataDir = resolveCalendarHookDataDir(env);
  const configPath = resolve(options.configPath ?? resolveCalendarHookConfigPath(env));
  const legacyPath = resolve(legacyConfigJsonPath(dataDir));

  if (existsSync(configPath)) {
    validateMode(configPath);
    return CalendarHookConfigSchema.parse(loadConfig(dataDir, 'calendar-hook', CalendarHookConfigSchema, {}));
  }

  if (existsSync(legacyPath)) {
    validateMode(legacyPath);
    return parseLegacyConfig(legacyPath);
  }

  return CalendarHookConfigSchema.parse({});
}
