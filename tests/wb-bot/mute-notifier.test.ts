import { describe, expect, it } from 'vitest';
import { createCardApprovalNotifier } from '../../apps/wb-bot/src/approval-gate/notifier.js';
import { MuteRegistry } from '../../packages/core/src/reverse-channel/index.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ApprovalRequestRecord } from '../../packages/core/src/approval-gate/contracts.js';

function mkRequest(overrides: Partial<ApprovalRequestRecord> = {}): ApprovalRequestRecord {
  const base: ApprovalRequestRecord = {
    requestId: 'req-1',
    runId: 'run-1',
    sessionId: 'bot:u:thread-1',
    anchor: 'writeToMainBranch',
    userOpenId: 'u-1',
    threadId: 'thread-1',
    replyMessageId: 'msg-1',
    sourceMessageId: 'src-1',
    carrier: 'group_card',
    status: 'pending_approval',
    createdAt: '2026-08-13T10:00:00.000Z',
  } as unknown as ApprovalRequestRecord;
  return { ...base, ...overrides };
}

describe('createCardApprovalNotifier + MuteRegistry', () => {
  it('命中 mute → skip sendCard (卡片本身仍在, 但不再额外 ping owner)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-notify-mute-'));
    try {
      const registry = new MuteRegistry(join(dir, 'mute.json'));
      registry.mute('bot:u:thread-1', '1h', { nowIso: '2026-08-13T10:00:00.000Z' });
      const sendCardCalls: string[] = [];
      const notifier = createCardApprovalNotifier({
        sendCard: async (chatId) => {
          sendCardCalls.push(chatId);
        },
        cardFor: () => ({ ok: true }),
        resolveChatId: (r) => r.threadId,
        muteRegistry: registry,
      });
      await notifier.notifyApprovers(mkRequest());
      expect(sendCardCalls).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('未静音 → 正常 sendCard 一次 (notifyOncePerRequest)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-notify-mute-'));
    try {
      const registry = new MuteRegistry(join(dir, 'mute.json'));
      const sendCardCalls: string[] = [];
      const notifier = createCardApprovalNotifier({
        sendCard: async (chatId) => {
          sendCardCalls.push(chatId);
        },
        cardFor: () => ({ ok: true }),
        resolveChatId: (r) => r.threadId,
        muteRegistry: registry,
      });
      const req = mkRequest();
      await notifier.notifyApprovers(req);
      await notifier.notifyApprovers(req); // idempotent
      expect(sendCardCalls).toEqual(['thread-1']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('静音对不同 sessionId 不影响', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-notify-mute-'));
    try {
      const registry = new MuteRegistry(join(dir, 'mute.json'));
      registry.mute('bot:u:other-thread', '1h', { nowIso: '2026-08-13T10:00:00.000Z' });
      const sendCardCalls: string[] = [];
      const notifier = createCardApprovalNotifier({
        sendCard: async (chatId) => {
          sendCardCalls.push(chatId);
        },
        cardFor: () => ({ ok: true }),
        resolveChatId: (r) => r.threadId,
        muteRegistry: registry,
      });
      await notifier.notifyApprovers(mkRequest()); // sessionId = bot:u:thread-1 未静音
      expect(sendCardCalls).toEqual(['thread-1']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
