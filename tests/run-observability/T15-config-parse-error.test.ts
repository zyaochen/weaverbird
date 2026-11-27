import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CODES } from '../../packages/core/src/config/errors.js';
import { loadObservabilityConfig } from '../../packages/core/src/run-observability/config-loader.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('T15 config parse error', () => {
  it('falls back to defaults and returns E_CONFIG_PARSE when config is invalid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-obs-config-'));
    roots.push(dir);
    const configDir = join(dir, 'config');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'run-observability.json'), '{invalid-json');
    const result = loadObservabilityConfig(dir);
    expect(result.config.silent_timeout_s).toBe(300);
    expect(result.errorCode).toBe(CODES.E_CONFIG_PARSE);
  });
});
