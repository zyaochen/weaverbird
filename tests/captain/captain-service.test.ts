import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CaptainService } from '../../packages/core/src/captain/index.js';

const roots: string[] = [];

function makeService() {
  const dir = mkdtempSync(join(tmpdir(), 'wb-captain-service-'));
  roots.push(dir);
  let tick = 0;
  const service = new CaptainService({
    dataDir: dir,
    nowFn: () => new Date(Date.UTC(2026, 5, 6, 0, 0, tick++)).toISOString(),
  });
  return { dir, service };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('captain-service', () => {
  it('creates idle session and writes mirror entry', () => {
    const { dir, service } = makeService();
    const session = service.createSession({
      session_id: 'sid-001',
      captain_id: 'default',
      created_at: '2026-06-06T00:00:00.000Z',
      last_active_at: '2026-06-06T00:00:00.000Z',
      cwd: '/repo',
      scope: 'dev',
      project: 'weaverbird',
      home_group_id: 'grp-001',
      agent: 'claude-code',
      latest_run_id: null,
      operator: 'ou_abc',
      entry_form: 'im',
    });
    expect(session.record.status).toBe('idle');
    const lines = readFileSync(join(dir, 'captain-state.ndjson'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"op":"upsert"');
  });

  it('binds run from idle to active and tracks latest run id', () => {
    const { service } = makeService();
    service.createSession({
      session_id: 'sid-001',
      captain_id: 'default',
      created_at: '2026-06-06T00:00:00.000Z',
      last_active_at: '2026-06-06T00:00:00.000Z',
      cwd: '/repo',
      scope: 'dev',
      project: 'weaverbird',
      home_group_id: 'grp-001',
      agent: 'claude-code',
      latest_run_id: null,
      operator: 'ou_abc',
      entry_form: 'im',
    });
    service.bindRun('sid-001', 'run-001');
    const session = service.getSession('sid-001');
    expect(session?.record.status).toBe('active');
    expect(session?.record.latest_run_id).toBe('run-001');
    expect(session?.run_ids).toEqual(['run-001']);
  });

  it('suspends active session and keeps it in active listing', () => {
    const { service } = makeService();
    service.createSession({
      session_id: 'sid-001', captain_id: 'default', created_at: '2026-06-06T00:00:00.000Z', last_active_at: '2026-06-06T00:00:00.000Z', cwd: '/repo', scope: 'dev', project: 'weaverbird', home_group_id: 'grp-001', agent: 'claude-code', latest_run_id: null, operator: 'ou_abc', entry_form: 'im',
    });
    service.bindRun('sid-001', 'run-001');
    service.suspendSession('sid-001');
    expect(service.getSession('sid-001')?.record.status).toBe('suspended');
    expect(service.listActiveSessions()).toHaveLength(1);
  });

  it('closes active or suspended sessions and writes close mirror op', () => {
    const { dir, service } = makeService();
    service.createSession({
      session_id: 'sid-001', captain_id: 'default', created_at: '2026-06-06T00:00:00.000Z', last_active_at: '2026-06-06T00:00:00.000Z', cwd: '/repo', scope: 'dev', project: 'weaverbird', home_group_id: 'grp-001', agent: 'claude-code', latest_run_id: null, operator: 'ou_abc', entry_form: 'im',
    });
    service.bindRun('sid-001', 'run-001');
    service.closeSession('sid-001');
    expect(service.getSession('sid-001')?.record.status).toBe('closed');
    const lines = readFileSync(join(dir, 'captain-state.ndjson'), 'utf8').trim().split('\n');
    expect(lines.at(-1)).toContain('"op":"close"');
  });

  it('throws on illegal transition from closed back to active', () => {
    const { service } = makeService();
    service.createSession({
      session_id: 'sid-001', captain_id: 'default', created_at: '2026-06-06T00:00:00.000Z', last_active_at: '2026-06-06T00:00:00.000Z', cwd: '/repo', scope: 'dev', project: 'weaverbird', home_group_id: 'grp-001', agent: 'claude-code', latest_run_id: null, operator: 'ou_abc', entry_form: 'im',
    });
    service.bindRun('sid-001', 'run-001');
    service.closeSession('sid-001');
    expect(() => service.bindRun('sid-001', 'run-002')).toThrow();
  });

  it('flush prefers upsertWithRevision CAS and bumps the in-memory revision on success', async () => {
    // M12-A: CaptainService must use the CAS path when exposed, so two hosts
    // contending for the same session cannot last-write-wins each other.
    const upsertCalls: Array<{ revision: number }> = [];
    const upsertWithRevision = vi.fn(async (record: { revision: number }, expectedRevision: number) => {
      upsertCalls.push({ revision: record.revision });
      // session-store 的 CAS 契约:client 传它"记得"的 record (含上次 sync
      // 拿到的 revision),service 负责在成功后把 in-memory 推到 newRevision.
      // mock 只确认 record.revision === expectedRevision (即 caller 还没 bump).
      if (record.revision !== expectedRevision) {
        throw new Error(`CAS mismatch: rev=${record.revision} expected=${expectedRevision}`);
      }
      return { ok: true, attempt: 1, newRevision: expectedRevision + 1 };
    });
    const reconcile = vi.fn().mockResolvedValue([]);
    const dir = mkdtempSync(join(tmpdir(), 'wb-captain-service-'));
    roots.push(dir);
    const service = new CaptainService({
      dataDir: dir,
      store: { upsert: vi.fn(), upsertWithRevision, reconcile },
    });
    service.createSession({
      session_id: 'sid-cas-1', captain_id: 'default', created_at: '2026-06-06T00:00:00.000Z', last_active_at: '2026-06-06T00:00:00.000Z', cwd: '/repo', scope: 'dev', project: 'weaverbird', home_group_id: 'grp-001', agent: 'claude-code', latest_run_id: null, operator: 'ou_abc', entry_form: 'im',
    });
    // 初始 revision = 0, 第一次 flush 期望以 expected=0 发, 成功后 in-memory bump 到 1
    await service.flush();
    expect(upsertWithRevision).toHaveBeenCalledTimes(1);
    expect(upsertCalls[0]?.revision).toBe(0);  // caller 送 revision=expected(0), store 端会 +1
    expect(service.getSession('sid-cas-1')?.record.revision).toBe(1);
    // 第二次 flush 应该走 expected=1, newRevision=2
    service.bindRun('sid-cas-1', 'run-1');
    await service.flush();
    expect(upsertWithRevision).toHaveBeenCalledTimes(2);
    expect(service.getSession('sid-cas-1')?.record.revision).toBe(2);
  });

  it('flushes dirty sessions through injected store and reconcile restores from store', async () => {
    const upsert = vi.fn().mockResolvedValue(undefined);
    const reconcile = vi.fn().mockResolvedValue([{
      session_id: 'sid-002',
      captain_id: 'default',
      created_at: '2026-06-06T00:00:00.000Z',
      last_active_at: '2026-06-06T00:10:00.000Z',
      closed_at: null,
      status: 'active',
      cwd: '/repo-2',
      scope: 'dev',
      project: 'proj-2',
      home_group_id: 'grp-002',
      agent: 'codex',
      latest_run_id: 'run-002',
      operator: 'ou_xyz',
      entry_form: 'cli',
    }]);
    const dir = mkdtempSync(join(tmpdir(), 'wb-captain-service-'));
    roots.push(dir);
    const service = new CaptainService({ dataDir: dir, store: { upsert, reconcile } });
    service.createSession({
      session_id: 'sid-001', captain_id: 'default', created_at: '2026-06-06T00:00:00.000Z', last_active_at: '2026-06-06T00:00:00.000Z', cwd: '/repo', scope: 'dev', project: 'weaverbird', home_group_id: 'grp-001', agent: 'claude-code', latest_run_id: null, operator: 'ou_abc', entry_form: 'im',
    });
    await service.flush();
    expect(upsert).toHaveBeenCalledTimes(1);
    await service.reconcile();
    expect(service.getSession('sid-002')?.record.agent).toBe('codex');
  });

  it('rotates captain-state.ndjson and reconcile reads rotated shards oldest-first', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-captain-service-'));
    roots.push(dir);
    writeFileSync(join(dir, 'captain-state.ndjson'), 'x'.repeat(8 * 1024 * 1024), 'utf8');
    const reconcile = vi.fn().mockResolvedValue([]);
    const service = new CaptainService({ dataDir: dir, store: { upsert: vi.fn().mockResolvedValue(undefined), reconcile } });
    service.createSession({
      session_id: 'sid-001', captain_id: 'default', created_at: '2026-06-06T00:00:00.000Z', last_active_at: '2026-06-06T00:00:00.000Z', cwd: '/repo', scope: 'dev', project: 'weaverbird', home_group_id: 'grp-001', agent: 'claude-code', latest_run_id: null, operator: 'ou_abc', entry_form: 'im',
    });
    expect(readFileSync(join(dir, 'captain-state.ndjson.1'), 'utf8')).toHaveLength(8 * 1024 * 1024);
    await service.reconcile();
    expect(service.getSession('sid-001')?.record.agent).toBe('claude-code');
  });
});
