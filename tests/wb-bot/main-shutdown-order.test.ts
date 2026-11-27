import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter, AgentRun } from '../../packages/core/src/index.js';
import { DefaultAgentRegistry } from '../../packages/core/src/agent/registry.js';
import { BindingStore } from '../../apps/wb-bot/src/binding/store.js';
import { EventHandler } from '../../apps/wb-bot/src/feishu/event-handler.js';

const roots: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-main-drain-'));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeDrainableRegistry(onStop?: () => void): { registry: DefaultAgentRegistry; waitUntilStarted: () => Promise<void> } {
  let runResolve: (() => void) | null = null;
  const agent: AgentAdapter = {
    id: 'claude-code',
    displayName: 'Claude Code',
    async isAvailable() { return true; },
    async getCapabilities() { return {} as any; },
    run(): AgentRun {
      return {
        events: {
          async *[Symbol.asyncIterator]() {
            await new Promise<void>((resolve) => { runResolve = resolve; });
            yield { type: 'done' as const };
          },
        },
        async stop() {
          onStop?.();
          runResolve?.();
        },
        async waitForExit() { return true; },
      };
    },
  };
  return {
    registry: new DefaultAgentRegistry([{ agent, command: 'claude' }]),
    waitUntilStarted: async () => {
      await vi.waitFor(() => expect(runResolve).not.toBeNull());
    },
  };
}

describe('main shutdown drain order', () => {
  it('returns immediately when there are no active sessions', async () => {
    const dir = makeDir();
    const store = new BindingStore(join(dir, 'wb-bot.db'));
    const { registry } = makeDrainableRegistry();
    const handler = new EventHandler(registry, store, {
      async replyCard() { return 'reply-1'; },
      async updateCard() {},
      async replyText() { return 'msg-1'; },
    }, dir);

    handler.beginDraining();
    await expect(handler.stopAllSessions(100)).resolves.toBeUndefined();
    store.close();
  });

  it('waits for active sessions to drain within the deadline window', async () => {
    const dir = makeDir();
    const store = new BindingStore(join(dir, 'wb-bot.db'));
    const { registry, waitUntilStarted } = makeDrainableRegistry();
    const handler = new EventHandler(registry, store, {
      async replyCard() { return 'reply-1'; },
      async updateCard() {},
      async replyText() { return 'msg-1'; },
    }, dir);

    const running = handler.handleMessage({ eventId: 'e1', userOpenId: 'u1', threadId: 't1', messageId: 'm1', text: 'task' });
    await waitUntilStarted();
    handler.beginDraining();
    await handler.stopAllSessions(500);
    await running;

    expect(handler.activeSessionsSnapshot()).toHaveLength(0);
    store.close();
  });

  it('times out forced teardown window when active sessions do not settle in time', async () => {
    const dir = makeDir();
    const store = new BindingStore(join(dir, 'wb-bot.db'));
    let started = false;
    const stubbornAgent: AgentAdapter = {
      id: 'claude-code',
      displayName: 'Claude Code',
      async isAvailable() { return true; },
      async getCapabilities() { return {} as any; },
      run(): AgentRun {
        return {
          events: {
            async *[Symbol.asyncIterator]() {
              started = true;
              await new Promise(() => {});
            },
          },
          async stop() {},
          async waitForExit() { return false; },
        };
      },
    };
    const handler = new EventHandler(new DefaultAgentRegistry([{ agent: stubbornAgent, command: 'claude' }]), store, {
      async replyCard() { return 'reply-1'; },
      async updateCard() {},
      async replyText() { return 'msg-1'; },
    }, dir);

    void handler.handleMessage({ eventId: 'e1', userOpenId: 'u1', threadId: 't1', messageId: 'm1', text: 'task' });
    await vi.waitFor(() => expect(started).toBe(true));
    handler.beginDraining();

    const start = Date.now();
    await handler.stopAllSessions(100);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(elapsed).toBeLessThan(500);
    store.close();
  });

  it('rejects new messages while draining', async () => {
    const dir = makeDir();
    const store = new BindingStore(join(dir, 'wb-bot.db'));
    const replies: Array<Record<string, unknown>> = [];
    const { registry } = makeDrainableRegistry();
    const handler = new EventHandler(registry, store, {
      async replyCard(_messageId, card) {
        replies.push(card);
        return 'reply-1';
      },
      async updateCard() {},
      async replyText() { return 'msg-1'; },
    }, dir);

    handler.beginDraining();
    await handler.handleMessage({ eventId: 'e1', userOpenId: 'u1', threadId: 't1', messageId: 'm1', text: 'new-task' });

    expect(JSON.stringify(replies[0])).toContain('shutdown drain');
    store.close();
  });
});
