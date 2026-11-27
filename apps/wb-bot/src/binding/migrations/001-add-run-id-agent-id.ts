import type BetterSqlite3 from 'better-sqlite3';

export interface Migration {
  version: number;
  description: string;
  up(db: InstanceType<typeof BetterSqlite3>): void;
}

export const migration001: Migration = {
  version: 1,
  description: 'add run_id and agent_id columns to inflight_card',
  up(db) {
    db.exec(`ALTER TABLE inflight_card ADD COLUMN run_id TEXT`);
    db.exec(`ALTER TABLE inflight_card ADD COLUMN agent_id TEXT`);
  },
};
