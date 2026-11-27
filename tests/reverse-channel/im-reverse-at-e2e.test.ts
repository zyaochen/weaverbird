import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DefaultAgentRegistry } from '../../packages/core/src/agent/registry.js';
import { ClaudeCodeAgent } from '../../packages/core/src/agent/claude-code.js';
import { BindingStore } from '../../apps/wb-bot/src/binding/store.js';
import { EventHandler } from '../../apps/wb-bot/src/feishu/event-handler.js';
import { CaptainService } from '../../packages/core/src/captain/index.js';
import { IpcServer } from '../../packages/core/src/reverse-channel/ipc-server.js';
import { wireUpReverseChannel } from '../../apps/wb-bot/src/server/wire-up.js';
import { waitForStoppedState } from '../helpers/process-state.js';

const roots: string[] = [];
const children: ChildProcess[] = [];

function writeConfig(dir: string): void {
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({
    captain: {
      bitable_base_id: 'Uq6hb0dUaaYiDQsunHel7EisgWd',
      sessions_table_id: 'tblyqLE52hgNO7UA',
      app_id: 'cli_yyyyyyyyyyyyyyyy',
      app_secret: 'secret-32-characters-000000000000',
      lark_domain: 'LarkSuite',
      captain_state_path: join(dir, 'captain-state.ndjson'),
      captain_toml_path: join(dir, 'captain.json'),
    },
  }, null, 2));
  chmodSync(path, 0o600);
}

function spawnSleeper(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  children.push(child);
  return child;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const child of children.splice(0)) {
    if (child.pid && !child.killed) {
      try { process.kill(child.pid, 'SIGCONT'); } catch {}
      try { process.kill(child.pid, 'SIGKILL'); } catch {}
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('im reverse-at e2e', () => {
  it.skipIf(process.platform === 'win32')('injects IM message and delivers real SIGSTOP through IPC control path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-im-reverse-'));
    roots.push(dir);
    writeConfig(dir);
    process.env['WB_DATA_DIR'] = dir;
    process.env['WB_MODE'] = 'multi-bot';

    const socketPath = join(dir, 'captain.sock');
    const child = spawnSleeper();
    expect(child.pid).toBeTypeOf('number');
    mkdirSync(join(dir, 'runs', 'default', 'run-001'), { recursive: true });
    writeFileSync(join(dir, 'runs', 'default', 'run-001', 'pid'), String(child.pid));

    const captainService = new CaptainService({ dataDir: dir });
    captainService.createSession({
      session_id: 'sid-001',
      captain_id: 'default',
      created_at: '2026-06-08T00:00:00.000Z',
      last_active_at: '2026-06-08T00:00:00.000Z',
      cwd: '/repo',
      scope: 'dev',
      project: 'weaverbird',
      home_group_id: 'grp',
      agent: 'claude-code',
      latest_run_id: null,
      operator: 'ou_owner',
      entry_form: 'im',
    });
    captainService.bindRun('sid-001', 'run-001');

    const server = new IpcServer(socketPath);
    await server.start();
    wireUpReverseChannel(server, captainService, dir, 'default');

    const store = new BindingStore(join(dir, 'wb-bot.db'));
    const registry = new DefaultAgentRegistry([{ agent: new ClaudeCodeAgent(), command: 'claude' }]);
    const replyCard = vi.fn(async (_messageId: string, _card: Record<string, unknown>) => 'reply-1');

    const handler = new EventHandler(registry, store, {
      replyCard,
      async updateCard() {},
      async replyText() { return 'msg-1'; },
    }, undefined, undefined, undefined, {
      botId: 'default',
      dataDir: dir,
      taskIndex: { size: 0 } as any,
      logFilePath: join(dir, 'wb-bot.log'),
      wsClientStatus: () => ({ lastEventAt: null }),
    }, captainService);

    try {
      await handler.handleMessage({
        eventId: 'evt-reverse-at',
        userOpenId: 'ou_owner',
        threadId: 'grp',
        messageId: 'm1',
        text: 'pause run-001',
      });
      expect(await waitForStoppedState(child.pid!, 1_500)).toBe(true);
      const lastReply = replyCard.mock.calls.at(-1);
      expect(lastReply).toBeDefined();
      if (!lastReply) {
        throw new Error('expected reply card call');
      }
      const [, lastCard] = lastReply;
      expect(JSON.stringify(lastCard)).toContain('✅ pause run-001');
    } finally {
      store.close();
      await server.stop();
    }
  });
});
