import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BindingStore } from '../../apps/wb-bot/src/binding/store.js';

let dir = '';
let store: BindingStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wb-bot-store-'));
  store = new BindingStore(join(dir, 'wb-bot.db'));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('binding store', () => {
  it('persists thread binding and per-agent continuations independently', () => {
    store.upsertThreadBinding('default', { userOpenId: 'u1', threadId: 't1', agentId: 'claude-code', cwd: '/tmp/a' });
    store.upsertContinuation('default', 'u1', 't1', 'claude-code', 'claude-token');
    store.upsertContinuation('default', 'u1', 't1', 'codex', 'codex-token');
    store.setCurrentAgent('default', 'u1', 't1', 'codex');

    expect(store.getThreadBinding('default', 'u1', 't1')).toEqual({ userOpenId: 'u1', threadId: 't1', agentId: 'codex', cwd: '/tmp/a' });
    expect(store.getContinuation('default', 'u1', 't1', 'claude-code')).toBe('claude-token');
    expect(store.getContinuation('default', 'u1', 't1', 'codex')).toBe('codex-token');
  });

  it('stores cwd aliases', () => {
    store.setAlias('u1', 'work', '/tmp/work');
    store.setAlias('u1', 'code', '/tmp/code');
    expect(store.listAliases('u1')).toEqual([
      { name: 'code', path: '/tmp/code' },
      { name: 'work', path: '/tmp/work' },
    ]);
    expect(store.removeAlias('u1', 'work')).toBe(true);
    expect(store.removeAlias('u1', 'work')).toBe(false);
  });

  it('tracks in-flight cards by (thread, agent)', () => {
    store.upsertInflightCard('default', {
      userOpenId: 'u1',
      threadId: 't1',
      sourceMessageId: 'm1',
      replyMessageId: 'reply-1',
      agentId: 'claude-code',
    });
    store.upsertInflightCard('default', {
      userOpenId: 'u1',
      threadId: 't2',
      sourceMessageId: 'm2',
      replyMessageId: 'reply-2',
      agentId: 'claude-code',
    });

    expect(store.getInflightCard('default', 'u1', 't1', 'claude-code')).toEqual({
      userOpenId: 'u1',
      threadId: 't1',
      sourceMessageId: 'm1',
      replyMessageId: 'reply-1',
      agentId: 'claude-code',
    });
    expect(store.listInflightCards('default')).toEqual([
      { userOpenId: 'u1', threadId: 't1', sourceMessageId: 'm1', replyMessageId: 'reply-1', agentId: 'claude-code' },
      { userOpenId: 'u1', threadId: 't2', sourceMessageId: 'm2', replyMessageId: 'reply-2', agentId: 'claude-code' },
    ]);
    expect(store.clearInflightCard('default', 'u1', 't1', 'claude-code')).toBe(true);
    expect(store.getInflightCard('default', 'u1', 't1', 'claude-code')).toBeNull();
    expect(store.clearInflightCard('default', 'u1', 't1', 'claude-code')).toBe(false);
  });
});
