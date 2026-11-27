import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * MuteRegistry (PRD §4.1 架构模块 / §2.7 @ 礼仪第 4 条)
 *
 * 职责：
 *   - 记录 /wb mute <sid> <duration> 的静音状态
 *   - NotifyDispatcher 派 @ 通知前先查 isMuted(sessionId)
 *   - 命中静音 → 仅刷卡片，不 @ 人
 *   - 静音到期自动失效
 *
 * 持久化策略：本地 JSON file（~/.weaverbird/mute.json）。Captain 挂掉重启后
 * mute 状态仍在。容量 <20 user × <100 session 时 JSON 文件足够，不引 DB。
 *
 * 无 LLM/network dependency —— 仅依赖 fs + time, 高度可测.
 */

type MuteEntry = {
  sessionId: string;
  expiresAtIso: string;
  createdAtIso: string;
  reason?: string;
};

type MuteFileShape = {
  version: 1;
  entries: MuteEntry[];
};

export type MuteQuery = {
  sessionId: string;
  nowIso?: string;
};

export type MuteRecord = {
  sessionId: string;
  muted: boolean;
  expiresAtIso?: string;
  reason?: string;
};

const DEFAULT_FILE_VERSION = 1 as const;

function isExpired(entry: MuteEntry, nowIso: string): boolean {
  return entry.expiresAtIso <= nowIso;
}

function parseDuration(duration: string, fromIso: string): string | null {
  const match = duration.trim().match(/^(\d+)(s|m|h|d)$/i);
  if (!match) return null;
  const value = Number.parseInt(match[1]!, 10);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = match[2]!.toLowerCase();
  const factorMs =
    unit === 's' ? 1_000 :
    unit === 'm' ? 60_000 :
    unit === 'h' ? 3_600_000 :
    unit === 'd' ? 86_400_000 : 0;
  if (factorMs === 0) return null;
  const fromMs = Date.parse(fromIso);
  if (Number.isNaN(fromMs)) return null;
  return new Date(fromMs + value * factorMs).toISOString();
}

function readFileSafe(path: string): MuteFileShape {
  if (!existsSync(path)) return { version: DEFAULT_FILE_VERSION, entries: [] };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<MuteFileShape> | null;
    if (!raw || typeof raw !== 'object') return { version: DEFAULT_FILE_VERSION, entries: [] };
    const entries = Array.isArray(raw.entries)
      ? raw.entries.filter((e): e is MuteEntry =>
          !!e &&
          typeof e === 'object' &&
          typeof (e as MuteEntry).sessionId === 'string' &&
          typeof (e as MuteEntry).expiresAtIso === 'string' &&
          typeof (e as MuteEntry).createdAtIso === 'string')
      : [];
    return { version: DEFAULT_FILE_VERSION, entries };
  } catch {
    return { version: DEFAULT_FILE_VERSION, entries: [] };
  }
}

export class MuteRegistry {
  private readonly filePath: string;
  private state: MuteFileShape;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.state = readFileSafe(filePath);
  }

  isMuted(query: MuteQuery): MuteRecord {
    const nowIso = query.nowIso ?? new Date().toISOString();
    const entry = this.state.entries.find((e) => e.sessionId === query.sessionId && !isExpired(e, nowIso));
    if (!entry) return { sessionId: query.sessionId, muted: false };
    return {
      sessionId: query.sessionId,
      muted: true,
      expiresAtIso: entry.expiresAtIso,
      reason: entry.reason,
    };
  }

  mute(sessionId: string, duration: string, opts: { nowIso?: string; reason?: string } = {}):
    { ok: boolean; expiresAtIso?: string; reason?: string; error?: string } {
    const nowIso = opts.nowIso ?? new Date().toISOString();
    const expiresAtIso = parseDuration(duration, nowIso);
    if (!expiresAtIso) {
      return { ok: false, error: `invalid duration: ${duration} (expect 30s / 15m / 2h / 7d)` };
    }
    const next: MuteEntry = {
      sessionId,
      expiresAtIso,
      createdAtIso: nowIso,
      ...(opts.reason ? { reason: opts.reason } : {}),
    };
    this.state = {
      version: DEFAULT_FILE_VERSION,
      entries: [...this.state.entries.filter((e) => e.sessionId !== sessionId), next],
    };
    this.persist();
    return { ok: true, expiresAtIso };
  }

  unmute(sessionId: string): { ok: boolean; removed: number } {
    const before = this.state.entries.length;
    this.state = {
      version: DEFAULT_FILE_VERSION,
      entries: this.state.entries.filter((e) => e.sessionId !== sessionId),
    };
    const removed = before - this.state.entries.length;
    if (removed > 0) this.persist();
    return { ok: removed > 0, removed };
  }

  list(opts: { includeExpired?: boolean; nowIso?: string } = {}): MuteEntry[] {
    const nowIso = opts.nowIso ?? new Date().toISOString();
    if (opts.includeExpired) return [...this.state.entries];
    return this.state.entries.filter((e) => !isExpired(e, nowIso));
  }

  private persist(): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8');
    renameSync(tmp, this.filePath);
  }
}

export function defaultMuteRegistryPath(dataDir: string): string {
  return `${dataDir}/mute-registry.json`;
}

export { parseDuration };
