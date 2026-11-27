import type BetterSqlite3 from 'better-sqlite3';
import type { Migration } from './001-add-run-id-agent-id.js';

export const migration003: Migration = {
  version: 3,
  description: 'inflight_card PK include agent_id · 解 multi-agent concurrent inflight 互相覆盖 / cleanupSession 连带删除 bug',
  up(db) {
    db.exec(`UPDATE inflight_card SET agent_id = 'claude-code' WHERE agent_id IS NULL`);

    db.exec(`
      CREATE TABLE inflight_card_new (
        user_open_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        source_message_id TEXT NOT NULL,
        reply_message_id TEXT NOT NULL,
        run_id TEXT,
        agent_id TEXT NOT NULL DEFAULT 'claude-code',
        bot_id TEXT NOT NULL DEFAULT 'default',
        PRIMARY KEY (bot_id, user_open_id, thread_id, agent_id)
      )
    `);
    db.exec(`
      INSERT INTO inflight_card_new (
        user_open_id, thread_id, source_message_id, reply_message_id, run_id, agent_id, bot_id
      )
      SELECT
        user_open_id, thread_id, source_message_id, reply_message_id, run_id,
        COALESCE(agent_id, 'claude-code'),
        bot_id
      FROM inflight_card
    `);
    db.exec(`DROP TABLE inflight_card`);
    db.exec(`ALTER TABLE inflight_card_new RENAME TO inflight_card`);
  },
};
