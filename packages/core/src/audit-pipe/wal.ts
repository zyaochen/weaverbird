import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { auditWalDir } from '../paths.js';
import type { AuditRecord, WalEntry } from './contracts.js';

export type Wal = {
  append(record: AuditRecord): number;
  replay(): AsyncIterable<WalEntry>;
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

function parseEntry(path: string): WalEntry | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as WalEntry;
  } catch {
    return null;
  }
}

export function createWal({ dataDir }: { dataDir: string }): Wal {
  const walDir = auditWalDir(dataDir);
  mkdirSync(walDir, { recursive: true });
  let counter = 0;
  let lastSeq = readdirSync(walDir).map((file) => Number.parseInt(file.replace(/\.jsonl$/, ''), 10)).filter(Number.isFinite).reduce((max, value) => Math.max(max, value), 0);

  function filePathFor(seq: number): string {
    return join(walDir, `${serializeSeq(seq)}.jsonl`);
  }

  function writeEntry(entry: WalEntry): void {
    atomicWrite(filePathFor(entry.seq), JSON.stringify(entry));
  }

  function nextSeq(): number {
    counter += 1;
    lastSeq = Math.max(lastSeq + 1, Date.now() * 1000 + counter);
    return lastSeq;
  }

  return {
    append(record): number {
      const seq = nextSeq();
      writeEntry({ seq, record, attempts: 0, state: 'queued', enqueued_at: new Date().toISOString() });
      return seq;
    },
    async *replay(): AsyncIterable<WalEntry> {
      const files = readdirSync(walDir).filter((file) => file.endsWith('.jsonl')).sort();
      for (const file of files) {
        const entry = parseEntry(join(walDir, file));
        if (entry) yield entry;
      }
    },
    ack(seq): void {
      unlinkSync(filePathFor(seq));
    },
    markPendingSync(seq): void {
      const path = filePathFor(seq);
      const entry = parseEntry(path);
      if (!entry) return;
      writeEntry({ ...entry, attempts: Math.max(entry.attempts, 5), state: 'pending-sync' });
    },
    bumpAttempts(seq): void {
      const path = filePathFor(seq);
      const entry = parseEntry(path);
      if (!entry) return;
      writeEntry({ ...entry, attempts: entry.attempts + 1 });
    },
    listFiles(): string[] {
      return readdirSync(walDir).filter((file) => file.endsWith('.jsonl')).sort();
    },
  };
}
