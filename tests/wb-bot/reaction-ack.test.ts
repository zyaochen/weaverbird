import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AckReactions } from '../../apps/wb-bot/src/feishu/reaction.js';
import { EventHandler } from '../../apps/wb-bot/src/feishu/event-handler.js';
import { BindingStore } from '../../apps/wb-bot/src/binding/store.js';
import { DefaultAgentRegistry } from '../../packages/core/src/agent/registry.js';
import type { AgentAdapter, AgentRun } from '../../packages/core/src/index.js';

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wb-ack-'));
  vi.stubEnv('WB_DATA_DIR', dir);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('AckReactions', () => {
  it('adds once per message and removes by the returned reaction id', async () => {
    const addReaction = vi.fn(async () => 'r-1');
    const removeReaction = vi.fn(async () => {});
    const acks = new AckReactions({ addReaction, removeReaction });
    acks.add('om_1');
    acks.add('om_1');
    await acks.clear('om_1');
    expect(addReaction).toHaveBeenCalledTimes(1);
    expect(addReaction).toHaveBeenCalledWith('om_1', 'Typing');
    expect(removeReaction).toHaveBeenCalledWith('om_1', 'r-1');
    expect(acks.has('om_1')).toBe(false);
  });

  it('swallows add/remove failures', async () => {
    const acks = new AckReactions({
      addReaction: async () => { throw new Error('99991672 no scope'); },
      removeReaction: async () => { throw new Error('unreachable'); },
    });
    acks.add('om_1');
    await expect(acks.clear('om_1')).resolves.toBeUndefined();
  });

  it('is a no-op when the client has no reaction support', async () => {
    const acks = new AckReactions({});
    acks.add('om_1');
    expect(acks.has('om_1')).toBe(false);
    await expect(acks.clear('om_1')).resolves.toBeUndefined();
  });
});

describe('EventHandler ack reaction', () => {
  it('reacts before the run card and clears after the run ends; commands get no reaction', async () => {
    const store = new BindingStore(join(dir, 'wb-bot.db'));
    const order: string[] = [];
    const agent: AgentAdapter = {
      id: 'codex',
      displayName: 'Codex',
      async isAvailable() { return true; },
      async getCapabilities() { return {} as never; },
      run(): AgentRun {
        return {
          events: { async *[Symbol.asyncIterator]() { yield { type: 'done' as const }; } },
          async stop() {},
          async waitForExit() { return true; },
        };
      },
    };
    const handler = new EventHandler(new DefaultAgentRegistry([{ agent, command: 'codex' }]), store, {
      async replyCard() { order.push('replyCard'); return 'reply-1'; },
      async updateCard() {},
      async replyText() { return 'text-1'; },
      async addReaction(messageId) { order.push(`add:${messageId}`); return `r-${messageId}`; },
      async removeReaction(messageId, reactionId) { order.push(`remove:${messageId}:${reactionId}`); },
    }, dir);
    try {
      await handler.handleMessage({ eventId: 'e1', userOpenId: 'u1', threadId: 't1', messageId: 'om_1', text: 'hello' });
      await vi.waitFor(() => expect(order).toContain('remove:om_1:r-om_1'));
      expect(order.indexOf('add:om_1')).toBeLessThan(order.indexOf('replyCard'));

      order.length = 0;
      await handler.handleMessage({ eventId: 'e2', userOpenId: 'u1', threadId: 't1', messageId: 'om_2', text: '/help' });
      expect(order).toEqual(['replyCard']);
    } finally {
      handler.dispose();
      store.close();
    }
  });
});
