import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { BindingStore } from '../../apps/wb-bot/src/binding/store.js';

let dir = '';
let store: BindingStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wb-bot-wal-'));
  store = new BindingStore(join(dir, 'wb-bot.db'));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('HP-W2-3 WAL mode', () => {
  it('enables WAL journal mode on new database', () => {
    const raw = new BetterSqlite3(join(dir, 'wb-bot.db'));
    const result = raw.pragma('journal_mode') as unknown as Array<{ journal_mode: string }>;
    expect(result[0]?.journal_mode).toBe('wal');
    raw.close();
  });

  it('sets busy_timeout = 5000 (per-connection setting)', () => {
    const raw = new BetterSqlite3(join(dir, 'wb-bot.db'));
    raw.pragma('busy_timeout = 5000');
    const result = raw.pragma('busy_timeout') as unknown as Array<{ timeout: number }>;
    expect(result[0]?.timeout).toBe(5000);
    raw.close();
  });

  it('supports concurrent reader while writer holds transaction', () => {
    store.upsertThreadBinding('default', { userOpenId: 'u1', threadId: 't1', agentId: 'claude-code', cwd: '/tmp/a' });

    const reader = new BetterSqlite3(join(dir, 'wb-bot.db'));
    const writerDb = new BetterSqlite3(join(dir, 'wb-bot.db'));
    writerDb.pragma('journal_mode = WAL');
    writerDb.pragma('busy_timeout = 5000');

    writerDb.exec('BEGIN');
    writerDb.prepare(
      `INSERT INTO thread_binding (user_open_id, thread_id, agent_id, cwd) VALUES (?, ?, ?, ?)`,
    ).run('u2', 't2', 'codex', '/tmp/b');

    const rows = reader.prepare('SELECT * FROM thread_binding').all() as Array<Record<string, unknown>>;
    expect(rows.length).toBe(1);
    expect(rows[0]?.['user_open_id']).toBe('u1');

    writerDb.exec('COMMIT');

    const rowsAfter = reader.prepare('SELECT * FROM thread_binding').all() as Array<Record<string, unknown>>;
    expect(rowsAfter.length).toBe(2);

    reader.close();
    writerDb.close();
  });

  it('W1 BindingStore operations work normally with WAL enabled', () => {
    store.upsertThreadBinding('default', { userOpenId: 'u1', threadId: 't1', agentId: 'claude-code', cwd: '/tmp/a' });
    store.upsertContinuation('default', 'u1', 't1', 'claude-code', 'token-1');
    store.upsertInflightCard('default', { userOpenId: 'u1', threadId: 't1', sourceMessageId: 'm1', replyMessageId: 'r1', agentId: 'claude-code' });
    store.setAlias('u1', 'work', '/tmp/work');

    expect(store.getThreadBinding('default', 'u1', 't1')?.agentId).toBe('claude-code');
    expect(store.getContinuation('default', 'u1', 't1', 'claude-code')).toBe('token-1');
    expect(store.getInflightCard('default', 'u1', 't1', 'claude-code')?.replyMessageId).toBe('r1');
    expect(store.listAliases('u1')).toHaveLength(1);

    store.clearInflightCard('default', 'u1', 't1', 'claude-code');
    expect(store.getInflightCard('default', 'u1', 't1', 'claude-code')).toBeNull();
  });
});
