import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createBitableSink } from '../../../packages/core/src/audit-pipe/bitable-sink.js';
import { DEFAULT_RETRY_POLICY } from '../../../packages/core/src/audit-pipe/contracts.js';
import type { AuditRecord } from '../../../packages/core/src/audit-pipe/contracts.js';
import { createWal } from '../../../packages/core/src/audit-pipe/wal.js';

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

function createSink(dir: string, batchCreate: ReturnType<typeof vi.fn>) {
  const wal = createWal({ dataDir: dir });
  const sink = createBitableSink({
    dataDir: dir,
    baseId: 'bascn123',
    tableId: 'tblXYZ',
    appId: 'cli_xxxxxxxxxxxxxxxx',
    appSecret: 'secret-32-characters-000000000000',
    larkDomain: 'https://open.larkoffice.com',
    retry: { ...DEFAULT_RETRY_POLICY, baseMs: 1, capMs: 4, jitterRatio: 0 },
    wal,
    _client: { bitable: { appTableRecord: { batchCreate } } } as any,
  });
  return { wal, sink };
}

describe('T6 bitable sink', () => {
  it('acks WAL files after successful batchCreate', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-bit-'));
    try {
      const batchCreate = vi.fn().mockResolvedValue({ code: 0, msg: 'success', data: { records: [{ record_id: 'rec1' }] } });
      const { wal, sink } = createSink(dir, batchCreate);
      wal.append(record(1));
      const result = await sink.flush();
      expect(result.ok).toBe(true);
      expect(batchCreate).toHaveBeenCalledTimes(1);
      expect(readdirSync(join(dir, 'wal', 'audit'))).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('retries rate-limit responses until success', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-bit-'));
    try {
      const batchCreate = vi.fn()
        .mockResolvedValueOnce({ code: 99991663, msg: 'rate limit', data: {} })
        .mockResolvedValueOnce({ code: 0, msg: 'success', data: { records: [{ record_id: 'rec1' }] } });
      const { wal, sink } = createSink(dir, batchCreate);
      wal.append(record(1));
      const result = await sink.flush();
      expect(result.ok).toBe(true);
      expect(batchCreate).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('marks WAL as pending-sync after retry exhaustion on 5xx errors', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-bit-'));
    try {
      const batchCreate = vi.fn().mockRejectedValue(new Error('HTTP 503 Service Unavailable'));
      const { wal, sink } = createSink(dir, batchCreate);
      wal.append(record(1));
      const result = await sink.flush();
      expect(result.ok).toBe(false);
      expect(result.attempt).toBe(5);
      expect(batchCreate).toHaveBeenCalledTimes(5);
      const file = readdirSync(join(dir, 'wal', 'audit'))[0]!;
      const entry = JSON.parse(readFileSync(join(dir, 'wal', 'audit', file), 'utf8')) as { state: string };
      expect(entry.state).toBe('pending-sync');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes audit_record_id as client_token and keeps it stable on replay', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-bit-'));
    try {
      const batchCreate = vi.fn().mockResolvedValue({ code: 0, msg: 'success', data: { records: [{ record_id: 'rec1' }] } });
      const { wal, sink } = createSink(dir, batchCreate);
      wal.append(record(1));
      await sink.flush();
      wal.append(record(1));
      await sink.flush();
      const clientTokens = batchCreate.mock.calls.map((call) => call[0].params?.client_token);
      expect(new Set(clientTokens).size).toBe(1);
      expect(clientTokens[0]).toBe('a1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
