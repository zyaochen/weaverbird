import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCaptainSessionStore, type CaptainStoreClientLike, type SessionRecord } from '../../packages/core/src/captain/index.js';

const roots: string[] = [];

function writeConfig(dir: string): string {
  const configDir = join(dir, 'config');
  mkdirSync(configDir, { recursive: true });
  const path = join(configDir, 'captain-store.json');
  writeFileSync(path, JSON.stringify({
    bitable_base_id: 'Uq6hb0dUaaYiDQsunHel7EisgWd',
    sessions_table_id: 'tblyqLE52hgNO7UA',
    app_id: 'cli_yyyyyyyyyyyyyyyy',
    app_secret: 'secret-32-characters-000000000000',
    lark_domain: 'LarkSuite',
    captain_state_path: join(dir, 'captain-state.ndjson'),
    captain_toml_path: join(dir, 'captain.json'),
  }, null, 2));
  chmodSync(path, 0o600);
  return path;
}

function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    session_id: overrides.session_id ?? 's1',
    captain_id: overrides.captain_id ?? 'default',
    created_at: overrides.created_at ?? '2026-06-06T00:00:00.000Z',
    last_active_at: overrides.last_active_at ?? '2026-06-06T00:10:00.000Z',
    closed_at: overrides.closed_at ?? null,
    status: overrides.status ?? 'active',
    cwd: overrides.cwd ?? '/repo',
    scope: overrides.scope ?? 'dev',
    project: overrides.project ?? 'weaverbird',
    home_group_id: overrides.home_group_id ?? 'grp-001',
    agent: overrides.agent ?? 'claude-code',
    latest_run_id: overrides.latest_run_id ?? 'run-001',
    operator: overrides.operator ?? 'ou_abc',
    entry_form: overrides.entry_form ?? 'im',
    revision: overrides.revision ?? 0,
  };
}

function makeClient(options: {
  fields?: string[];
  search?: ReturnType<typeof vi.fn>;
  batchCreate?: ReturnType<typeof vi.fn>;
  batchUpdate?: ReturnType<typeof vi.fn>;
} = {}): CaptainStoreClientLike {
  const fields = options.fields ?? [
    'session_id', 'captain_id', 'created_at', 'last_active_at', 'closed_at', 'status', 'cwd', 'scope', 'project',
    'home_group_id', 'agent', 'latest_run_id', 'operator', 'entry_form', 'revision',
  ];
  return {
    bitable: {
      appTableField: {
        list: vi.fn().mockResolvedValue({ code: 0, msg: 'ok', data: { items: fields.map((field_name) => ({ field_name })) } }),
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
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('session-store', () => {
  it('creates a new session row when none exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-captain-store-'));
    roots.push(dir);
    const configPath = writeConfig(dir);
    const client = makeClient();
    const store = createCaptainSessionStore({ configPath, env: { WB_DATA_DIR: dir }, _client: client, _retryOverride: { maxAttempts: 5, baseMs: 1, factor: 2, capMs: 4, jitterRatio: 0 } });

    await store.validateSchema();
    const result = await store.upsert(makeRecord());

    expect(result.ok).toBe(true);
    expect(client.bitable.appTableRecord.batchCreate).toHaveBeenCalledTimes(1);
  });

  it('upsertWithRevision creates on empty remote with revision=expected+1', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-captain-store-'));
    roots.push(dir);
    const configPath = writeConfig(dir);
    const client = makeClient();
    const store = createCaptainSessionStore({ configPath, env: { WB_DATA_DIR: dir }, _client: client, _retryOverride: { maxAttempts: 5, baseMs: 1, factor: 2, capMs: 4, jitterRatio: 0 } });

    const result = await store.upsertWithRevision(makeRecord({ session_id: 'cas-1', revision: 0 }), 0);
    expect(result.ok).toBe(true);
    expect(result.newRevision).toBe(1);
    const batchCreateMock = client.bitable.appTableRecord.batchCreate as unknown as ReturnType<typeof vi.fn>;
    const calls = batchCreateMock.mock.calls as unknown as Array<[{ data: { records: Array<{ fields: Record<string, unknown> }> } }]>;
    const fields = calls[0]?.[0]?.data?.records?.[0]?.fields ?? {};
    expect(fields['revision']).toBe(1);
    expect(fields['session_id']).toBe('cas-1');
  });

  it('upsertWithRevision writes when remote revision equals expected', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-captain-store-'));
    roots.push(dir);
    const configPath = writeConfig(dir);
    const sameRecord = makeRecord({ session_id: 'cas-2', revision: 5 });
    const search = vi.fn().mockResolvedValue({
      code: 0,
      msg: 'ok',
      data: { items: [{ record_id: 'rec-9', fields: { ...sameRecord, created_at: Date.parse(sameRecord.created_at), last_active_at: Date.parse(sameRecord.last_active_at) } }] },
    });
    const batchUpdate = vi.fn().mockResolvedValue({ code: 0, msg: 'ok', data: { records: [{ record_id: 'rec-9' }] } });
    const client = makeClient({ search, batchUpdate });
    const store = createCaptainSessionStore({ configPath, env: { WB_DATA_DIR: dir }, _client: client, _retryOverride: { maxAttempts: 5, baseMs: 1, factor: 2, capMs: 4, jitterRatio: 0 } });

    const result = await store.upsertWithRevision(makeRecord({ session_id: 'cas-2', revision: 5, agent: 'codex' }), 5);
    expect(result.ok).toBe(true);
    expect(result.newRevision).toBe(6);
    const calls = batchUpdate.mock.calls as unknown as Array<[{ data: { records: Array<{ fields: Record<string, unknown> }> } }]>;
    const fields = calls[0]?.[0]?.data?.records?.[0]?.fields ?? {};
    expect(fields['revision']).toBe(6);
    expect(fields['agent']).toBe('codex');
  });

  it('upsertWithRevision raises E_REVISION_MISMATCH when remote has moved on', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-captain-store-'));
    roots.push(dir);
    const configPath = writeConfig(dir);
    const remote = makeRecord({ session_id: 'cas-3', revision: 7 });
    const search = vi.fn().mockResolvedValue({
      code: 0,
      msg: 'ok',
      data: { items: [{ record_id: 'rec-7', fields: { ...remote, created_at: Date.parse(remote.created_at), last_active_at: Date.parse(remote.last_active_at) } }] },
    });
    const batchUpdate = vi.fn().mockResolvedValue({ code: 0, msg: 'ok', data: { records: [{ record_id: 'rec-7' }] } });
    const client = makeClient({ search, batchUpdate });
    const store = createCaptainSessionStore({ configPath, env: { WB_DATA_DIR: dir }, _client: client, _retryOverride: { maxAttempts: 5, baseMs: 1, factor: 2, capMs: 4, jitterRatio: 0 } });

    await expect(store.upsertWithRevision(makeRecord({ session_id: 'cas-3', revision: 5 }), 5)).rejects.toThrow('captain.session.revision_mismatch');
    expect(batchUpdate).not.toHaveBeenCalled();
  });

  it('updates an existing session row', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-captain-store-'));
    roots.push(dir);
    const configPath = writeConfig(dir);
    const search = vi.fn().mockResolvedValue({
      code: 0,
      msg: 'ok',
      data: { items: [{ record_id: 'rec-1', fields: { ...makeRecord(), created_at: Date.parse('2026-06-06T00:00:00.000Z'), last_active_at: Date.parse('2026-06-06T00:10:00.000Z') } }] },
    });
    const batchUpdate = vi.fn().mockResolvedValue({ code: 0, msg: 'ok', data: { records: [{ record_id: 'rec-1' }] } });
    const client = makeClient({ search, batchUpdate });
    const store = createCaptainSessionStore({ configPath, env: { WB_DATA_DIR: dir }, _client: client, _retryOverride: { maxAttempts: 5, baseMs: 1, factor: 2, capMs: 4, jitterRatio: 0 } });

    const result = await store.upsert(makeRecord({ status: 'suspended' }));

    expect(result.ok).toBe(true);
    expect(client.bitable.appTableRecord.batchUpdate).toHaveBeenCalledTimes(1);
  });

  it('writes WAL entry on repeated write failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-captain-store-'));
    roots.push(dir);
    const configPath = writeConfig(dir);
    const batchCreate = vi.fn().mockRejectedValue(new Error('HTTP 503'));
    const client = makeClient({ batchCreate });
    const store = createCaptainSessionStore({ configPath, env: { WB_DATA_DIR: dir }, _client: client, _retryOverride: { maxAttempts: 5, baseMs: 1, factor: 2, capMs: 4, jitterRatio: 0 } });

    const result = await store.upsert(makeRecord());

    expect(result.ok).toBe(false);
    const files = readdirSync(join(dir, 'wal', 'captain-sessions'));
    expect(files.length).toBeGreaterThan(0);
    expect(readFileSync(join(dir, 'wal', 'captain-sessions', files[0]!), 'utf8')).toContain('"session_id":"s1"');
  });

  it('sync worker drains pending WAL entries', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-captain-store-'));
    roots.push(dir);
    const configPath = writeConfig(dir);
    const client = makeClient();
    const store = createCaptainSessionStore({ configPath, env: { WB_DATA_DIR: dir }, _client: client, _retryOverride: { maxAttempts: 5, baseMs: 1, factor: 2, capMs: 4, jitterRatio: 0 } });
    const walDir = join(dir, 'wal', 'captain-sessions');
    mkdirSync(walDir, { recursive: true });
    writeFileSync(join(walDir, 's1_0000000000000001.jsonl'), JSON.stringify({ seq: 1, session_id: 's1', record: makeRecord(), attempts: 5, state: 'pending-sync', enqueued_at: new Date().toISOString() }));

    const drained = await store.syncOnce();

    expect(drained).toBe(1);
    expect(readdirSync(walDir)).toHaveLength(0);
  });

  it('reconcile backfills bitable from mirror when remote is missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-captain-store-'));
    roots.push(dir);
    const configPath = writeConfig(dir);
    const mirrorPath = join(dir, 'captain-state.ndjson');
    writeFileSync(mirrorPath, `${JSON.stringify({ ts: new Date().toISOString(), op: 'upsert', session: makeRecord() })}\n`);
    const client = makeClient();
    const store = createCaptainSessionStore({ configPath, env: { WB_DATA_DIR: dir }, _client: client, _retryOverride: { maxAttempts: 5, baseMs: 1, factor: 2, capMs: 4, jitterRatio: 0 } });

    const sessions = await store.reconcile();

    expect(client.bitable.appTableRecord.batchCreate).toHaveBeenCalled();
    expect(sessions[0]?.session_id).toBe('s1');
  });

  it('reconcile prefers newer mirror last_active_at', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-captain-store-'));
    roots.push(dir);
    const configPath = writeConfig(dir);
    const mirrorPath = join(dir, 'captain-state.ndjson');
    writeFileSync(mirrorPath, `${JSON.stringify({ ts: new Date().toISOString(), op: 'upsert', session: makeRecord({ last_active_at: '2026-06-06T00:10:00.000Z' }) })}\n`);
    const search = vi.fn().mockResolvedValue({
      code: 0,
      msg: 'ok',
      data: { items: [{ record_id: 'rec-1', fields: { ...makeRecord({ last_active_at: '2026-06-06T00:00:00.000Z' }), created_at: Date.parse('2026-06-06T00:00:00.000Z'), last_active_at: Date.parse('2026-06-06T00:00:00.000Z') } }] },
    });
    const client = makeClient({ search });
    const store = createCaptainSessionStore({ configPath, env: { WB_DATA_DIR: dir }, _client: client, _retryOverride: { maxAttempts: 5, baseMs: 1, factor: 2, capMs: 4, jitterRatio: 0 } });

    const sessions = await store.reconcile();

    expect(client.bitable.appTableRecord.batchUpdate).toHaveBeenCalled();
    expect(sessions[0]?.last_active_at).toBe('2026-06-06T00:10:00.000Z');
  });

  it('does not send closed_at field when value is null', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-captain-store-'));
    roots.push(dir);
    const configPath = writeConfig(dir);
    const batchCreate = vi.fn().mockResolvedValue({ code: 0, msg: 'ok', data: { records: [{ record_id: 'rec-1' }] } });
    const client = makeClient({ batchCreate });
    const store = createCaptainSessionStore({ configPath, env: { WB_DATA_DIR: dir }, _client: client, _retryOverride: { maxAttempts: 5, baseMs: 1, factor: 2, capMs: 4, jitterRatio: 0 } });

    await store.upsert(makeRecord({ closed_at: null }));

    const payload = batchCreate.mock.calls[0]?.[0];
    expect(payload.data.records[0].fields.closed_at).toBeUndefined();
    expect(payload.data.records[0].fields.latest_run_id).toBe('run-001');
    expect(payload.data.records[0].fields.entry_form).toBe('im');
    expect(payload.data.records[0].fields.operator).toEqual([{ id: 'ou_abc' }]);
  });
});
