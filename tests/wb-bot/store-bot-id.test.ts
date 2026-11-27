import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BindingStore } from '../../apps/wb-bot/src/binding/store.js';

let dir = '';
let store: BindingStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wb-bot-store-botid-'));
  store = new BindingStore(join(dir, 'wb-bot.db'));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('BindingStore botId isolation', () => {
  it('thread bindings are isolated by botId', () => {
    store.upsertThreadBinding('bot-a', { userOpenId: 'u1', threadId: 't1', agentId: 'claude-code', cwd: '/a' });
    store.upsertThreadBinding('bot-b', { userOpenId: 'u1', threadId: 't1', agentId: 'codex', cwd: '/b' });

    const a = store.getThreadBinding('bot-a', 'u1', 't1');
    const b = store.getThreadBinding('bot-b', 'u1', 't1');
    expect(a?.agentId).toBe('claude-code');
    expect(a?.cwd).toBe('/a');
    expect(b?.agentId).toBe('codex');
    expect(b?.cwd).toBe('/b');
  });

  it('continuations are isolated by botId', () => {
    store.upsertContinuation('bot-a', 'u1', 't1', 'claude-code', 'token-a');
    store.upsertContinuation('bot-b', 'u1', 't1', 'claude-code', 'token-b');

    expect(store.getContinuation('bot-a', 'u1', 't1', 'claude-code')).toBe('token-a');
    expect(store.getContinuation('bot-b', 'u1', 't1', 'claude-code')).toBe('token-b');
  });

  it('clearContinuation only affects the target botId', () => {
    store.upsertContinuation('bot-a', 'u1', 't1', 'claude-code', 'tok-a');
    store.upsertContinuation('bot-b', 'u1', 't1', 'claude-code', 'tok-b');

    expect(store.clearContinuation('bot-a', 'u1', 't1', 'claude-code')).toBe(true);
    expect(store.getContinuation('bot-a', 'u1', 't1', 'claude-code')).toBeNull();
    expect(store.getContinuation('bot-b', 'u1', 't1', 'claude-code')).toBe('tok-b');
  });

  it('inflight cards are isolated by botId', () => {
    store.upsertInflightCard('bot-a', {
      userOpenId: 'u1', threadId: 't1', sourceMessageId: 'sa', replyMessageId: 'ra', agentId: 'claude-code',
    });
    store.upsertInflightCard('bot-b', {
      userOpenId: 'u1', threadId: 't1', sourceMessageId: 'sb', replyMessageId: 'rb', agentId: 'claude-code',
    });

    expect(store.getInflightCard('bot-a', 'u1', 't1', 'claude-code')?.replyMessageId).toBe('ra');
    expect(store.getInflightCard('bot-b', 'u1', 't1', 'claude-code')?.replyMessageId).toBe('rb');
  });

  it('listInflightCards filters by botId', () => {
    store.upsertInflightCard('bot-a', { userOpenId: 'u1', threadId: 't1', sourceMessageId: 'sa', replyMessageId: 'ra', agentId: 'claude-code' });
    store.upsertInflightCard('bot-b', { userOpenId: 'u1', threadId: 't2', sourceMessageId: 'sb', replyMessageId: 'rb', agentId: 'claude-code' });

    expect(store.listInflightCards('bot-a')).toHaveLength(1);
    expect(store.listInflightCards('bot-b')).toHaveLength(1);
    expect(store.listInflightCards('bot-c')).toHaveLength(0);
  });

  it('clearInflightCard only affects the target botId', () => {
    store.upsertInflightCard('bot-a', { userOpenId: 'u1', threadId: 't1', sourceMessageId: 'sa', replyMessageId: 'ra', agentId: 'claude-code' });
    store.upsertInflightCard('bot-b', { userOpenId: 'u1', threadId: 't1', sourceMessageId: 'sb', replyMessageId: 'rb', agentId: 'claude-code' });

    expect(store.clearInflightCard('bot-a', 'u1', 't1', 'claude-code')).toBe(true);
    expect(store.getInflightCard('bot-a', 'u1', 't1', 'claude-code')).toBeNull();
    expect(store.getInflightCard('bot-b', 'u1', 't1', 'claude-code')?.replyMessageId).toBe('rb');
  });

  it('setCurrentAgent is isolated by botId', () => {
    store.upsertThreadBinding('bot-a', { userOpenId: 'u1', threadId: 't1', agentId: 'claude-code', cwd: '/a' });
    store.upsertThreadBinding('bot-b', { userOpenId: 'u1', threadId: 't1', agentId: 'claude-code', cwd: '/b' });

    store.setCurrentAgent('bot-a', 'u1', 't1', 'codex');

    expect(store.getThreadBinding('bot-a', 'u1', 't1')?.agentId).toBe('codex');
    expect(store.getThreadBinding('bot-b', 'u1', 't1')?.agentId).toBe('claude-code');
  });

  it('setCurrentCwd is isolated by botId', () => {
    store.upsertThreadBinding('bot-a', { userOpenId: 'u1', threadId: 't1', agentId: 'claude-code', cwd: '/a' });
    store.upsertThreadBinding('bot-b', { userOpenId: 'u1', threadId: 't1', agentId: 'claude-code', cwd: '/b' });

    store.setCurrentCwd('bot-a', 'u1', 't1', '/new-a');

    expect(store.getThreadBinding('bot-a', 'u1', 't1')?.cwd).toBe('/new-a');
    expect(store.getThreadBinding('bot-b', 'u1', 't1')?.cwd).toBe('/b');
  });

  it('W2 compat: botId=default works identically to pre-W2.5', () => {
    store.upsertThreadBinding('default', { userOpenId: 'u1', threadId: 't1', agentId: 'claude-code', cwd: '/tmp' });
    store.upsertContinuation('default', 'u1', 't1', 'claude-code', 'tok-1');
    store.upsertInflightCard('default', { userOpenId: 'u1', threadId: 't1', sourceMessageId: 'm1', replyMessageId: 'r1', agentId: 'claude-code' });

    expect(store.getThreadBinding('default', 'u1', 't1')?.agentId).toBe('claude-code');
    expect(store.getContinuation('default', 'u1', 't1', 'claude-code')).toBe('tok-1');
    expect(store.getInflightCard('default', 'u1', 't1', 'claude-code')?.replyMessageId).toBe('r1');
    expect(store.listInflightCards('default')).toHaveLength(1);

    expect(store.clearInflightCard('default', 'u1', 't1', 'claude-code')).toBe(true);
    expect(store.clearContinuation('default', 'u1', 't1', 'claude-code')).toBe(true);
  });
});
