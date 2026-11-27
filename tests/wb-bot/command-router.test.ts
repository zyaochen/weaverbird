import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DefaultAgentRegistry } from '../../packages/core/src/agent/registry.js';
import { ClaudeCodeAgent } from '../../packages/core/src/agent/claude-code.js';
import { CodexAgent } from '../../packages/core/src/agent/codex.js';
import { BindingStore } from '../../apps/wb-bot/src/binding/store.js';
import { resetAgentListCache, runCommand } from '../../apps/wb-bot/src/commands/router.js';

let dir = '';
let store: BindingStore;
const registry = new DefaultAgentRegistry([
  { agent: new ClaudeCodeAgent(), command: 'claude' },
  { agent: new CodexAgent(), command: 'codex' },
]);

beforeEach(() => {
  resetAgentListCache();
  dir = mkdtempSync(join(tmpdir(), 'wb-bot-router-'));
  store = new BindingStore(join(dir, 'wb-bot.db'));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function ctx() {
  return { userOpenId: 'u1', threadId: 't1', registry, store, botId: 'default' };
}

describe('command router', () => {
  it('switches agent and reports current state without exposing tokens', async () => {
    store.upsertContinuation('default', 'u1', 't1', 'codex', 'secret-token');
    await expect(runCommand('/use codex', ctx())).resolves.toContain('继续之前 codex 会话');
    await expect(runCommand('/now', ctx())).resolves.toBe('agent: codex\ncwd: -\n上下文: 有');
  });

  it('handles cwd aliases and unknown commands', async () => {
    await expect(runCommand('/cwd-list', ctx())).resolves.toBe('没有已保存的 cwd alias');
    await expect(runCommand('/cwd-add tmp /tmp', ctx())).resolves.toContain('已保存 cwd alias');
    await expect(runCommand('/cwd tmp', ctx())).resolves.toContain('已设置 cwd');
    await expect(runCommand('/cwd-rm tmp', ctx())).resolves.toContain('已删除 alias');
    await expect(runCommand('/nope', ctx())).resolves.toContain('未知命令 /nope');
  });

  it('rejects protected cwd targets and explains why', async () => {
    await expect(runCommand('/cwd /etc', ctx())).resolves.toContain('❌ 路径不允许: /etc. denied (protected): /etc');
  });

  it('returns stop no-active-run message and list-agents output', async () => {
    await expect(runCommand('/stop', ctx())).resolves.toBe('当前没有可停止的运行');
    await expect(runCommand(' /list-agents', ctx())).resolves.toContain('Claude Code');
    await expect(runCommand('/list-agents', ctx())).resolves.toContain('streaming');
    await expect(runCommand('/list-agents', ctx())).resolves.toContain('resumable');
    await expect(runCommand('/help', ctx())).resolves.toContain('/reset-context');
  });

  it('keeps now output limited to status lines', async () => {
    store.setCurrentAgent('default', 'u1', 't1', 'codex');
    await expect(runCommand('/now', ctx())).resolves.toBe('agent: codex\ncwd: -\n上下文: 无');
  });

  it('caches list-agents briefly to avoid repeated slow checks', async () => {
    const registry = {
      register() {},
      lookup() { return null; },
      list() {
        return [
          {
            id: 'claude-code',
            displayName: 'Claude Code',
            async isAvailable() { return true; },
            async getCapabilities() {
              return new ClaudeCodeAgent().getCapabilities();
            },
            run() { throw new Error('not used'); },
          },
        ];
      },
      isAvailable: vi.fn(async () => true),
    };
    const commandCtx = { userOpenId: 'u1', threadId: 't1', registry, store, botId: 'default' };

    const first = await runCommand('/list-agents', commandCtx);
    const second = await runCommand('/list-agents', commandCtx);

    expect(first).toBe(second);
    expect(registry.isAvailable).toHaveBeenCalledTimes(1);
  });

  it('clears current agent context without exposing tokens', async () => {
    store.upsertContinuation('default', 'u1', 't1', 'claude-code', 'secret-token');
    await expect(runCommand('/reset-context', ctx())).resolves.toBe('已清空 claude-code 上下文');
    await expect(runCommand('/now', ctx())).resolves.toBe('agent: claude-code\ncwd: -\n上下文: 无');
    await expect(runCommand('/reset-context', ctx())).resolves.toBe('claude-code 当前没有可清空的上下文');
  });
});
