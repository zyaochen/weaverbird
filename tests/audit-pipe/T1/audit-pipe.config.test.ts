import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadAuditPipeConfig } from '../../../packages/core/src/audit-pipe/config.js';
import { AUDIT_PIPE_ERROR_CODES, AuditPipeError } from '../../../packages/core/src/audit-pipe/contracts.js';

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'wb-audit-cfg-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeConfig(path: string, value: unknown, mode = 0o600): void {
  writeFileSync(path, JSON.stringify(value, null, 2));
  chmodSync(path, mode);
}

describe('T1 config loader', () => {
  it('loads enabled config with literal and env sources', () => {
    withTempDir((dir) => {
      const configPath = join(dir, 'config.json');
      writeConfig(configPath, {
        audit: {
          enabled: true,
          bitable_base_id: { type: 'literal', value: 'bascn123' },
          bitable_table_id: { type: 'literal', value: 'tblXYZ' },
          app_id: { type: 'literal', value: 'cli_xxxxxxxxxxxxxxxx' },
          app_secret: { type: 'env', name: 'WEAVERBIRD_LARK_APP_SECRET' },
          lark_domain: 'https://open.larkoffice.com',
        },
      });
      const config = loadAuditPipeConfig({ configPath, env: { WEAVERBIRD_LARK_APP_SECRET: 'secret-32-characters-000000000000' } });
      expect(config.audit.enabled).toBe(true);
      if (config.audit.enabled) {
        expect(config.audit.bitable_base_id).toBe('bascn123');
        expect(config.audit.app_secret).toBe('secret-32-characters-000000000000');
        expect(config.audit.lark_domain).toBe('https://open.larkoffice.com');
      }
    });
  });

  it('returns disabled config without resolving sources', () => {
    withTempDir((dir) => {
      const configPath = join(dir, 'config.json');
      writeConfig(configPath, { audit: { enabled: false } });
      const config = loadAuditPipeConfig({ configPath, env: {} });
      expect(config.audit.enabled).toBe(false);
    });
  });

  it('rejects placeholder literal values', () => {
    withTempDir((dir) => {
      const configPath = join(dir, 'config.json');
      writeConfig(configPath, {
        audit: {
          enabled: true,
          bitable_base_id: { type: 'literal', value: 'bascn123' },
          bitable_table_id: { type: 'literal', value: 'tblXYZ' },
          app_id: { type: 'literal', value: 'cli_xxxxxxxxxxxxxxxx' },
          app_secret: { type: 'literal', value: '<your_app_secret>' },
          lark_domain: 'https://open.larkoffice.com',
        },
      });
      expect(() => loadAuditPipeConfig({ configPath, env: {} })).toThrow(AuditPipeError);
      try {
        loadAuditPipeConfig({ configPath, env: {} });
      } catch (error) {
        expect((error as AuditPipeError).code).toBe(AUDIT_PIPE_ERROR_CODES.E_CFG_PLACEHOLDER);
      }
    });
  });

  it('rejects missing env source', () => {
    withTempDir((dir) => {
      const configPath = join(dir, 'config.json');
      writeConfig(configPath, {
        audit: {
          enabled: true,
          bitable_base_id: { type: 'literal', value: 'bascn123' },
          bitable_table_id: { type: 'literal', value: 'tblXYZ' },
          app_id: { type: 'literal', value: 'cli_xxxxxxxxxxxxxxxx' },
          app_secret: { type: 'env', name: 'WEAVERBIRD_LARK_APP_SECRET' },
          lark_domain: 'https://open.larkoffice.com',
        },
      });
      expect(() => loadAuditPipeConfig({ configPath, env: {} })).toThrow(AuditPipeError);
      try {
        loadAuditPipeConfig({ configPath, env: {} });
      } catch (error) {
        expect((error as AuditPipeError).code).toBe(AUDIT_PIPE_ERROR_CODES.E_CFG_MISSING_ENV);
      }
    });
  });

  it('rejects config.json with permissions wider than 600', () => {
    withTempDir((dir) => {
      const configPath = join(dir, 'config.json');
      writeConfig(configPath, {
        audit: {
          enabled: true,
          bitable_base_id: { type: 'literal', value: 'bascn123' },
          bitable_table_id: { type: 'literal', value: 'tblXYZ' },
          app_id: { type: 'literal', value: 'cli_xxxxxxxxxxxxxxxx' },
          app_secret: { type: 'literal', value: 'secret-32-characters-000000000000' },
          lark_domain: 'https://open.larkoffice.com',
        },
      }, 0o644);
      expect(() => loadAuditPipeConfig({ configPath, env: {} })).toThrow(AuditPipeError);
      try {
        loadAuditPipeConfig({ configPath, env: {} });
      } catch (error) {
        expect((error as AuditPipeError).code).toBe(AUDIT_PIPE_ERROR_CODES.E_CFG_PERM_TOO_OPEN);
      }
    });
  });

  it('rejects invalid JSON', () => {
    withTempDir((dir) => {
      const configPath = join(dir, 'config.json');
      writeFileSync(configPath, '{not valid json');
      chmodSync(configPath, 0o600);
      expect(() => loadAuditPipeConfig({ configPath, env: {} })).toThrow(AuditPipeError);
      try {
        loadAuditPipeConfig({ configPath, env: {} });
      } catch (error) {
        expect((error as AuditPipeError).code).toBe(AUDIT_PIPE_ERROR_CODES.E_CFG_INVALID_JSON);
      }
    });
  });
});
