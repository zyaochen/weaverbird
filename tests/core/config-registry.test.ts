import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { afterEach, describe, expect, it } from 'vitest';
import { CODES, ConfigError, loadConfig } from '../../packages/core/src/index.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('T2-config-default', () => {
  it('returns defaults when config file is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-config-registry-'));
    roots.push(dir);
    mkdirSync(join(dir, 'config'), { recursive: true });

    const defaults = { enabled: true };
    const schema = z.object({ enabled: z.boolean() });

    expect(loadConfig(dir, 'observability', schema, defaults)).toEqual(defaults);
  });
});

describe('T2b-config-missing', () => {
  it('throws ConfigError when config file is missing and defaults are omitted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-config-registry-'));
    roots.push(dir);
    mkdirSync(join(dir, 'config'), { recursive: true });

    expect(() => loadConfig(dir, 'observability', z.object({ enabled: z.boolean() }))).toThrow(ConfigError);

    try {
      loadConfig(dir, 'observability', z.object({ enabled: z.boolean() }));
      throw new Error('expected ConfigError');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).code).toBe(CODES.E_CONFIG_MISSING);
    }
  });
});

describe('T3-config-parse-error', () => {
  it('throws ConfigError when config json is malformed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-config-registry-'));
    roots.push(dir);
    const configDir = join(dir, 'config');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'observability.json'), '{invalid-json');

    expect(() => loadConfig(dir, 'observability', z.object({ enabled: z.boolean() }), { enabled: true })).toThrow(ConfigError);

    try {
      loadConfig(dir, 'observability', z.object({ enabled: z.boolean() }), { enabled: true });
      throw new Error('expected ConfigError');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).code).toBe(CODES.E_CONFIG_PARSE);
    }
  });
});
