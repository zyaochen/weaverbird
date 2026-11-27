import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { runMigrations, type MigrationResult } from './migration-runner.js';
import { SCHEMA_SQL } from './schema.js';
import { sleepSync } from './sleep-sync.js';
import { toChatTopicKey } from '../feishu/topic-key.js';

export type ThreadBinding = {
  userOpenId: string;
  threadId: string;
  agentId: string;
  cwd: string | null;
};

export type CwdAlias = {
  name: string;
  path: string;
};

export type InflightCard = {
  userOpenId: string;
  threadId: string;
  sourceMessageId: string;
  replyMessageId: string;
  agentId: string;
  runId?: string | null;
};

export type CardEntity = {
  cardId: string;
  /** 最近一次已占用的 sequence; 下一次更新必须用更大的值. */
  sequence: number;
  streaming: boolean;
};

type ThreadBindingRow = {
  user_open_id: string;
  thread_id: string;
  agent_id: string;
  cwd: string | null;
};

type InflightCardRow = Record<string, unknown>;

const ALIAS_CHAIN_LIMIT = 8;

export class BindingStore {
  private readonly db: InstanceType<typeof BetterSqlite3>;
  private readonly readOnly: boolean;
  readonly migrationResult: MigrationResult;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new (BetterSqlite3 as unknown as { new (path: string, options?: { timeout?: number }): InstanceType<typeof BetterSqlite3> })(dbPath, { timeout: 5000 });
    this.ensureWalMode();
    this.db.pragma('foreign_keys = ON');
    for (const sql of SCHEMA_SQL) this.db.exec(sql);

    this.migrationResult = runMigrations(this.db);
    this.readOnly = !this.migrationResult.success;
  }

  private ensureWalMode(): void {
    const db = this.db as InstanceType<typeof BetterSqlite3> & {
      pragma(source: string, options?: { simple?: boolean }): unknown;
    };
    const current = String(db.pragma('journal_mode', { simple: true }) ?? '').toLowerCase();
    if (current === 'wal') return;

    const delays = [50, 100, 200, 400, 800, 1600] as const;
    let lastError: unknown;
    for (let i = 0; i <= delays.length; i++) {
      try {
        this.db.pragma('journal_mode = WAL');
        return;
      } catch (error) {
        lastError = error;
        const code = error instanceof Error && 'code' in error
          ? (error as Error & { code?: string }).code
          : undefined;
        if (code !== 'SQLITE_BUSY' && code !== 'SQLITE_LOCKED') throw error;
        if (i === delays.length) break;
        sleepSync(delays[i]!);
        const recheck = String(db.pragma('journal_mode', { simple: true }) ?? '').toLowerCase();
        if (recheck === 'wal') return;
      }
    }
    throw lastError;
  }

  private initialThreadIdCandidates(threadId: string): string[] {
    const normalized = threadId.trim();
    if (!normalized) return [];
    const out = [normalized];
    if (normalized.startsWith('chat:')) {
      out.push(normalized.slice('chat:'.length));
      return out;
    }
    if (normalized.startsWith('root:')) return out;
    const chatKey = toChatTopicKey(normalized);
    if (chatKey && chatKey !== normalized) out.push(chatKey);
    return out;
  }

  private listThreadIdCandidates(botId: string, userOpenId: string, threadId: string): string[] {
    const queue = this.initialThreadIdCandidates(threadId);
    const seen = new Set(queue);
    const readAlias = this.db.prepare(
      'SELECT target_thread_id FROM thread_alias WHERE bot_id = ? AND user_open_id = ? AND alias_thread_id = ?',
    );

    for (let i = 0; i < queue.length && i < ALIAS_CHAIN_LIMIT; i += 1) {
      const key = queue[i]!;
      const row = readAlias.get(botId, userOpenId, key) as { target_thread_id?: string } | undefined;
      const target = typeof row?.target_thread_id === 'string' ? row.target_thread_id : null;
      if (!target || seen.has(target)) continue;
      seen.add(target);
      queue.push(target);
      for (const fallback of this.initialThreadIdCandidates(target)) {
        if (seen.has(fallback)) continue;
        seen.add(fallback);
        queue.push(fallback);
      }
    }

    return queue;
  }

  private findThreadBindingRow(botId: string, userOpenId: string, threadId: string): ThreadBindingRow | undefined {
    const stmt = this.db.prepare(
      'SELECT user_open_id, thread_id, agent_id, cwd FROM thread_binding WHERE bot_id = ? AND user_open_id = ? AND thread_id = ?',
    );
    for (const candidate of this.listThreadIdCandidates(botId, userOpenId, threadId)) {
      const row = stmt.get(botId, userOpenId, candidate) as ThreadBindingRow | undefined;
      if (row) return row;
    }
    return undefined;
  }

  private findContinuationRow(botId: string, userOpenId: string, threadId: string, agentId: string): { thread_id: string; continuation_token: string } | undefined {
    const stmt = this.db.prepare(
      'SELECT thread_id, continuation_token FROM agent_continuation WHERE bot_id = ? AND user_open_id = ? AND thread_id = ? AND agent_id = ?',
    );
    for (const candidate of this.listThreadIdCandidates(botId, userOpenId, threadId)) {
      const row = stmt.get(botId, userOpenId, candidate, agentId) as { thread_id: string; continuation_token: string } | undefined;
      if (row) return row;
    }
    return undefined;
  }

  private findInflightCardRow(botId: string, userOpenId: string, threadId: string, agentId: string): InflightCardRow | undefined {
    const stmt = this.db.prepare(
      'SELECT * FROM inflight_card WHERE bot_id = ? AND user_open_id = ? AND thread_id = ? AND agent_id = ?',
    );
    for (const candidate of this.listThreadIdCandidates(botId, userOpenId, threadId)) {
      const row = stmt.get(botId, userOpenId, candidate, agentId) as InflightCardRow | undefined;
      if (row) return row;
    }
    return undefined;
  }

  private toInflightCard(row: InflightCardRow): InflightCard {
    return {
      userOpenId: row['user_open_id'] as string,
      threadId: row['thread_id'] as string,
      sourceMessageId: row['source_message_id'] as string,
      replyMessageId: row['reply_message_id'] as string,
      agentId: row['agent_id'] as string,
      runId: (row['run_id'] as string | null) ?? undefined,
    };
  }

  get isReadOnly(): boolean {
    return this.readOnly;
  }

  /**
   * SQLite integrity quick check (lightweight, not full PRAGMA integrity_check).
   * Block E E6 + plan v1.5 §2 Block E (A.M-7): chosen over BEGIN IMMEDIATE
   * to avoid contending the write lock in W2.5 multi-bot scenarios.
   */
  quickCheck(): { ok: boolean; error?: string } {
    try {
      const row = this.db.prepare('PRAGMA quick_check').get() as { quick_check?: string } | undefined;
      const value = row?.quick_check ?? '';
      if (value === 'ok') return { ok: true };
      return { ok: false, error: value };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  close(): void {
    this.db.close();
  }

  upsertThreadAlias(botId: string, userOpenId: string, aliasThreadId: string, targetThreadId: string): void {
    if (this.readOnly) return;
    if (!aliasThreadId || !targetThreadId) return;
    this.db.prepare(
      `INSERT INTO thread_alias (bot_id, user_open_id, alias_thread_id, target_thread_id)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(bot_id, user_open_id, alias_thread_id)
       DO UPDATE SET target_thread_id = excluded.target_thread_id`,
    ).run(botId, userOpenId, aliasThreadId, targetThreadId);
  }

  getThreadBinding(botId: string, userOpenId: string, threadId: string): ThreadBinding | null {
    const row = this.findThreadBindingRow(botId, userOpenId, threadId);
    if (!row) return null;
    return { userOpenId: row.user_open_id, threadId: row.thread_id, agentId: row.agent_id, cwd: row.cwd };
  }

  upsertThreadBinding(botId: string, binding: ThreadBinding): void {
    const existing = this.findThreadBindingRow(botId, binding.userOpenId, binding.threadId);
    const threadId = existing?.thread_id ?? binding.threadId;
    this.db.prepare(
      `INSERT INTO thread_binding (bot_id, user_open_id, thread_id, agent_id, cwd)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(bot_id, user_open_id, thread_id)
       DO UPDATE SET agent_id = excluded.agent_id, cwd = excluded.cwd`,
    ).run(botId, binding.userOpenId, threadId, binding.agentId, binding.cwd);
  }

  setCurrentAgent(botId: string, userOpenId: string, threadId: string, agentId: string): void {
    const existing = this.getThreadBinding(botId, userOpenId, threadId);
    this.upsertThreadBinding(botId, { userOpenId, threadId: existing?.threadId ?? threadId, agentId, cwd: existing?.cwd ?? null });
  }

  setCurrentCwd(botId: string, userOpenId: string, threadId: string, cwd: string | null): void {
    const existing = this.getThreadBinding(botId, userOpenId, threadId);
    this.upsertThreadBinding(botId, { userOpenId, threadId: existing?.threadId ?? threadId, agentId: existing?.agentId ?? 'claude-code', cwd });
  }

  getContinuation(botId: string, userOpenId: string, threadId: string, agentId: string): string | null {
    const row = this.findContinuationRow(botId, userOpenId, threadId, agentId);
    return row?.continuation_token ?? null;
  }

  upsertContinuation(botId: string, userOpenId: string, threadId: string, agentId: string, token: string): void {
    const existing = this.findContinuationRow(botId, userOpenId, threadId, agentId);
    const storageThreadId = existing?.thread_id ?? threadId;
    this.db.prepare(
      `INSERT INTO agent_continuation (bot_id, user_open_id, thread_id, agent_id, continuation_token)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(bot_id, user_open_id, thread_id, agent_id)
       DO UPDATE SET continuation_token = excluded.continuation_token`,
    ).run(botId, userOpenId, storageThreadId, agentId, token);
  }

  clearContinuation(botId: string, userOpenId: string, threadId: string, agentId: string): boolean {
    const existing = this.findContinuationRow(botId, userOpenId, threadId, agentId);
    if (!existing) return false;
    const result = this.db.prepare(
      'DELETE FROM agent_continuation WHERE bot_id = ? AND user_open_id = ? AND thread_id = ? AND agent_id = ?',
    ).run(botId, userOpenId, existing.thread_id, agentId);
    return result.changes > 0;
  }

  upsertInflightCard(botId: string, card: InflightCard): void {
    if (this.readOnly) return;
    const existing = this.findInflightCardRow(botId, card.userOpenId, card.threadId, card.agentId);
    const storageThreadId = (existing?.['thread_id'] as string | undefined) ?? card.threadId;
    this.db.prepare(
      `INSERT INTO inflight_card (bot_id, user_open_id, thread_id, agent_id, source_message_id, reply_message_id, run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(bot_id, user_open_id, thread_id, agent_id)
       DO UPDATE SET source_message_id = excluded.source_message_id, reply_message_id = excluded.reply_message_id, run_id = excluded.run_id`,
    ).run(botId, card.userOpenId, storageThreadId, card.agentId, card.sourceMessageId, card.replyMessageId, card.runId ?? null);
  }

  getInflightCard(botId: string, userOpenId: string, threadId: string, agentId: string): InflightCard | null {
    const row = this.findInflightCardRow(botId, userOpenId, threadId, agentId);
    return row ? this.toInflightCard(row) : null;
  }

  listInflightCards(botId: string): InflightCard[] {
    const rows = this.db.prepare(
      'SELECT * FROM inflight_card WHERE bot_id = ? ORDER BY user_open_id ASC, thread_id ASC, agent_id ASC',
    ).all(botId) as Array<InflightCardRow>;
    return rows.map((row) => this.toInflightCard(row));
  }

  clearInflightCard(botId: string, userOpenId: string, threadId: string, agentId: string): boolean {
    const existing = this.findInflightCardRow(botId, userOpenId, threadId, agentId);
    if (!existing) return false;
    const result = this.db.prepare(
      'DELETE FROM inflight_card WHERE bot_id = ? AND user_open_id = ? AND thread_id = ? AND agent_id = ?',
    ).run(botId, userOpenId, existing['thread_id'], agentId);
    return result.changes > 0;
  }

  setAlias(userOpenId: string, name: string, path: string): void {
    this.db.prepare(
      `INSERT INTO cwd_alias (user_open_id, name, path)
       VALUES (?, ?, ?)
       ON CONFLICT(user_open_id, name)
       DO UPDATE SET path = excluded.path`,
    ).run(userOpenId, name, path);
  }

  listAliases(userOpenId: string): CwdAlias[] {
    const rows = this.db.prepare(
      'SELECT name, path FROM cwd_alias WHERE user_open_id = ? ORDER BY name ASC',
    ).all(userOpenId) as Array<{ name: string; path: string }>;
    return rows.map((row) => ({ name: row.name, path: row.path }));
  }

  removeAlias(userOpenId: string, name: string): boolean {
    const result = this.db.prepare('DELETE FROM cwd_alias WHERE user_open_id = ? AND name = ?').run(userOpenId, name);
    return result.changes > 0;
  }

  getCardEntity(botId: string, messageId: string): CardEntity | null {
    const row = this.db.prepare(
      'SELECT card_id, sequence, streaming FROM card_entity WHERE bot_id = ? AND message_id = ?',
    ).get(botId, messageId) as { card_id: string; sequence: number; streaming: number } | undefined;
    return row ? { cardId: row.card_id, sequence: row.sequence, streaming: row.streaming === 1 } : null;
  }

  saveCardEntity(botId: string, messageId: string, entity: CardEntity): void {
    if (this.readOnly) return;
    this.db.prepare(
      `INSERT INTO card_entity (bot_id, message_id, card_id, sequence, streaming, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(bot_id, message_id)
       DO UPDATE SET card_id = excluded.card_id, sequence = excluded.sequence, streaming = excluded.streaming, updated_at = excluded.updated_at`,
    ).run(botId, messageId, entity.cardId, entity.sequence, entity.streaming ? 1 : 0, Date.now());
  }

  /** 卡片实体只在运行期和重启恢复时有用; 清掉长时间没动过的. */
  pruneCardEntities(olderThanMs: number): number {
    if (this.readOnly) return 0;
    return this.db.prepare('DELETE FROM card_entity WHERE updated_at < ?').run(Date.now() - olderThanMs).changes;
  }

  /** 群里是否必须 @bot 才响应; 没设置过默认 true. */
  getRequireMention(botId: string, chatId: string): boolean {
    const row = this.db.prepare(
      'SELECT require_mention FROM group_setting WHERE bot_id = ? AND chat_id = ?',
    ).get(botId, chatId) as { require_mention: number } | undefined;
    return row ? row.require_mention === 1 : true;
  }

  setRequireMention(botId: string, chatId: string, requireMention: boolean, updatedBy: string): void {
    if (this.readOnly) throw new Error('binding store is read-only (migration failed); cannot change group settings');
    this.db.prepare(
      `INSERT INTO group_setting (bot_id, chat_id, require_mention, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(bot_id, chat_id)
       DO UPDATE SET require_mention = excluded.require_mention, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    ).run(botId, chatId, requireMention ? 1 : 0, updatedBy, Date.now());
  }
}
