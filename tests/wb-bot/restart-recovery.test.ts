import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DefaultAgentRegistry } from '../../packages/core/src/agent/registry.js';
import { ClaudeCodeAgent } from '../../packages/core/src/agent/claude-code.js';
import { checkCaptainQueue } from '../../apps/wb-bot/src/commands/health.js';
import { BindingStore } from '../../apps/wb-bot/src/binding/store.js';
import { replayCaptainQueueOrAlert } from '../../apps/wb-bot/src/feishu/transport.js';
import { EventHandler } from '../../apps/wb-bot/src/feishu/event-handler.js';
import { CaptainService, createCaptainConcurrencyContainer } from '../../packages/core/src/captain/index.js';
import { ProgressStore } from '../../packages/core/src/run-observability/progress-store.js';

const registry = new DefaultAgentRegistry([{ agent: new ClaudeCodeAgent(), command: 'claude' }]);
const roots: string[] = [];

function createDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-bot-restart-'));
  roots.push(dir);
  return join(dir, 'wb-bot.db');
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

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['WB_DATA_DIR'];
  delete process.env['WB_HEARTBEAT_STALE_MS'];
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('restart recovery', () => {
  it('keeps bindings across store reopen and patches stale in-flight cards after restart', async () => {
    const dbPath = createDbPath();
    const firstStore = new BindingStore(dbPath);
    firstStore.upsertThreadBinding('default', { userOpenId: 'u1', threadId: 't1', agentId: 'codex', cwd: '/tmp/project' });
    firstStore.upsertContinuation('default', 'u1', 't1', 'codex', 'token-1');
    firstStore.upsertInflightCard('default', { userOpenId: 'u1', threadId: 't1', sourceMessageId: 'm1', replyMessageId: 'reply-1', agentId: 'codex' });
    firstStore.close();

    const secondStore = new BindingStore(dbPath);
    expect(secondStore.getThreadBinding('default', 'u1', 't1')).toEqual({
      userOpenId: 'u1',
      threadId: 't1',
      agentId: 'codex',
      cwd: '/tmp/project',
    });
    expect(secondStore.getContinuation('default', 'u1', 't1', 'codex')).toBe('token-1');
    expect(secondStore.getInflightCard('default', 'u1', 't1', 'codex')).toEqual({
      userOpenId: 'u1',
      threadId: 't1',
      sourceMessageId: 'm1',
      replyMessageId: 'reply-1',
      agentId: 'codex',
    });

    const replies: Array<Record<string, unknown>> = [];
    const updates: Array<{ messageId: string; card: Record<string, unknown> }> = [];
    const handler = new EventHandler(registry, secondStore, {
      async replyCard(_messageId, card) {
        replies.push(card);
        return 'reply-1';
      },
      async updateCard(messageId, card) {
        updates.push({ messageId, card });
      },
      async replyText() { return 'msg-1'; },
    });

    await handler.recoverInflightCards();

    expect(updates).toHaveLength(1);
    expect(updates[0]?.messageId).toBe('reply-1');
    expect(JSON.stringify(updates[0]?.card)).toContain('服务重启');
    expect(JSON.stringify(updates[0]?.card)).not.toContain('操作: 已停止');
    expect(secondStore.getInflightCard('default', 'u1', 't1', 'codex')).toBeNull();

    await handler.markRestarted('m1');
    const reply = replies[0] as { header: { title: { content: string } }; body: { elements: Array<{ content?: string }> } };
    expect(reply.header.title.content).toContain('🔴 error');
    expect(JSON.stringify(reply)).toContain('服务重启');
    expect(JSON.stringify(reply)).not.toContain('操作: 已停止');

    secondStore.close();
  });

  it('marks lost replayed running entry as ended(cancelled) and keeps queued work untouched', async () => {
    const dbPath = createDbPath();
    const dataDir = join(roots.at(-1)!, 'data');
    mkdirSync(join(dataDir, 'runs', 'default', 'run-lost-1'), { recursive: true });
    mkdirSync(join(dataDir, 'captain'), { recursive: true });
    writeFileSync(join(dataDir, 'runs', 'default', 'run-lost-1', 'spec.json'), JSON.stringify({ agentId: 'claude-code' }));
    writeFileSync(join(dataDir, 'runs', 'default', 'run-lost-1', 'status'), 'running');
    writeFileSync(join(dataDir, 'runs', 'default', 'run-lost-1', 'heartbeat'), '1');
    writeFileSync(join(dataDir, 'runs', 'default', 'run-lost-1', 'events.ndjson'), '');
    const oldDate = new Date(Date.now() - 60_000);
    utimesSync(join(dataDir, 'runs', 'default', 'run-lost-1', 'events.ndjson'), oldDate, oldDate);
    writeFileSync(join(dataDir, 'captain', 'queue.ndjson'), [
      '{"session_id":"default:u1:t1","run_id":"run-lost-1","status":"running","ts":"2026-06-14T00:00:00.000Z"}',
      '{"session_id":"default:u1:t1","run_id":"run-queued-1","status":"queued","ts":"2026-06-14T00:00:01.000Z"}',
    ].join('\n') + '\n');

    process.env['WB_DATA_DIR'] = dataDir;
    process.env['WB_HEARTBEAT_STALE_MS'] = '5000';

    const bindingStore = new BindingStore(dbPath);
    bindingStore.upsertInflightCard('default', {
      userOpenId: 'u1',
      threadId: 't1',
      sourceMessageId: 'm1',
      replyMessageId: 'reply-1',
      runId: 'run-lost-1',
      agentId: 'claude-code',
    });

    const updates: Array<{ messageId: string; card: Record<string, unknown> }> = [];
    const captainService = new CaptainService({ dataDir });
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
    captainService.bindRun('default:u1:t1', 'run-lost-1');

    const captainConcurrency = createCaptainConcurrencyContainer(dataDir);
    replayCaptainQueueOrAlert(captainConcurrency, dataDir);

    const handler = new EventHandler(registry, bindingStore, {
      async replyCard() { return 'reply-1'; },
      async updateCard(messageId, card) { updates.push({ messageId, card }); },
      async replyText() { return 'msg-1'; },
    }, '/tmp', undefined, { dataDir, wbRunnerMainPath: '/dev/null', botId: 'default' }, undefined, captainService, captainConcurrency);

    await handler.recoverInflightCards();

    const queueFile = readFileSync(join(dataDir, 'captain', 'queue.ndjson'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(queueFile.at(-1)).toMatchObject({ run_id: 'run-lost-1', status: 'ended', reason: 'cancelled' });
    expect(captainConcurrency.index.countRunning('default:u1:t1')).toBe(0);
    expect(captainConcurrency.index.countQueued('default:u1:t1')).toBe(1);
    expect(captainConcurrency.index.listQueued('default:u1:t1')).toEqual(['run-queued-1']);
    expect(checkCaptainQueue(dataDir).detail).toContain('running 0/1 · queued 1/10');
    expect(bindingStore.getInflightCard('default', 'u1', 't1', 'claude-code')).toBeNull();
    expect(updates).toHaveLength(1);
    bindingStore.close();
  });

  it('does not reconcile resumed runs into ended entries', async () => {
    const dbPath = createDbPath();
    const dataDir = join(roots.at(-1)!, 'data');
    mkdirSync(join(dataDir, 'runs', 'default', 'run-resumed-1'), { recursive: true });
    mkdirSync(join(dataDir, 'captain'), { recursive: true });
    writeFileSync(join(dataDir, 'runs', 'default', 'run-resumed-1', 'spec.json'), JSON.stringify({ agentId: 'claude-code' }));
    writeFileSync(join(dataDir, 'runs', 'default', 'run-resumed-1', 'status'), 'running');
    writeFileSync(join(dataDir, 'runs', 'default', 'run-resumed-1', 'heartbeat'), String(Math.floor(Date.now() / 1000)));
    writeFileSync(join(dataDir, 'runs', 'default', 'run-resumed-1', 'events.ndjson'), '');
    writeFileSync(join(dataDir, 'captain', 'queue.ndjson'), '{"session_id":"default:u1:t1","run_id":"run-resumed-1","status":"running","ts":"2026-06-14T00:00:00.000Z"}\n');

    process.env['WB_DATA_DIR'] = dataDir;
    process.env['WB_HEARTBEAT_STALE_MS'] = '120000';

    const bindingStore = new BindingStore(dbPath);
    bindingStore.upsertInflightCard('default', {
      userOpenId: 'u1',
      threadId: 't1',
      sourceMessageId: 'm1',
      replyMessageId: 'reply-1',
      runId: 'run-resumed-1',
      agentId: 'claude-code',
    });

    const captainService = new CaptainService({ dataDir });
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
    captainService.bindRun('default:u1:t1', 'run-resumed-1');

    const captainConcurrency = createCaptainConcurrencyContainer(dataDir);
    replayCaptainQueueOrAlert(captainConcurrency, dataDir);

    const handler = new EventHandler(registry, bindingStore, {
      async replyCard() { return 'reply-1'; },
      async updateCard() {},
      async replyText() { return 'msg-1'; },
    }, '/tmp', undefined, { dataDir, wbRunnerMainPath: '/dev/null', botId: 'default' }, undefined, captainService, captainConcurrency);

    await handler.recoverInflightCards();

    const queueFile = readFileSync(join(dataDir, 'captain', 'queue.ndjson'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(queueFile).toHaveLength(1);
    expect(captainConcurrency.index.countRunning('default:u1:t1')).toBe(1);
    expect(captainConcurrency.index.countQueued('default:u1:t1')).toBe(0);
    bindingStore.close();
  });

  it('blocks restart recovery auto-stop after stale self-heal limit is exhausted', async () => {
    const dbPath = createDbPath();
    const dataDir = join(roots.at(-1)!, 'data');
    mkdirSync(join(dataDir, 'runs', 'default', 'run-lost-2'), { recursive: true });
    mkdirSync(join(dataDir, 'captain'), { recursive: true });
    writeFileSync(join(dataDir, 'runs', 'default', 'run-lost-2', 'spec.json'), JSON.stringify({ agentId: 'claude-code' }));
    writeFileSync(join(dataDir, 'runs', 'default', 'run-lost-2', 'status'), 'running');
    writeFileSync(join(dataDir, 'runs', 'default', 'run-lost-2', 'heartbeat'), '1');
    writeFileSync(join(dataDir, 'runs', 'default', 'run-lost-2', 'events.ndjson'), '');
    const oldDate = new Date(Date.now() - 60_000);
    utimesSync(join(dataDir, 'runs', 'default', 'run-lost-2', 'events.ndjson'), oldDate, oldDate);
    writeFileSync(join(dataDir, 'captain', 'queue.ndjson'), '{"session_id":"default:u1:t1","run_id":"run-lost-2","status":"running","ts":"2026-06-14T00:00:00.000Z"}\n');
    seedStaleSelfHealMeta(dataDir, 'run-lost-2', 1);

    process.env['WB_DATA_DIR'] = dataDir;
    process.env['WB_HEARTBEAT_STALE_MS'] = '5000';

    const bindingStore = new BindingStore(dbPath);
    bindingStore.upsertInflightCard('default', {
      userOpenId: 'u1',
      threadId: 't1',
      sourceMessageId: 'm1',
      replyMessageId: 'reply-1',
      runId: 'run-lost-2',
      agentId: 'claude-code',
    });

    const updates: Array<{ messageId: string; card: Record<string, unknown> }> = [];
    const captainService = new CaptainService({ dataDir });
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
    captainService.bindRun('default:u1:t1', 'run-lost-2');

    const captainConcurrency = createCaptainConcurrencyContainer(dataDir);
    replayCaptainQueueOrAlert(captainConcurrency, dataDir);

    const handler = new EventHandler(registry, bindingStore, {
      async replyCard() { return 'reply-1'; },
      async updateCard(messageId, card) { updates.push({ messageId, card }); },
      async replyText() { return 'msg-1'; },
    }, '/tmp', undefined, { dataDir, wbRunnerMainPath: '/dev/null', botId: 'default' }, undefined, captainService, captainConcurrency);

    await handler.recoverInflightCards();

    const queueFile = readFileSync(join(dataDir, 'captain', 'queue.ndjson'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(queueFile).toHaveLength(1);
    expect(captainConcurrency.index.countRunning('default:u1:t1')).toBe(1);
    expect(readFileSync(join(dataDir, 'admin-alerts.ndjson'), 'utf8')).toContain('restart recovery stale-run auto-recovery disabled after limit: run-lost-2');
    // M13-D: escalated card is the new colleague-tone action card with retry/dismiss buttons.
    expect(JSON.stringify(updates[0]?.card)).toContain('反复卡死');
    expect(JSON.stringify(updates[0]?.card)).toContain('watchdog_retry');
    bindingStore.close();
  });
});
