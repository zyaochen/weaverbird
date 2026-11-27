import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { BindingStore } from '../../apps/wb-bot/src/binding/store.js';
import { runMigrations, CURRENT_SCHEMA_VERSION } from '../../apps/wb-bot/src/binding/migration-runner.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('W2.5-Hotfix-batch-B P0-1 · inflight_card 主键含 agent_id (multi-agent concurrent)', () => {
  let dir = '';
  let store: BindingStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wb-bot-inflight-multi-'));
    roots.push(dir);
    store = new BindingStore(join(dir, 'wb-bot.db'));
  });

  afterEach(() => {
    store.close();
  });

  describe('regression: 多 agent 并发 inflight 不互相覆盖', () => {
    it('同 thread 下 claude + codex 并发 upsert 各自保留', () => {
      store.upsertInflightCard('default', {
        userOpenId: 'u1', threadId: 't1',
        sourceMessageId: 'msg-claude', replyMessageId: 'reply-claude',
        runId: 'run-claude', agentId: 'claude-code',
      });
      store.upsertInflightCard('default', {
        userOpenId: 'u1', threadId: 't1',
        sourceMessageId: 'msg-codex', replyMessageId: 'reply-codex',
        runId: 'run-codex', agentId: 'codex',
      });

      const list = store.listInflightCards('default');
      expect(list).toHaveLength(2);
      expect(list.find((c) => c.agentId === 'claude-code')?.replyMessageId).toBe('reply-claude');
      expect(list.find((c) => c.agentId === 'codex')?.replyMessageId).toBe('reply-codex');
    });

    it('同 (bot, user, thread, agent) 重复 upsert 仍按设计覆盖', () => {
      store.upsertInflightCard('default', {
        userOpenId: 'u1', threadId: 't1',
        sourceMessageId: 'msg-1', replyMessageId: 'reply-1',
        runId: 'run-1', agentId: 'claude-code',
      });
      store.upsertInflightCard('default', {
        userOpenId: 'u1', threadId: 't1',
        sourceMessageId: 'msg-2', replyMessageId: 'reply-2',
        runId: 'run-2', agentId: 'claude-code',
      });

      const card = store.getInflightCard('default', 'u1', 't1', 'claude-code');
      expect(card?.replyMessageId).toBe('reply-2');
      expect(card?.runId).toBe('run-2');
      expect(store.listInflightCards('default')).toHaveLength(1);
    });
  });

  describe('regression: clearInflightCard(agent) 不连带删另 agent', () => {
    it('claude 完成 → clearInflightCard(claude-code) → codex inflight 仍保留', () => {
      store.upsertInflightCard('default', {
        userOpenId: 'u1', threadId: 't1',
        sourceMessageId: 'msg-claude', replyMessageId: 'reply-claude',
        runId: 'run-claude', agentId: 'claude-code',
      });
      store.upsertInflightCard('default', {
        userOpenId: 'u1', threadId: 't1',
        sourceMessageId: 'msg-codex', replyMessageId: 'reply-codex',
        runId: 'run-codex', agentId: 'codex',
      });

      const cleared = store.clearInflightCard('default', 'u1', 't1', 'claude-code');
      expect(cleared).toBe(true);

      expect(store.getInflightCard('default', 'u1', 't1', 'claude-code')).toBeNull();
      expect(store.getInflightCard('default', 'u1', 't1', 'codex')?.replyMessageId).toBe('reply-codex');
      expect(store.listInflightCards('default')).toHaveLength(1);
    });

    it('clear 不存在的 (thread, agent) → false, 其他 row 不受影响', () => {
      store.upsertInflightCard('default', {
        userOpenId: 'u1', threadId: 't1',
        sourceMessageId: 'msg-1', replyMessageId: 'reply-1',
        runId: 'run-1', agentId: 'claude-code',
      });
      expect(store.clearInflightCard('default', 'u1', 't1', 'codex')).toBe(false);
      expect(store.listInflightCards('default')).toHaveLength(1);
    });
  });

  describe('multi-bot × multi-agent isolation', () => {
    it('不同 bot 的同 (user, thread, agent) 各自独立', () => {
      store.upsertInflightCard('bot-a', {
        userOpenId: 'u1', threadId: 't1',
        sourceMessageId: 'msg-a', replyMessageId: 'reply-a',
        runId: 'run-a', agentId: 'claude-code',
      });
      store.upsertInflightCard('bot-b', {
        userOpenId: 'u1', threadId: 't1',
        sourceMessageId: 'msg-b', replyMessageId: 'reply-b',
        runId: 'run-b', agentId: 'claude-code',
      });

      expect(store.getInflightCard('bot-a', 'u1', 't1', 'claude-code')?.replyMessageId).toBe('reply-a');
      expect(store.getInflightCard('bot-b', 'u1', 't1', 'claude-code')?.replyMessageId).toBe('reply-b');

      store.clearInflightCard('bot-a', 'u1', 't1', 'claude-code');
      expect(store.getInflightCard('bot-a', 'u1', 't1', 'claude-code')).toBeNull();
      expect(store.getInflightCard('bot-b', 'u1', 't1', 'claude-code')?.replyMessageId).toBe('reply-b');
    });
  });

  describe('listInflightCards 排序稳定', () => {
    it('排序 (user, thread, agent) 全为 ASC', () => {
      store.upsertInflightCard('default', {
        userOpenId: 'u1', threadId: 't1', sourceMessageId: 's1', replyMessageId: 'r1', agentId: 'codex',
      });
      store.upsertInflightCard('default', {
        userOpenId: 'u1', threadId: 't1', sourceMessageId: 's2', replyMessageId: 'r2', agentId: 'claude-code',
      });
      const list = store.listInflightCards('default');
      expect(list.map((c) => c.agentId)).toEqual(['claude-code', 'codex']);
    });
  });
});

describe('W2.5-Hotfix-batch-B P0-1 · migration 003 升级路径', () => {
  it('v2 schema + 已有数据 → v3 升级, agent_id 填默认值 claude-code, PK 升级', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-m003-'));
    roots.push(dir);
    const db = new BetterSqlite3(join(dir, 'test.db'));
    db.pragma('journal_mode = WAL');

    db.exec(`CREATE TABLE thread_binding (
      user_open_id TEXT NOT NULL, thread_id TEXT NOT NULL,
      agent_id TEXT NOT NULL, cwd TEXT,
      bot_id TEXT NOT NULL DEFAULT 'default',
      PRIMARY KEY (bot_id, user_open_id, thread_id)
    )`);
    db.exec(`CREATE TABLE agent_continuation (
      user_open_id TEXT NOT NULL, thread_id TEXT NOT NULL,
      agent_id TEXT NOT NULL, continuation_token TEXT NOT NULL,
      bot_id TEXT NOT NULL DEFAULT 'default',
      PRIMARY KEY (bot_id, user_open_id, thread_id, agent_id)
    )`);
    db.exec(`CREATE TABLE cwd_alias (
      user_open_id TEXT NOT NULL, name TEXT NOT NULL, path TEXT NOT NULL,
      PRIMARY KEY (user_open_id, name)
    )`);
    db.exec(`CREATE TABLE inflight_card (
      user_open_id TEXT NOT NULL, thread_id TEXT NOT NULL,
      source_message_id TEXT NOT NULL, reply_message_id TEXT NOT NULL,
      run_id TEXT, agent_id TEXT,
      bot_id TEXT NOT NULL DEFAULT 'default',
      PRIMARY KEY (bot_id, user_open_id, thread_id)
    )`);
    db.pragma('user_version = 2');

    db.exec(`INSERT INTO inflight_card (user_open_id, thread_id, source_message_id, reply_message_id, run_id, agent_id, bot_id) VALUES ('u1', 't1', 'sm1', 'rm1', 'r1', 'claude-code', 'default')`);
    db.exec(`INSERT INTO inflight_card (user_open_id, thread_id, source_message_id, reply_message_id, run_id, agent_id, bot_id) VALUES ('u2', 't2', 'sm2', 'rm2', 'r2', NULL, 'default')`);

    const result = runMigrations(db);
    expect(result.success).toBe(true);
    expect(result.fromVersion).toBe(2);
    expect(result.toVersion).toBe(CURRENT_SCHEMA_VERSION);

    const pkRows = (db.prepare("PRAGMA table_info('inflight_card')").all() as Array<{ name: string; pk: number }>)
      .filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
    expect(pkRows).toEqual(['bot_id', 'user_open_id', 'thread_id', 'agent_id']);

    const rows = db.prepare('SELECT * FROM inflight_card ORDER BY user_open_id').all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[0]!['agent_id']).toBe('claude-code');
    expect(rows[1]!['agent_id']).toBe('claude-code');

    db.close();
  });

  it('v2 → v3: 同 thread 不同 agent 现在可以共存 (升级后立即 insert 验证)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-m003-coexist-'));
    roots.push(dir);
    const store = new BindingStore(join(dir, 'wb-bot.db'));
    expect(store.migrationResult.success).toBe(true);
    expect(store.migrationResult.toVersion).toBe(CURRENT_SCHEMA_VERSION);

    store.upsertInflightCard('default', {
      userOpenId: 'u1', threadId: 't1', sourceMessageId: 'sm1', replyMessageId: 'rm1', agentId: 'claude-code',
    });
    store.upsertInflightCard('default', {
      userOpenId: 'u1', threadId: 't1', sourceMessageId: 'sm2', replyMessageId: 'rm2', agentId: 'codex',
    });

    expect(store.listInflightCards('default')).toHaveLength(2);

    store.close();
  });
});
