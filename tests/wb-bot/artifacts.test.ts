import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { artifactLabel, findArtifacts, uploadKind } from '../../apps/wb-bot/src/feishu/artifacts.js';
import { EventHandler } from '../../apps/wb-bot/src/feishu/event-handler.js';
import { BindingStore } from '../../apps/wb-bot/src/binding/store.js';
import { DefaultAgentRegistry } from '../../packages/core/src/agent/registry.js';
import type { AgentAdapter, AgentRun } from '../../packages/core/src/index.js';

let dir = '';
let cwd = '';
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'wb-artifacts-')));
  cwd = join(dir, 'repo');
  mkdirSync(join(cwd, 'out'), { recursive: true });
  vi.stubEnv('WB_DATA_DIR', join(dir, 'data'));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('findArtifacts', () => {
  it('keeps fresh files inside cwd from tool inputs and answer text', () => {
    const startedAt = Date.now();
    writeFileSync(join(cwd, 'out', 'plot.png'), 'png');
    writeFileSync(join(cwd, 'report.md'), '# r');
    const old = join(cwd, 'old.txt');
    writeFileSync(old, 'old');
    utimesSync(old, new Date(startedAt - 60_000), new Date(startedAt - 60_000));
    writeFileSync(join(dir, 'outside.txt'), 'x');
    const found = findArtifacts({
      cwd,
      startedAt,
      tools: [
        { id: '1', name: 'Write', input: { file_path: join(cwd, 'out', 'plot.png') }, output: 'ok' },
        { id: '2', name: 'Write', input: { file_path: join(cwd, 'missing.png') }, isError: true },
      ],
      text: `生成了 \`./report.md\`, 旧文件 ${old}, 外部 ${join(dir, 'outside.txt')} 和目录 ${cwd}/out`,
    });
    expect(found).toEqual([join(cwd, 'out', 'plot.png'), join(cwd, 'report.md')]);
    expect(artifactLabel(found[0]!, cwd)).toBe('out/plot.png');
  });

  it('skips empty files and returns nothing without cwd', () => {
    writeFileSync(join(cwd, 'empty.txt'), '');
    expect(findArtifacts({ cwd, startedAt: 0, tools: [], text: `${cwd}/empty.txt` })).toEqual([]);
    expect(findArtifacts({ startedAt: 0, tools: [], text: '/etc/hosts' })).toEqual([]);
  });

  it('maps extensions to Feishu upload kinds', () => {
    expect(uploadKind('a.PNG', 100)).toEqual({ kind: 'image' });
    expect(uploadKind('a.png', 11 * 1024 * 1024)).toEqual({ kind: 'file', fileType: 'stream' });
    expect(uploadKind('a.pdf', 1)).toEqual({ kind: 'file', fileType: 'pdf' });
    expect(uploadKind('a.xlsx', 1)).toEqual({ kind: 'file', fileType: 'xls' });
    expect(uploadKind('a.ts', 1)).toEqual({ kind: 'file', fileType: 'stream' });
  });
});

describe('artifact send-back button', () => {
  it('offers found artifacts on the final card and uploads only when the initiator clicks', async () => {
    const store = new BindingStore(join(dir, 'wb-bot.db'));
    store.setCurrentCwd('default', 'u1', 't1', cwd);
    const target = join(cwd, 'chart.png');
    const agent: AgentAdapter = {
      id: 'codex',
      displayName: 'Codex',
      async isAvailable() { return true; },
      async getCapabilities() { return {} as never; },
      run(): AgentRun {
        return {
          events: {
            async *[Symbol.asyncIterator]() {
              yield { type: 'tool_use' as const, id: 't1', name: 'Write', input: { file_path: target } };
              writeFileSync(target, 'png-bytes');
              yield { type: 'tool_result' as const, id: 't1', output: 'ok', isError: false };
              yield { type: 'text' as const, delta: 'done, see chart.png' };
              yield { type: 'done' as const };
            },
          },
          async stop() {},
          async waitForExit() { return true; },
        };
      },
    };
    const updates: Array<Record<string, unknown>> = [];
    const sendLocalFile = vi.fn(async () => {});
    const handler = new EventHandler(new DefaultAgentRegistry([{ agent, command: 'codex' }]), store, {
      async replyCard() { return 'card-1'; },
      async updateCard(_id, card) { updates.push(card); },
      async replyText() { return 'text-1'; },
      sendLocalFile,
    }, cwd);
    try {
      await handler.handleMessage({ eventId: 'e1', userOpenId: 'u1', threadId: 't1', messageId: 'om_1', text: 'draw a chart' });
      await vi.waitFor(() => expect(JSON.stringify(updates.at(-1))).toContain('发送 chart.png'));
      expect(JSON.stringify(updates.at(-1))).toContain('📎 本轮产物: `chart.png`');

      const click = (userOpenId: string, eventId: string) =>
        handler.handleCardAction({ eventId, userOpenId, threadId: 'chat', messageId: 'card-1', action: 'send_artifact', artifactIndex: 0 });
      expect(await click('u2', 'x1')).toEqual({ toast: { type: 'error', content: '只有发起人可以发送产物' } });
      expect(await click('u1', 'x2')).toEqual({ toast: { type: 'success', content: '正在发送 chart.png' } });
      await vi.waitFor(() => expect(sendLocalFile).toHaveBeenCalledWith('om_1', target));
      expect(await click('u1', 'x3')).toEqual({ toast: { type: 'info', content: '已经发送过了' } });
    } finally {
      handler.dispose();
      store.close();
    }
  });
});
