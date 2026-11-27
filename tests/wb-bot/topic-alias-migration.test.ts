import BetterSqlite3 from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BindingStore } from '../../apps/wb-bot/src/binding/store.js';

let dir = '';
let dbPath = '';

function seedVersion3Database(path: string): void {
  const db = new BetterSqlite3(path);
  db.exec(`
    CREATE TABLE thread_binding (
      user_open_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      cwd TEXT,
      bot_id TEXT NOT NULL DEFAULT 'default',
      PRIMARY KEY (bot_id, user_open_id, thread_id)
    );
    CREATE TABLE agent_continuation (
      user_open_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      continuation_token TEXT NOT NULL,
      bot_id TEXT NOT NULL DEFAULT 'default',
      PRIMARY KEY (bot_id, user_open_id, thread_id, agent_id)
    );
    CREATE TABLE inflight_card (
      user_open_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      source_message_id TEXT NOT NULL,
      reply_message_id TEXT NOT NULL,
      run_id TEXT,
      agent_id TEXT NOT NULL DEFAULT 'claude-code',
      bot_id TEXT NOT NULL DEFAULT 'default',
      PRIMARY KEY (bot_id, user_open_id, thread_id, agent_id)
    );
  `);

  db.prepare('INSERT INTO thread_binding (bot_id, user_open_id, thread_id, agent_id, cwd) VALUES (?, ?, ?, ?, ?)')
    .run('default', 'ou_user', 'oc_legacy', 'claude-code', '/repo');
  db.prepare('INSERT INTO agent_continuation (bot_id, user_open_id, thread_id, agent_id, continuation_token) VALUES (?, ?, ?, ?, ?)')
    .run('default', 'ou_user', 'oc_legacy', 'claude-code', 'tok-legacy');
  db.prepare('INSERT INTO inflight_card (bot_id, user_open_id, thread_id, agent_id, source_message_id, reply_message_id, run_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('default', 'ou_user', 'oc_legacy', 'claude-code', 'om_source', 'om_reply', 'run-legacy');
  db.pragma('user_version = 3');
  db.close();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wb-thread-alias-'));
  dbPath = join(dir, 'wb-bot.db');
  seedVersion3Database(dbPath);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('topic alias migration', () => {
  it('keeps legacy chat_id bindings reachable from canonical root topic aliases after migration', () => {
    const store = new BindingStore(dbPath);
    try {
      store.upsertThreadAlias('default', 'ou_user', 'root:om_root', 'chat:oc_legacy');

      expect(store.getThreadBinding('default', 'ou_user', 'root:om_root')).toEqual({
        userOpenId: 'ou_user',
        threadId: 'oc_legacy',
        agentId: 'claude-code',
        cwd: '/repo',
      });
      expect(store.getContinuation('default', 'ou_user', 'root:om_root', 'claude-code')).toBe('tok-legacy');
      expect(store.getInflightCard('default', 'ou_user', 'root:om_root', 'claude-code')).toEqual({
        userOpenId: 'ou_user',
        threadId: 'oc_legacy',
        sourceMessageId: 'om_source',
        replyMessageId: 'om_reply',
        agentId: 'claude-code',
        runId: 'run-legacy',
      });
      expect(store.clearInflightCard('default', 'ou_user', 'root:om_root', 'claude-code')).toBe(true);
      expect(store.getInflightCard('default', 'ou_user', 'root:om_root', 'claude-code')).toBeNull();
    } finally {
      store.close();
    }
  });
});
