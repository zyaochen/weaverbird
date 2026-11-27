import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DefaultAgentRegistry } from '../../packages/core/src/agent/registry.js';
import { ClaudeCodeAgent } from '../../packages/core/src/agent/claude-code.js';
import { BindingStore } from '../../apps/wb-bot/src/binding/store.js';
import { runCommand } from '../../apps/wb-bot/src/commands/router.js';
import { loadGroupSyncConfig } from '../../packages/core/src/group-sync/index.js';

const registry = new DefaultAgentRegistry([{ agent: new ClaudeCodeAgent(), command: 'claude' }]);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-wb-sync-'));
  roots.push(dir);
  return dir;
}

function seedGroupSyncConfig(dataDir: string, enabled = true): void {
  mkdirSync(join(dataDir, 'config'), { recursive: true });
  const path = join(dataDir, 'config', 'group-sync.json');
  writeFileSync(path, JSON.stringify({
    enabled,
    transport: 'mock',
    rpc_timeout_ms: 1_000,
    sweep_interval_ms: 5_000,
  }));
  chmodSync(path, 0o600);
}

describe('/wb sync slash command', () => {
  it('rejects when control plane is missing', async () => {
    const dataDir = makeDir();
    seedGroupSyncConfig(dataDir, true);
    const store = new BindingStore(join(makeDir(), 'wb-bot.db'));
    const response = await runCommand('/wb sync run', {
      userOpenId: 'u1',
      threadId: 't1',
      registry,
      store,
      botId: 'default',
    });
    expect(response).toContain('⚠️ /wb sync 不可用');
    store.close();
  });

  it('rejects when group-sync is disabled in config', async () => {
    const dataDir = makeDir();
    seedGroupSyncConfig(dataDir, false);
    const store = new BindingStore(join(makeDir(), 'wb-bot.db'));
    const response = await runCommand('/wb sync run', {
      userOpenId: 'u1',
      threadId: 't1',
      registry,
      store,
      botId: 'default',
      controlPlane: {
        botId: 'default',
        dataDir,
        taskIndex: {} as never,
        logFilePath: '/dev/null',
        wsClientStatus: () => ({ lastEventAt: null }),
      },
    });
    expect(response).toContain('group-sync 未启用');
    store.close();
  });

  it('returns run acknowledgment when enabled', async () => {
    const dataDir = makeDir();
    seedGroupSyncConfig(dataDir, true);
    const store = new BindingStore(join(makeDir(), 'wb-bot.db'));
    const response = await runCommand('/wb sync run', {
      userOpenId: 'u1',
      threadId: 't1',
      registry,
      store,
      botId: 'default',
      controlPlane: {
        botId: 'default',
        dataDir,
        taskIndex: {} as never,
        logFilePath: '/dev/null',
        wsClientStatus: () => ({ lastEventAt: null }),
      },
    });
    expect(response).toContain('✅ sync 已开始');
    expect(response).toMatch(/run-wb-sync-[a-z0-9]+/);
    const config = loadGroupSyncConfig({ env: { WB_DATA_DIR: dataDir } });
    expect(config.enabled).toBe(true);
    store.close();
  });

  it('rejects unknown sub-command', async () => {
    const dataDir = makeDir();
    seedGroupSyncConfig(dataDir, true);
    const store = new BindingStore(join(makeDir(), 'wb-bot.db'));
    const response = await runCommand('/wb sync clean', {
      userOpenId: 'u1',
      threadId: 't1',
      registry,
      store,
      botId: 'default',
      controlPlane: {
        botId: 'default',
        dataDir,
        taskIndex: {} as never,
        logFilePath: '/dev/null',
        wsClientStatus: () => ({ lastEventAt: null }),
      },
    });
    expect(response).toBe('Usage: /wb sync run');
    store.close();
  });
});
