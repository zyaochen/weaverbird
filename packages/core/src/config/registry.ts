import { readFileSync } from 'node:fs';
import type { ZodSchema } from 'zod';
import { configFile } from '../paths.js';
import { CODES, ConfigError } from './errors.js';

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}

export function loadConfig<T>(
  dataDir: string,
  domain: string,
  schema: ZodSchema<T>,
): T;
export function loadConfig<T>(
  dataDir: string,
  domain: string,
  schema: ZodSchema<T>,
  defaults: T,
): T;
export function loadConfig<T>(
  dataDir: string,
  domain: string,
  schema: ZodSchema<T>,
  defaults?: T,
): T {
  const path = configFile(dataDir, domain);

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      if (defaults !== undefined) return defaults;
      throw new ConfigError(CODES.E_CONFIG_MISSING, `missing config for ${domain}`, error);
    }
    throw new ConfigError(CODES.E_CONFIG_PARSE, `failed to read config for ${domain}`, error);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(CODES.E_CONFIG_PARSE, `failed to parse config for ${domain}`, error);
  }

  try {
    return schema.parse(parsed);
  } catch (error) {
    throw new ConfigError(CODES.E_CONFIG_PARSE, `invalid config for ${domain}`, error);
  }
}
