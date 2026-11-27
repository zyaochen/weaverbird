import type { Migration } from './001-add-run-id-agent-id.js';

/**
 * CardKit 卡片实体: 消息只引用 card_id, 之后的更新必须走 cardkit 接口且 sequence 严格递增.
 * 重启后 restart-recovery 要改写残留的运行卡, 所以 card_id 与最近用过的 sequence 落库.
 */
export const migration005: Migration = {
  version: 5,
  description: 'add card_entity table mapping Feishu message ids to CardKit card ids and sequences',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS card_entity (
        bot_id TEXT NOT NULL DEFAULT 'default',
        message_id TEXT NOT NULL,
        card_id TEXT NOT NULL,
        sequence INTEGER NOT NULL DEFAULT 0,
        streaming INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (bot_id, message_id)
      )
    `);
  },
};
