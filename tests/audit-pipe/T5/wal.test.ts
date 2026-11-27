import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createWal } from '../../../packages/core/src/audit-pipe/wal.js';
import type { AuditRecord } from '../../../packages/core/src/audit-pipe/contracts.js';

function record(revision: number): AuditRecord {
  return {
    audit_record_id: `a${revision}`,
    session_id: 'om_t',
    run_id: 'r1',
    revision,
    actor: 'ou_x',
    action: 'file_read',
    resource: 'a.ts',
    ts: '2026-06-04T00:00:00.000Z',
    entry_form: 'im',
    entry_detail: { source_message_id: 'm', user_open_id: 'ou_x', thread_id: 'om_t' },
    agent_id: 'claude-code',
    raw_tool_use_id: `t${revision}`,
    raw_tool_name: 'Read',
  };
}

describe('T5 WAL', () => {
  it('creates monotonic .jsonl files for appended records', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-wal-'));
    try {
      const wal = createWal({ dataDir: dir });
      wal.append(record(1));
      wal.append(record(2));
      wal.append(record(3));
      const files = readdirSync(join(dir, 'wal', 'audit')).sort();
      expect(files).toHaveLength(3);
      expect(files[0]).toMatch(/^\d+\.jsonl$/);
      expect(Number.parseInt(files[1]!.replace(/\.jsonl$/, ''), 10)).toBeGreaterThan(Number.parseInt(files[0]!.replace(/\.jsonl$/, ''), 10));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('replays queued entries in sequence order', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-wal-'));
    try {
      const wal = createWal({ dataDir: dir });
      wal.append(record(1));
      wal.append(record(2));
      const seen: number[] = [];
      for await (const entry of wal.replay()) seen.push(entry.record.revision);
      expect(seen).toEqual([1, 2]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('removes files on ack', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-wal-'));
    try {
      const wal = createWal({ dataDir: dir });
      const seq = wal.append(record(1));
      wal.append(record(2));
      wal.ack(seq);
      expect(readdirSync(join(dir, 'wal', 'audit'))).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('marks entries as pending-sync with attempts >= 5', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-wal-'));
    try {
      const wal = createWal({ dataDir: dir });
      const seq = wal.append(record(1));
      wal.markPendingSync(seq);
      const file = readdirSync(join(dir, 'wal', 'audit'))[0]!;
      const entry = JSON.parse(readFileSync(join(dir, 'wal', 'audit', file), 'utf8')) as { state: string; attempts: number };
      expect(entry.state).toBe('pending-sync');
      expect(entry.attempts).toBeGreaterThanOrEqual(5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips corrupted WAL files during replay', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-wal-'));
    try {
      const walDir = join(dir, 'wal', 'audit');
      mkdirSync(walDir, { recursive: true });
      writeFileSync(join(walDir, '0000000000000001.jsonl'), 'not json');
      const wal = createWal({ dataDir: dir });
      wal.append(record(2));
      const seen: number[] = [];
      for await (const entry of wal.replay()) seen.push(entry.record.revision);
      expect(seen).toEqual([2]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
