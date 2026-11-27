import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DefaultAgentRegistry } from '../../packages/core/src/agent/registry.js';
import { ClaudeCodeAgent } from '../../packages/core/src/agent/claude-code.js';
import { BindingStore } from '../../apps/wb-bot/src/binding/store.js';
import { EventHandler } from '../../apps/wb-bot/src/feishu/event-handler.js';
import { TaskIndex } from '../../apps/wb-bot/src/binding/task-index.js';

const agent = new ClaudeCodeAgent();
const registry = new DefaultAgentRegistry([{ agent, command: 'claude' }]);
const feishu = {
  async replyCard() { return 'reply-1'; },
  async updateCard() {},
  async replyText() { return 'msg-1'; },
};

let dir: string;
let store: BindingStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wb-bot-ehbotid-'));
  store = new BindingStore(join(dir, 'wb-bot.db'));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('EventHandler botId propagation', () => {
  it('uses runnerConfig.botId for store operations', async () => {
    const handler = new EventHandler(
      registry, store, feishu, '/tmp', undefined,
      { dataDir: dir, wbRunnerMainPath: '/dev/null', botId: 'my-bot' },
    );

    const listSpy = vi.spyOn(store, 'listInflightCards');
    await handler.recoverInflightCards();

    expect(listSpy).toHaveBeenCalledWith('my-bot');
    listSpy.mockRestore();
  });

  it('defaults to "default" when neither runnerConfig nor controlPlane provide botId', async () => {
    const handler = new EventHandler(registry, store, feishu, '/tmp');

    const listSpy = vi.spyOn(store, 'listInflightCards');
    await handler.recoverInflightCards();

    expect(listSpy).toHaveBeenCalledWith('default');
    listSpy.mockRestore();
  });

  it('controlPlane.botId is used when runnerConfig is absent', async () => {
    const taskIndex = new TaskIndex(dir, 'default');
    const handler = new EventHandler(
      registry, store, feishu, '/tmp', undefined, undefined,
      { botId: 'cp-bot', dataDir: dir, logFilePath: '/dev/null', taskIndex, wsClientStatus: () => ({ lastEventAt: null }) },
    );

    const listSpy = vi.spyOn(store, 'listInflightCards');
    await handler.recoverInflightCards();

    expect(listSpy).toHaveBeenCalledWith('cp-bot');
    listSpy.mockRestore();
  });

  it('runnerConfig.botId takes precedence over controlPlane.botId', async () => {
    const taskIndex = new TaskIndex(dir, 'default');
    const handler = new EventHandler(
      registry, store, feishu, '/tmp', undefined,
      { dataDir: dir, wbRunnerMainPath: '/dev/null', botId: 'runner-bot' },
      { botId: 'cp-bot', dataDir: dir, logFilePath: '/dev/null', taskIndex, wsClientStatus: () => ({ lastEventAt: null }) },
    );

    const listSpy = vi.spyOn(store, 'listInflightCards');
    await handler.recoverInflightCards();

    expect(listSpy).toHaveBeenCalledWith('runner-bot');
    listSpy.mockRestore();
  });
});
