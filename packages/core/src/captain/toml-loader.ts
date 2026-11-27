import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { CAPTAIN_ERROR_CODES, CaptainError, CaptainTomlSchema, type CaptainMapping, type CaptainTomlConfig } from './contracts.js';

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null;
}

function resolveCaptainMappingPaths(opts: { cwd?: string; homeDir?: string } = {}): {
  repoJsonPath: string;
  repoTomlPath: string;
  localJsonPath: string;
} {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const homeDir = resolve(opts.homeDir ?? homedir());
  return {
    repoJsonPath: join(cwd, 'captain.json'),
    repoTomlPath: join(cwd, 'captain.toml'),
    localJsonPath: join(homeDir, '.weaverbird', 'captain.json'),
  };
}

function parseJsonConfig(path: string): CaptainTomlConfig {
  try {
    return CaptainTomlSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    throw new CaptainError(CAPTAIN_ERROR_CODES.E_TOML_INVALID, `failed to parse ${path}: ${error instanceof Error ? error.message : String(error)}`, error);
  }
}

// Minimal TOML subset parser for the captain mapping shape.
// Supports: `#` comments, `key = "string"` scalars at root (only `version` is honored),
// and `[[mapping]]` array-of-tables entries with scalar values.
// Anything outside that subset throws E_TOML_INVALID so users cannot silently drift.
function parseTomlConfig(path: string): CaptainTomlConfig {
  const raw = readFileSync(path, 'utf8');
  const out: { version?: number; mapping: Array<Record<string, string>> } = { mapping: [] };
  let current: Record<string, string> | null = null;
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    if (line === '[[mapping]]') {
      current = {};
      out.mapping.push(current);
      continue;
    }
    const match = /^([A-Za-z0-9_]+)\s*=\s*"([^"]*)"\s*$/.exec(line) ?? /^([A-Za-z0-9_]+)\s*=\s*(\d+)\s*$/.exec(line);
    if (!match || match[1] === undefined || match[2] === undefined) {
      throw new CaptainError(CAPTAIN_ERROR_CODES.E_TOML_INVALID, `unsupported TOML line in ${path}: ${line}`);
    }
    const key = match[1];
    const value = match[2];
    if (!current) {
      if (key === 'version') out.version = Number(value);
      else throw new CaptainError(CAPTAIN_ERROR_CODES.E_TOML_INVALID, `unsupported root key in ${path}: ${key}`);
      continue;
    }
    current[key] = value;
  }
  try {
    return CaptainTomlSchema.parse({ version: out.version ?? 1, mapping: out.mapping });
  } catch (error) {
    throw new CaptainError(CAPTAIN_ERROR_CODES.E_TOML_INVALID, `failed to parse ${path}: ${error instanceof Error ? error.message : String(error)}`, error);
  }
}

function mergeMappings(base: CaptainMapping[], override: CaptainMapping[]): CaptainMapping[] {
  const merged = new Map<string, CaptainMapping>();
  for (const mapping of base) merged.set(mapping.captain_id, mapping);
  for (const mapping of override) merged.set(mapping.captain_id, mapping);
  return [...merged.values()];
}

export function loadCaptainConfig(opts: { cwd?: string; homeDir?: string } = {}): CaptainTomlConfig {
  const { repoJsonPath, repoTomlPath, localJsonPath } = resolveCaptainMappingPaths(opts);

  const repoExists = existsSync(repoJsonPath);
  const repoTomlExists = existsSync(repoTomlPath);
  const localExists = existsSync(localJsonPath);

  if (!repoExists && !repoTomlExists && !localExists) {
    throw new CaptainError(CAPTAIN_ERROR_CODES.E_TOML_MISSING, 'captain.json is missing in repo root and ~/.weaverbird');
  }

  const repoConfig = repoExists ? parseJsonConfig(repoJsonPath) : repoTomlExists ? parseTomlConfig(repoTomlPath) : { version: 1, mapping: [] };
  const localConfig = localExists ? parseJsonConfig(localJsonPath) : { version: 1, mapping: [] };
  return CaptainTomlSchema.parse({
    version: Math.max(repoConfig.version, localConfig.version),
    mapping: mergeMappings(repoConfig.mapping, localConfig.mapping),
  });
}
