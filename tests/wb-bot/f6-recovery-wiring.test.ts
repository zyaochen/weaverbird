import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DefaultAgentRegistry } from '../../packages/core/src/agent/registry.js';
import type { AgentAdapter, AgentRun, RunRequest } from '../../packages/core/src/index.js';
import { BindingStore } from '../../apps/wb-bot/src/binding/store.js';
import { EventHandler } from '../../apps/wb-bot/src/feishu/event-handler.js';

let dir = '';
let store: BindingStore;

function mkAgentWithRotation(id: string, displayName: string, tokenRotation: 'rotating' | 'static'): AgentAdapter {
  return {
    id,
    displayName,
    async isAvailable() { return true; },
    async getCapabilities() { return { tokenRotation } as any; },
    run(_req: RunRequest): AgentRun {
      return {
        events: { async *[Symbol.asyncIterator]() { yield { type: 'done' as const, continuationToken: undefined }; } },
        async stop() {},
        async waitForExit() { return true; },
      };
    },
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wb-f6-'));
  store = new BindingStore(join(dir, 'wb-bot.db'));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('F6 recovery wiring', () => {
  it('F6.2.1: rotating agent + events.ndjson with done token → upsert called', async () => {
    const agent = mkAgentWithRotation('claude-code', 'Claude Code', 'rotating');
    const registry = new DefaultAgentRegistry([{ agent, command: 'claude' }]);
    const dataDir = mkdtempSync(join(tmpdir(), 'wb-data-'));
    const botId = 'default';
    const runId = 'run-test-001';
    const runDir = join(dataDir, 'runs', botId, runId);
    mkdirSync(runDir, { recursive: true });

    writeFileSync(join(runDir, 'spec.json'), JSON.stringify({ agentId: 'claude-code', prompt: 'hi' }));
    writeFileSync(join(runDir, 'status'), 'running');
    writeFileSync(join(runDir, 'heartbeat'), String(Math.floor(Date.now() / 1000)));
    writeFileSync(join(runDir, 'events.ndjson'), [
      '{"type":"system","continuationToken":"old-token","cwd":"/tmp"}',
      '{"type":"text","delta":"hello"}',
      '{"type":"done","continuationToken":"new-token-from-events"}',
    ].join('\n'));

    store.upsertInflightCard('default', {
      sourceMessageId: 'src-1',
      replyMessageId: 'reply-1',
      userOpenId: 'u1',
      threadId: 't1',
      runId,
      agentId: 'claude-code',
    });

    const upsertSpy = vi.spyOn(store, 'upsertContinuation');
    const prev = process.env['WB_DATA_DIR'];
    process.env['WB_DATA_DIR'] = dataDir;
    let replySeq = 0;

    const handler = new EventHandler(registry, store, {
      async replyCard() { return `reply-${++replySeq}`; },
      async updateCard() {},
      async replyText() { return 'msg-1'; },
    }, '/tmp', undefined, { dataDir, wbRunnerMainPath: '/dev/null', botId });

    await handler.recoverInflightCards();

    expect(upsertSpy).toHaveBeenCalledWith('default', 'u1', 't1', 'claude-code', 'new-token-from-events');
    upsertSpy.mockRestore();
    if (prev === undefined) delete process.env['WB_DATA_DIR'];
    else process.env['WB_DATA_DIR'] = prev;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('F6.2.3: static agent (codex) → upsert NOT called for backfill', async () => {
    const agent = mkAgentWithRotation('codex', 'Codex', 'static');
    const registry = new DefaultAgentRegistry([{ agent, command: 'codex' }]);
    const dataDir = mkdtempSync(join(tmpdir(), 'wb-data-'));
    const botId = 'default';
    const runId = 'run-codex-001';
    const runDir = join(dataDir, 'runs', botId, runId);
    mkdirSync(runDir, { recursive: true });

    writeFileSync(join(runDir, 'spec.json'), JSON.stringify({ agentId: 'codex', prompt: 'hi' }));
    writeFileSync(join(runDir, 'status'), 'running');
    writeFileSync(join(runDir, 'heartbeat'), String(Math.floor(Date.now() / 1000)));
    writeFileSync(join(runDir, 'events.ndjson'), '{"type":"done","continuationToken":"codex-tok"}\n');

    store.upsertInflightCard('default', {
      sourceMessageId: 'src-2',
      replyMessageId: 'reply-2',
      userOpenId: 'u2',
      threadId: 't2',
      runId,
      agentId: 'codex',
    });

    const upsertSpy = vi.spyOn(store, 'upsertContinuation');
    const prev = process.env['WB_DATA_DIR'];
    process.env['WB_DATA_DIR'] = dataDir;
    let replySeq = 0;

    const handler = new EventHandler(registry, store, {
      async replyCard() { return `reply-${++replySeq}`; },
      async updateCard() {},
      async replyText() { return 'msg-1'; },
    }, '/tmp', undefined, { dataDir, wbRunnerMainPath: '/dev/null', botId });

    await handler.recoverInflightCards();

    const backfillCalls = upsertSpy.mock.calls.filter(([, , , agentId]) => agentId === 'codex');
    expect(backfillCalls).toHaveLength(0);
    upsertSpy.mockRestore();
    if (prev === undefined) delete process.env['WB_DATA_DIR'];
    else process.env['WB_DATA_DIR'] = prev;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('F6.2.4: rotating agent + events.ndjson without token → upsert NOT called', async () => {
    const agent = mkAgentWithRotation('claude-code', 'Claude Code', 'rotating');
    const registry = new DefaultAgentRegistry([{ agent, command: 'claude' }]);
    const dataDir = mkdtempSync(join(tmpdir(), 'wb-data-'));
    const botId = 'default';
    const runId = 'run-notoken-001';
    const runDir = join(dataDir, 'runs', botId, runId);
    mkdirSync(runDir, { recursive: true });

    writeFileSync(join(runDir, 'spec.json'), JSON.stringify({ agentId: 'claude-code', prompt: 'hi' }));
    writeFileSync(join(runDir, 'status'), 'running');
    writeFileSync(join(runDir, 'heartbeat'), String(Math.floor(Date.now() / 1000)));
    writeFileSync(join(runDir, 'events.ndjson'), '{"type":"text","delta":"no token here"}\n');

    store.upsertInflightCard('default', {
      sourceMessageId: 'src-3',
      replyMessageId: 'reply-3',
      userOpenId: 'u3',
      threadId: 't3',
      runId,
      agentId: 'claude-code',
    });

    const upsertSpy = vi.spyOn(store, 'upsertContinuation');
    const prev = process.env['WB_DATA_DIR'];
    process.env['WB_DATA_DIR'] = dataDir;
    let replySeq = 0;

    const handler = new EventHandler(registry, store, {
      async replyCard() { return `reply-${++replySeq}`; },
      async updateCard() {},
      async replyText() { return 'msg-1'; },
    }, '/tmp', undefined, { dataDir, wbRunnerMainPath: '/dev/null', botId });

    await handler.recoverInflightCards();

    expect(upsertSpy).not.toHaveBeenCalled();
    upsertSpy.mockRestore();
    if (prev === undefined) delete process.env['WB_DATA_DIR'];
    else process.env['WB_DATA_DIR'] = prev;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('reattached run keeps the original start time for the elapsed clock and the completion push', async () => {
    const agent = mkAgentWithRotation('claude-code', 'Claude Code', 'rotating');
    const registry = new DefaultAgentRegistry([{ agent, command: 'claude' }]);
    const dataDir = mkdtempSync(join(tmpdir(), 'wb-data-'));
    const botId = 'default';
    const runId = 'run-resume-start-001';
    const runDir = join(dataDir, 'runs', botId, runId);
    mkdirSync(runDir, { recursive: true });
    const startedAt = Date.now() - 10 * 60_000;

    writeFileSync(join(runDir, 'spec.json'), JSON.stringify({ agentId: 'claude-code', prompt: 'hi', startedAt: new Date(startedAt).toISOString() }));
    writeFileSync(join(runDir, 'status'), 'running');
    writeFileSync(join(runDir, 'heartbeat'), String(Math.floor(Date.now() / 1000)));
    writeFileSync(join(runDir, 'events.ndjson'), '{"type":"text","delta":"answer"}\n{"type":"done"}\n');
    store.upsertInflightCard('default', {
      sourceMessageId: 'src-5',
      replyMessageId: 'reply-5',
      userOpenId: 'u5',
      threadId: 't5',
      runId,
      agentId: 'claude-code',
    });

    const replyText = vi.fn(async () => 'msg-1');
    const handler = new EventHandler(registry, store, {
      async replyCard() { return 'reply-x'; },
      async updateCard() {},
      replyText,
    }, '/tmp', undefined, { dataDir, wbRunnerMainPath: '/dev/null', botId });

    await handler.recoverInflightCards();
    await vi.waitFor(() => expect(replyText).toHaveBeenCalledTimes(1), { timeout: 3000 });
    const [replyTo, message] = replyText.mock.calls[0] as unknown as [string, string];
    expect(replyTo).toBe('reply-5');
    expect(message).toMatch(/ · 10m(\d+s)? · /);
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('F6.2.5: rotating agent + spec.json missing → no crash, no upsert', async () => {
    const agent = mkAgentWithRotation('claude-code', 'Claude Code', 'rotating');
    const registry = new DefaultAgentRegistry([{ agent, command: 'claude' }]);
    const dataDir = mkdtempSync(join(tmpdir(), 'wb-data-'));
    const botId = 'default';
    const runId = 'run-nospec-001';
    const runDir = join(dataDir, 'runs', botId, runId);
    mkdirSync(runDir, { recursive: true });

    writeFileSync(join(runDir, 'status'), 'running');
    writeFileSync(join(runDir, 'heartbeat'), String(Math.floor(Date.now() / 1000)));

    store.upsertInflightCard('default', {
      sourceMessageId: 'src-4',
      replyMessageId: 'reply-4',
      userOpenId: 'u4',
      threadId: 't4',
      runId,
      agentId: 'claude-code',
    });

    const upsertSpy = vi.spyOn(store, 'upsertContinuation');
    const prev = process.env['WB_DATA_DIR'];
    process.env['WB_DATA_DIR'] = dataDir;
    let replySeq = 0;

    const handler = new EventHandler(registry, store, {
      async replyCard() { return `reply-${++replySeq}`; },
      async updateCard() {},
      async replyText() { return 'msg-1'; },
    }, '/tmp', undefined, { dataDir, wbRunnerMainPath: '/dev/null', botId });

    await expect(handler.recoverInflightCards()).resolves.not.toThrow();
    expect(upsertSpy).not.toHaveBeenCalled();
    upsertSpy.mockRestore();
    if (prev === undefined) delete process.env['WB_DATA_DIR'];
    else process.env['WB_DATA_DIR'] = prev;
    rmSync(dataDir, { recursive: true, force: true });
  });
});
