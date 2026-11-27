import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runRegistryWalDir } from '../paths.js';
import type { RunRecord, RunWalEntry } from './contracts.js';

export type RunRegistryWal = {
  append(runId: string, record: RunRecord): number;
  replay(): AsyncIterable<RunWalEntry>;
  ack(seq: number): void;
  markPendingSync(seq: number): void;
  bumpAttempts(seq: number): void;
  listFiles(): string[];
};

function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

function serializeSeq(seq: number): string {
  return `${seq}`.padStart(16, '0');
}

function parseEntry(path: string): RunWalEntry | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as RunWalEntry;
  } catch {
    return null;
  }
}

export function createRunRegistryWal({ dataDir, walPath }: { dataDir: string; walPath?: string }): RunRegistryWal {
  const walDir = walPath ?? runRegistryWalDir(dataDir);
  mkdirSync(walDir, { recursive: true });
  let counter = 0;
  let lastSeq = 0;
  for (const file of readdirSync(walDir)) {
    const match = file.match(/_(\d+)\.jsonl$/);
    const seq = match ? Number.parseInt(match[1]!, 10) : Number.NaN;
    if (Number.isFinite(seq)) lastSeq = Math.max(lastSeq, seq);
  }

  function filePathFor(entry: Pick<RunWalEntry, 'run_id' | 'seq'>): string {
    return join(walDir, `${entry.run_id}_${serializeSeq(entry.seq)}.jsonl`);
  }

  function findEntryPath(seq: number): string | null {
    const suffix = `_${serializeSeq(seq)}.jsonl`;
    try {
      const file = readdirSync(walDir).find((name) => name.endsWith(suffix));
      return file ? join(walDir, file) : null;
    } catch {
      return null;
    }
  }

  function writeEntry(entry: RunWalEntry): void {
    atomicWrite(filePathFor(entry), JSON.stringify(entry));
  }

  function nextSeq(): number {
    counter += 1;
    lastSeq = Math.max(lastSeq + 1, Date.now() * 1000 + counter);
    return lastSeq;
  }

  return {
    append(runId, record): number {
      const seq = nextSeq();
      writeEntry({ seq, run_id: runId, record, attempts: 0, state: 'queued', enqueued_at: new Date().toISOString() });
      return seq;
    },
    async *replay(): AsyncIterable<RunWalEntry> {
      let files: string[] = [];
      try {
        files = readdirSync(walDir).filter((file) => file.endsWith('.jsonl')).sort();
      } catch {
        files = [];
      }
      for (const file of files) {
        const entry = parseEntry(join(walDir, file));
        if (entry) yield entry;
      }
    },
    ack(seq): void {
      const path = findEntryPath(seq);
      if (path) unlinkSync(path);
    },
    markPendingSync(seq): void {
      const path = findEntryPath(seq);
      if (!path) return;
      const entry = parseEntry(path);
      if (!entry) return;
      unlinkSync(path);
      writeEntry({ ...entry, attempts: Math.max(entry.attempts, 5), state: 'pending-sync' });
    },
    bumpAttempts(seq): void {
      const path = findEntryPath(seq);
      if (!path) return;
      const entry = parseEntry(path);
      if (!entry) return;
      unlinkSync(path);
      writeEntry({ ...entry, attempts: entry.attempts + 1 });
    },
    listFiles(): string[] {
      try {
        return readdirSync(walDir).filter((file) => file.endsWith('.jsonl')).sort();
      } catch {
        return [];
      }
    },
  };
}
