import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { configFile, legacyConfigJsonPath, resolveDataDir } from '../paths.js';
import { AUDIT_PIPE_ERROR_CODES, type AuditPipeConfig, AuditPipeConfigSchema, AuditPipeError, type ConfigSource } from './contracts.js';

export type LoadAuditPipeConfigOptions = { configPath?: string; env?: NodeJS.ProcessEnv };

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null;
}

function asConfigSource(value: unknown): ConfigSource {
  if (!isRecord(value) || typeof value['type'] !== 'string') {
    throw new AuditPipeError(AUDIT_PIPE_ERROR_CODES.E_CFG_BAD_SOURCE_TYPE, 'config source type is missing');
  }
  if (value['type'] === 'literal' && typeof value['value'] === 'string') {
    return { type: 'literal', value: value['value'] };
  }
  if (value['type'] === 'env' && typeof value['name'] === 'string') {
    return { type: 'env', name: value['name'] };
  }
  throw new AuditPipeError(AUDIT_PIPE_ERROR_CODES.E_CFG_BAD_SOURCE_TYPE, `unknown source type: ${String(value['type'])}`);
}

export function resolveAuditDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolveDataDir({ dataDir: env['WB_DATA_DIR'] });
}

export function resolveAuditPipeConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(configFile(resolveAuditDataDir(env), 'audit-pipe'));
}

export function resolveSource(src: ConfigSource, env: NodeJS.ProcessEnv): string {
  if (src.type === 'literal') {
    if (!src.value || src.value.startsWith('<')) {
      throw new AuditPipeError(AUDIT_PIPE_ERROR_CODES.E_CFG_PLACEHOLDER, 'config value is still a placeholder');
    }
    return src.value;
  }
  if (src.type === 'env') {
    const value = env[src.name];
    if (!value) {
      throw new AuditPipeError(AUDIT_PIPE_ERROR_CODES.E_CFG_MISSING_ENV, `env ${src.name} is missing`);
    }
    return value;
  }
  throw new AuditPipeError(AUDIT_PIPE_ERROR_CODES.E_CFG_BAD_SOURCE_TYPE, 'unknown config source type');
}

function validateMode(path: string): void {
  const stat = statSync(path);
  if ((stat.mode & 0o077) !== 0) {
    throw new AuditPipeError(AUDIT_PIPE_ERROR_CODES.E_CFG_PERM_TOO_OPEN, `${path} permissions are too open (${(stat.mode & 0o777).toString(8)}), expected 600`);
  }
}

function parseDomainConfig(raw: unknown, env: NodeJS.ProcessEnv): AuditPipeConfig {
  if (!isRecord(raw)) {
    throw new AuditPipeError(AUDIT_PIPE_ERROR_CODES.E_CFG_INVALID_JSON, 'audit-pipe config must be an object');
  }
  if (raw['enabled'] === false) {
    return AuditPipeConfigSchema.parse({ audit: { enabled: false } });
  }
  if (raw['enabled'] !== true) {
    throw new AuditPipeError(AUDIT_PIPE_ERROR_CODES.E_CFG_INVALID_JSON, 'enabled must be a boolean');
  }

  return AuditPipeConfigSchema.parse({
    audit: {
      enabled: true,
      bitable_base_id: resolveSource(asConfigSource(raw['bitable_base_id']), env),
      bitable_table_id: resolveSource(asConfigSource(raw['bitable_table_id']), env),
      app_id: resolveSource(asConfigSource(raw['app_id']), env),
      app_secret: resolveSource(asConfigSource(raw['app_secret']), env),
      lark_domain: typeof raw['lark_domain'] === 'string' && raw['lark_domain'].trim().length > 0 ? raw['lark_domain'].trim() : 'https://open.larkoffice.com',
    },
  });
}

function parseLegacyConfig(raw: unknown, env: NodeJS.ProcessEnv): AuditPipeConfig {
  if (!isRecord(raw) || !isRecord(raw['audit'])) {
    return AuditPipeConfigSchema.parse({ audit: { enabled: false } });
  }
  return parseDomainConfig(raw['audit'], env);
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new AuditPipeError(AUDIT_PIPE_ERROR_CODES.E_CFG_INVALID_JSON, `failed to parse ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function loadAuditPipeConfig(options: LoadAuditPipeConfigOptions = {}): AuditPipeConfig {
  const env = options.env ?? process.env;
  const dataDir = resolveAuditDataDir(env);
  const configPath = resolve(options.configPath ?? resolveAuditPipeConfigPath(env));
  const legacyPath = resolve(legacyConfigJsonPath(dataDir));

  if (existsSync(configPath)) {
    validateMode(configPath);
    const parsed = readJson(configPath);
    if (configPath.endsWith('config.json')) return parseLegacyConfig(parsed, env);
    return parseDomainConfig(parsed, env);
  }

  if (options.configPath) {
    return AuditPipeConfigSchema.parse({ audit: { enabled: false } });
  }

  if (existsSync(legacyPath)) {
    validateMode(legacyPath);
    console.warn('[audit-pipe] deprecated legacy config.json path in use; migrate to config/audit-pipe.json');
    const parsed = readJson(legacyPath);
    return parseLegacyConfig(parsed, env);
  }

  return AuditPipeConfigSchema.parse({ audit: { enabled: false } });
}
