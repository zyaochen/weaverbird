import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CODES } from '../../packages/core/src/config/errors.js';
import { loadObservabilityConfig } from '../../packages/core/src/run-observability/config-loader.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('T14 config defaults', () => {
  it('returns defaults when config file is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-obs-config-'));
    roots.push(dir);
    mkdirSync(join(dir, 'config'), { recursive: true });
    const result = loadObservabilityConfig(dir);
    expect(result.config.silent_timeout_s).toBe(300);
    expect(result.config.alert_enabled).toBe(true);
    expect(result.errorCode).toBe(CODES.E_CONFIG_PARSE);
  });
});
