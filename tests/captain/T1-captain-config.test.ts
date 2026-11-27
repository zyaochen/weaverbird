import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, CODES } from '../../packages/core/src/config/errors.js';
import { loadConcurrencyConfig } from '../../packages/core/src/captain/concurrency-config.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('T1-captain-config', () => {
  it('T1-defaults: missing file returns concurrency defaults', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-captain-config-'));
    roots.push(dir);
    mkdirSync(join(dir, 'config'), { recursive: true });

    expect(loadConcurrencyConfig(dir)).toEqual({
      max_concurrent_runs: 1,
      queue_max_depth: 10,
    });
  });

  it('T2-parse-error: malformed json throws ConfigError(config.parse_error)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-captain-config-'));
    roots.push(dir);
    const configDir = join(dir, 'config');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'captain.json'), '{invalid-json');

    expect(() => loadConcurrencyConfig(dir)).toThrow(ConfigError);

    try {
      loadConcurrencyConfig(dir);
      throw new Error('expected ConfigError');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).code).toBe(CODES.E_CONFIG_PARSE);
    }
  });

  it('T3-schema-violation: negative max_concurrent_runs throws ConfigError', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-captain-config-'));
    roots.push(dir);
    const configDir = join(dir, 'config');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'captain.json'), JSON.stringify({
      max_concurrent_runs: -1,
      queue_max_depth: 10,
    }));

    expect(() => loadConcurrencyConfig(dir)).toThrow(ConfigError);

    try {
      loadConcurrencyConfig(dir);
      throw new Error('expected ConfigError');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).code).toBe(CODES.E_CONFIG_PARSE);
    }
  });
});
