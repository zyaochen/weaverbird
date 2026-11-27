import type BetterSqlite3 from 'better-sqlite3';
import type { Migration } from './001-add-run-id-agent-id.js';

function rebuildTable(
  db: InstanceType<typeof BetterSqlite3>,
  table: string,
  columns: string,
  selectCols: string,
  newPk: string,
): void {
  db.exec(`CREATE TABLE ${table}_new (${columns}, PRIMARY KEY (${newPk}))`);
  db.exec(`INSERT INTO ${table}_new (${selectCols}, bot_id) SELECT ${selectCols}, 'default' FROM ${table}`);
  db.exec(`DROP TABLE ${table}`);
  db.exec(`ALTER TABLE ${table}_new RENAME TO ${table}`);
}

export const migration002: Migration = {
  version: 2,
  description: 'add bot_id column + PK upgrade to thread_binding, agent_continuation, inflight_card',
  up(db) {
    rebuildTable(
      db,
      'thread_binding',
      'user_open_id TEXT NOT NULL, thread_id TEXT NOT NULL, agent_id TEXT NOT NULL, cwd TEXT, bot_id TEXT NOT NULL DEFAULT \'default\'',
      'user_open_id, thread_id, agent_id, cwd',
      'bot_id, user_open_id, thread_id',
    );

    rebuildTable(
      db,
      'agent_continuation',
      'user_open_id TEXT NOT NULL, thread_id TEXT NOT NULL, agent_id TEXT NOT NULL, continuation_token TEXT NOT NULL, bot_id TEXT NOT NULL DEFAULT \'default\'',
      'user_open_id, thread_id, agent_id, continuation_token',
      'bot_id, user_open_id, thread_id, agent_id',
    );

    // inflight_card has run_id + agent_id from migration 001
    const cols = db.prepare("PRAGMA table_info('inflight_card')").all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);
    const hasRunId = colNames.includes('run_id');
    const hasAgentId = colNames.includes('agent_id');

    let inflightCols = 'user_open_id TEXT NOT NULL, thread_id TEXT NOT NULL, source_message_id TEXT NOT NULL, reply_message_id TEXT NOT NULL';
    let selectList = 'user_open_id, thread_id, source_message_id, reply_message_id';

    if (hasRunId) {
      inflightCols += ', run_id TEXT';
      selectList += ', run_id';
    }
    if (hasAgentId) {
      inflightCols += ', agent_id TEXT';
      selectList += ', agent_id';
    }

    inflightCols += ", bot_id TEXT NOT NULL DEFAULT 'default'";

    db.exec(`CREATE TABLE inflight_card_new (${inflightCols}, PRIMARY KEY (bot_id, user_open_id, thread_id))`);
    db.exec(`INSERT INTO inflight_card_new (${selectList}, bot_id) SELECT ${selectList}, 'default' FROM inflight_card`);
    db.exec('DROP TABLE inflight_card');
    db.exec('ALTER TABLE inflight_card_new RENAME TO inflight_card');
  },
};
