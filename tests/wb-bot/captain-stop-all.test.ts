import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BindingStore } from '../../apps/wb-bot/src/binding/store.js';
import { captainStopAll, renderCaptainStopAllCard } from '../../apps/wb-bot/src/captain/captain-stop-all.js';
import type { BotStatus } from '../../apps/wb-bot/src/captain/bot-discovery.js';

let root = '';
let store: BindingStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wb-captain-stop-all-'));
  store = new BindingStore(join(root, 'wb-bot.db'));
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

function bot(botId: string): BotStatus {
  return { botId, configPath: `/tmp/.env.${botId}`, online: true, lastHeartbeatAt: Date.now(), agentAllowed: ['claude-code'] };
}

function writeRun(botId: string, runId: string, status?: string): void {
  const runDir = join(root, 'runs', botId, runId);
  mkdirSync(runDir, { recursive: true });
  if (status !== undefined) writeFileSync(join(runDir, 'status'), status);
}

describe('captainStopAll', () => {
  it('returns empty result when there are no active runs', () => {
    const result = captainStopAll({ bots: [bot('default')], store, dataDir: root, nowFn: () => 1000 });
    expect(result).toEqual({ sent: [], failed: [] });
    expect(renderCaptainStopAllCard(result)).toBe('✅ 当前没有 active run');
  });

  it('writes stop.signal for running runs across multiple bots', () => {
    store.upsertInflightCard('default', { userOpenId: 'u1', threadId: 't1', sourceMessageId: 'm1', replyMessageId: 'r1', runId: 'r-default-1', agentId: 'claude-code' });
    store.upsertInflightCard('claude', { userOpenId: 'u2', threadId: 't2', sourceMessageId: 'm2', replyMessageId: 'r2', runId: 'r-claude-1', agentId: 'codex' });
    store.upsertInflightCard('codex', { userOpenId: 'u3', threadId: 't3', sourceMessageId: 'm3', replyMessageId: 'r3', runId: 'r-codex-1', agentId: 'mira-cli' });
    writeRun('default', 'r-default-1', 'running');
    writeRun('claude', 'r-claude-1', 'running');
    writeRun('codex', 'r-codex-1', 'running');

    const result = captainStopAll({ bots: [bot('default'), bot('claude'), bot('codex')], store, dataDir: root, nowFn: () => 1234567890 });
    expect(result.sent).toHaveLength(3);
    expect(readFileSync(join(root, 'runs', 'default', 'r-default-1', 'stop.signal'), 'utf8')).toBe('1234567890');
    expect(readFileSync(join(root, 'runs', 'claude', 'r-claude-1', 'stop.signal'), 'utf8')).toBe('1234567890');
    expect(readFileSync(join(root, 'runs', 'codex', 'r-codex-1', 'stop.signal'), 'utf8')).toBe('1234567890');
    const card = renderCaptainStopAllCard(result);
    expect(card).toContain('✅ 已向 3 个 active run 发送 stop 信号');
    expect(card).toContain('- default / r-default-1 : signal sent');
    expect(card).toContain('- claude / r-claude-1 : signal sent');
    expect(card).toContain('- codex / r-codex-1 : signal sent');
    expect(card.startsWith('```')).toBe(true);
  });

  it('skips runs whose status file is missing', () => {
    store.upsertInflightCard('claude', { userOpenId: 'u1', threadId: 't1', sourceMessageId: 'm1', replyMessageId: 'r1', runId: 'r-missing', agentId: 'claude-code' });
    writeRun('claude', 'r-missing');

    const result = captainStopAll({ bots: [bot('claude')], store, dataDir: root, nowFn: () => 1000 });
    expect(result).toEqual({ sent: [], failed: [] });
    expect(existsSync(join(root, 'runs', 'claude', 'r-missing', 'stop.signal'))).toBe(false);
  });

  it('skips runs whose status is not running', () => {
    store.upsertInflightCard('claude', { userOpenId: 'u1', threadId: 't1', sourceMessageId: 'm1', replyMessageId: 'r1', runId: 'r-done', agentId: 'claude-code' });
    store.upsertInflightCard('codex', { userOpenId: 'u2', threadId: 't2', sourceMessageId: 'm2', replyMessageId: 'r2', runId: 'r-error', agentId: 'codex' });
    writeRun('claude', 'r-done', 'done');
    writeRun('codex', 'r-error', 'error');

    const result = captainStopAll({ bots: [bot('claude'), bot('codex')], store, dataDir: root, nowFn: () => 1000 });
    expect(result).toEqual({ sent: [], failed: [] });
  });

  it('records write failures without blocking other bots', () => {
    store.upsertInflightCard('claude', { userOpenId: 'u1', threadId: 't1', sourceMessageId: 'm1', replyMessageId: 'r1', runId: 'r-ok', agentId: 'claude-code' });
    store.upsertInflightCard('codex', { userOpenId: 'u2', threadId: 't2', sourceMessageId: 'm2', replyMessageId: 'r2', runId: 'r-fail', agentId: 'codex' });
    writeRun('claude', 'r-ok', 'running');
    writeRun('codex', 'r-fail', 'running');
    mkdirSync(join(root, 'runs', 'codex', 'r-fail', 'stop.signal'), { recursive: true });

    const result = captainStopAll({ bots: [bot('claude'), bot('codex')], store, dataDir: root, nowFn: () => 5000 });
    expect(result.sent).toHaveLength(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.botId).toBe('codex');
    expect(renderCaptainStopAllCard(result)).toContain('⚠️ 1 个失败:');
  });

  it('swallows listInflightCards failure for one bot and continues others', () => {
    store.upsertInflightCard('claude', { userOpenId: 'u1', threadId: 't1', sourceMessageId: 'm1', replyMessageId: 'r1', runId: 'r-ok', agentId: 'claude-code' });
    writeRun('claude', 'r-ok', 'running');
    const badStore = {
      ...store,
      listInflightCards(botId: string) {
        if (botId === 'codex') throw new Error('sqlite read failed');
        return store.listInflightCards(botId);
      },
    } as BindingStore;

    const result = captainStopAll({ bots: [bot('claude'), bot('codex')], store: badStore, dataDir: root, nowFn: () => 9000 });
    expect(result.sent).toHaveLength(1);
    expect(result.failed).toHaveLength(0);
  });

  it('passes inflight card agentId through to the stop signal entry', () => {
    store.upsertInflightCard('claude', { userOpenId: 'u1', threadId: 't1', sourceMessageId: 'm1', replyMessageId: 'r1', runId: 'r-with-agent', agentId: 'codex' });
    writeRun('claude', 'r-with-agent', 'running');

    const result = captainStopAll({ bots: [bot('claude')], store, dataDir: root, nowFn: () => 1000 });
    expect(result.sent[0]?.agentId).toBe('codex');
  });

  // W2.5-Hotfix-batch-C P1-7: 文案脱钩 ~500ms 强承诺.
  // R1 review γ: stop-all 实现只是写 stop.signal, 卡片却暗示 "~500ms 内完成", 属强承诺.
  // 收敛是异步的 (wb-runner 跑完手头 tool 才退), 不该让用户预期固定 500ms 内全部完成.
  describe('footer 文案 (P1-7 regression guard)', () => {
    it('不再承诺 "~500ms 内完成" / "完成后" 这类强语义', () => {
      store.upsertInflightCard('default', { userOpenId: 'u1', threadId: 't1', sourceMessageId: 'm1', replyMessageId: 'r1', runId: 'r-1', agentId: 'claude-code' });
      writeRun('default', 'r-1', 'running');
      const result = captainStopAll({ bots: [bot('default')], store, dataDir: root, nowFn: () => 1000 });
      const card = renderCaptainStopAllCard(result);
      expect(card).not.toContain('500ms');
      expect(card).not.toMatch(/~\s*500\s*ms/);
      expect(card).not.toContain('graceful stop 将在');
    });

    it('明文化收敛是异步 + 引导用 /status 跟踪', () => {
      store.upsertInflightCard('default', { userOpenId: 'u1', threadId: 't1', sourceMessageId: 'm1', replyMessageId: 'r1', runId: 'r-1', agentId: 'claude-code' });
      writeRun('default', 'r-1', 'running');
      const result = captainStopAll({ bots: [bot('default')], store, dataDir: root, nowFn: () => 1000 });
      const card = renderCaptainStopAllCard(result);
      expect(card).toContain('signal 仅触发 graceful stop');
      expect(card).toContain('异步');
      expect(card).toContain('/status');
    });
  });
});
