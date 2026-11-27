import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DefaultAgentRegistry } from '../../packages/core/src/agent/registry.js';
import { ClaudeCodeAgent } from '../../packages/core/src/agent/claude-code.js';
import { CodexAgent } from '../../packages/core/src/agent/codex.js';
import { BindingStore } from '../../apps/wb-bot/src/binding/store.js';
import { runCommand } from '../../apps/wb-bot/src/commands/router.js';

let root = '';
let store: BindingStore;

const registry = new DefaultAgentRegistry([
  { agent: new ClaudeCodeAgent(), command: 'claude' },
  { agent: new CodexAgent(), command: 'codex' },
]);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wb-captain-router-'));
  store = new BindingStore(join(root, 'wb-bot.db'));
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
  delete process.env['WB_MODE'];
  delete process.env['WB_DISABLE_CAPTAIN'];
  delete process.env['WB_CONFIG_DIR'];
  delete process.env['WB_DATA_DIR'];
});

function writeBotEnv(configDir: string, botId: string, agentAllowed = 'claude-code'): void {
  writeFileSync(join(configDir, `.env.${botId}`), [
    `BOT_ID=${botId}`,
    `LARK_APP_ID=app_${botId}`,
    `LARK_APP_SECRET=secret_${botId}`,
    `AGENT_ALLOWED=${agentAllowed}`,
  ].join('\n'));
}

function writeHeartbeat(dataDir: string, botId: string, tsSec: string): void {
  const dir = join(dataDir, 'runs', botId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'heartbeat'), tsSec);
}

describe('runCommand /list-bots captain mode', () => {
  it('renders multi-bot list when captain gate is enabled', async () => {
    const configDir = join(root, 'configs');
    const dataDir = join(root, 'data');
    mkdirSync(configDir, { recursive: true });
    writeBotEnv(configDir, 'default', 'claude-code,codex');
    writeBotEnv(configDir, 'claude', 'claude-code');
    writeBotEnv(configDir, 'codex', 'codex');
    const nowSec = Math.floor(Date.now() / 1000);
    writeHeartbeat(dataDir, 'default', String(nowSec));
    writeHeartbeat(dataDir, 'claude', String(nowSec));

    process.env['WB_MODE'] = 'multi-bot';
    process.env['WB_CONFIG_DIR'] = configDir;
    process.env['WB_DATA_DIR'] = dataDir;

    const out = await runCommand('/list-bots', {
      userOpenId: 'u1',
      threadId: 't1',
      registry,
      store,
      botId: 'default',
    });

    expect(out).toContain('📋 已配置 bot');
    expect(out).toContain('default (Captain)');
    expect(out).toContain('claude');
    expect(out).toContain('codex');
    expect(out).toContain('离线 ✗ (无 heartbeat)');
    expect(out).toContain('在线 ✓');
    expect(out?.startsWith('```')).toBe(true);
  });

  it('falls back to W2 placeholder when captain is disabled', async () => {
    process.env['WB_MODE'] = 'multi-bot';
    process.env['WB_DISABLE_CAPTAIN'] = 'true';

    const out = await runCommand('/list-bots', {
      userOpenId: 'u1',
      threadId: 't1',
      registry,
      store,
      botId: 'default',
    });

    expect(out).toContain('📋 已配置 bot (single-bot mode)');
    expect(out).toContain('在线 ✓ (本进程)');
  });
});
