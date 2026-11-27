import { existsSync } from 'node:fs';
import type { ZodSchema } from 'zod';
import { CODES } from '../config/errors.js';
import { loadConfig } from '../config/registry.js';
import { configFile } from '../paths.js';
import { ObservabilityConfigSchema, type ObservabilityConfig } from './contracts.js';

export function loadObservabilityConfig(dataDir: string): { config: ObservabilityConfig; errorCode: string | null } {
  const defaults: ObservabilityConfig = ObservabilityConfigSchema.parse({}) as ObservabilityConfig;
  const path = configFile(dataDir, 'run-observability');
  const missing = !existsSync(path);

  try {
    const config = loadConfig(
      dataDir,
      'run-observability',
      ObservabilityConfigSchema as unknown as ZodSchema<ObservabilityConfig>,
      defaults,
    );
    return {
      config,
      errorCode: missing ? CODES.E_CONFIG_PARSE : null,
    };
  } catch {
    return {
      config: defaults,
      errorCode: CODES.E_CONFIG_PARSE,
    };
  }
}
