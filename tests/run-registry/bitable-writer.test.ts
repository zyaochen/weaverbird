import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createRunRegistryWriter,
  RUN_REGISTRY_ERROR_CODES,
  RunRegistryError,
  type RunRecord,
  type RunRegistryClientLike,
} from '../../packages/core/src/run-registry/index.js';

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
    run_finalize_grace_ms: 30000,
    doc_url_allowlist: ['*.larkoffice.com', '*.feishu.cn', 'github.com'],
  }, null, 2));
  chmodSync(path, 0o600);
  return path;
}

function makeRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    run_id: overrides.run_id ?? 'run-001',
    created_at: overrides.created_at ?? '2026-06-06T00:00:00.000Z',
    operator: overrides.operator ?? 'ou_abc',
    project: overrides.project ?? 'proj-A',
    cwd: overrides.cwd ?? '/repo',
    scope: overrides.scope ?? 'normal',
    agent: overrides.agent ?? 'claude-code',
    cmd: overrides.cmd ?? 'claude-code --model opus',
    status: overrides.status ?? 'active',
    cost_tokens: overrides.cost_tokens ?? null,
    cost_minutes: overrides.cost_minutes ?? 1,
    produced_doc_urls: overrides.produced_doc_urls ?? ['https://example.larkoffice.com/docx/abc123'],
    commit_shas: overrides.commit_shas ?? ['0123456789abcdef0123456789abcdef01234567'],
    doc_sink_failed: overrides.doc_sink_failed ?? false,
    calendar_block_id: overrides.calendar_block_id ?? null,
    calendar_hook_failed: overrides.calendar_hook_failed ?? false,
    risk_level: overrides.risk_level ?? 'unknown',
    home_group_id: overrides.home_group_id ?? 'grp-001',
    entry_form: overrides.entry_form ?? 'im',
  };
}

function makeClient(options: {
  fields?: string[];
  search?: ReturnType<typeof vi.fn>;
  batchCreate?: ReturnType<typeof vi.fn>;
  batchUpdate?: ReturnType<typeof vi.fn>;
} = {}): RunRegistryClientLike {
  const requiredFields = options.fields ?? [
    'run_id', 'created_at', 'operator', 'project', 'cwd', 'scope', 'agent', 'cmd', 'status',
    'cost_tokens', 'cost_minutes', 'produced_doc_urls', 'commit_shas', 'doc_sink_failed', 'calendar_block_id', 'calendar_hook_failed', 'risk_level', 'home_group_id', 'entry_form',
  ];
  return {
    bitable: {
      appTableField: {
        list: vi.fn().mockResolvedValue({ code: 0, msg: 'ok', data: { items: requiredFields.map((field_name) => ({ field_name })) } }),
      },
      appTableRecord: {
        search: options.search ?? vi.fn().mockResolvedValue({ code: 0, msg: 'ok', data: { items: [] } }),
        batchCreate: options.batchCreate ?? vi.fn().mockResolvedValue({ code: 0, msg: 'ok', data: { records: [{ record_id: 'rec-1' }] } }),
        batchUpdate: options.batchUpdate ?? vi.fn().mockResolvedValue({ code: 0, msg: 'ok', data: { records: [{ record_id: 'rec-1' }] } }),
      },
    },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('bitable-writer', () => {
  it('creates a new bitable row for a new run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-run-writer-'));
    roots.push(dir);
    const configPath = writeConfig(dir);
    const client = makeClient();
    const writer = createRunRegistryWriter({ configPath, env: { WB_DATA_DIR: dir }, _client: client, _retryOverride: { maxAttempts: 5, baseMs: 1, factor: 2, capMs: 4, jitterRatio: 0 } });

    await writer.validateSchema();
    const result = await writer.upsert(makeRecord());

    expect(result.ok).toBe(true);
    expect(client.bitable.appTableRecord.batchCreate).toHaveBeenCalledTimes(1);
  });

  it('updates existing row instead of creating duplicate', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-run-writer-'));
    roots.push(dir);
    const configPath = writeConfig(dir);
    const search = vi.fn().mockResolvedValue({
      code: 0,
      msg: 'ok',
      data: { items: [{ record_id: 'rec-1', fields: { ...makeRecord(), created_at: Date.parse('2026-06-06T00:00:00.000Z') } }] },
    });
    const batchUpdate = vi.fn().mockResolvedValue({ code: 0, msg: 'ok', data: { records: [{ record_id: 'rec-1' }] } });
    const client = makeClient({ search, batchUpdate });
    const writer = createRunRegistryWriter({ configPath, env: { WB_DATA_DIR: dir }, _client: client, _retryOverride: { maxAttempts: 5, baseMs: 1, factor: 2, capMs: 4, jitterRatio: 0 } });

    const result = await writer.upsert(makeRecord({ status: 'succeeded' }));

    expect(result.ok).toBe(true);
    expect(client.bitable.appTableRecord.batchUpdate).toHaveBeenCalledTimes(1);
    expect(client.bitable.appTableRecord.batchCreate).not.toHaveBeenCalled();
  });

  it('writes WAL on transient failure and clears it after retry success', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-run-writer-'));
    roots.push(dir);
    const configPath = writeConfig(dir);
    const batchCreate = vi.fn()
      .mockResolvedValueOnce({ code: 99991663, msg: 'rate limit' })
      .mockResolvedValueOnce({ code: 0, msg: 'ok', data: { records: [{ record_id: 'rec-1' }] } });
    const client = makeClient({ batchCreate });
    const writer = createRunRegistryWriter({ configPath, env: { WB_DATA_DIR: dir }, _client: client, _retryOverride: { maxAttempts: 5, baseMs: 1, factor: 2, capMs: 4, jitterRatio: 0 } });

    const result = await writer.upsert(makeRecord());

    expect(result.ok).toBe(true);
    expect(client.bitable.appTableRecord.batchCreate).toHaveBeenCalledTimes(2);
    expect(readdirSync(join(dir, 'wal', 'run-registry'))).toHaveLength(0);
  });

  it('marks WAL entry pending-sync after retry exhaustion without throwing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-run-writer-'));
    roots.push(dir);
    const configPath = writeConfig(dir);
    const batchCreate = vi.fn().mockRejectedValue(new Error('HTTP 503 Service Unavailable'));
    const client = makeClient({ batchCreate });
    const writer = createRunRegistryWriter({ configPath, env: { WB_DATA_DIR: dir }, _client: client, _retryOverride: { maxAttempts: 5, baseMs: 1, factor: 2, capMs: 4, jitterRatio: 0 } });

    const result = await writer.upsert(makeRecord());

    expect(result.ok).toBe(false);
    expect(result.lark_msg).toBe(RUN_REGISTRY_ERROR_CODES.E_BITABLE_RETRY_EXHAUSTED);
    const file = readdirSync(join(dir, 'wal', 'run-registry'))[0]!;
    const entry = JSON.parse(readFileSync(join(dir, 'wal', 'run-registry', file), 'utf8')) as { state: string };
    expect(entry.state).toBe('pending-sync');
  });

  it('throws schema mismatch when required field is missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-run-writer-'));
    roots.push(dir);
    const configPath = writeConfig(dir);
    const client = makeClient({ fields: [
      'run_id', 'created_at', 'operator', 'project', 'cwd', 'scope', 'agent', 'cmd', 'status',
      'cost_tokens', 'cost_minutes', 'produced_doc_urls', 'commit_shas', 'doc_sink_failed', 'calendar_block_id', 'calendar_hook_failed', 'risk_level', 'entry_form',
    ] });
    const writer = createRunRegistryWriter({ configPath, env: { WB_DATA_DIR: dir }, _client: client });

    await expect(writer.validateSchema()).rejects.toMatchObject({ code: RUN_REGISTRY_ERROR_CODES.E_SCHEMA_MISMATCH });
  });

  it('sync worker replays pending WAL entries', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-run-writer-'));
    roots.push(dir);
    const configPath = writeConfig(dir);
    const batchCreate = vi.fn().mockResolvedValue({ code: 0, msg: 'ok', data: { records: [{ record_id: 'rec-1' }] } });
    const client = makeClient({ batchCreate });
    const writer = createRunRegistryWriter({ configPath, env: { WB_DATA_DIR: dir }, _client: client, _syncIntervalMs: 20, _retryOverride: { maxAttempts: 5, baseMs: 1, factor: 2, capMs: 4, jitterRatio: 0 } });
    const walDir = join(dir, 'wal', 'run-registry');
    mkdirSync(walDir, { recursive: true });
    const now = new Date().toISOString();
    writeFileSync(join(walDir, 'run-001_0000000000000001.jsonl'), JSON.stringify({
      seq: 1,
      run_id: 'run-001',
      record: makeRecord(),
      attempts: 5,
      state: 'pending-sync',
      enqueued_at: now,
    }));
    writeFileSync(join(walDir, 'run-002_0000000000000002.jsonl'), JSON.stringify({
      seq: 2,
      run_id: 'run-002',
      record: makeRecord({ run_id: 'run-002' }),
      attempts: 5,
      state: 'pending-sync',
      enqueued_at: now,
    }));
    writeFileSync(join(walDir, 'run-003_0000000000000003.jsonl'), JSON.stringify({
      seq: 3,
      run_id: 'run-003',
      record: makeRecord({ run_id: 'run-003' }),
      attempts: 5,
      state: 'pending-sync',
      enqueued_at: now,
    }));

    const drained = await writer.syncOnce();

    expect(drained).toBe(3);
    expect(readdirSync(walDir)).toHaveLength(0);
    writer.stopSyncWorker();
  });

  it('parses strict boolean values for doc_sink_failed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-run-writer-'));
    roots.push(dir);
    const configPath = writeConfig(dir);
    const search = vi.fn().mockResolvedValue({
      code: 0,
      msg: 'ok',
      data: {
        items: [{
          record_id: 'rec-1',
          fields: {
            ...makeRecord(),
            created_at: Date.parse('2026-06-06T00:00:00.000Z'),
            doc_sink_failed: 'false',
          },
        }],
      },
    });
    const client = makeClient({ search });
    const writer = createRunRegistryWriter({ configPath, env: { WB_DATA_DIR: dir }, _client: client });

    const record = await writer.findByRunId('run-001');

    expect(record?.doc_sink_failed).toBe(false);
  });
});
