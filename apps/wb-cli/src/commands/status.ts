import { existsSync } from 'node:fs';
import BetterSqlite3 from 'better-sqlite3';
import { botDbPath, resolveDataDir } from '../../../../packages/core/src/paths.js';

type ThreadBinding = { agentId: string; cwd: string | null } | null;

function readThreadBinding(dbPath: string, botId: string, userOpenId: string, threadId: string): ThreadBinding {
  if (!existsSync(dbPath)) return null;
  let db: InstanceType<typeof BetterSqlite3> | null = null;
  try {
    db = new BetterSqlite3(dbPath);
    // PRAGMA query_only prevents accidental writes; no schema migration is triggered
    db.pragma('query_only = ON');
    const row = db
      .prepare('SELECT agent_id, cwd FROM thread_binding WHERE bot_id = ? AND user_open_id = ? AND thread_id = ?')
      .get(botId, userOpenId, threadId) as { agent_id: string; cwd: string | null } | undefined;
    return row ? { agentId: row.agent_id, cwd: row.cwd } : null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

export function statusCommand(opts: { botId?: string; userOpenId?: string; threadId?: string; dataDir?: string } = {}): number {
  const dataDir = resolveDataDir({ dataDir: opts.dataDir });
  const botId = opts.botId ?? process.env['BOT_ID'] ?? 'default';
  const userOpenId = opts.userOpenId ?? process.env['WB_USER_OPEN_ID'] ?? 'cli';
  const threadId = opts.threadId ?? process.env['WB_THREAD_ID'] ?? 'cli';
  const binding = readThreadBinding(botDbPath(dataDir), botId, userOpenId, threadId);
  const agent = binding?.agentId ?? 'claude-code';
  const cwd = binding?.cwd ?? '-';
  const status = binding ? 'bound' : 'unknown';
  process.stdout.write(`cwd=${cwd}\nagent=${agent}\nstatus=${status}\n`);
  return 0;
}
