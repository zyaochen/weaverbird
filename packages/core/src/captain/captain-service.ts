import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { captainStatePath } from '../paths.js';
import { appendNdjsonLine, readNdjsonSegments } from '../util/ndjson-rotation.js';
import {
  CAPTAIN_ERROR_CODES,
  CaptainError,
  type CaptainMirrorEntry,
  type SessionEntry,
  type SessionRecord,
} from './contracts.js';
import type { CaptainSessionStore } from './session-store.js';

type CreateSessionInput = Omit<SessionRecord, 'status' | 'closed_at' | 'revision'> & {
  status?: SessionRecord['status'];
  closed_at?: SessionRecord['closed_at'];
  /** Optional initial revision; defaults to 0 so legacy callers stay unchanged. */
  revision?: SessionRecord['revision'];
};

type CaptainServiceOptions = {
  dataDir: string;
  mirrorPath?: string;
  /**
   * Default store surface stays `upsert`/`reconcile`; callers may also surface
   * `upsertWithRevision` to enable the M12-A CAS path. When missing we fall back to
   * plain `upsert` to preserve single-host behaviour.
   */
  store?: Pick<CaptainSessionStore, 'upsert' | 'reconcile'> & Partial<Pick<CaptainSessionStore, 'upsertWithRevision'>>;
  nowFn?: () => string;
};

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

export class CaptainService {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly mirrorPath: string;
  private readonly store?: Pick<CaptainSessionStore, 'upsert' | 'reconcile'>;
  private readonly nowFn: () => string;

  constructor(options: CaptainServiceOptions) {
    this.mirrorPath = options.mirrorPath ?? captainStatePath(options.dataDir);
    this.store = options.store;
    this.nowFn = options.nowFn ?? (() => new Date().toISOString());
    ensureDir(join(this.mirrorPath, '..'));
  }

  getSession(sessionId: string): SessionEntry | undefined {
    const entry = this.sessions.get(sessionId);
    return entry ? { record: { ...entry.record }, run_ids: [...entry.run_ids], dirty: entry.dirty } : undefined;
  }

  listActiveSessions(): SessionEntry[] {
    return [...this.sessions.values()]
      .filter((entry) => entry.record.status === 'active' || entry.record.status === 'suspended')
      .map((entry) => ({ record: { ...entry.record }, run_ids: [...entry.run_ids], dirty: entry.dirty }));
  }

  createSession(input: CreateSessionInput): SessionEntry {
    const record: SessionRecord = {
      ...input,
      status: 'idle',
      closed_at: null,
      revision: input.revision ?? 0,
    };
    const entry: SessionEntry = { record, run_ids: [], dirty: true };
    this.sessions.set(record.session_id, entry);
    this.writeMirror({ ts: this.nowFn(), op: 'upsert', session: record });
    return this.getSession(record.session_id)!;
  }

  updateSession(sessionId: string, patch: Partial<SessionRecord>): SessionEntry {
    const entry = this.requireSession(sessionId);
    entry.record = { ...entry.record, ...patch };
    entry.dirty = true;
    this.writeMirror({ ts: this.nowFn(), op: 'upsert', session: entry.record });
    return this.getSession(sessionId)!;
  }

  bindRun(sessionId: string, runId: string): void {
    const entry = this.requireSession(sessionId);
    if (entry.record.status === 'closed') {
      throw new CaptainError(CAPTAIN_ERROR_CODES.E_SESSION_NOT_FOUND, `session ${sessionId} already closed`);
    }
    if (entry.record.status !== 'idle' && entry.record.status !== 'suspended' && entry.record.status !== 'active') {
      throw new CaptainError(CAPTAIN_ERROR_CODES.E_SESSION_NOT_FOUND, `session ${sessionId} cannot bind run from ${entry.record.status}`);
    }
    if (!entry.run_ids.includes(runId)) entry.run_ids.push(runId);
    entry.record = {
      ...entry.record,
      status: 'active',
      latest_run_id: runId,
      last_active_at: this.nowFn(),
      closed_at: null,
    };
    entry.dirty = true;
    this.writeMirror({ ts: this.nowFn(), op: 'upsert', session: entry.record });
  }

  suspendSession(sessionId: string): void {
    const entry = this.requireSession(sessionId);
    if (entry.record.status !== 'active') {
      throw new CaptainError(CAPTAIN_ERROR_CODES.E_SESSION_NOT_FOUND, `session ${sessionId} cannot suspend from ${entry.record.status}`);
    }
    entry.record = { ...entry.record, status: 'suspended', last_active_at: this.nowFn() };
    entry.dirty = true;
    this.writeMirror({ ts: this.nowFn(), op: 'upsert', session: entry.record });
  }

  closeSession(sessionId: string): void {
    const entry = this.requireSession(sessionId);
    if (entry.record.status !== 'active' && entry.record.status !== 'suspended') {
      throw new CaptainError(CAPTAIN_ERROR_CODES.E_SESSION_NOT_FOUND, `session ${sessionId} cannot close from ${entry.record.status}`);
    }
    entry.record = {
      ...entry.record,
      status: 'closed',
      closed_at: this.nowFn(),
      last_active_at: this.nowFn(),
    };
    entry.dirty = true;
    this.writeMirror({ ts: this.nowFn(), op: 'close', session: entry.record });
  }

  async flush(): Promise<void> {
    const store = this.store;
    if (!store?.upsert) return;
    for (const entry of this.sessions.values()) {
      if (!entry.dirty) continue;
      // M12-A (2026-08-04 owner-authorized, resolves PRD Q5 last-write-wins):
      // Cross-device attach relies on CAS to detect "the other host already moved the
      // row". If the store surface does not offer upsertWithRevision, fall back to the
      // simple upsert to preserve legacy single-host behaviour.
      const storeWithCas = store as Pick<CaptainSessionStore, 'upsert'> & Partial<Pick<CaptainSessionStore, 'upsertWithRevision'>>;
      if (typeof storeWithCas.upsertWithRevision === 'function') {
        const expected = entry.record.revision;
        const result = await storeWithCas.upsertWithRevision(entry.record, expected);
        entry.record = { ...entry.record, revision: result.newRevision };
      } else {
        await store.upsert(entry.record);
      }
      entry.dirty = false;
    }
  }

  async reconcile(): Promise<void> {
    const storeSessions = this.store?.reconcile ? await this.store.reconcile() : [];
    const mirrorSessions = this.readMirrorSnapshot();
    const merged = new Map<string, SessionRecord>();
    for (const record of mirrorSessions.values()) merged.set(record.session_id, record);
    for (const record of storeSessions) {
      const existing = merged.get(record.session_id);
      if (!existing || Date.parse(record.last_active_at) > Date.parse(existing.last_active_at)) {
        merged.set(record.session_id, record);
      }
    }
    for (const record of merged.values()) {
      const entry = this.sessions.get(record.session_id);
      this.sessions.set(record.session_id, {
        record,
        run_ids: entry?.run_ids ?? (record.latest_run_id ? [record.latest_run_id] : []),
        dirty: false,
      });
    }
  }

  private requireSession(sessionId: string): SessionEntry {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      throw new CaptainError(CAPTAIN_ERROR_CODES.E_SESSION_NOT_FOUND, `session ${sessionId} not found`);
    }
    return entry;
  }

  private writeMirror(entry: CaptainMirrorEntry): void {
    appendNdjsonLine(this.mirrorPath, JSON.stringify(entry), { fsync: true });
  }

  private readMirrorSnapshot(): Map<string, SessionRecord> {
    const latest = new Map<string, SessionRecord>();
    for (const line of readNdjsonSegments(this.mirrorPath)) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as CaptainMirrorEntry;
        latest.set(parsed.session.session_id, parsed.session);
      } catch {
        continue;
      }
    }
    return latest;
  }
}
