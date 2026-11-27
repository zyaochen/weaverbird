import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadRunRegistryConfig } from '../../packages/core/src/run-registry/config.js';
import { RunRegistryConfigSchema, RUN_REGISTRY_ERROR_CODES, RunRegistryError } from '../../packages/core/src/run-registry/index.js';

const roots: string[] = [];

function writeDomainConfig(dir: string, domain: string, value: unknown, mode = 0o600): string {
  const configDir = join(dir, 'config');
  mkdirSync(configDir, { recursive: true });
  const path = join(configDir, `${domain}.json`);
  writeFileSync(path, JSON.stringify(value, null, 2));
  chmodSync(path, mode);
  return path;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('T1 run-registry config registry', () => {
  it('throws missing-style registry error when config file is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-run-registry-cfg-'));
    roots.push(dir);
    expect(() => loadRunRegistryConfig({ env: { WB_DATA_DIR: dir } })).toThrow(RunRegistryError);
    try {
      loadRunRegistryConfig({ env: { WB_DATA_DIR: dir } });
    } catch (error) {
      expect((error as RunRegistryError).code).toBe(RUN_REGISTRY_ERROR_CODES.E_CFG_MISSING);
    }
  });

  it('throws parse-style registry error on malformed config json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-run-registry-cfg-'));
    roots.push(dir);
    const configDir = join(dir, 'config');
    mkdirSync(configDir, { recursive: true });
    const path = join(configDir, 'run-registry.json');
    writeFileSync(path, '{not-valid-json');
    chmodSync(path, 0o600);

    expect(() => loadRunRegistryConfig({ env: { WB_DATA_DIR: dir } })).toThrow(RunRegistryError);
    try {
      loadRunRegistryConfig({ env: { WB_DATA_DIR: dir } });
    } catch (error) {
      expect((error as RunRegistryError).code).toBe(RUN_REGISTRY_ERROR_CODES.E_CFG_INVALID);
    }
  });

  it('loads config from config/run-registry.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-run-registry-cfg-'));
    roots.push(dir);
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      run_registry: {
        bitable_base_id: 'LEGACY',
        bitable_table_id: 'tbl-legacy',
        app_id: 'cli_legacy',
        app_secret: 'secret-legacy',
        lark_domain: 'https://open.larkoffice.com',
      },
    }, null, 2));
    chmodSync(join(dir, 'config.json'), 0o600);

    const legacyConfig = loadRunRegistryConfig({ env: { WB_DATA_DIR: dir } });
    expect(legacyConfig.bitable_base_id).toBe('LEGACY');
    expect(legacyConfig.run_finalize_grace_ms).toBe(30_000);

    writeDomainConfig(dir, 'run-registry', {
      bitable_base_id: 'BAS1',
      bitable_table_id: 'tbl1',
      app_id: 'cli_xxx',
      app_secret: 'secret',
      lark_domain: 'https://open.larkoffice.com',
    });

    const config = loadRunRegistryConfig({ env: { WB_DATA_DIR: dir } });
    expect(config.bitable_base_id).toBe('BAS1');
    expect(config.run_finalize_grace_ms).toBe(30_000);
  });
});
