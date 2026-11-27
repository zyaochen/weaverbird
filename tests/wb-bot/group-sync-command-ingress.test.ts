import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BindingStore } from '../../apps/wb-bot/src/binding/store.js';
import { EventHandler } from '../../apps/wb-bot/src/feishu/event-handler.js';
import { DefaultAgentRegistry } from '../../packages/core/src/agent/registry.js';
import type { AgentAdapter, AgentRun, RunRequest } from '../../packages/core/src/index.js';
import { groupSyncMockLedgerPath, runGroupSyncStatePath } from '../../packages/core/src/paths.js';
import { createMockGroupSyncTransport, startGroupSyncScheduler, type GroupSyncConfig, type GroupSyncCommandReceived } from '../../packages/core/src/group-sync/index.js';

const roots: string[] = [];
const config: GroupSyncConfig = {
  enabled: true,
  transport: 'mock',
  rpc_timeout_ms: 50,
  sweep_interval_ms: 10_000,
};

function createFeishu() {
  return {
    replyCard: vi.fn(async () => 'reply-1'),
    updateCard: vi.fn(async () => undefined),
    replyText: vi.fn(async () => 'msg-1'),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('group-sync command ingress', () => {
  it('routes group-sync command through existing event-handler path and preserves session/run/revision', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-group-sync-ingress-'));
    roots.push(dir);
    mkdirSync(join(dir, 'group-sync'), { recursive: true });
    writeFileSync(join(dir, 'group-sync', 'mock-commands.json'), JSON.stringify([
      {
        request_id: 'req-3',
        session_id: 'sid-3',
        run_id: 'run-3',
        revision: 2,
        text: 'hello from group sync',
        scheduled_at: '2026-06-29T00:00:00.000Z',
        user_open_id: 'ou_user',
        thread_id: 'oc_thread',
        message_id: 'msg-3',
      },
    ], null, 2));

    const store = new BindingStore(join(dir, 'wb-bot.db'));
    const feishu = createFeishu();
    const agent: AgentAdapter = {
      id: 'claude-code',
      displayName: 'Claude Code',
      async isAvailable() { return true; },
      async getCapabilities() { return {} as any; },
      run(_req: RunRequest): AgentRun {
        return {
          events: {
            async *[Symbol.asyncIterator]() {
              yield { type: 'done' as const };
            },
          },
          async stop() {},
          async waitForExit() { return true; },
        };
      },
    };
    const registry = new DefaultAgentRegistry([{ agent, command: 'claude' }]);
    const handler = new EventHandler(registry, store, feishu as any, '/tmp');
    const seen: GroupSyncCommandReceived[] = [];
    const scheduler = startGroupSyncScheduler({
      dataDir: dir,
      config,
      transport: createMockGroupSyncTransport(dir),
      nowFn: () => Date.parse('2026-06-29T00:00:01.000Z'),
      onCommand: async (command) => {
        seen.push(command);
        await handler.dispatchCommandReceived({
          source: 'periodic',
          requestId: command.request_id,
          sessionId: command.session_id,
          runId: command.run_id,
          revision: command.revision,
          text: command.text,
          userOpenId: command.user_open_id ?? 'group-sync',
          threadId: command.thread_id ?? command.session_id,
          messageId: command.message_id ?? command.request_id,
          scheduledAt: command.scheduled_at,
        });
      },
    });

    await scheduler.tick();

    expect(seen).toEqual([expect.objectContaining({ session_id: 'sid-3', run_id: 'run-3', revision: 2 })]);
    expect(feishu.replyCard).toHaveBeenCalled();
    expect(store.listInflightCards('default')).toHaveLength(0);
    expect(readFileSync(runGroupSyncStatePath(dir, 'run-3'), 'utf8')).toContain('"session_id": "sid-3"');
    expect(readFileSync(groupSyncMockLedgerPath(dir), 'utf8')).toContain('"run_id":"run-3"');
    store.close();
    handler.dispose();
    scheduler.stop();
  });
});

