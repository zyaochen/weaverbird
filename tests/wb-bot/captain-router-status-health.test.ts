import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DefaultAgentRegistry } from '../../packages/core/src/agent/registry.js';
import { ClaudeCodeAgent } from '../../packages/core/src/agent/claude-code.js';
import { CodexAgent } from '../../packages/core/src/agent/codex.js';
import { BindingStore } from '../../apps/wb-bot/src/binding/store.js';
import { TaskIndex } from '../../apps/wb-bot/src/binding/task-index.js';
import { resetAgentListCache, runCommand } from '../../apps/wb-bot/src/commands/router.js';
import type { ControlPlaneConfig } from '../../apps/wb-bot/src/feishu/event-handler.js';

let root = '';
let store: BindingStore;
let cp: ControlPlaneConfig;
const registry = new DefaultAgentRegistry([
  { agent: new ClaudeCodeAgent(), command: 'claude' },
  { agent: new CodexAgent(), command: 'codex' },
]);

beforeEach(() => {
  resetAgentListCache();
  root = mkdtempSync(join(tmpdir(), 'wb-captain-router-status-'));
  store = new BindingStore(join(root, 'wb-bot.db'));
  cp = {
    botId: 'default',
    dataDir: root,
    taskIndex: new TaskIndex(root, 'default'),
    logFilePath: join(root, 'logs', 'default', 'wb-bot.log'),
    wsClientStatus: () => ({ lastEventAt: Date.now() - 5000 }),
  };
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

describe('router /status and /health captain gating', () => {
  it('keeps single-bot /status output unchanged', async () => {
    const out = await runCommand('/status', {
      userOpenId: 'u1',
      threadId: 't1',
      registry,
      store,
      botId: 'default',
      controlPlane: cp,
      activeSessions: () => [],
    });
    expect(out).toContain('📊 Weaverbird Status (single-bot mode');
    expect(out).toContain('(single-bot 模式: 仅显示本进程 active runs)');
  });

  it('renders captain /status card in multi-bot mode', async () => {
    const configDir = join(root, 'configs');
    const dataDir = join(root, 'data');
    mkdirSync(configDir, { recursive: true });
    writeBotEnv(configDir, 'default', 'claude-code,codex');
    writeBotEnv(configDir, 'claude', 'claude-code');
    const nowSec = Math.floor(Date.now() / 1000);
    writeHeartbeat(dataDir, 'default', String(nowSec));
    writeHeartbeat(dataDir, 'claude', String(nowSec));

    process.env['WB_MODE'] = 'multi-bot';
    process.env['WB_CONFIG_DIR'] = configDir;
    process.env['WB_DATA_DIR'] = dataDir;

    const out = await runCommand('/status', {
      userOpenId: 'u1',
      threadId: 't1',
      registry,
      store,
      botId: 'default',
      controlPlane: cp,
      activeSessions: () => [],
    });
    expect(out).toContain('📊 Weaverbird Status');
    expect(out).toContain('default (Captain)');
    expect(out?.startsWith('```')).toBe(true);
  });

  it('keeps single-bot /health output unchanged', async () => {
    const out = await runCommand('/health', {
      userOpenId: 'u1',
      threadId: 't1',
      registry,
      store,
      botId: 'default',
      controlPlane: cp,
    });
    expect(out).toContain('🩺 Health Check (single-bot mode)');
    expect(out).toContain('single-bot 模式: 跨 bot 心跳检查跳过');
  });

  it('renders captain /health with cross-bot check 4', async () => {
    const configDir = join(root, 'configs');
    const dataDir = join(root, 'data');
    mkdirSync(configDir, { recursive: true });
    writeBotEnv(configDir, 'default', 'claude-code,codex');
    writeBotEnv(configDir, 'claude', 'claude-code');
    writeHeartbeat(dataDir, 'default', String(Math.floor(Date.now() / 1000)));

    process.env['WB_MODE'] = 'multi-bot';
    process.env['WB_CONFIG_DIR'] = configDir;
    process.env['WB_DATA_DIR'] = dataDir;

    const out = await runCommand('/health', {
      userOpenId: 'u1',
      threadId: 't1',
      registry,
      store,
      botId: 'default',
      controlPlane: cp,
    });
    expect(out).toContain('🩺 Health Check (Captain mode)');
    expect(out).toContain('Worker 心跳');
  });
});
