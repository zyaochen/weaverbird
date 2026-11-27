import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunTailer, type RunRegistryConfig, type RunUpserted } from '../../packages/core/src/run-registry/index.js';

const roots: string[] = [];
const registryConfig: RunRegistryConfig = {
  bitable_base_id: 'base',
  bitable_table_id: 'table',
  app_id: 'app',
  app_secret: 'secret',
  lark_domain: 'https://open.larkoffice.com',
  run_finalize_grace_ms: 30_000,
  doc_url_allowlist: ['*.larkoffice.com', '*.feishu.cn', 'github.com'],
};

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
    entry_detail: { source_message_id: 'm1', user_open_id: 'ou_abc', thread_id: 'thread-001/child' },
    agent_id: 'claude-code',
    raw_tool_use_id: `tool-${revision}`,
    raw_tool_name: 'WebFetch',
  };
}

function installSpec(root: string, runId: string, startedAt = '2026-06-06T00:00:00.000Z'): string {
  const runDir = join(root, 'runs', 'default', runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'spec.json'), JSON.stringify({
    runId,
    botId: 'default',
    agentId: 'claude-code',
    userOpenId: 'ou_abc',
    threadId: 'thread-001/child',
    sourceMessageId: 'm1',
    replyMessageId: 'r1',
    cwd: '/repo',
    model: 'claude-sonnet-4-6',
    consentLevel: 'normal',
    startedAt,
    schemaVersion: 1,
    host: 'local',
  }, null, 2));
  writeFileSync(join(runDir, 'status'), 'running');
  return runDir;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('tailer-finalize', () => {
  it('finalizes to succeeded when status file is done', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-run-registry-'));
    roots.push(root);
    const mirrorPath = join(root, 'audit-mirror.ndjson');
    writeFileSync(mirrorPath, '');
    const runDir = installSpec(root, 'run-001');
    const events: RunUpserted[] = [];

    const tailer = new RunTailer({
      dataDir: root,
      mirrorPath,
      batchFlushIntervalMs: 20,
      pollIntervalMs: 10,
      finalizeIntervalMs: 10,
      onRunUpserted: (event) => { events.push(event); },
    });
    tailer.start();
    appendFileSync(mirrorPath, `${JSON.stringify(makeAuditRecord('run-001', 0))}\n`);
    await wait(40);
    writeFileSync(join(runDir, 'status'), 'done');
    await wait(80);

    expect(events.at(-1)?.status).toBe('succeeded');
    expect(tailer.getEntry('run-001')?.state).toBe('DONE');
    tailer.stop();
  });

  it('finalizes to failed when status file is error', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-run-registry-'));
    roots.push(root);
    const mirrorPath = join(root, 'audit-mirror.ndjson');
    writeFileSync(mirrorPath, '');
    const runDir = installSpec(root, 'run-002');
    const events: RunUpserted[] = [];

    const tailer = new RunTailer({
      dataDir: root,
      mirrorPath,
      batchFlushIntervalMs: 20,
      pollIntervalMs: 10,
      finalizeIntervalMs: 10,
      onRunUpserted: (event) => { events.push(event); },
    });
    tailer.start();
    appendFileSync(mirrorPath, `${JSON.stringify(makeAuditRecord('run-002', 0))}\n`);
    await wait(40);
    writeFileSync(join(runDir, 'status'), 'error');
    await wait(80);

    expect(events.at(-1)?.status).toBe('failed');
    tailer.stop();
  });

  it('finalizes to succeeded after grace timeout', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-run-registry-'));
    roots.push(root);
    const mirrorPath = join(root, 'audit-mirror.ndjson');
    writeFileSync(mirrorPath, '');
    installSpec(root, 'run-003');
    const events: RunUpserted[] = [];

    const tailer = new RunTailer({
      dataDir: root,
      mirrorPath,
      batchFlushIntervalMs: 20,
      pollIntervalMs: 10,
      finalizeIntervalMs: 10,
      runFinalizeGraceMs: 100,
      onRunUpserted: (event) => { events.push(event); },
    });
    tailer.start();
    appendFileSync(mirrorPath, `${JSON.stringify(makeAuditRecord('run-003', 0))}\n`);
    await wait(180);

    expect(events.at(-1)?.status).toBe('succeeded');
    expect(tailer.getEntry('run-003')?.state).toBe('DONE');
    tailer.stop();
  });

  it('lets status signal win before timeout', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-run-registry-'));
    roots.push(root);
    const mirrorPath = join(root, 'audit-mirror.ndjson');
    writeFileSync(mirrorPath, '');
    const runDir = installSpec(root, 'run-004');
    const events: RunUpserted[] = [];

    const tailer = new RunTailer({
      dataDir: root,
      mirrorPath,
      batchFlushIntervalMs: 20,
      pollIntervalMs: 10,
      finalizeIntervalMs: 10,
      runFinalizeGraceMs: 120,
      onRunUpserted: (event) => { events.push(event); },
    });
    tailer.start();
    appendFileSync(mirrorPath, `${JSON.stringify(makeAuditRecord('run-004', 0))}\n`);
    await wait(50);
    writeFileSync(join(runDir, 'status'), 'cancelled');
    await wait(100);

    expect(events.at(-1)?.status).toBe('cancelled');
    tailer.stop();
  });

  it('computes cost_minutes from startedAt to last event timestamp', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-run-registry-'));
    roots.push(root);
    const mirrorPath = join(root, 'audit-mirror.ndjson');
    writeFileSync(mirrorPath, '');
    installSpec(root, 'run-005', '2026-06-06T00:00:00.000Z');
    const events: RunUpserted[] = [];

    const tailer = new RunTailer({
      dataDir: root,
      mirrorPath,
      batchFlushIntervalMs: 20,
      pollIntervalMs: 10,
      finalizeIntervalMs: 10,
      runFinalizeGraceMs: 100,
      onRunUpserted: (event) => { events.push(event); },
    });
    tailer.start();
    appendFileSync(mirrorPath, `${JSON.stringify(makeAuditRecord('run-005', 0, '2026-06-06T00:00:00.000Z'))}\n`);
    appendFileSync(mirrorPath, `${JSON.stringify(makeAuditRecord('run-005', 1, '2026-06-06T00:01:30.000Z'))}\n`);
    await wait(180);

    expect(events.at(-1)?.cost_minutes).toBe(1);
    tailer.stop();
  });

  it('does not block terminal upsert when doc transport hangs and later marks doc_sink_failed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-run-registry-'));
    roots.push(root);
    const mirrorPath = join(root, 'audit-mirror.ndjson');
    writeFileSync(mirrorPath, '');
    const runDir = installSpec(root, 'run-006');
    writeFileSync(join(runDir, 'events.ndjson'), `${JSON.stringify({ type: 'text', delta: 'Paragraph '.repeat(300), schemaVersion: 1 })}\n`);
    const events: RunUpserted[] = [];
    const transport = {
      create: vi.fn(() => new Promise<{ url: string; rawOutput: string }>((_, reject) => setTimeout(() => reject(new Error('timeout')), 40))),
    };

    const tailer = new RunTailer({
      dataDir: root,
      mirrorPath,
      config: registryConfig,
      docSinkTransport: transport,
      batchFlushIntervalMs: 20,
      pollIntervalMs: 10,
      finalizeIntervalMs: 10,
      onRunUpserted: (event) => { events.push(event); },
    });
    tailer.start();
    appendFileSync(mirrorPath, `${JSON.stringify({ ...makeAuditRecord('run-006', 0), resource: 'https://example.com/not-allowed' })}\n`);
    await wait(40);
    writeFileSync(join(runDir, 'status'), 'done');
    await wait(30);

    expect(events.some((event) => event.status === 'succeeded')).toBe(true);
    expect(events.find((event) => event.status === 'succeeded')?.doc_sink_failed).toBe(false);
    await wait(80);
    expect(events.at(-1)?.doc_sink_failed).toBe(true);
    tailer.stop();
  });

  it('retries missing run directory after it appears later', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-run-registry-'));
    roots.push(root);
    const mirrorPath = join(root, 'audit-mirror.ndjson');
    writeFileSync(mirrorPath, '');
    const events: RunUpserted[] = [];

    const tailer = new RunTailer({
      dataDir: root,
      mirrorPath,
      batchFlushIntervalMs: 20,
      pollIntervalMs: 10,
      finalizeIntervalMs: 10,
      onRunUpserted: (event) => { events.push(event); },
    });
    tailer.start();
    appendFileSync(mirrorPath, `${JSON.stringify(makeAuditRecord('run-007', 0))}\n`);
    await wait(40);
    const runDir = installSpec(root, 'run-007');
    writeFileSync(join(runDir, 'status'), 'error');
    await wait(100);

    expect(events.at(-1)?.status).toBe('failed');
    expect(tailer.getEntry('run-007')?.spec?.cwd).toBe('/repo');
    tailer.stop();
  });
});
