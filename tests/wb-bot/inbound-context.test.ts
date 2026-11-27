import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildAgentInput } from '../../apps/wb-bot/src/feishu/inbound-context.js';
import { MediaCache } from '../../apps/wb-bot/src/feishu/media-cache.js';
import { buildAgentArgs, EventHandler } from '../../apps/wb-bot/src/feishu/event-handler.js';
import { BindingStore } from '../../apps/wb-bot/src/binding/store.js';
import { DefaultAgentRegistry } from '../../packages/core/src/agent/registry.js';
import { CodexAgent } from '../../packages/core/src/agent/codex.js';
import { promptWithLocalFiles } from '../../packages/core/src/agent/claude-code.js';
import type { AgentAdapter, AgentRun, RunRequest } from '../../packages/core/src/index.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

let dir = '';
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'wb-inbound-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('MediaCache', () => {
  it('stores by content hash with a sniffed extension and dedups repeats', async () => {
    const download = vi.fn(async () => PNG);
    const cache = new MediaCache({ rootDir: dir, download });
    const first = await cache.resolve('om_1', [{ type: 'image', fileKey: 'img_1' }]);
    const second = await cache.resolve('om_2', [{ type: 'image', fileKey: 'img_2' }]);
    expect(download).toHaveBeenCalledWith('om_1', 'img_1', 'image');
    expect(first.resolved[0]!.path).toMatch(/\.png$/);
    expect(second.resolved[0]!.path).toBe(first.resolved[0]!.path);
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it('keeps the file extension from the file name and downloads files as type=file', async () => {
    const download = vi.fn(async () => Buffer.from('log line'));
    const cache = new MediaCache({ rootDir: dir, download });
    const { resolved } = await cache.resolve('om_1', [{ type: 'file', fileKey: 'file_1', fileName: 'Trace.LOG' }]);
    expect(download).toHaveBeenCalledWith('om_1', 'file_1', 'file');
    expect(resolved[0]!.path).toMatch(/\.log$/);
  });

  it('reports oversize and failed downloads instead of throwing', async () => {
    const cache = new MediaCache({
      rootDir: dir,
      maxFileBytes: 4,
      download: async (_m, key) => {
        if (key === 'bad') throw new Error('403');
        return Buffer.from('0123456789');
      },
    });
    const { resolved, failures } = await cache.resolve('om_1', [
      { type: 'file', fileKey: 'big', fileName: 'big.bin' },
      { type: 'file', fileKey: 'bad' },
      { type: 'sticker', fileKey: 'stk' },
    ]);
    expect(resolved).toEqual([]);
    expect(failures.map((f) => f.resource.fileKey)).toEqual(['big', 'bad']);
    expect(failures[0]!.reason).toContain('上限');
    expect(failures[1]!.reason).toContain('403');
  });

  it('evicts the oldest files once the directory exceeds the total budget', async () => {
    const old = join(dir, 'old.bin');
    writeFileSync(old, Buffer.alloc(8));
    utimesSync(old, new Date(1_000), new Date(1_000));
    const cache = new MediaCache({ rootDir: dir, maxTotalBytes: 12, download: async () => PNG });
    const { resolved } = await cache.resolve('om_1', [{ type: 'image', fileKey: 'img' }]);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(resolved[0]!.path)).toBe(true);
  });
});

describe('buildAgentInput', () => {
  it('replaces resource keys with local paths and splits images from attachments', async () => {
    const media = new MediaCache({
      rootDir: dir,
      download: async (_m, key) => (key === 'img_1' ? PNG : Buffer.from('pdf')),
    });
    const input = await buildAgentInput({
      messageId: 'om_1',
      text: '看图 ![image](img_1) 和 <file key="file_1" name="a.pdf"/>',
      resources: [{ type: 'image', fileKey: 'img_1' }, { type: 'file', fileKey: 'file_1', fileName: 'a.pdf' }],
    }, { botOpenId: '', media });
    expect(input.images).toHaveLength(1);
    expect(input.attachments).toHaveLength(1);
    expect(input.text).toContain(`![image](${input.images[0]})`);
    expect(input.text).toContain(`<file path="${input.attachments[0]}" name="a.pdf"/>`);
    expect(input.text).not.toContain('img_1');
    expect(input.notices).toEqual([]);
  });

  it('prefixes the quoted parent message and localizes its resources', async () => {
    const fetchMessage = vi.fn(async () => [
      { message_id: 'om_parent', msg_type: 'image', body: { content: JSON.stringify({ image_key: 'img_p' }) } },
    ]);
    const media = new MediaCache({ rootDir: dir, download: async () => PNG });
    const input = await buildAgentInput({ messageId: 'om_1', text: '这张图什么意思', parentId: 'om_parent' }, { botOpenId: '', fetchMessage, media });
    expect(fetchMessage).toHaveBeenCalledWith('om_parent');
    expect(input.text.startsWith('> 引用消息:\n> ![image](')).toBe(true);
    expect(input.text.endsWith('\n\n这张图什么意思')).toBe(true);
    expect(input.images).toHaveLength(1);
  });

  it('surfaces quote and download problems as notices', async () => {
    const input = await buildAgentInput({
      messageId: 'om_1',
      text: 'hi',
      parentId: 'om_gone',
      resources: [{ type: 'image', fileKey: 'img_1' }],
    }, { botOpenId: '', fetchMessage: async () => { throw new Error('230002'); } });
    expect(input.text).toBe('hi');
    expect(input.notices).toEqual([
      '引用的消息读取失败: 230002',
      '1 个附件未下载: 当前通道不支持下载资源',
    ]);
  });
});

describe('agent argv for local files', () => {
  it('codex wb-runner argv puts --image right after the subcommand', () => {
    expect(buildAgentArgs('codex', 'p', '/tmp', undefined, undefined, undefined, ['/a.png', '/b.png']))
      .toEqual(['exec', '--image', '/a.png', '--image', '/b.png', '--json', '--skip-git-repo-check', '-']);
    expect(buildAgentArgs('codex', 'p', '/tmp', 'tok', undefined, 'gpt-x', ['/a.png']))
      .toEqual(['exec', 'resume', '--image', '/a.png', '--json', '--model', 'gpt-x', '--skip-git-repo-check', 'tok', '-']);
  });

  it('codex adapter consumes RunRequest.images', () => {
    const agent = new CodexAgent() as unknown as { buildProcessSpec(req: RunRequest): { args: string[] } };
    expect(agent.buildProcessSpec({ prompt: 'p', images: ['/a.png'] }).args)
      .toEqual(['exec', '--image', '/a.png', '--json', '--skip-git-repo-check', '-']);
  });

  it('claude prompt lists files that are not already in the prompt', () => {
    expect(promptWithLocalFiles({ prompt: 'see /a.png', images: ['/a.png'], attachments: ['/b.pdf'] }))
      .toBe('see /a.png\n\n附件: /b.pdf');
    expect(promptWithLocalFiles({ prompt: 'plain' })).toBe('plain');
  });
});

describe('EventHandler inbound wiring', () => {
  it('downloads resources before the run and passes local paths to the agent', async () => {
    vi.stubEnv('WB_DATA_DIR', dir);
    const store = new BindingStore(join(dir, 'wb-bot.db'));
    const requests: RunRequest[] = [];
    const agent: AgentAdapter = {
      id: 'codex',
      displayName: 'Codex',
      async isAvailable() { return true; },
      async getCapabilities() { return {} as never; },
      run(req: RunRequest): AgentRun {
        requests.push(req);
        return {
          events: { async *[Symbol.asyncIterator]() { yield { type: 'done' as const }; } },
          async stop() {},
          async waitForExit() { return true; },
        };
      },
    };
    const cards: Array<Record<string, unknown>> = [];
    const handler = new EventHandler(new DefaultAgentRegistry([{ agent, command: 'codex' }]), store, {
      async replyCard(_m, card) { cards.push(card); return 'reply-1'; },
      async updateCard(_m, card) { cards.push(card); },
      async replyText() { return 'text-1'; },
      async downloadResource() { return PNG; },
    }, dir);
    try {
      await handler.handleMessage({
        eventId: 'e1', userOpenId: 'u1', threadId: 't1', messageId: 'om_1',
        text: '![image](img_1)', resources: [{ type: 'image', fileKey: 'img_1' }],
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]!.images).toHaveLength(1);
      expect(requests[0]!.images![0]).toContain(join(dir, 'media'));
      expect(requests[0]!.prompt).toBe(`![image](${requests[0]!.images![0]})`);
    } finally {
      handler.dispose();
      store.close();
      vi.unstubAllEnvs();
    }
  });
});
