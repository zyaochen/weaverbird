import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DefaultAgentRegistry } from '../../packages/core/src/agent/registry.js';
import { ClaudeCodeAgent } from '../../packages/core/src/agent/claude-code.js';
import { BindingStore } from '../../apps/wb-bot/src/binding/store.js';
import { EventHandler } from '../../apps/wb-bot/src/feishu/event-handler.js';
import { EchoTailer } from '../../packages/core/src/reverse-channel/echo-tailer.js';
import type { SessionRecord } from '../../packages/core/src/captain/contracts.js';

const registry = new DefaultAgentRegistry([{ agent: new ClaudeCodeAgent(), command: 'claude' }]);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function seedCaptainState(dir: string, session: Partial<SessionRecord>): void {
  const mirrorPath = join(dir, 'captain-state.ndjson');
  mkdirSync(join(mirrorPath, '..'), { recursive: true });
  writeFileSync(mirrorPath, JSON.stringify({ op: 'upsert', ts: '2026-08-04T00:00:00Z', session: {
    session_id: session.session_id ?? 'sess-1',
    captain_id: session.captain_id ?? 'default',
    created_at: session.created_at ?? '2026-08-04T00:00:00Z',
    last_active_at: session.last_active_at ?? '2026-08-04T00:05:00Z',
    closed_at: session.closed_at ?? null,
    status: session.status ?? 'active',
    cwd: session.cwd ?? '/repo',
    scope: session.scope ?? 'dev',
    project: session.project ?? 'weaverbird',
    home_group_id: session.home_group_id ?? 'oc_home_grp',
    agent: session.agent ?? 'claude-code',
    latest_run_id: session.latest_run_id ?? 'run-cli-1',
    operator: session.operator ?? 'ou_owner',
    entry_form: session.entry_form ?? 'cli',
    revision: session.revision ?? 0,
  } }) + '\n');
}

describe('EventHandler.sendHomeGroupCard', () => {
  it('sends via feishu.sendCard when available', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-echo-'));
    roots.push(dir);
    const sent: Array<{ chatId: string }> = [];
    const handler = new EventHandler(registry, new BindingStore(join(dir, 'db')), {
      async replyCard() { return 'r'; },
      async updateCard() {},
      async replyText() { return 'r'; },
      sendCard: async (chatId) => { sent.push({ chatId }); },
    }, '/tmp', undefined, { dataDir: dir, wbRunnerMainPath: '/dev/null', botId: 'default' });

    await handler.sendHomeGroupCard('oc_home_grp', { schema: '2.0' });
    expect(sent).toEqual([{ chatId: 'oc_home_grp' }]);
    handler.dispose();
  });

  it('without sendCard, warn-and-return (no throw)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-echo-'));
    roots.push(dir);
    const handler = new EventHandler(registry, new BindingStore(join(dir, 'db')), {
      async replyCard() { return 'r'; },
      async updateCard() {},
      async replyText() { return 'r'; },
    }, '/tmp', undefined, { dataDir: dir, wbRunnerMainPath: '/dev/null', botId: 'default' });
    await expect(handler.sendHomeGroupCard('oc_home_grp', { schema: '2.0' })).resolves.toBeUndefined();
    handler.dispose();
  });

  it('null chatId short-circuits (no log noise)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-echo-'));
    roots.push(dir);
    const handler = new EventHandler(registry, new BindingStore(join(dir, 'db')), {
      async replyCard() { return 'r'; },
      async updateCard() {},
      async replyText() { return 'r'; },
    }, '/tmp', undefined, { dataDir: dir, wbRunnerMainPath: '/dev/null', botId: 'default' });
    await expect(handler.sendHomeGroupCard(null, { schema: '2.0' })).resolves.toBeUndefined();
    handler.dispose();
  });
});

describe('EchoDaemon (transport mini-watcher)', () => {
  it('emits Echo card once per unseen latest_run_id', async () => {
    // 直接喂 EchoTailer (不动 transport.startTransport), 保证 daemon 逻辑:
    // 读 state mirror 发现新 latest_run_id -> echoTailer.onRunUpserted 发首卡;
    // 30 秒内的重复 latest_run_id 不重发;ECHO_MAX_PER_RUN 卡控发散频率.
    const dir = mkdtempSync(join(tmpdir(), 'wb-echo-daemon-'));
    roots.push(dir);

    const sent: Array<{ runId: string }> = [];
    const tailer = new EchoTailer(async (payload) => {
      sent.push({ runId: payload.run_id, ...payload } as unknown as { runId: string });
    });

    const sess: SessionRecord = {
      session_id: 'sess-cli-1',
      captain_id: 'default',
      created_at: '2026-08-04T00:00:00Z',
      last_active_at: '2026-08-04T00:05:00Z',
      closed_at: null,
      status: 'active',
      cwd: '/repo',
      scope: 'dev',
      project: 'weaverbird',
      home_group_id: 'oc_home_grp',
      agent: 'claude-code',
      latest_run_id: 'run-cli-1',
      operator: 'ou_owner',
      entry_form: 'cli',
      revision: 0,
    };
    seedCaptainState(dir, sess);

    const first = await tailer.onRunUpserted({
      run_id: 'run-cli-1',
      cmd: 'cli-start',
      cwd: '/repo',
      created_at: '2026-08-04T00:05:00Z',
      status: 'active',
      session: sess,
      operator_open_id: 'ou_owner',
    });
    expect(first).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.runId).toBe('run-cli-1');

    // 同 run_id + 同 status 在 30s 窗口不发
    const dup = await tailer.onRunUpserted({
      run_id: 'run-cli-1',
      cmd: 'cli-start',
      cwd: '/repo',
      created_at: '2026-08-04T00:05:00Z',
      status: 'active',
      session: sess,
      operator_open_id: 'ou_owner',
    });
    expect(dup).toBe(false);
    expect(sent).toHaveLength(1);
  });
});
