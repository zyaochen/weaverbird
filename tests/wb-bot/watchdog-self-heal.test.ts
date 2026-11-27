import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DefaultAgentRegistry } from '../../packages/core/src/agent/registry.js';
import { ClaudeCodeAgent } from '../../packages/core/src/agent/claude-code.js';
import { BindingStore } from '../../apps/wb-bot/src/binding/store.js';
import { EventHandler } from '../../apps/wb-bot/src/feishu/event-handler.js';
import { createInitialState } from '../../apps/wb-bot/src/feishu/stream-state.js';
import { CaptainService, createCaptainConcurrencyContainer } from '../../packages/core/src/captain/index.js';
import { ProgressStore } from '../../packages/core/src/run-observability/progress-store.js';

const registry = new DefaultAgentRegistry([{ agent: new ClaudeCodeAgent(), command: 'claude' }]);
const roots: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-watchdog-'));
  roots.push(dir);
  return dir;
}

function writeStaleRun(dataDir: string, runId: string): void {
  const runDir = join(dataDir, 'runs', 'default', runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'spec.json'), JSON.stringify({ agentId: 'claude-code' }));
  writeFileSync(join(runDir, 'status'), 'running');
  writeFileSync(join(runDir, 'heartbeat'), '1');
  writeFileSync(join(runDir, 'events.ndjson'), '');
  const oldDate = new Date(Date.now() - 60_000);
  utimesSync(join(runDir, 'events.ndjson'), oldDate, oldDate);
}

function writeFreshRunSpec(dataDir: string, runId: string): void {
  const runDir = join(dataDir, 'runs', 'default', runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'spec.json'), JSON.stringify({
    runId,
    botId: 'default',
    agentId: 'claude-code',
    startedAt: new Date().toISOString(),
  }));
}

function seedCaptainSession(service: CaptainService, runId: string): void {
  service.createSession({
    session_id: 'default:u1:t1',
    captain_id: 'default',
    created_at: '2026-06-22T00:00:00.000Z',
    last_active_at: '2026-06-22T00:00:00.000Z',
    cwd: '/repo',
    scope: 'dev',
    project: 'weaverbird',
    home_group_id: 't1',
    agent: 'claude-code',
    latest_run_id: null,
    operator: 'u1',
    entry_form: 'im',
  });
  service.bindRun('default:u1:t1', runId);
}

function seedStaleSelfHealMeta(dataDir: string, runId: string, attempts: number, escalatedAt: string | null = null): void {
  const store = new ProgressStore({
    dataDir,
    botId: 'default',
    runId,
    sessionId: 'default:u1:t1',
    originMessageId: 'm1',
    cardMessageId: 'reply-1',
    nowFn: () => '2026-06-22T00:00:00.000Z',
  });
  const entry = store.readOrInitEntry('2026-06-22T00:00:00.000Z');
  entry.stale_self_heal_attempts = attempts;
  entry.stale_self_heal_last_attempt_at = '2026-06-22T00:00:00.000Z';
  entry.stale_self_heal_escalated_at = escalatedAt;
  store.saveEntry(entry);
}

function writePidFile(dataDir: string, runId: string, pid: number): void {
  writeFileSync(join(dataDir, 'runs', 'default', runId, 'pid'), String(pid));
}

// A short-lived pid whose zombie entry is reaped before the sweep inspects it,
// so isRunnerProcessStopped sees ESRCH without any real child surviving the test.
function spawnDeadPid(): number {
  return Number.parseInt(execFileSync('/bin/sh', ['-c', 'true & echo $!; wait'], { encoding: 'utf8' }).trim(), 10);
}

function writeDeadPidFile(dataDir: string, runId: string): void {
  writePidFile(dataDir, runId, spawnDeadPid());
}

// A sleeper node child that survives SIGTERM, so the watchdog's liveness probe sees a live run.
// Caller is responsible for `.kill('SIGKILL')` on the returned handle during teardown.
function spawnSurvivorPid(): { pid: number; kill: () => void } {
  const child = spawn(
    process.execPath,
    ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'],
    { stdio: 'ignore' },
  );
  if (!child.pid) throw new Error('spawnSurvivorPid: no pid');
  return { pid: child.pid, kill: () => { child.kill('SIGKILL'); } };
}


afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['WB_HEARTBEAT_STALE_MS'];
  delete process.env['WB_ADMIN_THREAD_ID'];
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('watchdog self-heal', () => {
  it('skips fresh wb-runner sessions during startup grace to avoid false stale recovery', async () => {
    const dir = makeDir();
    const dataDir = join(dir, 'data');
    const store = new BindingStore(join(dir, 'wb-bot.db'));

    store.upsertInflightCard('default', {
      userOpenId: 'u1',
      threadId: 't1',
      sourceMessageId: 'm1',
      replyMessageId: 'reply-1',
      runId: 'run-starting-1',
      agentId: 'claude-code',
    });

    const updates: Array<{ messageId: string; card: Record<string, unknown> }> = [];
    const handler = new EventHandler(registry, store, {
      async replyCard() { return 'reply-1'; },
      async updateCard(messageId, card) { updates.push({ messageId, card }); },
      async replyText() { return 'msg-1'; },
    }, '/tmp', undefined, { dataDir, wbRunnerMainPath: '/dev/null', botId: 'default' });

    const activeSession = {
      scopeKey: 'u1:t1:claude-code',
      sourceMessageId: 'm1',
      replyMessageId: 'reply-1',
      run: null,
      runId: 'run-starting-1',
      pipeline: {},
      state: createInitialState('claude-code', 'Claude Code', 'Claude Code'),
      extraMessageIds: [],
      eventsReader: { stop() {} },
      startedAt: Date.now(),
      agentId: 'claude-code',
      sessionId: 'default:u1:t1',
    };
    (handler as any).activeSessions.set(activeSession.scopeKey, activeSession);

    await (handler as any).sweepStaleRuns();

    expect(store.getInflightCard('default', 'u1', 't1', 'claude-code')).not.toBeNull();
    expect(existsSync(join(dataDir, 'runs', 'default', 'run-starting-1', 'stop.signal'))).toBe(false);
    expect(updates).toHaveLength(0);
    expect(existsSync(join(dataDir, 'admin-alerts.ndjson'))).toBe(false);

    handler.dispose();
    store.close();
  });

  it('skips fresh wb-runner runs during startup grace even before active session is visible', async () => {
    const dir = makeDir();
    const dataDir = join(dir, 'data');
    const store = new BindingStore(join(dir, 'wb-bot.db'));

    writeFreshRunSpec(dataDir, 'run-starting-disk-1');
    store.upsertInflightCard('default', {
      userOpenId: 'u1',
      threadId: 't1',
      sourceMessageId: 'm1',
      replyMessageId: 'reply-1',
      runId: 'run-starting-disk-1',
      agentId: 'claude-code',
    });

    const updates: Array<{ messageId: string; card: Record<string, unknown> }> = [];
    const handler = new EventHandler(registry, store, {
      async replyCard() { return 'reply-1'; },
      async updateCard(messageId, card) { updates.push({ messageId, card }); },
      async replyText() { return 'msg-1'; },
    }, '/tmp', undefined, { dataDir, wbRunnerMainPath: '/dev/null', botId: 'default' });

    await (handler as any).sweepStaleRuns();

    expect(store.getInflightCard('default', 'u1', 't1', 'claude-code')).not.toBeNull();
    expect(existsSync(join(dataDir, 'runs', 'default', 'run-starting-disk-1', 'stop.signal'))).toBe(false);
    expect(updates).toHaveLength(0);
    expect(existsSync(join(dataDir, 'admin-alerts.ndjson'))).toBe(false);

    handler.dispose();
    store.close();
  });

  it('does not auto-recover a run whose in-memory session already reached a terminal state', async () => {
    const dir = makeDir();
    const dataDir = join(dir, 'data');
    const store = new BindingStore(join(dir, 'wb-bot.db'));
    process.env['WB_HEARTBEAT_STALE_MS'] = '5000';

    writeStaleRun(dataDir, 'run-terminal-race-1');
    store.upsertInflightCard('default', {
      userOpenId: 'u1',
      threadId: 't1',
      sourceMessageId: 'm1',
      replyMessageId: 'reply-1',
      runId: 'run-terminal-race-1',
      agentId: 'claude-code',
    });

    const updates: Array<{ messageId: string; card: Record<string, unknown> }> = [];
    const handler = new EventHandler(registry, store, {
      async replyCard() { return 'reply-1'; },
      async updateCard(messageId, card) { updates.push({ messageId, card }); },
      async replyText() { return 'msg-1'; },
    }, '/tmp', undefined, { dataDir, wbRunnerMainPath: '/dev/null', botId: 'default' });

    const activeSession = {
      scopeKey: 'u1:t1:claude-code',
      sourceMessageId: 'm1',
      replyMessageId: 'reply-1',
      run: null,
      runId: 'run-terminal-race-1',
      pipeline: {},
      state: {
        ...createInitialState('claude-code', 'Claude Code', 'Claude Code'),
        terminalState: 'done' as const,
      },
      extraMessageIds: [],
      eventsReader: { stop() {} },
      startedAt: Date.now() - 10_000,
      agentId: 'claude-code',
      sessionId: 'default:u1:t1',
    };
    (handler as any).activeSessions.set(activeSession.scopeKey, activeSession);

    await (handler as any).sweepStaleRuns();

    expect(existsSync(join(dataDir, 'runs', 'default', 'run-terminal-race-1', 'stop.signal'))).toBe(false);
    expect(store.getInflightCard('default', 'u1', 't1', 'claude-code')).not.toBeNull();
    expect(updates).toHaveLength(0);
    expect(existsSync(join(dataDir, 'admin-alerts.ndjson'))).toBe(false);

    handler.dispose();
    store.close();
  });

  it('auto-recovers a stale inflight run and marks it ended(cancelled)', async () => {
    const dir = makeDir();
    const dataDir = join(dir, 'data');
    const store = new BindingStore(join(dir, 'wb-bot.db'));
    process.env['WB_HEARTBEAT_STALE_MS'] = '5000';

    writeStaleRun(dataDir, 'run-stale-1');
    writeDeadPidFile(dataDir, 'run-stale-1');
    mkdirSync(join(dataDir, 'captain'), { recursive: true });
    writeFileSync(join(dataDir, 'captain', 'queue.ndjson'), [
      '{"session_id":"default:u1:t1","run_id":"run-stale-1","status":"running","ts":"2026-06-22T00:00:00.000Z"}',
      '{"session_id":"default:u1:t1","run_id":"run-queued-1","status":"queued","ts":"2026-06-22T00:00:01.000Z"}',
    ].join('\n') + '\n');
    store.upsertInflightCard('default', {
      userOpenId: 'u1',
      threadId: 't1',
      sourceMessageId: 'm1',
      replyMessageId: 'reply-1',
      runId: 'run-stale-1',
      agentId: 'claude-code',
    });

    const captainService = new CaptainService({ dataDir });
    seedCaptainSession(captainService, 'run-stale-1');
    const captainConcurrency = createCaptainConcurrencyContainer(dataDir);
    captainConcurrency.index.replay(captainConcurrency.store.readAll());

    const updates: Array<{ messageId: string; card: Record<string, unknown> }> = [];
    const handler = new EventHandler(registry, store, {
      async replyCard() { return 'reply-1'; },
      async updateCard(messageId, card) { updates.push({ messageId, card }); },
      async replyText() { return 'msg-1'; },
    }, '/tmp', undefined, { dataDir, wbRunnerMainPath: '/dev/null', botId: 'default' }, undefined, captainService, captainConcurrency);

    await (handler as any).sweepStaleRuns();

    expect(existsSync(join(dataDir, 'runs', 'default', 'run-stale-1', 'stop.signal'))).toBe(true);
    const queueLines = readFileSync(join(dataDir, 'captain', 'queue.ndjson'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(queueLines.at(-1)).toMatchObject({ run_id: 'run-stale-1', status: 'ended', reason: 'cancelled' });
    expect(captainConcurrency.index.countRunning('default:u1:t1')).toBe(0);
    expect(captainConcurrency.index.countQueued('default:u1:t1')).toBe(1);
    expect(store.getInflightCard('default', 'u1', 't1', 'claude-code')).toBeNull();
    expect(updates).toHaveLength(1);
    // M13-D: 文案换成同事口吻"+按钮,不再重复"已自动恢复并停止该次运行"字样.
    expect(JSON.stringify(updates[0]?.card)).toContain('卡死了');
    expect(JSON.stringify(updates[0]?.card)).toContain('watchdog_dismiss');
    const alerts = readFileSync(join(dataDir, 'admin-alerts.ndjson'), 'utf8');
    expect(alerts).toContain('watchdog auto-recovered stale run: run-stale-1');

    handler.dispose();
    store.close();
  });

  it('fails open when card patch throws during stale-run recovery', async () => {
    const dir = makeDir();
    const dataDir = join(dir, 'data');
    const store = new BindingStore(join(dir, 'wb-bot.db'));
    process.env['WB_HEARTBEAT_STALE_MS'] = '5000';

    writeStaleRun(dataDir, 'run-stale-2');
    writeDeadPidFile(dataDir, 'run-stale-2');
    mkdirSync(join(dataDir, 'captain'), { recursive: true });
    writeFileSync(join(dataDir, 'captain', 'queue.ndjson'), '{"session_id":"default:u1:t1","run_id":"run-stale-2","status":"running","ts":"2026-06-22T00:00:00.000Z"}\n');
    store.upsertInflightCard('default', {
      userOpenId: 'u1',
      threadId: 't1',
      sourceMessageId: 'm1',
      replyMessageId: 'reply-1',
      runId: 'run-stale-2',
      agentId: 'claude-code',
    });

    const captainService = new CaptainService({ dataDir });
    seedCaptainSession(captainService, 'run-stale-2');
    const captainConcurrency = createCaptainConcurrencyContainer(dataDir);
    captainConcurrency.index.replay(captainConcurrency.store.readAll());

    const handler = new EventHandler(registry, store, {
      async replyCard() { return 'reply-1'; },
      async updateCard() { throw new Error('patch down'); },
      async replyText() { return 'msg-1'; },
    }, '/tmp', undefined, { dataDir, wbRunnerMainPath: '/dev/null', botId: 'default' }, undefined, captainService, captainConcurrency);

    await expect((handler as any).sweepStaleRuns()).resolves.toBeUndefined();

    expect(store.getInflightCard('default', 'u1', 't1', 'claude-code')).toBeNull();
    const queueLines = readFileSync(join(dataDir, 'captain', 'queue.ndjson'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(queueLines.at(-1)).toMatchObject({ run_id: 'run-stale-2', status: 'ended', reason: 'cancelled' });
    const alerts = readFileSync(join(dataDir, 'admin-alerts.ndjson'), 'utf8');
    expect(alerts).toContain('watchdog stale-run recovery failed: run-stale-2');

    handler.dispose();
    store.close();
  });

  it('blocks repeated stale self-heal for the same run and escalates once', async () => {
    const dir = makeDir();
    const dataDir = join(dir, 'data');
    const store = new BindingStore(join(dir, 'wb-bot.db'));
    process.env['WB_HEARTBEAT_STALE_MS'] = '5000';

    writeStaleRun(dataDir, 'run-stale-3');
    writeDeadPidFile(dataDir, 'run-stale-3');
    seedStaleSelfHealMeta(dataDir, 'run-stale-3', 1);
    mkdirSync(join(dataDir, 'captain'), { recursive: true });
    writeFileSync(join(dataDir, 'captain', 'queue.ndjson'), '{"session_id":"default:u1:t1","run_id":"run-stale-3","status":"running","ts":"2026-06-22T00:00:00.000Z"}\n');
    store.upsertInflightCard('default', {
      userOpenId: 'u1',
      threadId: 't1',
      sourceMessageId: 'm1',
      replyMessageId: 'reply-1',
      runId: 'run-stale-3',
      agentId: 'claude-code',
    });

    const captainService = new CaptainService({ dataDir });
    seedCaptainSession(captainService, 'run-stale-3');
    const captainConcurrency = createCaptainConcurrencyContainer(dataDir);
    captainConcurrency.index.replay(captainConcurrency.store.readAll());

    const updates: Array<{ messageId: string; card: Record<string, unknown> }> = [];
    const handler = new EventHandler(registry, store, {
      async replyCard() { return 'reply-1'; },
      async updateCard(messageId, card) { updates.push({ messageId, card }); },
      async replyText() { return 'msg-1'; },
    }, '/tmp', undefined, { dataDir, wbRunnerMainPath: '/dev/null', botId: 'default' }, undefined, captainService, captainConcurrency);

    await (handler as any).sweepStaleRuns();

    expect(existsSync(join(dataDir, 'runs', 'default', 'run-stale-3', 'stop.signal'))).toBe(false);
    const queueLines = readFileSync(join(dataDir, 'captain', 'queue.ndjson'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(queueLines).toHaveLength(1);
    expect(captainConcurrency.index.countRunning('default:u1:t1')).toBe(1);
    expect(store.getInflightCard('default', 'u1', 't1', 'claude-code')).toBeNull();
    expect(updates).toHaveLength(1);
    // M13-D: escalated card 文案同事口吻 + 按钮.
    expect(JSON.stringify(updates[0]?.card)).toContain('反复卡死');
    expect(JSON.stringify(updates[0]?.card)).toContain('watchdog_retry');
    const alerts = readFileSync(join(dataDir, 'admin-alerts.ndjson'), 'utf8');
    expect(alerts).toContain('watchdog stale-run auto-recovery disabled after limit: run-stale-3');

    handler.dispose();
    store.close();
  });

  it('does not emit duplicate escalation alerts after stale self-heal is blocked', async () => {
    const dir = makeDir();
    const dataDir = join(dir, 'data');
    const store = new BindingStore(join(dir, 'wb-bot.db'));
    process.env['WB_HEARTBEAT_STALE_MS'] = '5000';

    writeStaleRun(dataDir, 'run-stale-4');
    seedStaleSelfHealMeta(dataDir, 'run-stale-4', 1, '2026-06-22T00:00:00.000Z');
    mkdirSync(join(dataDir, 'captain'), { recursive: true });
    writeFileSync(join(dataDir, 'captain', 'queue.ndjson'), '{"session_id":"default:u1:t1","run_id":"run-stale-4","status":"running","ts":"2026-06-22T00:00:00.000Z"}\n');
    store.upsertInflightCard('default', {
      userOpenId: 'u1',
      threadId: 't1',
      sourceMessageId: 'm1',
      replyMessageId: 'reply-1',
      runId: 'run-stale-4',
      agentId: 'claude-code',
    });

    const captainService = new CaptainService({ dataDir });
    seedCaptainSession(captainService, 'run-stale-4');
    const captainConcurrency = createCaptainConcurrencyContainer(dataDir);
    captainConcurrency.index.replay(captainConcurrency.store.readAll());

    const handler = new EventHandler(registry, store, {
      async replyCard() { return 'reply-1'; },
      async updateCard() {},
      async replyText() { return 'msg-1'; },
    }, '/tmp', undefined, { dataDir, wbRunnerMainPath: '/dev/null', botId: 'default' }, undefined, captainService, captainConcurrency);

    await (handler as any).sweepStaleRuns();

    expect(existsSync(join(dataDir, 'admin-alerts.ndjson'))).toBe(false);

    handler.dispose();
    store.close();
  });

  it('retains inflight card and session when the stale runner is still alive after the cancel signal', async () => {
    const dir = makeDir();
    const dataDir = join(dir, 'data');
    const store = new BindingStore(join(dir, 'wb-bot.db'));
    process.env['WB_HEARTBEAT_STALE_MS'] = '5000';

    writeStaleRun(dataDir, 'run-stubborn-1');
    const survivor1 = spawnSurvivorPid();
    writePidFile(dataDir, 'run-stubborn-1', survivor1.pid);
    mkdirSync(join(dataDir, 'captain'), { recursive: true });
    writeFileSync(join(dataDir, 'captain', 'queue.ndjson'), '{"session_id":"default:u1:t1","run_id":"run-stubborn-1","status":"running","ts":"2026-06-22T00:00:00.000Z"}\n');
    store.upsertInflightCard('default', {
      userOpenId: 'u1',
      threadId: 't1',
      sourceMessageId: 'm1',
      replyMessageId: 'reply-1',
      runId: 'run-stubborn-1',
      agentId: 'claude-code',
    });

    const updates: Array<{ messageId: string; card: Record<string, unknown> }> = [];
    const handler = new EventHandler(registry, store, {
      async replyCard() { return 'reply-1'; },
      async updateCard(messageId, card) { updates.push({ messageId, card }); },
      async replyText() { return 'msg-1'; },
    }, '/tmp', undefined, { dataDir, wbRunnerMainPath: '/dev/null', botId: 'default' });

    try {
      await (handler as any).sweepStaleRuns();

      // The cancel channel was exercised (stop.signal written), but the runner is still
      // alive, so the card must survive and the next sweep can retry.
      expect(existsSync(join(dataDir, 'runs', 'default', 'run-stubborn-1', 'stop.signal'))).toBe(true);
      expect(store.getInflightCard('default', 'u1', 't1', 'claude-code')).not.toBeNull();
      expect(updates).toHaveLength(1);
    } finally {
      survivor1.kill();
      handler.dispose();
      store.close();
    }
  });

  it('clears inflight card on the next sweep once the stubborn runner has exited', async () => {
    const dir = makeDir();
    const dataDir = join(dir, 'data');
    const store = new BindingStore(join(dir, 'wb-bot.db'));
    process.env['WB_HEARTBEAT_STALE_MS'] = '5000';

    writeStaleRun(dataDir, 'run-stubborn-2');
    const survivor2 = spawnSurvivorPid();
    writePidFile(dataDir, 'run-stubborn-2', survivor2.pid);
    mkdirSync(join(dataDir, 'captain'), { recursive: true });
    writeFileSync(join(dataDir, 'captain', 'queue.ndjson'), '{"session_id":"default:u1:t1","run_id":"run-stubborn-2","status":"running","ts":"2026-06-22T00:00:00.000Z"}\n');
    store.upsertInflightCard('default', {
      userOpenId: 'u1',
      threadId: 't1',
      sourceMessageId: 'm1',
      replyMessageId: 'reply-1',
      runId: 'run-stubborn-2',
      agentId: 'claude-code',
    });

    const handler = new EventHandler(registry, store, {
      async replyCard() { return 'reply-1'; },
      async updateCard() {},
      async replyText() { return 'msg-1'; },
    }, '/tmp', undefined, { dataDir, wbRunnerMainPath: '/dev/null', botId: 'default' });

    try {
      await (handler as any).sweepStaleRuns();
      expect(store.getInflightCard('default', 'u1', 't1', 'claude-code')).not.toBeNull();

      // Simulate the runner finally exiting after the first signal attempt.
      rmSync(join(dataDir, 'runs', 'default', 'run-stubborn-2', 'pid'));
      survivor2.kill();
      await (handler as any).sweepStaleRuns();
      expect(store.getInflightCard('default', 'u1', 't1', 'claude-code')).toBeNull();
    } finally {
      survivor2.kill();
      handler.dispose();
      store.close();
    }
  });

  it('tears down the run when an approval request expires so the scope frees', async () => {
    const dir = makeDir();
    const dataDir = join(dir, 'data');
    const store = new BindingStore(join(dir, 'wb-bot.db'));

    const handler = new EventHandler(registry, store, {
      async replyCard() { return 'reply-1'; },
      async updateCard() {},
      async replyText() { return 'msg-1'; },
    }, '/tmp', undefined, { dataDir, wbRunnerMainPath: '/dev/null', botId: 'default' });

    const run = { stop: vi.fn(async () => {}) };
    const activeSession = {
      scopeKey: 'u1:t1:claude-code',
      threadId: 't1',
      homeGroupId: null,
      sourceMessageId: 'm1',
      replyMessageId: 'reply-1',
      run,
      runId: 'run-approval-expire-1',
      pipeline: { force: async () => {}, flush: async () => {}, dispose: () => {} },
      state: {
        ...createInitialState('claude-code', 'Claude', 'Claude'),
        terminalState: 'running' as const,
      },
      extraMessageIds: [],
      eventsReader: { stop() {} },
      startedAt: Date.now(),
      agentId: 'claude-code',
      sessionId: 'default:u1:t1',
    };
    (handler as any).activeSessions.set(activeSession.scopeKey, activeSession);

    const stopSpy = vi.spyOn(handler as any, 'stopSession').mockResolvedValue(undefined);
    vi.spyOn((handler as any).approvalRequests, 'listPending').mockReturnValue([]);
    vi.spyOn((handler as any).approvalRequests, 'expireOverdue').mockReturnValue([{
      requestId: 'req-1',
      runId: 'run-approval-expire-1',
      status: 'expired',
      resolutionReason: 'approval timeout',
      resolvedAt: '2026-06-22T00:00:00.000Z',
      createdAt: '2026-06-22T00:00:00.000Z',
    }]);

    await (handler as any).sweepApprovalRequests();

    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(stopSpy).toHaveBeenCalledWith(activeSession);
    expect(run.stop).not.toHaveBeenCalled(); // stopSession is mocked; real path delegates to run.stop()
    expect(activeSession.state.terminalState).toBe('error');
    expect(activeSession.state.errorMessage).toBe('approval timeout');

    handler.dispose();
    store.close();
  });
});
