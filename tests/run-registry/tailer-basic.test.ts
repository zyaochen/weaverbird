import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RunTailer } from '../../packages/core/src/run-registry/index.js';

const roots: string[] = [];

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeAuditRecord(runId: string, revision: number, ts = new Date(Date.now() + revision * 10).toISOString()) {
  return {
    audit_record_id: `audit-${runId}-${revision}`,
    session_id: `session-${runId}`,
    run_id: runId,
    revision,
    actor: 'user',
    action: 'network_call',
    resource: 'https://example.larkoffice.com/docx/abc123',
    ts,
    entry_form: 'im',
    entry_detail: { source_message_id: 'm1', user_open_id: 'ou_abc', thread_id: 'thd_001' },
    agent_id: 'claude-code',
    raw_tool_use_id: `tool-${revision}`,
    raw_tool_name: 'WebFetch',
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('tailer-basic', () => {
  it('transitions first audit record into ACTIVE entry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-run-registry-'));
    roots.push(root);
    const mirrorPath = join(root, 'audit-mirror.ndjson');
    writeFileSync(mirrorPath, '');

    const tailer = new RunTailer({ dataDir: root, batchFlushIntervalMs: 20, pollIntervalMs: 10, finalizeIntervalMs: 10 });
    tailer.start();
    appendFileSync(mirrorPath, `${JSON.stringify(makeAuditRecord('run-001', 0))}\n`);
    await wait(60);

    const entry = tailer.getEntry('run-001');
    expect(entry?.state).toBe('ACTIVE');
    expect(entry?.event_count).toBe(1);
    tailer.stop();
  });

  it('aggregates multiple records for the same run', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-run-registry-'));
    roots.push(root);
    const mirrorPath = join(root, 'audit-mirror.ndjson');
    writeFileSync(mirrorPath, '');

    const tailer = new RunTailer({ dataDir: root, batchFlushIntervalMs: 20, pollIntervalMs: 10, finalizeIntervalMs: 10 });
    tailer.start();
    for (let i = 0; i < 5; i += 1) {
      appendFileSync(mirrorPath, `${JSON.stringify(makeAuditRecord('run-001', i))}\n`);
    }
    await wait(80);

    const entry = tailer.getEntry('run-001');
    expect(entry?.event_count).toBe(5);
    expect(entry!.last_event_ts).toBeGreaterThan(entry!.first_event_ts);
    tailer.stop();
  });

  it('tracks different run ids independently', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-run-registry-'));
    roots.push(root);
    const mirrorPath = join(root, 'audit-mirror.ndjson');
    writeFileSync(mirrorPath, '');

    const tailer = new RunTailer({ dataDir: root, batchFlushIntervalMs: 20, pollIntervalMs: 10, finalizeIntervalMs: 10 });
    tailer.start();
    appendFileSync(mirrorPath, `${JSON.stringify(makeAuditRecord('run-001', 0))}\n`);
    appendFileSync(mirrorPath, `${JSON.stringify(makeAuditRecord('run-001', 1))}\n`);
    appendFileSync(mirrorPath, `${JSON.stringify(makeAuditRecord('run-002', 0))}\n`);
    appendFileSync(mirrorPath, `${JSON.stringify(makeAuditRecord('run-002', 1))}\n`);
    appendFileSync(mirrorPath, `${JSON.stringify(makeAuditRecord('run-002', 2))}\n`);
    await wait(80);

    expect(tailer.getEntry('run-001')?.event_count).toBe(2);
    expect(tailer.getEntry('run-002')?.event_count).toBe(3);
    tailer.stop();
  });

  it('ignores rejected records', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-run-registry-'));
    roots.push(root);
    const mirrorPath = join(root, 'audit-mirror.ndjson');
    writeFileSync(mirrorPath, '');

    const tailer = new RunTailer({ dataDir: root, batchFlushIntervalMs: 20, pollIntervalMs: 10, finalizeIntervalMs: 10 });
    tailer.start();
    appendFileSync(mirrorPath, `${JSON.stringify({
      audit_record_id: 'reject-1',
      status: 'rejected',
      reason: 'parse_error',
      raw_line: '{}',
      ts: '2026-06-06T00:00:00.000Z',
      run_id: null,
    })}\n`);
    await wait(60);

    expect(tailer.size).toBe(0);
    tailer.stop();
  });

  it('starts cleanly before mirror file exists and begins tailing after creation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-run-registry-'));
    roots.push(root);
    const mirrorPath = join(root, 'audit-mirror.ndjson');

    const tailer = new RunTailer({ dataDir: root, batchFlushIntervalMs: 20, pollIntervalMs: 10, finalizeIntervalMs: 10 });
    expect(() => tailer.start()).not.toThrow();
    await wait(30);
    expect(tailer.size).toBe(0);

    writeFileSync(mirrorPath, '');
    appendFileSync(mirrorPath, `${JSON.stringify(makeAuditRecord('run-003', 0))}\n`);
    await wait(80);

    expect(tailer.getEntry('run-003')?.event_count).toBe(1);
    tailer.stop();
  });
});
