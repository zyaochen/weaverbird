import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DefaultAgentRegistry } from '../../packages/core/src/agent/registry.js';
import { ClaudeCodeAgent } from '../../packages/core/src/agent/claude-code.js';
import { BindingStore } from '../../apps/wb-bot/src/binding/store.js';
import { EventHandler } from '../../apps/wb-bot/src/feishu/event-handler.js';

const registry = new DefaultAgentRegistry([{ agent: new ClaudeCodeAgent(), command: 'claude' }]);
const roots: string[] = [];

function createDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-bot-kill9-'));
  roots.push(dir);
  return join(dir, 'wb-bot.db');
}

function createRunDir(dataDir: string, runId: string, status: string, heartbeatAge: number): void {
  const runDir = join(dataDir, 'runs', 'default', runId);
  mkdirSync(runDir, { recursive: true });
  const spec = {
    runId,
    botId: 'default',
    agentId: 'claude-code',
    cwd: '/tmp/test',
    userOpenId: 'u1',
    threadId: 't1',
    sourceMessageId: 'm1',
    replyMessageId: 'reply-1',
    startedAt: new Date().toISOString(),
    schemaVersion: 1,
  };
  writeFileSync(join(runDir, 'spec.json'), JSON.stringify(spec));
  writeFileSync(join(runDir, 'status'), status);
  const hbTimestamp = Math.floor((Date.now() - heartbeatAge) / 1000);
  writeFileSync(join(runDir, 'heartbeat'), String(hbTimestamp));
  writeFileSync(join(runDir, 'events.ndjson'), '');
  const { utimesSync } = require('node:fs');
  const oldDate = new Date(Date.now() - heartbeatAge);
  utimesSync(join(runDir, 'events.ndjson'), oldDate, oldDate);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('A5 process supervision kill-9 + restart', () => {
  it('resumes run when heartbeat is fresh after wb-bot restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-bot-kill9-'));
    roots.push(dir);
    const dbPath = join(dir, 'wb-bot.db');

    process.env['WB_DATA_DIR'] = dir;
    process.env['WB_HEARTBEAT_STALE_MS'] = '120000';

    createRunDir(dir, 'run-fresh-123', 'running', 5_000);

    const store = new BindingStore(dbPath);
    store.upsertInflightCard('default', {
      userOpenId: 'u1',
      threadId: 't1',
      sourceMessageId: 'm1',
      replyMessageId: 'reply-1',
      runId: 'run-fresh-123',
      agentId: 'claude-code',
    });

    const updates: Array<{ messageId: string; card: Record<string, unknown> }> = [];
    const handler = new EventHandler(registry, store, {
      async replyCard() { return 'new-reply'; },
      async updateCard(messageId, card) { updates.push({ messageId, card }); },
      async replyText() { return 'msg-1'; },
    });

    await handler.recoverInflightCards();

    expect(updates).toHaveLength(1);
    expect(updates[0]?.messageId).toBe('reply-1');
    const cardJson = JSON.stringify(updates[0]?.card);
    expect(cardJson).toContain('仍在运行中');
    expect(cardJson).toContain('run-fresh-12');

    store.close();
    delete process.env['WB_DATA_DIR'];
    delete process.env['WB_HEARTBEAT_STALE_MS'];
  });

  it('marks run as lost when heartbeat is stale', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-bot-kill9-'));
    roots.push(dir);
    const dbPath = join(dir, 'wb-bot.db');

    process.env['WB_DATA_DIR'] = dir;
    process.env['WB_HEARTBEAT_STALE_MS'] = '5000';

    createRunDir(dir, 'run-stale-456', 'running', 60_000);

    const store = new BindingStore(dbPath);
    store.upsertInflightCard('default', {
      userOpenId: 'u1',
      threadId: 't1',
      sourceMessageId: 'm1',
      replyMessageId: 'reply-1',
      runId: 'run-stale-456',
      agentId: 'claude-code',
    });

    const updates: Array<{ messageId: string; card: Record<string, unknown> }> = [];
    const handler = new EventHandler(registry, store, {
      async replyCard() { return 'new-reply'; },
      async updateCard(messageId, card) { updates.push({ messageId, card }); },
      async replyText() { return 'msg-1'; },
    });

    await handler.recoverInflightCards();

    expect(updates).toHaveLength(1);
    const cardJson = JSON.stringify(updates[0]?.card);
    // M13-D+M13-I: 新文案 + dismiss 按钮.
    expect(cardJson).toContain('卡已经断了');
    expect(cardJson).toContain('watchdog_dismiss');

    store.close();
    delete process.env['WB_DATA_DIR'];
    delete process.env['WB_HEARTBEAT_STALE_MS'];
  });

  it('falls back to W1 behavior for pre-W2 inflight cards (run_id IS NULL)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-bot-kill9-'));
    roots.push(dir);
    const dbPath = join(dir, 'wb-bot.db');

    const store = new BindingStore(dbPath);
    store.upsertInflightCard('default', {
      userOpenId: 'u1',
      threadId: 't1',
      sourceMessageId: 'm1',
      replyMessageId: 'reply-1',
      agentId: 'claude-code',
    });

    const updates: Array<{ messageId: string; card: Record<string, unknown> }> = [];
    const handler = new EventHandler(registry, store, {
      async replyCard() { return 'new-reply'; },
      async updateCard(messageId, card) { updates.push({ messageId, card }); },
      async replyText() { return 'msg-1'; },
    });

    await handler.recoverInflightCards();

    expect(updates).toHaveLength(1);
    const cardJson = JSON.stringify(updates[0]?.card);
    // M13-D+M13-I: 新文案 (同事口吻) + dismiss 按钮.
    expect(cardJson).toContain('卡已经断了');

    expect(store.getInflightCard('default', 'u1', 't1', 'claude-code')).toBeNull();
    store.close();
  });
});
