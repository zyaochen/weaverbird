import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommentEvent } from '@larksuiteoapi/node-sdk';
import { FeishuApiError } from '../../apps/wb-bot/src/feishu/card-transport.js';
import { DocCommentChannel, stripMarkdown, type CommentThread, type DocCommentApi } from '../../apps/wb-bot/src/feishu/doc-comment.js';
import { EventHandler } from '../../apps/wb-bot/src/feishu/event-handler.js';
import { BindingStore } from '../../apps/wb-bot/src/binding/store.js';
import { DefaultAgentRegistry } from '../../packages/core/src/agent/registry.js';
import type { AgentAdapter, AgentRun, RunRequest } from '../../packages/core/src/index.js';

const text = (value: string) => ({ elements: [{ type: 'text_run', text_run: { text: value } }] });

function event(patch: Partial<CommentEvent> = {}): CommentEvent {
  return { fileToken: 'doxcn1', fileType: 'docx', commentId: 'c1', replyId: 'r2', operator: { openId: 'ou_user' }, mentionedBot: true, timestamp: 0, ...patch };
}

function fakeApi(thread: CommentThread, overrides: Partial<DocCommentApi> = {}) {
  const calls: string[] = [];
  const api: DocCommentApi = {
    async getThread() { calls.push('get'); return thread; },
    async replyInThread(_f, _t, _c, body) { calls.push(`reply:${body}`); return 'r-bot'; },
    async createComment(_f, _t, body) { calls.push(`create:${body}`); return 'r-new'; },
    async setTyping(_f, _t, replyId, on) { calls.push(`typing:${replyId}:${on}`); },
    ...overrides,
  };
  return { api, calls };
}

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const thread: CommentThread = {
  quote: '选中的\n一段话',
  isWhole: false,
  replies: [
    { reply_id: 'r1', content: text('这段是不是写错了') },
    { reply_id: 'r2', content: text(' 帮我看下') },
  ],
};

describe('DocCommentChannel', () => {
  it('runs the thread as input, reacts while working and replies in thread as plain text', async () => {
    const { api, calls } = fakeApi(thread);
    const run = vi.fn(async () => ({ text: '## 结论\n**没写错**, 见 `foo`' }));
    const channel = new DocCommentChannel({ api, botOpenId: 'ou_bot', run, logger });
    await channel.handle(event());
    expect(run).toHaveBeenCalledWith({
      userOpenId: 'ou_user',
      threadId: 'doc:doxcn1',
      prompt: '> 云文档评论 · https://feishu.cn/docx/doxcn1\n> 选中原文: 选中的 一段话\n> 评论线程:\n> - 这段是不是写错了\n\n帮我看下',
    });
    expect(calls).toEqual(['get', 'typing:r2:true', 'reply:结论\n没写错, 见 foo', 'typing:r2:false']);
  });

  it('ignores unmentioned, self-authored, own-reply and repeated events', async () => {
    const { api, calls } = fakeApi(thread);
    const run = vi.fn(async () => ({ text: 'ok' }));
    const channel = new DocCommentChannel({ api, botOpenId: 'ou_bot', run, logger });
    await channel.handle(event({ mentionedBot: false }));
    await channel.handle(event({ operator: { openId: 'ou_bot' } }));
    await channel.handle(event({ fileType: 'bitable' }));
    await channel.handle(event());
    await channel.handle(event());
    await channel.handle(event({ replyId: 'r-bot' }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(calls.filter((call) => call === 'get')).toHaveLength(1);
  });

  it('falls back to a new comment for whole-document comments and reports agent errors', async () => {
    const { api, calls } = fakeApi(thread, {
      async replyInThread() { throw new FeishuApiError('drive.fileCommentReply.create', 1069302, 'whole comment'); },
    });
    const channel = new DocCommentChannel({ api, botOpenId: 'ou_bot', run: async () => ({ text: '', error: '上一条还在处理, 请稍后再 @ 我' }), logger });
    await channel.handle(event());
    expect(calls).toContain('create:⚠️ 上一条还在处理, 请稍后再 @ 我');
  });

  it('strips common markdown for the plain-text comment box', () => {
    expect(stripMarkdown('# T\n- a\n> q\n```ts\ncode\n```\n[link](https://x)')).toBe('T\n• a\nq\ncode\nlink (https://x)');
  });
});

describe('EventHandler.runHeadless', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wb-headless-'));
    vi.stubEnv('WB_DATA_DIR', dir);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it('runs the bound agent with doc-scoped continuation and refuses overlapping runs', async () => {
    const store = new BindingStore(join(dir, 'wb-bot.db'));
    const requests: RunRequest[] = [];
    let release: (() => void) | null = null;
    const agent: AgentAdapter = {
      id: 'codex',
      displayName: 'Codex',
      async isAvailable() { return true; },
      async getCapabilities() { return {} as never; },
      run(req): AgentRun {
        requests.push(req);
        return {
          events: {
            async *[Symbol.asyncIterator]() {
              await new Promise<void>((resolve) => { release = resolve; });
              yield { type: 'text' as const, delta: 'answer' };
              yield { type: 'done' as const, continuationToken: 'tok-doc' };
            },
          },
          async stop() {},
          async waitForExit() { return true; },
        };
      },
    };
    const handler = new EventHandler(new DefaultAgentRegistry([{ agent, command: 'codex' }]), store, {
      async replyCard() { return 'r'; },
      async updateCard() {},
      async replyText() { return 't'; },
    }, dir);
    try {
      const first = handler.runHeadless({ userOpenId: 'ou_user', threadId: 'doc:doxcn1', prompt: 'q1' });
      await vi.waitFor(() => expect(release).not.toBeNull());
      expect(await handler.runHeadless({ userOpenId: 'ou_user', threadId: 'doc:doxcn1', prompt: 'q2' }))
        .toEqual({ text: '', error: '上一条还在处理, 请稍后再 @ 我' });
      release!();
      expect(await first).toEqual({ text: 'answer' });
      expect(requests[0]).toMatchObject({ prompt: 'q1', cwd: dir });
      expect(store.getContinuation('default', 'ou_user', 'doc:doxcn1', 'codex')).toBe('tok-doc');
    } finally {
      handler.dispose();
      store.close();
    }
  });
});
