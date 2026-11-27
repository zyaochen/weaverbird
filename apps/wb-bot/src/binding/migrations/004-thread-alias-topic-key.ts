import type BetterSqlite3 from 'better-sqlite3';
import type { Migration } from './001-add-run-id-agent-id.js';

function insertLegacyChatAliases(db: InstanceType<typeof BetterSqlite3>, table: 'thread_binding' | 'agent_continuation' | 'inflight_card'): void {
  db.exec(`
    INSERT OR IGNORE INTO thread_alias (bot_id, user_open_id, alias_thread_id, target_thread_id)
    SELECT DISTINCT
      bot_id,
      user_open_id,
      'chat:' || thread_id,
      thread_id
    FROM ${table}
    WHERE thread_id NOT LIKE 'chat:%'
      AND thread_id NOT LIKE 'root:%'
  `);
}

export const migration004: Migration = {
  version: 4,
  description: 'add thread_alias table for canonical topic-key fallback to legacy chat_id rows',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS thread_alias (
        bot_id TEXT NOT NULL DEFAULT 'default',
        user_open_id TEXT NOT NULL,
        alias_thread_id TEXT NOT NULL,
        target_thread_id TEXT NOT NULL,
        PRIMARY KEY (bot_id, user_open_id, alias_thread_id)
      )
    `);

    insertLegacyChatAliases(db, 'thread_binding');
    insertLegacyChatAliases(db, 'agent_continuation');
    insertLegacyChatAliases(db, 'inflight_card');
  },
};
