import type { Migration } from './001-add-run-id-agent-id.js';

/** 每个群的 bot 行为开关; 目前只有 require_mention (群里是否必须 @bot 才响应). */
export const migration006: Migration = {
  version: 6,
  description: 'add group_setting table for per-chat bot switches',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS group_setting (
        bot_id TEXT NOT NULL DEFAULT 'default',
        chat_id TEXT NOT NULL,
        require_mention INTEGER NOT NULL DEFAULT 1,
        updated_by TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (bot_id, chat_id)
      )
    `);
  },
};
