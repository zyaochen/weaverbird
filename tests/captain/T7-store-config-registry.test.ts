import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCaptainSessionStore, type CaptainStoreClientLike } from '../../packages/core/src/captain/index.js';
import { CaptainError, CAPTAIN_ERROR_CODES } from '../../packages/core/src/captain/contracts.js';

const roots: string[] = [];

function makeClient(): CaptainStoreClientLike {
  return {
    bitable: {
      appTableField: {
        list: async () => ({ code: 0, msg: 'ok', data: { items: [] } }),
      },
      appTableRecord: {
        search: async () => ({ code: 0, msg: 'ok', data: { items: [] } }),
        batchCreate: async () => ({ code: 0, msg: 'ok', data: { records: [] } }),
        batchUpdate: async () => ({ code: 0, msg: 'ok', data: { records: [] } }),
      },
    },
  };
}

function writeCaptainStoreConfig(dir: string, value: unknown, mode = 0o600): void {
  const configDir = join(dir, 'config');
  mkdirSync(configDir, { recursive: true });
  const path = join(configDir, 'captain-store.json');
  writeFileSync(path, JSON.stringify(value, null, 2));
  chmodSync(path, mode);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('T7 captain-store config registry', () => {
  it('defaults through config registry when file is missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-captain-store-cfg-'));
    roots.push(dir);

    await expect(async () => createCaptainSessionStore({ env: { WB_DATA_DIR: dir }, _client: makeClient() })).rejects.toThrow(CaptainError);
    try {
      createCaptainSessionStore({ env: { WB_DATA_DIR: dir }, _client: makeClient() });
    } catch (error) {
      expect((error as CaptainError).code).toBe(CAPTAIN_ERROR_CODES.E_CONFIG_INCOMPLETE);
    }
  });

  it('throws CaptainError on malformed captain-store config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-captain-store-cfg-'));
    roots.push(dir);
    const configDir = join(dir, 'config');
    mkdirSync(configDir, { recursive: true });
    const path = join(configDir, 'captain-store.json');
    writeFileSync(path, '{bad-json');
    chmodSync(path, 0o600);

    expect(() => createCaptainSessionStore({ env: { WB_DATA_DIR: dir }, _client: makeClient() })).toThrow(CaptainError);
    try {
      createCaptainSessionStore({ env: { WB_DATA_DIR: dir }, _client: makeClient() });
    } catch (error) {
      expect((error as CaptainError).code).toBe(CAPTAIN_ERROR_CODES.E_CONFIG_INCOMPLETE);
    }
  });

  it('loads config from config/captain-store.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-captain-store-cfg-'));
    roots.push(dir);
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      captain: {
        bitable_base_id: 'legacy-b',
        sessions_table_id: 'legacy-t',
        app_id: 'legacy-a',
        app_secret: 'legacy-s',
        lark_domain: 'LarkSuite',
        captain_state_path: join(dir, 'captain-state.ndjson'),
        captain_toml_path: join(dir, 'captain.json'),
      },
    }, null, 2));
    chmodSync(join(dir, 'config.json'), 0o600);

    const legacyStore = createCaptainSessionStore({ env: { WB_DATA_DIR: dir }, _client: makeClient() });
    expect(legacyStore.config.sessions_table_id).toBe('legacy-t');

    writeCaptainStoreConfig(dir, {
      bitable_base_id: 'b',
      sessions_table_id: 't',
      app_id: 'a',
      app_secret: 's',
      lark_domain: 'LarkSuite',
      captain_state_path: join(dir, 'captain-state.ndjson'),
      captain_toml_path: join(dir, 'captain.json'),
    });

    const store = createCaptainSessionStore({ env: { WB_DATA_DIR: dir }, _client: makeClient() });
    expect(store.config.sessions_table_id).toBe('t');
  });
});
