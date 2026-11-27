import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BindingStore } from '../../apps/wb-bot/src/binding/store.js';
import { EventHandler } from '../../apps/wb-bot/src/feishu/event-handler.js';
import { createInitialState } from '../../apps/wb-bot/src/feishu/stream-state.js';
import { ApprovalRequestStore } from '../../apps/wb-bot/src/approval-gate/store.js';
import { runApprovalHook } from '../../apps/wb-bot/src/approval-gate/hook-main.js';

const roots: string[] = [];

function mkRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'wb-f16b-l1-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['WB_DATA_DIR'];
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createReadonlyWriteGuards() {
  return {
    replyCard: vi.fn(async () => 'reply-approval'),
    updateCard: vi.fn(async () => undefined),
    replyText: vi.fn(async () => 'msg-1'),
    messageCreate: vi.fn(async () => { throw new Error('unexpected real egress path: message.create'); }),
    messageReply: vi.fn(async () => { throw new Error('unexpected real egress path: message.reply'); }),
    messagePatch: vi.fn(async () => { throw new Error('unexpected real egress path: message.patch'); }),
  };
}

describe('F16-b L1 harness', () => {
  it('replays writeToMainBranch fixed-config approval flow without real outbound', async () => {
    const root = mkRoot();
    process.env['WB_DATA_DIR'] = root;
    const configPath = join(root, 'approval-codeowners.json');
    writeFileSync(configPath, JSON.stringify({
      version: 1,
      repositories: [{ repoRoot: root, branches: [{ name: 'main', rules: [{ paths: ['apps/**'], codeOwnerOpenIds: ['ou_code_owner_1'] }] }] }],
    }, null, 2));
    chmodSync(configPath, 0o600);

    const gitRunner = (args: string[]) => {
      if (args.join(' ') === 'rev-parse --show-toplevel') return root;
      if (args.join(' ') === 'diff --name-only HEAD^ HEAD') return 'apps/wb-bot/src/main.ts';
      throw new Error('unexpected git call');
    };

    runApprovalHook({
      WB_DATA_DIR: root,
      WB_APPROVAL_RUN_ID: 'run-l1',
      WB_APPROVAL_BOT_ID: 'default',
      WB_APPROVAL_SESSION_ID: 'default:ou_owner:grp',
      WB_APPROVAL_USER_OPEN_ID: 'ou_owner',
      WB_APPROVAL_THREAD_ID: 'grp',
      WB_APPROVAL_SOURCE_MESSAGE_ID: 'm1',
      WB_APPROVAL_REPLY_MESSAGE_ID: 'r1',
      WB_APPROVAL_AGENT_ID: 'claude-code',
      WB_APPROVAL_CODE_OWNER_CONFIG_PATH: configPath,
    }, {
      cwd: root,
      tool_name: 'Bash',
      tool_input: { command: 'git push origin HEAD:main' },
    }, { skipWait: true, gitRunner });

    const request = new ApprovalRequestStore(root).listPending()[0];
    expect(request?.allowedApproverOpenIds).toEqual(['ou_code_owner_1', 'ou_owner']);

    const store = new BindingStore(join(root, 'wb-bot.db'));
    const feishu = createReadonlyWriteGuards();
    const handler = new EventHandler({
      register() {},
      lookup() { return null; },
      list() { return []; },
      async isAvailable() { return null; },
    }, store, feishu);

    const session = {
      scopeKey: 'ou_owner:grp:claude-code',
      sourceMessageId: 'm1',
      replyMessageId: 'r1',
      run: null,
      runId: 'run-l1',
      pipeline: { force: vi.fn(async () => undefined), flush: vi.fn(async () => undefined) },
      state: { ...createInitialState('claude-code', 'Claude Code', 'Claude Code'), cwd: root },
      extraMessageIds: [],
      startedAt: Date.now(),
      agentId: 'claude-code',
      sessionId: 'default:ou_owner:grp',
    };
    (handler as any).activeSessions.set(session.scopeKey, session);
    (handler as any).activeSessionsByMessageId.set('r1', session);

    const approved = await handler.handleCardAction({
      eventId: 'evt-approve-l1',
      userOpenId: 'ou_code_owner_1',
      threadId: 'grp',
      messageId: 'reply-approval',
      action: 'approval_gate_approve',
      requestId: request?.requestId,
    });
    expect((approved as { toast?: { content?: string } }).toast?.content).toBe('已批准');

    const auditText = readFileSync(join(root, 'audit-mirror.ndjson'), 'utf8');
    expect(auditText).toContain('approval-gate:created');
    expect(auditText).toContain('approval-gate:dispatched');
    expect(auditText).toContain('approval-gate:resolved');
    expect(auditText).not.toMatch(/oc_[0-9a-z]{8,}/i);
    expect(auditText).not.toMatch(/tenant_access_token|app_secret|sk-/i);

    store.close();
  });
});
