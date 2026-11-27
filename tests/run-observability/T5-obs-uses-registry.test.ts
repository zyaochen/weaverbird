import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadObservabilityConfig } from '../../packages/core/src/run-observability/config-loader.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('T5-obs-uses-registry', () => {
  it('loads observability config from config/run-observability.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-obs-registry-'));
    roots.push(dir);

    mkdirSync(join(dir, 'run-observability'), { recursive: true });
    writeFileSync(join(dir, 'run-observability', 'config.json'), JSON.stringify({
      enabled: false,
      silent_timeout_s: 600,
    }));

    mkdirSync(join(dir, 'config'), { recursive: true });
    writeFileSync(join(dir, 'config', 'run-observability.json'), JSON.stringify({
      enabled: true,
      alert_enabled: false,
      silent_timeout_s: 601,
    }));

    const result = loadObservabilityConfig(dir);
    expect(result.errorCode).toBeNull();
    expect(result.config.enabled).toBe(true);
    expect(result.config.alert_enabled).toBe(false);
    expect(result.config.silent_timeout_s).toBe(601);
  });
});
