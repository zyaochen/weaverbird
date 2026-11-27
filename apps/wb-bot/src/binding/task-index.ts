import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type TaskEntry = {
  runId: string;
  agentId: string;
  status: string;
  cwd: string;
  startedAt: string;
  lastModified: number;
  userOpenId: string;
  threadId: string;
};

const MAX_ENTRIES = 700;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

class SimpleLRU<K, V> {
  private readonly map = new Map<K, V>();
  constructor(private readonly max: number) {}

  get size(): number { return this.map.size; }

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }

  entries(): IterableIterator<[K, V]> { return this.map.entries(); }
}

/**
 * TaskIndex: in-memory LRU (max 700 entries) of recent runs.
 *
 * Scope (W2): single wb-bot process, default botId; 7-day window.
 * Out-of-scope: no search / tag / retry / scheduled / cross-bot aggregation (W2.5+).
 * Source of truth: runs/<botId>/<runId>/{spec.json, status} filesystem;
 * SQLite binding only holds inflight_card table, not TaskIndex state.
 */
export class TaskIndex {
  private readonly cache: SimpleLRU<string, TaskEntry>;
  private scanning = false;

  constructor(private readonly dataDir: string, private readonly botId: string = 'default') {
    this.cache = new SimpleLRU<string, TaskEntry>(MAX_ENTRIES);
  }

  get size(): number {
    return this.cache.size;
  }

  get(runId: string): TaskEntry | undefined {
    return this.cache.get(runId);
  }

  list(limit?: number): TaskEntry[] {
    const entries: TaskEntry[] = [];
    for (const [, entry] of this.cache.entries()) {
      entries.push(entry);
    }
    entries.sort((a, b) => b.lastModified - a.lastModified);
    return limit ? entries.slice(0, limit) : entries;
  }

  scheduleScan(): void {
    if (this.scanning) return;
    this.scanning = true;
    setImmediate(() => {
      try {
        this.scan();
      } finally {
        this.scanning = false;
      }
    });
  }

  scan(): void {
    const runsDir = join(this.dataDir, 'runs', this.botId);
    if (!existsSync(runsDir)) return;

    const cutoff = Date.now() - SEVEN_DAYS_MS;
    let dirs: string[];
    try {
      dirs = readdirSync(runsDir);
    } catch {
      return;
    }

    for (const runId of dirs) {
      const runDir = join(runsDir, runId);
      const specPath = join(runDir, 'spec.json');
      const statusPath = join(runDir, 'status');

      if (!existsSync(specPath)) continue;

      let lastModified: number;
      try {
        const stat = statSync(runDir);
        lastModified = stat.mtimeMs;
      } catch {
        continue;
      }

      if (lastModified < cutoff) continue;

      try {
        const specRaw = readFileSync(specPath, 'utf8');
        const spec = JSON.parse(specRaw) as Record<string, unknown>;
        const status = existsSync(statusPath)
          ? readFileSync(statusPath, 'utf8').trim()
          : 'running';

        this.cache.set(runId, {
          runId,
          agentId: (spec['agentId'] as string) ?? 'unknown',
          status,
          cwd: (spec['cwd'] as string) ?? '',
          startedAt: (spec['startedAt'] as string) ?? '',
          lastModified,
          userOpenId: (spec['userOpenId'] as string) ?? '',
          threadId: (spec['threadId'] as string) ?? '',
        });
      } catch {
        continue;
      }
    }
  }
}
