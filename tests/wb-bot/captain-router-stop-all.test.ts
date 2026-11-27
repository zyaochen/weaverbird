import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DefaultAgentRegistry } from '../../packages/core/src/agent/registry.js';
import { ClaudeCodeAgent } from '../../packages/core/src/agent/claude-code.js';
import { CodexAgent } from '../../packages/core/src/agent/codex.js';
import { BindingStore } from '../../apps/wb-bot/src/binding/store.js';
import { resetAgentListCache, runCommand } from '../../apps/wb-bot/src/commands/router.js';

let root = '';
let store: BindingStore;
const registry = new DefaultAgentRegistry([
  { agent: new ClaudeCodeAgent(), command: 'claude' },
  { agent: new CodexAgent(), command: 'codex' },
]);

beforeEach(() => {
  resetAgentListCache();
  root = mkdtempSync(join(tmpdir(), 'wb-captain-router-stop-all-'));
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

function writeRun(dataDir: string, botId: string, runId: string, status: string): void {
  const runDir = join(dataDir, 'runs', botId, runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'status'), status);
}

describe('router /stop-all captain gating', () => {
  it('keeps single-bot no-session output unchanged', async () => {
    const out = await runCommand('/stop-all', {
      userOpenId: 'u1',
      threadId: 't1',
      registry,
      store,
      botId: 'default',
      activeSessions: () => [],
      stopAllSessions: async () => {},
    });
    expect(out).toBe('✅ 当前没有 active run');
  });

  it('keeps single-bot active-session output unchanged', async () => {
    const out = await runCommand('/stop-all', {
      userOpenId: 'u1',
      threadId: 't1',
      registry,
      store,
      botId: 'default',
      activeSessions: () => [
        { scopeKey: 'u1:t1:claude-code', agentId: 'claude-code', runId: 'r-aaaaaaaaaaaa', startedAt: Date.now(), stopState: 'running', terminalState: 'running', replyMessageId: 'm1' },
        { scopeKey: 'u1:t1:codex', agentId: 'codex', runId: 'r-bbbbbbbbbbbb', startedAt: Date.now(), stopState: 'running', terminalState: 'running', replyMessageId: 'm2' },
      ],
      stopAllSessions: async () => {},
    });
    expect(out).toContain('✅ 已向 2 个 active run 发送 stop 信号');
    expect(out).toContain('claude-code / r-aaaaaaaaaa');
    expect(out).toContain('codex / r-bbbbbbbbbb');
  });

  it('renders captain mode stop-all card for cross-bot active runs', async () => {
    const configDir = join(root, 'configs');
    const dataDir = join(root, 'data');
    mkdirSync(configDir, { recursive: true });
    writeBotEnv(configDir, 'default', 'claude-code');
    writeBotEnv(configDir, 'claude', 'claude-code');
    writeBotEnv(configDir, 'codex', 'codex');
    store.upsertInflightCard('default', { userOpenId: 'u1', threadId: 't1', sourceMessageId: 'm1', replyMessageId: 'r1', runId: 'r-default-1', agentId: 'claude-code' });
    store.upsertInflightCard('claude', { userOpenId: 'u2', threadId: 't2', sourceMessageId: 'm2', replyMessageId: 'r2', runId: 'r-claude-1', agentId: 'claude-code' });
    store.upsertInflightCard('codex', { userOpenId: 'u3', threadId: 't3', sourceMessageId: 'm3', replyMessageId: 'r3', runId: 'r-codex-1', agentId: 'codex' });
    writeRun(dataDir, 'default', 'r-default-1', 'running');
    writeRun(dataDir, 'claude', 'r-claude-1', 'running');
    writeRun(dataDir, 'codex', 'r-codex-1', 'running');

    process.env['WB_MODE'] = 'multi-bot';
    process.env['WB_CONFIG_DIR'] = configDir;
    process.env['WB_DATA_DIR'] = dataDir;

    const out = await runCommand('/stop-all', {
      userOpenId: 'u1',
      threadId: 't1',
      registry,
      store,
      botId: 'default',
    });
    expect(out).toContain('✅ 已向 3 个 active run 发送 stop 信号');
    expect(out).toContain('- default / r-default-1 : signal sent');
    expect(out).toContain('- claude / r-claude-1 : signal sent');
    expect(out).toContain('- codex / r-codex-1 : signal sent');
    expect(out?.startsWith('```')).toBe(true);
  });

  it('returns captain-mode no-active-run copy when nothing is running', async () => {
    const configDir = join(root, 'configs');
    const dataDir = join(root, 'data');
    mkdirSync(configDir, { recursive: true });
    writeBotEnv(configDir, 'default', 'claude-code');
    process.env['WB_MODE'] = 'multi-bot';
    process.env['WB_CONFIG_DIR'] = configDir;
    process.env['WB_DATA_DIR'] = dataDir;

    const out = await runCommand('/stop-all', {
      userOpenId: 'u1',
      threadId: 't1',
      registry,
      store,
      botId: 'default',
    });
    expect(out).toBe('✅ 当前没有 active run');
  });
});
