import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCodeAgent } from '../../packages/core/src/agent/claude-code.js';
import { CodexAgent } from '../../packages/core/src/agent/codex.js';
import { BindingStore } from '../../apps/wb-bot/src/binding/store.js';
import { resetAgentListCache, runCommand } from '../../apps/wb-bot/src/commands/router.js';

// W2.5-Hotfix-batch-D D2: /agents cache 从 module-level 改成 per-(botId, agentAllowed)
// 这里直接构造受控 fake registry 来观察 isAvailable 调用次数, 不依赖真实 PATH 可达性.

let dir = '';
let store: BindingStore;

function fakeAgent(id: string, displayName: string) {
  return {
    id,
    displayName,
    async isAvailable() { return true; },
    async getCapabilities() {
      // Reuse ClaudeCodeAgent's capabilities shape — 内容不重要, 我们只看缓存命中, 不断言文本.
      return new ClaudeCodeAgent().getCapabilities();
    },
    run() { throw new Error('not used'); },
  };
}

function makeRegistry(agentIds: string[]) {
  const agents = agentIds.map((id) => fakeAgent(id, id));
  return {
    register() {},
    lookup() { return null; },
    list() { return agents; },
    isAvailable: vi.fn(async () => true),
  };
}

beforeEach(() => {
  resetAgentListCache();
  dir = mkdtempSync(join(tmpdir(), 'wb-bot-agents-cache-'));
  store = new BindingStore(join(dir, 'wb-bot.db'));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('/agents per-context cache (W2.5-Hotfix-batch-D D2)', () => {
  it('hits cache for the same ctx on repeated /agents calls', async () => {
    const registry = makeRegistry(['claude-code', 'codex']);
    const ctx = { userOpenId: 'u1', threadId: 't1', registry, store, botId: 'bot-a' };

    const first = await runCommand('/agents', ctx);
    const second = await runCommand('/agents', ctx);

    expect(first).toBe(second);
    // 2 agents · 1 次 miss → isAvailable 被调 2 次; 第二次完全命中, 不再调.
    expect(registry.isAvailable).toHaveBeenCalledTimes(2);
  });

  it('does not share cache across different botIds', async () => {
    // 两个 ctx 共用同一 registry 实例 (registry.list() 顺序 / 内容相同),
    // 但 botId 不同应该当成不同 cache key.
    const registry = makeRegistry(['claude-code', 'codex']);
    const ctxA = { userOpenId: 'u1', threadId: 't1', registry, store, botId: 'bot-a' };
    const ctxB = { userOpenId: 'u1', threadId: 't1', registry, store, botId: 'bot-b' };

    await runCommand('/agents', ctxA);
    await runCommand('/agents', ctxB);

    // 两次 miss, 每次都对 2 个 agent 调一次 isAvailable → 共 4 次.
    expect(registry.isAvailable).toHaveBeenCalledTimes(4);
  });

  it('does not share cache across different agentAllowed sets (different registries)', async () => {
    const registryA = makeRegistry(['claude-code']);
    const registryB = makeRegistry(['claude-code', 'codex']);
    const ctxA = { userOpenId: 'u1', threadId: 't1', registry: registryA, store, botId: 'default' };
    const ctxB = { userOpenId: 'u1', threadId: 't1', registry: registryB, store, botId: 'default' };

    await runCommand('/agents', ctxA);
    await runCommand('/agents', ctxB);

    expect(registryA.isAvailable).toHaveBeenCalledTimes(1);
    expect(registryB.isAvailable).toHaveBeenCalledTimes(2);
  });

  it('resetAgentListCache() clears all entries — next /agents misses cache', async () => {
    const registry = makeRegistry(['claude-code', 'codex']);
    const ctx = { userOpenId: 'u1', threadId: 't1', registry, store, botId: 'bot-a' };

    await runCommand('/agents', ctx);
    expect(registry.isAvailable).toHaveBeenCalledTimes(2);

    // 第二次命中, 计数不变.
    await runCommand('/agents', ctx);
    expect(registry.isAvailable).toHaveBeenCalledTimes(2);

    resetAgentListCache();

    // reset 后第三次重新 miss, 再调 2 次.
    await runCommand('/agents', ctx);
    expect(registry.isAvailable).toHaveBeenCalledTimes(4);
  });
});
