import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BindingStore } from '../../../apps/wb-bot/src/binding/store.js';
import { buildVThreadCases, V_THREAD_CASE_IDS } from './cases.js';
import { clearTrackedStoreRows, loadVThreadHarnessConfig, readTopicSnapshot, runVThreadSuite } from './harness.js';

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function mkRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'wb-v-thread-'));
  roots.push(root);
  return root;
}

describe('v-thread e2e harness', () => {
  it('pins the latest E1-E7 matrix and keeps the first egress on the owner message send path', () => {
    const cases = buildVThreadCases();
    expect(cases.map((item) => item.id)).toEqual([...V_THREAD_CASE_IDS]);
    expect(cases[0]?.firstEgressSurface).toContain('+messages-send');
    expect(cases[5]?.mode).toBe('manual');
  });

  it('blocks before the first real egress until owner chat+identity confirmation is present', async () => {
    const cliRunner = vi.fn(async () => {
      throw new Error('lark-cli must not run before the owner confirmation gate is open');
    });
    const result = await runVThreadSuite({
      WB_DATA_DIR: '/tmp/weaverbird-v-thread',
      WB_VTHREAD_E2E_CHAT_ID: 'oc_vthread_test',
      WB_VTHREAD_E2E_CHAT_ALLOWLIST: 'oc_vthread_test',
      WB_VTHREAD_E2E_OWNER_OPEN_ID: 'ou_owner',
      WB_VTHREAD_E2E_OWNER_LABEL: 'owner-uat',
    }, {
      cliRunner,
      now: () => new Date('2026-07-10T08:30:00.000Z'),
      sleep: async () => undefined,
    });

    expect(result.status).toBe('blocked');
    expect(result.stopPoint).toBe('before_first_real_egress');
    expect(result.reason).toContain('owner confirmation missing');
    expect(result.caseResults).toHaveLength(7);
    expect(result.caseResults.every((item) => item.status === 'blocked')).toBe(true);
    expect(cliRunner).not.toHaveBeenCalled();
  });

  it('derives allowlist and owner confirmation flags from env input', () => {
    const config = loadVThreadHarnessConfig({
      BOT_ID: 'default',
      WB_DATA_DIR: '/tmp/weaverbird-v-thread',
      WB_VTHREAD_E2E_CHAT_ID: 'oc_vthread_test',
      WB_VTHREAD_E2E_CHAT_ALLOWLIST: 'oc_other, oc_vthread_test',
      WB_VTHREAD_E2E_OWNER_OPEN_ID: 'ou_owner',
      WB_VTHREAD_E2E_OWNER_LABEL: 'owner-uat',
      WB_VTHREAD_E2E_CONFIRM_CHAT_ID: 'oc_vthread_test',
      WB_VTHREAD_E2E_CONFIRM_ACTOR: 'owner-uat',
    }, new Date('2026-07-10T08:30:00.000Z'));

    expect(config.chatAllowlist.has('oc_vthread_test')).toBe(true);
    expect(config.allowRealEgress).toBe(true);
    expect(config.runTag).toBe('20260710083000');
  });

  it('cleans only tracked store rows and preserves unrelated user/topic state', () => {
    const root = mkRoot();
    const dbPath = join(root, 'wb-bot.db');
    const store = new BindingStore(dbPath);
    try {
      store.upsertThreadBinding('default', {
        userOpenId: 'ou_owner',
        threadId: 'root:om_root',
        agentId: 'claude-code',
        cwd: '/repo',
      });
      store.upsertContinuation('default', 'ou_owner', 'root:om_root', 'claude-code', 'tok-owner');
      store.upsertInflightCard('default', {
        userOpenId: 'ou_owner',
        threadId: 'root:om_root',
        sourceMessageId: 'om_root',
        replyMessageId: 'om_card',
        agentId: 'claude-code',
        runId: 'run-owner',
      });
      store.upsertThreadAlias('default', 'ou_owner', 'chat:oc_test', 'root:om_root');

      store.upsertThreadBinding('default', {
        userOpenId: 'ou_other',
        threadId: 'root:om_other',
        agentId: 'claude-code',
        cwd: '/keep',
      });
      store.upsertContinuation('default', 'ou_other', 'root:om_other', 'claude-code', 'tok-other');
    } finally {
      store.close();
    }

    const cleanup = clearTrackedStoreRows(dbPath, [{
      botId: 'default',
      userOpenId: 'ou_owner',
      threadId: 'root:om_root',
      agentId: 'claude-code',
      aliasThreadIds: ['chat:oc_test'],
    }]);

    expect(cleanup.threadBinding).toBe(1);
    expect(cleanup.continuation).toBe(1);
    expect(cleanup.inflight).toBe(1);
    expect(cleanup.alias).toBeGreaterThanOrEqual(1);

    const owner = readTopicSnapshot(dbPath, {
      botId: 'default',
      userOpenId: 'ou_owner',
      threadId: 'root:om_root',
      agentId: 'claude-code',
    });
    const other = readTopicSnapshot(dbPath, {
      botId: 'default',
      userOpenId: 'ou_other',
      threadId: 'root:om_other',
      agentId: 'claude-code',
    });

    expect(owner.binding).toBeNull();
    expect(owner.continuation).toBeNull();
    expect(owner.inflight).toBeNull();
    expect(other.binding?.threadId).toBe('root:om_other');
    expect(other.continuation).toBe('tok-other');
  });
});
