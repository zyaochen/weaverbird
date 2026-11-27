import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ZodSchema } from 'zod';
import { loadConfig } from '../config/registry.js';
import { configFile, legacyConfigJsonPath, resolveDataDir } from '../paths.js';
import {
  RUN_REGISTRY_ERROR_CODES,
  RunRegistryConfigSchema,
  RunRegistryError,
  type RunRegistryConfig,
} from './contracts.js';

export type LoadRunRegistryConfigOptions = { configPath?: string; env?: NodeJS.ProcessEnv };

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null;
}

function validateMode(path: string): void {
  const stat = statSync(path);
  if ((stat.mode & 0o077) !== 0) {
    throw new RunRegistryError(RUN_REGISTRY_ERROR_CODES.E_CFG_INVALID, `${path} permissions are too open (${(stat.mode & 0o777).toString(8)}), expected 600`);
  }
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function parseLegacyConfig(path: string): RunRegistryConfig {
  let parsed: unknown;
  try {
    parsed = readJson(path);
  } catch (error) {
    throw new RunRegistryError(
      RUN_REGISTRY_ERROR_CODES.E_CFG_INVALID,
      `failed to parse ${path}: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }

  if (!isRecord(parsed) || !isRecord(parsed['run_registry'])) {
    throw new RunRegistryError(RUN_REGISTRY_ERROR_CODES.E_CFG_MISSING, 'config.json must contain a run_registry object');
  }

  try {
    return RunRegistryConfigSchema.parse(parsed['run_registry']);
  } catch (error) {
    throw new RunRegistryError(RUN_REGISTRY_ERROR_CODES.E_CFG_INVALID, 'run-registry config is invalid', error);
  }
}

export function resolveRunRegistryDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolveDataDir({ dataDir: env['WB_DATA_DIR'] });
}

export function resolveRunRegistryConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(configFile(resolveRunRegistryDataDir(env), 'run-registry'));
}

export function loadRunRegistryConfig(options: LoadRunRegistryConfigOptions = {}): RunRegistryConfig {
  const env = options.env ?? process.env;
  const dataDir = resolveRunRegistryDataDir(env);
  const configPath = resolve(options.configPath ?? resolveRunRegistryConfigPath(env));
  const legacyPath = resolve(legacyConfigJsonPath(dataDir));

  if (existsSync(configPath)) {
    validateMode(configPath);
    try {
      return loadConfig(
        dataDir,
        'run-registry',
        RunRegistryConfigSchema as unknown as ZodSchema<RunRegistryConfig>,
      );
    } catch (error) {
      throw new RunRegistryError(RUN_REGISTRY_ERROR_CODES.E_CFG_INVALID, 'run-registry config is invalid', error);
    }
  }

  if (options.configPath && existsSync(configPath)) {
    validateMode(configPath);
    try {
      const parsed = readJson(configPath);
      return RunRegistryConfigSchema.parse(parsed);
    } catch (error) {
      throw new RunRegistryError(RUN_REGISTRY_ERROR_CODES.E_CFG_INVALID, `failed to parse ${configPath}: ${error instanceof Error ? error.message : String(error)}`, error);
    }
  }

  if (existsSync(legacyPath)) {
    validateMode(legacyPath);
    console.warn('[run-registry] deprecated legacy config.json path in use; migrate to config/run-registry.json');
    return parseLegacyConfig(legacyPath);
  }

  try {
    return loadConfig(
      dataDir,
      'run-registry',
      RunRegistryConfigSchema as unknown as ZodSchema<RunRegistryConfig>,
    );
  } catch (error) {
    throw new RunRegistryError(RUN_REGISTRY_ERROR_CODES.E_CFG_MISSING, 'run-registry config is missing', error);
  }
}
