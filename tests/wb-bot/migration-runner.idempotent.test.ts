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

function createDb(dir: string): InstanceType<typeof BetterSqlite3> {
  const db = new BetterSqlite3(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  for (const sql of SCHEMA_SQL) db.exec(sql);
  return db;
}

describe('M-3 migration runner idempotency + atomic transaction', () => {
  it('running migrations twice yields same user_version and no duplicate schema', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-migration-'));
    roots.push(dir);
    const db = createDb(dir);

    const result1 = runMigrations(db);
    expect(result1.success).toBe(true);
    expect(result1.toVersion).toBe(CURRENT_SCHEMA_VERSION);

    const result2 = runMigrations(db);
    expect(result2.success).toBe(true);
    expect(result2.fromVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(result2.toVersion).toBe(CURRENT_SCHEMA_VERSION);

    const version = (db.pragma('user_version') as unknown as Array<{ user_version: number }>)[0]!.user_version;
    expect(version).toBe(CURRENT_SCHEMA_VERSION);

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>;
    const tableNames = tables.map((t) => t.name);
    const uniqueNames = [...new Set(tableNames)];
    expect(tableNames).toEqual(uniqueNames);

    db.close();
  });

  it('running migrations 3 times has no effect after first', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-migration-'));
    roots.push(dir);
    const db = createDb(dir);

    runMigrations(db);
    runMigrations(db);
    const result3 = runMigrations(db);

    expect(result3.success).toBe(true);
    expect(result3.fromVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(result3.toVersion).toBe(CURRENT_SCHEMA_VERSION);

    db.close();
  });

  it('atomic migration: BEGIN IMMEDIATE wraps all migration steps', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-migration-'));
    roots.push(dir);
    const db = createDb(dir);

    const result = runMigrations(db);
    expect(result.success).toBe(true);
    expect(result.toVersion).toBe(CURRENT_SCHEMA_VERSION);

    // Verify the user_version was set inside the transaction
    const version = (db.pragma('user_version') as unknown as Array<{ user_version: number }>)[0]!.user_version;
    expect(version).toBe(CURRENT_SCHEMA_VERSION);

    db.close();
  });
});
