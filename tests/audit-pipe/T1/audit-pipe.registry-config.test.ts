import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadAuditPipeConfig } from '../../../packages/core/src/audit-pipe/config.js';
import { AUDIT_PIPE_ERROR_CODES, AuditPipeError } from '../../../packages/core/src/audit-pipe/contracts.js';

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'wb-audit-registry-cfg-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeDomainConfig(dir: string, value: unknown, mode = 0o600): string {
  const configDir = join(dir, 'config');
  mkdirSync(configDir, { recursive: true });
  const path = join(configDir, 'audit-pipe.json');
  writeFileSync(path, JSON.stringify(value, null, 2));
  chmodSync(path, mode);
  return path;
}

describe('T1 audit-pipe registry config', () => {
  it('defaults when config file is missing', () => {
    withTempDir((dir) => {
      const config = loadAuditPipeConfig({ env: { WB_DATA_DIR: dir } });
      expect(config.audit.enabled).toBe(false);
    });
  });

  it('throws parse error on malformed audit-pipe domain file', () => {
    withTempDir((dir) => {
      const configDir = join(dir, 'config');
      mkdirSync(configDir, { recursive: true });
      const path = join(configDir, 'audit-pipe.json');
      writeFileSync(path, '{bad-json');
      chmodSync(path, 0o600);
      expect(() => loadAuditPipeConfig({ env: { WB_DATA_DIR: dir } })).toThrow(AuditPipeError);
      try {
        loadAuditPipeConfig({ env: { WB_DATA_DIR: dir } });
      } catch (error) {
        expect((error as AuditPipeError).code).toBe(AUDIT_PIPE_ERROR_CODES.E_CFG_INVALID_JSON);
      }
    });
  });

  it('loads enabled config from config/audit-pipe.json', () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, 'config.json'), JSON.stringify({
        audit: {
          enabled: true,
          bitable_base_id: { type: 'literal', value: 'legacy-base' },
          bitable_table_id: { type: 'literal', value: 'legacy-table' },
          app_id: { type: 'literal', value: 'legacy-app' },
          app_secret: { type: 'literal', value: 'legacy-secret-32-characters-0000' },
          lark_domain: 'https://open.larkoffice.com',
        },
      }, null, 2));
      chmodSync(join(dir, 'config.json'), 0o600);

      const legacyConfig = loadAuditPipeConfig({ env: { WB_DATA_DIR: dir } });
      expect(legacyConfig.audit.enabled).toBe(true);
      if (legacyConfig.audit.enabled) {
        expect(legacyConfig.audit.bitable_base_id).toBe('legacy-base');
      }

      writeDomainConfig(dir, {
        enabled: true,
        bitable_base_id: { type: 'literal', value: 'bascn123' },
        bitable_table_id: { type: 'literal', value: 'tblXYZ' },
        app_id: { type: 'literal', value: 'cli_xxxxxxxxxxxxxxxx' },
        app_secret: { type: 'literal', value: 'secret-32-characters-000000000000' },
        lark_domain: 'https://open.larkoffice.com',
      });
      const config = loadAuditPipeConfig({ env: { WB_DATA_DIR: dir } });
      expect(config.audit.enabled).toBe(true);
      if (config.audit.enabled) {
        expect(config.audit.bitable_base_id).toBe('bascn123');
      }
    });
  });
});
