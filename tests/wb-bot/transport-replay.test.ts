import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCaptainConcurrencyContainer, CaptainService } from '../../packages/core/src/captain/index.js';
import { replayCaptainQueueOrAlert, reconcileOrphanCaptainRunsOrAlert } from '../../apps/wb-bot/src/feishu/transport.js';
import { BindingStore } from '../../apps/wb-bot/src/binding/store.js';

const roots: string[] = [];

function makeDir(prefix = 'wb-transport-replay-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['WB_ADMIN_THREAD_ID'];
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('transport replay', () => {
  it('replays queue.ndjson history into the captain index at boot', () => {
    const dir = makeDir();
    const container = createCaptainConcurrencyContainer(dir);
    container.store.append({ session_id: 'default:u1:t1', run_id: 'run-1', status: 'running', ts: '2026-06-14T00:00:00.000Z' });
    container.store.append({ session_id: 'default:u1:t1', run_id: 'run-2', status: 'queued', ts: '2026-06-14T00:00:01.000Z' });

    const reloaded = createCaptainConcurrencyContainer(dir);
    expect(reloaded.index.countRunning('default:u1:t1')).toBe(0);
    expect(reloaded.index.countQueued('default:u1:t1')).toBe(0);

    replayCaptainQueueOrAlert(reloaded, dir);

    expect(reloaded.index.countRunning('default:u1:t1')).toBe(1);
    expect(reloaded.index.countQueued('default:u1:t1')).toBe(1);
    expect(reloaded.index.listQueued('default:u1:t1')).toEqual(['run-2']);
  });

  it('replays rotated queue shards oldest-first', () => {
    const dir = makeDir();
    mkdirSync(join(dir, 'captain'), { recursive: true });
    writeFileSync(join(dir, 'captain', 'queue.ndjson.1'), '{"session_id":"default:u1:t1","run_id":"run-1","status":"running","ts":"2026-06-14T00:00:00.000Z"}\n');
    writeFileSync(join(dir, 'captain', 'queue.ndjson'), '{"session_id":"default:u1:t1","run_id":"run-1","status":"ended","ts":"2026-06-14T00:00:01.000Z"}\n{"session_id":"default:u1:t1","run_id":"run-2","status":"queued","ts":"2026-06-14T00:00:02.000Z"}\n');

    const reloaded = createCaptainConcurrencyContainer(dir);
    replayCaptainQueueOrAlert(reloaded, dir);

    expect(reloaded.index.countRunning('default:u1:t1')).toBe(0);
    expect(reloaded.index.countQueued('default:u1:t1')).toBe(1);
    expect(reloaded.index.listQueued('default:u1:t1')).toEqual(['run-2']);
  });

  it('fails open and writes an admin alert when replay throws', () => {
    const dir = makeDir();
    const container = createCaptainConcurrencyContainer(dir);
    writeFileSync(container.store.path, '{bad-json}\n', 'utf8');

    const broken = {
      ...container,
      store: {
        ...container.store,
        readAll() {
          throw new Error('boom');
        },
      },
    };

    expect(() => replayCaptainQueueOrAlert(broken as typeof container, dir)).not.toThrow();
    const alerts = readFileSync(join(dir, 'admin-alerts.ndjson'), 'utf8');
    expect(alerts).toContain('captain queue replay failed during boot');
  });

  it('best-effort read error hook does not block replay when metrics recording fails', () => {
    const dir = makeDir();
    mkdirSync(join(dir, 'captain'), { recursive: true });
    writeFileSync(join(dir, 'captain', 'queue.ndjson'), '{bad-json}\n{"session_id":"default:u1:t1","run_id":"run-queued","status":"queued","ts":"2026-06-14T00:00:00.000Z"}\n');

    const container = createCaptainConcurrencyContainer(dir);
    vi.spyOn(container.metrics, 'record').mockImplementation(() => {
      throw new Error('metrics down');
    });

    expect(() => replayCaptainQueueOrAlert(container, dir)).not.toThrow();
    expect(container.index.countQueued('default:u1:t1')).toBe(1);
  });

  it('does not auto-spawn queued runs during replay', () => {
    const dir = makeDir();
    mkdirSync(join(dir, 'captain'), { recursive: true });
    writeFileSync(join(dir, 'captain', 'queue.ndjson'), '{"session_id":"default:u1:t1","run_id":"run-queued","status":"queued","ts":"2026-06-14T00:00:00.000Z"}\n');

    const reloaded = createCaptainConcurrencyContainer(dir);
    replayCaptainQueueOrAlert(reloaded, dir);

    expect(reloaded.index.countQueued('default:u1:t1')).toBe(1);
    expect(reloaded.index.countRunning('default:u1:t1')).toBe(0);
  });

  it('reconciles orphan running entries to ended(cancelled) during boot replay', () => {
    const dir = makeDir();
    mkdirSync(join(dir, 'captain'), { recursive: true });
    writeFileSync(join(dir, 'captain', 'queue.ndjson'), '{"session_id":"default:u1:t1","run_id":"run-orphan","status":"running","ts":"2026-06-14T00:00:00.000Z"}\n');

    const bindingStore = new BindingStore(join(dir, 'wb-bot.db'));
    const captainService = new CaptainService({ dataDir: dir });
    captainService.createSession({
      session_id: 'default:u1:t1',
      captain_id: 'default',
      created_at: '2026-06-14T00:00:00.000Z',
      last_active_at: '2026-06-14T00:00:00.000Z',
      cwd: '/repo',
      scope: 'dev',
      project: 'weaverbird',
      home_group_id: 't1',
      agent: 'claude-code',
      latest_run_id: null,
      operator: 'u1',
      entry_form: 'im',
    });
    captainService.bindRun('default:u1:t1', 'run-orphan');

    const reloaded = createCaptainConcurrencyContainer(dir);
    replayCaptainQueueOrAlert(reloaded, dir);
    reconcileOrphanCaptainRunsOrAlert(reloaded, captainService, bindingStore, dir, 'default');

    const queueLines = readFileSync(join(dir, 'captain', 'queue.ndjson'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(queueLines.at(-1)).toMatchObject({ run_id: 'run-orphan', status: 'ended', reason: 'cancelled' });
    expect(reloaded.index.countRunning('default:u1:t1')).toBe(0);
    bindingStore.close();
  });

  it('fails open when orphan reconcile cannot append an ended entry', () => {
    const dir = makeDir();
    mkdirSync(join(dir, 'captain'), { recursive: true });
    writeFileSync(join(dir, 'captain', 'queue.ndjson'), '{"session_id":"default:u1:t1","run_id":"run-orphan","status":"running","ts":"2026-06-14T00:00:00.000Z"}\n');

    const bindingStore = new BindingStore(join(dir, 'wb-bot.db'));
    const captainService = new CaptainService({ dataDir: dir });
    captainService.createSession({
      session_id: 'default:u1:t1',
      captain_id: 'default',
      created_at: '2026-06-14T00:00:00.000Z',
      last_active_at: '2026-06-14T00:00:00.000Z',
      cwd: '/repo',
      scope: 'dev',
      project: 'weaverbird',
      home_group_id: 't1',
      agent: 'claude-code',
      latest_run_id: null,
      operator: 'u1',
      entry_form: 'im',
    });
    captainService.bindRun('default:u1:t1', 'run-orphan');

    const reloaded = createCaptainConcurrencyContainer(dir);
    replayCaptainQueueOrAlert(reloaded, dir);
    vi.spyOn(reloaded.store, 'append').mockImplementation(() => {
      throw new Error('disk full');
    });

    expect(() => reconcileOrphanCaptainRunsOrAlert(reloaded, captainService, bindingStore, dir, 'default')).not.toThrow();
    expect(reloaded.index.countRunning('default:u1:t1')).toBe(1);
    bindingStore.close();
  });
});
