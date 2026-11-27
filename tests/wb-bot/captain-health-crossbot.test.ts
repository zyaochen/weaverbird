import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BindingStore } from '../../apps/wb-bot/src/binding/store.js';
import { TaskIndex } from '../../apps/wb-bot/src/binding/task-index.js';
import { renderHealth } from '../../apps/wb-bot/src/commands/health.js';
import type { ControlPlaneConfig } from '../../apps/wb-bot/src/feishu/event-handler.js';
import type { BotStatus } from '../../apps/wb-bot/src/captain/bot-discovery.js';

let dir = '';
let store: BindingStore;
let cp: ControlPlaneConfig;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wb-captain-health-'));
  store = new BindingStore(join(dir, 'wb-bot.db'));
  cp = {
    botId: 'default',
    dataDir: dir,
    taskIndex: new TaskIndex(dir, 'default'),
    logFilePath: join(dir, 'logs', 'default', 'wb-bot.log'),
    wsClientStatus: () => ({ lastEventAt: Date.now() - 5000 }),
  };
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function bot(botId: string, online: boolean, lastHeartbeatAt: number | null): BotStatus {
  return { botId, online, lastHeartbeatAt, configPath: `/tmp/.env.${botId}`, agentAllowed: ['claude-code'] };
}

describe('renderHealth cross-bot', () => {
  it('reports check 4 ok when all other bots are fresh', async () => {
    const out = await renderHealth({ cp, store, bots: [bot('claude', true, Date.now() - 10_000), bot('codex', true, Date.now() - 15_000)] });
    expect(out).toContain('🩺 Health Check (Captain mode)');
    expect(out).toContain('✅ Worker 心跳: 全部 2 个 bot 心跳新鲜 (< 30s)');
  });

  it('reports check 4 warn when one bot is stale', async () => {
    const out = await renderHealth({ cp, store, bots: [bot('claude', true, Date.now() - 10_000), bot('codex', false, Date.now() - 60_000)] });
    expect(out).toContain('⚠️ Worker 心跳: 1/2 bot stale: codex (1min 前)');
  });

  it('reports check 4 error when all other bots are stale', async () => {
    const out = await renderHealth({ cp, store, bots: [bot('claude', false, Date.now() - 120_000), bot('codex', false, null)] });
    expect(out).toContain('❌ Worker 心跳: 2/2 bot stale');
    expect(out).toContain('claude (2min 前)');
    expect(out).toContain('codex (无 heartbeat)');
  });

  it('reports no other bots as ok', async () => {
    const out = await renderHealth({ cp, store, bots: [] });
    expect(out).toContain('✅ Worker 心跳: 无其它 bot (仅 Captain 自己)');
  });

  it('keeps W2 single-bot path unchanged when bots are omitted', async () => {
    const out = await renderHealth(cp, store);
    expect(out).toContain('🩺 Health Check (single-bot mode)');
    expect(out).toContain('single-bot 模式: 跨 bot 心跳检查跳过');
    expect(out).not.toContain('Worker 心跳');
  });

  it('output contains Audit Pipe check item', async () => {
    const out = await renderHealth({ cp, store, bots: [] });
    expect(out).toContain('Audit Pipe');
    expect(out).not.toMatch(/❌ Audit Pipe/);
  });

  it('single-bot has 8 check items after adding Captain Queue', async () => {
    const out = await renderHealth(cp, store);
    const items = out.split('\n').filter((line) => /^[✅⚠️❌]/.test(line));
    expect(items).toHaveLength(8);
    expect(items.some((line) => line.includes('Audit Pipe'))).toBe(true);
    expect(items.some((line) => line.includes('Run Registry'))).toBe(true);
    expect(items.some((line) => line.includes('Captain Sessions'))).toBe(true);
    expect(items.some((line) => line.includes('Captain Queue'))).toBe(true);
    expect(items.some((line) => line.includes('Reverse Channel'))).toBe(true);
  });

  it('captain has 9 check items after adding Captain Queue', async () => {
    const out = await renderHealth({ cp, store, bots: [] });
    const items = out.split('\n').filter((line) => /^[✅⚠️❌]/.test(line));
    expect(items).toHaveLength(9);
    expect(items.some((line) => line.includes('Audit Pipe'))).toBe(true);
    expect(items.some((line) => line.includes('Run Registry'))).toBe(true);
    expect(items.some((line) => line.includes('Captain Sessions'))).toBe(true);
    expect(items.some((line) => line.includes('Captain Queue'))).toBe(true);
    expect(items.some((line) => line.includes('Reverse Channel'))).toBe(true);
    const captainSessionsIndex = items.findIndex((line) => line.includes('Captain Sessions'));
    const captainQueueIndex = items.findIndex((line) => line.includes('Captain Queue'));
    const reverseChannelIndex = items.findIndex((line) => line.includes('Reverse Channel'));
    expect(captainSessionsIndex).toBeGreaterThanOrEqual(0);
    expect(captainQueueIndex).toBe(captainSessionsIndex + 1);
    expect(reverseChannelIndex).toBe(captainQueueIndex + 1);
  });
});
