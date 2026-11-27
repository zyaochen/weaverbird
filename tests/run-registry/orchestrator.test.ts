import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startRunRegistry, type DocSinkTransport, type RunRegistryClientLike } from '../../packages/core/src/run-registry/index.js';

const roots: string[] = [];

function writeConfig(dir: string): string {
  const configDir = join(dir, 'config');
  mkdirSync(configDir, { recursive: true });
  const path = join(configDir, 'run-registry.json');
  writeFileSync(path, JSON.stringify({
    bitable_base_id: 'bascn123',
    bitable_table_id: 'tblXYZ',
    app_id: 'cli_xxxxxxxxxxxxxxxx',
    app_secret: 'secret-32-characters-000000000000',
    lark_domain: 'https://open.larkoffice.com',
    run_finalize_grace_ms: 100,
    doc_url_allowlist: ['*.larkoffice.com', '*.feishu.cn', 'github.com'],
  }, null, 2));
  chmodSync(path, 0o600);
  return path;
}

function writeRun(dir: string, runId: string, status = 'done', body = 'Paragraph '.repeat(300)): void {
  const runDir = join(dir, 'runs', 'default', runId);
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
    startedAt: '2026-06-27T00:00:00.000Z',
    schemaVersion: 1,
    host: 'local',
  }, null, 2));
  writeFileSync(join(runDir, 'status'), status);
  writeFileSync(join(runDir, 'events.ndjson'), `${JSON.stringify({ type: 'text', delta: body, schemaVersion: 1 })}\n`);
  writeFileSync(join(dir, 'audit-mirror.ndjson'), `${JSON.stringify({
    audit_record_id: `audit-${runId}-0`,
    session_id: `session-${runId}`,
    run_id: runId,
    revision: 0,
    actor: 'user',
    action: 'network_call',
    resource: 'https://example.com/not-allowed',
    ts: '2026-06-27T00:00:01.000Z',
    entry_form: 'im',
    entry_detail: { source_message_id: 'm1', user_open_id: 'ou_abc', thread_id: 'thread-001/child' },
    agent_id: 'claude-code',
    raw_tool_use_id: 'tool-1',
    raw_tool_name: 'WebFetch',
  })}\n`);
}

function makeClient(): RunRegistryClientLike {
  return {
    bitable: {
      appTableField: {
        list: vi.fn().mockResolvedValue({ code: 0, msg: 'ok', data: { items: [
          'run_id', 'created_at', 'operator', 'project', 'cwd', 'scope', 'agent', 'cmd', 'status',
          'cost_tokens', 'cost_minutes', 'produced_doc_urls', 'commit_shas', 'doc_sink_failed', 'calendar_block_id', 'calendar_hook_failed', 'risk_level', 'home_group_id', 'entry_form',
        ].map((field_name) => ({ field_name })) } }),
      },
      appTableRecord: {
        search: vi.fn().mockResolvedValue({ code: 0, msg: 'ok', data: { items: [] } }),
        batchCreate: vi.fn().mockResolvedValue({ code: 0, msg: 'ok', data: { records: [{ record_id: 'rec-1' }] } }),
        batchUpdate: vi.fn().mockResolvedValue({ code: 0, msg: 'ok', data: { records: [{ record_id: 'rec-1' }] } }),
      },
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('run-registry orchestrator', () => {
  it('wires tailer to writer and persists doc sink result', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-run-reg-orch-'));
    roots.push(dir);
    const configPath = writeConfig(dir);
    writeRun(dir, 'run-001');
    const client = makeClient();
    const transport: DocSinkTransport = {
      create: vi.fn().mockResolvedValue({ url: 'https://foo.larkoffice.com/suite/docx/created', rawOutput: 'ok' }),
    };

    const controller = await startRunRegistry({
      configPath,
      env: { WB_DATA_DIR: dir },
      _client: client,
      _retryOverride: { maxAttempts: 5, baseMs: 1, factor: 2, capMs: 4, jitterRatio: 0 },
      _syncIntervalMs: 20,
      _tailerBatchFlushIntervalMs: 20,
      _tailerPollIntervalMs: 10,
      _tailerFinalizeIntervalMs: 10,
      docSinkTransport: transport,
    });

    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(client.bitable.appTableRecord.batchCreate).toHaveBeenCalled();
    const payload = (client.bitable.appTableRecord.batchCreate as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    expect(payload.data.records[0].fields.produced_doc_urls).toEqual(['https://foo.larkoffice.com/suite/docx/created']);
    expect(payload.data.records[0].fields.doc_sink_failed).toBe(false);
    await controller.stop();
    await new Promise((resolve) => setTimeout(resolve, 30));
  });

  it('does not duplicate doc creation across reload while finalize is in flight', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-run-reg-orch-'));
    roots.push(dir);
    const configPath = writeConfig(dir);
    writeRun(dir, 'run-002');
    const client = makeClient();
    let releaseCreate!: (value: { url: string; rawOutput: string }) => void;
    const transport: DocSinkTransport = {
      create: vi.fn().mockImplementation(() => new Promise<{ url: string; rawOutput: string }>((resolve) => {
        releaseCreate = resolve;
      })),
    };

    const controller = await startRunRegistry({
      configPath,
      env: { WB_DATA_DIR: dir },
      _client: client,
      _retryOverride: { maxAttempts: 5, baseMs: 1, factor: 2, capMs: 4, jitterRatio: 0 },
      _syncIntervalMs: 20,
      _tailerBatchFlushIntervalMs: 20,
      _tailerPollIntervalMs: 10,
      _tailerFinalizeIntervalMs: 10,
      docSinkTransport: transport,
    });

    await vi.waitFor(() => {
      expect(transport.create).toHaveBeenCalledTimes(1);
      expect(releaseCreate).not.toBeNull();
    });

    const reloadPromise = controller.reload();
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseCreate?.({ url: 'https://foo.larkoffice.com/suite/docx/reload', rawOutput: 'ok' });
    await reloadPromise;
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(transport.create).toHaveBeenCalledTimes(1);
    await controller.stop();
  }, 10_000);
});
