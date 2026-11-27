import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMirrorSink } from '../../../packages/core/src/audit-pipe/mirror-sink.js';
import type { AuditRecord, RejectedRecord } from '../../../packages/core/src/audit-pipe/contracts.js';

const RECORD: AuditRecord = {
  audit_record_id: 'a1',
  session_id: 'om_t',
  run_id: 'r1',
  revision: 1,
  actor: 'ou_x',
  action: 'file_read',
  resource: 'a.ts',
  ts: '2026-06-04T00:00:00.000Z',
  entry_form: 'im',
  entry_detail: { source_message_id: 'msg', user_open_id: 'ou_x', thread_id: 'om_t' },
  agent_id: 'claude-code',
  raw_tool_use_id: 'toolu_1',
  raw_tool_name: 'Read',
};

describe('T4 mirror sink', () => {
  afterEach(() => vi.restoreAllMocks());

  it('writes NDJSON lines that can be read back', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-mirror-'));
    try {
      const sink = createMirrorSink({ dataDir: dir });
      sink.write(RECORD);
      const content = readFileSync(join(dir, 'audit-mirror.ndjson'), 'utf8');
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!).audit_record_id).toBe('a1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes rejected records into mirror too', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-mirror-'));
    try {
      const sink = createMirrorSink({ dataDir: dir });
      const rejected: RejectedRecord = { audit_record_id: 'r1', status: 'rejected', reason: 'missing_spec', raw_line: 'x', ts: '2026-06-04T00:00:00.000Z', run_id: null };
      sink.write(rejected);
      const content = readFileSync(join(dir, 'audit-mirror.ndjson'), 'utf8').trim();
      expect(JSON.parse(content).status).toBe('rejected');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rotates audit-mirror.ndjson and keeps fsync-sensitive writes working', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-mirror-'));
    try {
      writeFileSync(join(dir, 'audit-mirror.ndjson'), 'x'.repeat(8 * 1024 * 1024), 'utf8');
      const sink = createMirrorSink({ dataDir: dir });
      sink.write(RECORD);
      const rotated = readFileSync(join(dir, 'audit-mirror.ndjson.1'), 'utf8');
      const active = readFileSync(join(dir, 'audit-mirror.ndjson'), 'utf8').trim().split('\n');
      expect(rotated).toHaveLength(8 * 1024 * 1024);
      expect(active).toHaveLength(1);
      expect(JSON.parse(active[0]!).audit_record_id).toBe('a1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits with code 2 when mirror write fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-mirror-'));
    try {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit:${code}`); }) as never);
      const sink = createMirrorSink({ dataDir: dir });
      if (platform() !== 'win32') {
        chmodSync(dir, 0o500);
        expect(() => sink.write(RECORD)).toThrow(/exit:2/);
        chmodSync(dir, 0o700);
      }
      exitSpy.mockRestore();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
