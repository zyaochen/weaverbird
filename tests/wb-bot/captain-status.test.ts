import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BindingStore } from '../../apps/wb-bot/src/binding/store.js';
import { renderCaptainStatusCard } from '../../apps/wb-bot/src/captain/captain-status.js';
import type { BotStatus } from '../../apps/wb-bot/src/captain/bot-discovery.js';

let root = '';
let store: BindingStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wb-captain-status-'));
  store = new BindingStore(join(root, 'wb-bot.db'));
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

function writeRun(botId: string, runId: string, status: string, heartbeatSec?: number): void {
  const runDir = join(root, 'runs', botId, runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'status'), status);
  if (heartbeatSec !== undefined) writeFileSync(join(runDir, 'heartbeat'), String(heartbeatSec));
}

function bots(overrides?: Partial<Record<string, Partial<BotStatus>>>): BotStatus[] {
  return [
    { botId: 'default', configPath: '/tmp/.env.default', online: true, lastHeartbeatAt: 995_000, agentAllowed: ['claude-code'] },
    { botId: 'claude', configPath: '/tmp/.env.claude', online: true, lastHeartbeatAt: 994_000, agentAllowed: ['claude-code'] },
    { botId: 'codex', configPath: '/tmp/.env.codex', online: true, lastHeartbeatAt: 993_000, agentAllowed: ['codex'] },
  ].map((bot) => ({ ...bot, ...(overrides?.[bot.botId] ?? {}) }));
}

describe('renderCaptainStatusCard', () => {
  it('renders captain first with running and idle bots', () => {
    store.upsertInflightCard('claude', { userOpenId: 'u1', threadId: 't1', sourceMessageId: 'm1', replyMessageId: 'r1', runId: 'r-abcdef123456789', agentId: 'claude-code' });
    writeRun('claude', 'r-abcdef123456789', 'running', 940);

    const out = renderCaptainStatusCard({
      bots: bots(),
      store,
      dataDir: root,
      captainBotId: 'default',
      nowFn: () => 1_000_000,
    });

    expect(out.startsWith('```\n📊 Weaverbird Status')).toBe(true);
    expect(out.indexOf('default (Captain)')).toBeLessThan(out.indexOf('claude'));
    expect(out).toContain('🤖 claude');
    expect(out).toContain('跑中 1 · 1min · run r-abcdef1234');
    expect(out).toContain('🤖 default (Captain)');
    expect(out).toContain('空闲 · 最后心跳 5s 前');
    expect(out).toContain('per-bot 摘要视图');
    expect(out).toContain('完整 run 列表视图待 W3');
  });

  it('renders offline bot with heartbeat age', () => {
    const out = renderCaptainStatusCard({
      bots: bots({ codex: { online: false, lastHeartbeatAt: 400_000 } }),
      store,
      dataDir: root,
      captainBotId: 'default',
      nowFn: () => 1_000_000,
    });
    expect(out).toContain('🤖 codex');
    expect(out).toContain('⚠️ 离线 (最后心跳 10min 前)');
  });

  it('renders offline bot with no heartbeat', () => {
    const out = renderCaptainStatusCard({
      bots: bots({ codex: { online: false, lastHeartbeatAt: null } }),
      store,
      dataDir: root,
      captainBotId: 'default',
      nowFn: () => 1_000_000,
    });
    expect(out).toContain('🤖 codex');
    expect(out).toContain('⚠️ 离线 (无 heartbeat)');
  });

  it('renders online idle bot heartbeat age', () => {
    const out = renderCaptainStatusCard({
      bots: bots({ claude: { online: true, lastHeartbeatAt: 999_000 } }),
      store,
      dataDir: root,
      captainBotId: 'default',
      nowFn: () => 1_000_000,
    });
    expect(out).toContain('🤖 claude');
    expect(out).toContain('空闲 · 最后心跳 1s 前');
  });

  it('renders running bot even if status file is missing', () => {
    store.upsertInflightCard('claude', { userOpenId: 'u1', threadId: 't1', sourceMessageId: 'm1', replyMessageId: 'r1', runId: 'r-missing-status', agentId: 'claude-code' });
    const runDir = join(root, 'runs', 'claude', 'r-missing-status');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'heartbeat'), '970');

    const out = renderCaptainStatusCard({
      bots: bots(),
      store,
      dataDir: root,
      captainBotId: 'default',
      nowFn: () => 1_000_000,
    });
    expect(out).toContain('🤖 claude');
    expect(out).toContain('跑中 1 · 30s · run r-missing-st');
  });

  it('shows N + earliest hint when same bot has multiple concurrent runs (multi-agent)', () => {
    store.upsertInflightCard('claude', { userOpenId: 'u1', threadId: 't1', sourceMessageId: 'm1', replyMessageId: 'r1', runId: 'r-claude-1111', agentId: 'claude-code' });
    store.upsertInflightCard('claude', { userOpenId: 'u1', threadId: 't1', sourceMessageId: 'm2', replyMessageId: 'r2', runId: 'r-codex-2222', agentId: 'codex' });
    writeRun('claude', 'r-claude-1111', 'running', 900);
    writeRun('claude', 'r-codex-2222', 'running', 950);

    const out = renderCaptainStatusCard({
      bots: bots(),
      store,
      dataDir: root,
      captainBotId: 'default',
      nowFn: () => 1_000_000,
    });

    expect(out).toMatch(/跑中 2 · 最早 1min · run r-claude-111 \(\+1 更多\)/);
  });

  it('swallows listInflightCards failure and treats bot as idle', () => {
    const badStore = {
      listInflightCards() {
        throw new Error('sqlite unavailable');
      },
    } as unknown as BindingStore;

    const out = renderCaptainStatusCard({
      bots: bots(),
      store: badStore,
      dataDir: root,
      captainBotId: 'default',
      nowFn: () => 1_000_000,
    });
    expect(out).toContain('🤖 claude');
    expect(out).toContain('空闲 · 最后心跳 6s 前');
  });

  it('renders empty worker placeholder when no bots discovered', () => {
    const out = renderCaptainStatusCard({ bots: [], store, dataDir: root, captainBotId: 'default', nowFn: () => 1_000_000 });
    expect(out).toContain('(无 worker)');
  });
});
