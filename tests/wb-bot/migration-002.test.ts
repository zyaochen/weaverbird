import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { runMigrations, CURRENT_SCHEMA_VERSION } from '../../apps/wb-bot/src/binding/migration-runner.js';
import { SCHEMA_SQL } from '../../apps/wb-bot/src/binding/schema.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function freshDb(dir: string): InstanceType<typeof BetterSqlite3> {
  const db = new BetterSqlite3(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  for (const sql of SCHEMA_SQL) db.exec(sql);
  return db;
}

const V1_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS thread_binding (
    user_open_id TEXT NOT NULL, thread_id TEXT NOT NULL,
    agent_id TEXT NOT NULL, cwd TEXT,
    PRIMARY KEY (user_open_id, thread_id)
  )`,
  `CREATE TABLE IF NOT EXISTS agent_continuation (
    user_open_id TEXT NOT NULL, thread_id TEXT NOT NULL,
    agent_id TEXT NOT NULL, continuation_token TEXT NOT NULL,
    PRIMARY KEY (user_open_id, thread_id, agent_id)
  )`,
  `CREATE TABLE IF NOT EXISTS cwd_alias (
    user_open_id TEXT NOT NULL, name TEXT NOT NULL, path TEXT NOT NULL,
    PRIMARY KEY (user_open_id, name)
  )`,
  `CREATE TABLE IF NOT EXISTS inflight_card (
    user_open_id TEXT NOT NULL, thread_id TEXT NOT NULL,
    source_message_id TEXT NOT NULL, reply_message_id TEXT NOT NULL,
    PRIMARY KEY (user_open_id, thread_id)
  )`,
];

function v1Db(dir: string): InstanceType<typeof BetterSqlite3> {
  const db = new BetterSqlite3(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  for (const sql of V1_SCHEMA_SQL) db.exec(sql);
  // run migration 001 to add run_id + agent_id to inflight_card
  db.exec('ALTER TABLE inflight_card ADD COLUMN run_id TEXT');
  db.exec('ALTER TABLE inflight_card ADD COLUMN agent_id TEXT');
  db.pragma('user_version = 1');
  return db;
}

function tableColumns(db: InstanceType<typeof BetterSqlite3>, table: string): string[] {
  const cols = db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>;
  return cols.map((c) => c.name);
}

function tablePkColumns(db: InstanceType<typeof BetterSqlite3>, table: string): string[] {
  const cols = db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string; pk: number }>;
  return cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
}

describe('HP-W2.5-1 migration 002 add bot_id', () => {
  it('case 1: fresh install → user_version=CURRENT, bot_id in 3 tables, PK upgraded (含 v3 inflight agent_id)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-m002-'));
    roots.push(dir);
    const db = freshDb(dir);

    const result = runMigrations(db);
    expect(result.success).toBe(true);
    expect(result.toVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(3);

    expect(tableColumns(db, 'thread_binding')).toContain('bot_id');
    expect(tableColumns(db, 'agent_continuation')).toContain('bot_id');
    expect(tableColumns(db, 'inflight_card')).toContain('bot_id');
    expect(tableColumns(db, 'inflight_card')).toContain('agent_id');

    expect(tablePkColumns(db, 'thread_binding')).toEqual(['bot_id', 'user_open_id', 'thread_id']);
    expect(tablePkColumns(db, 'agent_continuation')).toEqual(['bot_id', 'user_open_id', 'thread_id', 'agent_id']);
    expect(tablePkColumns(db, 'inflight_card')).toEqual(['bot_id', 'user_open_id', 'thread_id', 'agent_id']);

    // idempotent second run
    const result2 = runMigrations(db);
    expect(result2.success).toBe(true);
    expect(result2.fromVersion).toBe(CURRENT_SCHEMA_VERSION);

    db.close();
  });

  it('case 2: W2 upgrade (v1 schema + data) → data preserved, bot_id=default, PK upgraded', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-m002-'));
    roots.push(dir);
    const db = v1Db(dir);

    // insert mixed data
    db.exec(`INSERT INTO thread_binding (user_open_id, thread_id, agent_id, cwd) VALUES ('ou_a', 'th_1', 'claude-code', '/home')`);
    db.exec(`INSERT INTO thread_binding (user_open_id, thread_id, agent_id, cwd) VALUES ('ou_b', 'th_2', 'codex', '/work')`);
    db.exec(`INSERT INTO agent_continuation (user_open_id, thread_id, agent_id, continuation_token) VALUES ('ou_a', 'th_1', 'claude-code', 'tok_abc')`);
    db.exec(`INSERT INTO inflight_card (user_open_id, thread_id, source_message_id, reply_message_id, run_id, agent_id) VALUES ('ou_a', 'th_1', 'sm_1', 'rm_1', 'run_1', 'claude-code')`);

    const result = runMigrations(db);
    expect(result.success).toBe(true);
    expect(result.fromVersion).toBe(1);
    expect(result.toVersion).toBe(CURRENT_SCHEMA_VERSION);

    // verify data preserved with bot_id='default'
    const bindings = db.prepare('SELECT * FROM thread_binding ORDER BY user_open_id').all() as Array<Record<string, unknown>>;
    expect(bindings).toHaveLength(2);
    expect(bindings[0]!['bot_id']).toBe('default');
    expect(bindings[0]!['user_open_id']).toBe('ou_a');
    expect(bindings[0]!['cwd']).toBe('/home');
    expect(bindings[1]!['bot_id']).toBe('default');

    const conts = db.prepare('SELECT * FROM agent_continuation').all() as Array<Record<string, unknown>>;
    expect(conts).toHaveLength(1);
    expect(conts[0]!['bot_id']).toBe('default');
    expect(conts[0]!['continuation_token']).toBe('tok_abc');

    const cards = db.prepare('SELECT * FROM inflight_card').all() as Array<Record<string, unknown>>;
    expect(cards).toHaveLength(1);
    expect(cards[0]!['bot_id']).toBe('default');
    expect(cards[0]!['run_id']).toBe('run_1');
    expect(cards[0]!['agent_id']).toBe('claude-code');

    // PK upgraded
    expect(tablePkColumns(db, 'thread_binding')).toEqual(['bot_id', 'user_open_id', 'thread_id']);

    db.close();
  });

  it('case 3: multi-bot PK allows different bot_id on same (user, thread)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-m002-'));
    roots.push(dir);
    const db = freshDb(dir);
    runMigrations(db);

    db.exec(`INSERT INTO thread_binding (bot_id, user_open_id, thread_id, agent_id, cwd) VALUES ('default', 'ou_x', 'th_y', 'claude-code', '/a')`);
    db.exec(`INSERT INTO thread_binding (bot_id, user_open_id, thread_id, agent_id, cwd) VALUES ('claude', 'ou_x', 'th_y', 'claude-code', '/b')`);

    const rows = db.prepare('SELECT * FROM thread_binding WHERE user_open_id = ? ORDER BY bot_id').all('ou_x') as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[0]!['bot_id']).toBe('claude');
    expect(rows[0]!['cwd']).toBe('/b');
    expect(rows[1]!['bot_id']).toBe('default');
    expect(rows[1]!['cwd']).toBe('/a');

    db.close();
  });

  it('case 4: same bot UNIQUE conflict', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-m002-'));
    roots.push(dir);
    const db = freshDb(dir);
    runMigrations(db);

    db.exec(`INSERT INTO thread_binding (bot_id, user_open_id, thread_id, agent_id, cwd) VALUES ('default', 'ou_x', 'th_y', 'claude-code', '/a')`);
    expect(() => {
      db.exec(`INSERT INTO thread_binding (bot_id, user_open_id, thread_id, agent_id, cwd) VALUES ('default', 'ou_x', 'th_y', 'codex', '/b')`);
    }).toThrow();

    db.close();
  });

  it('case 5: inflight_card + agent_continuation multi-bot insert', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-m002-'));
    roots.push(dir);
    const db = freshDb(dir);
    runMigrations(db);

    db.exec(`INSERT INTO inflight_card (bot_id, user_open_id, thread_id, source_message_id, reply_message_id) VALUES ('default', 'ou_x', 'th_y', 'sm1', 'rm1')`);
    db.exec(`INSERT INTO inflight_card (bot_id, user_open_id, thread_id, source_message_id, reply_message_id) VALUES ('claude', 'ou_x', 'th_y', 'sm2', 'rm2')`);

    const cards = db.prepare('SELECT * FROM inflight_card ORDER BY bot_id').all() as Array<Record<string, unknown>>;
    expect(cards).toHaveLength(2);
    expect(cards[0]!['bot_id']).toBe('claude');
    expect(cards[1]!['bot_id']).toBe('default');

    db.exec(`INSERT INTO agent_continuation (bot_id, user_open_id, thread_id, agent_id, continuation_token) VALUES ('default', 'ou_x', 'th_y', 'claude-code', 'tok1')`);
    db.exec(`INSERT INTO agent_continuation (bot_id, user_open_id, thread_id, agent_id, continuation_token) VALUES ('claude', 'ou_x', 'th_y', 'claude-code', 'tok2')`);

    const conts = db.prepare('SELECT * FROM agent_continuation ORDER BY bot_id').all() as Array<Record<string, unknown>>;
    expect(conts).toHaveLength(2);

    db.close();
  });

  it('case 6: cwd_alias schema unchanged (no bot_id column)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-m002-'));
    roots.push(dir);
    const db = freshDb(dir);
    runMigrations(db);

    expect(tableColumns(db, 'cwd_alias')).not.toContain('bot_id');
    expect(tablePkColumns(db, 'cwd_alias')).toEqual(['user_open_id', 'name']);

    db.close();
  });

  it('case 7: BindingStore integration (constructor runs SCHEMA_SQL + migrations)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-m002-'));
    roots.push(dir);

    // Simulate full BindingStore initialization path
    const { BindingStore } = await import('../../apps/wb-bot/src/binding/store.js');
    const store = new BindingStore(join(dir, 'store-test.db'));
    expect(store.isReadOnly).toBe(false);
    expect(store.migrationResult.success).toBe(true);
    expect(store.migrationResult.toVersion).toBe(CURRENT_SCHEMA_VERSION);

    // upsert + get round-trip with new schema
    store.upsertThreadBinding('default', { userOpenId: 'ou_test', threadId: 'th_test', agentId: 'claude-code', cwd: '/tmp' });
    const binding = store.getThreadBinding('default', 'ou_test', 'th_test');
    expect(binding).toBeTruthy();
    expect(binding!.agentId).toBe('claude-code');

    store.upsertContinuation('default', 'ou_test', 'th_test', 'claude-code', 'tok_123');
    expect(store.getContinuation('default', 'ou_test', 'th_test', 'claude-code')).toBe('tok_123');

    store.upsertInflightCard('default', { userOpenId: 'ou_test', threadId: 'th_test', sourceMessageId: 'sm', replyMessageId: 'rm', runId: 'r1', agentId: 'claude-code' });
    const card = store.getInflightCard('default', 'ou_test', 'th_test', 'claude-code');
    expect(card).toBeTruthy();
    expect(card!.runId).toBe('r1');

    store.close();
  });
});
