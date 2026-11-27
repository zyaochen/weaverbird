import type BetterSqlite3 from 'better-sqlite3';
import type { Migration } from './migrations/001-add-run-id-agent-id.js';
import { migration001 } from './migrations/001-add-run-id-agent-id.js';
import { migration002 } from './migrations/002-add-bot-id.js';
import { migration003 } from './migrations/003-inflight-card-agent-id-pk.js';
import { migration004 } from './migrations/004-thread-alias-topic-key.js';
import { migration005 } from './migrations/005-card-entity.js';
import { migration006 } from './migrations/006-group-setting.js';

const ALL_MIGRATIONS: Migration[] = [migration001, migration002, migration003, migration004, migration005, migration006];

export const CURRENT_SCHEMA_VERSION = ALL_MIGRATIONS.length;

export type MigrationResult = {
  success: boolean;
  fromVersion: number;
  toVersion: number;
  error?: string;
};

export function runMigrations(db: InstanceType<typeof BetterSqlite3>): MigrationResult {
  const rows = db.pragma('user_version') as unknown as Array<{ user_version: number }>;
  const currentVersion = rows[0]?.user_version ?? 0;

  if (currentVersion >= CURRENT_SCHEMA_VERSION) {
    return { success: true, fromVersion: currentVersion, toVersion: currentVersion };
  }

  const pending = ALL_MIGRATIONS.filter((m) => m.version > currentVersion);

  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const migration of pending) {
        migration.up(db);
      }
      db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return { success: true, fromVersion: currentVersion, toVersion: CURRENT_SCHEMA_VERSION };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, fromVersion: currentVersion, toVersion: currentVersion, error: message };
  }
}
