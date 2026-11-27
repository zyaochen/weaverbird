export const CREATE_THREAD_BINDING_SQL = `
CREATE TABLE IF NOT EXISTS thread_binding (
  user_open_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  cwd TEXT,
  bot_id TEXT NOT NULL DEFAULT 'default',
  PRIMARY KEY (bot_id, user_open_id, thread_id)
);
`;

export const CREATE_AGENT_CONTINUATION_SQL = `
CREATE TABLE IF NOT EXISTS agent_continuation (
  user_open_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  continuation_token TEXT NOT NULL,
  bot_id TEXT NOT NULL DEFAULT 'default',
  PRIMARY KEY (bot_id, user_open_id, thread_id, agent_id)
);
`;

export const CREATE_CWD_ALIAS_SQL = `
CREATE TABLE IF NOT EXISTS cwd_alias (
  user_open_id TEXT NOT NULL,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  PRIMARY KEY (user_open_id, name)
);
`;

export const CREATE_THREAD_ALIAS_SQL = `
CREATE TABLE IF NOT EXISTS thread_alias (
  bot_id TEXT NOT NULL DEFAULT 'default',
  user_open_id TEXT NOT NULL,
  alias_thread_id TEXT NOT NULL,
  target_thread_id TEXT NOT NULL,
  PRIMARY KEY (bot_id, user_open_id, alias_thread_id)
);
`;

// NOTE: SCHEMA_SQL 是 "v0 早期 form", 由 migrations 001/002/003 增量升到 final form.
// 不要把 run_id / agent_id / 4-tuple PK 写在这里, 否则 m001 ADD COLUMN 会撞重复列.
// 最终 form 见 migration 003 (PK = (bot_id, user_open_id, thread_id, agent_id),
// agent_id NOT NULL DEFAULT 'claude-code').
export const CREATE_INFLIGHT_CARD_SQL = `
CREATE TABLE IF NOT EXISTS inflight_card (
  user_open_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  reply_message_id TEXT NOT NULL,
  bot_id TEXT NOT NULL DEFAULT 'default',
  PRIMARY KEY (bot_id, user_open_id, thread_id)
);
`;

export const SCHEMA_SQL = [
  CREATE_THREAD_BINDING_SQL,
  CREATE_AGENT_CONTINUATION_SQL,
  CREATE_CWD_ALIAS_SQL,
  CREATE_THREAD_ALIAS_SQL,
  CREATE_INFLIGHT_CARD_SQL,
] as const;
