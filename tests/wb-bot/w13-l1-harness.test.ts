import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BindingStore } from '../../apps/wb-bot/src/binding/store.js';
import { EventHandler } from '../../apps/wb-bot/src/feishu/event-handler.js';
import { createInitialState } from '../../apps/wb-bot/src/feishu/stream-state.js';
import { replayEventsFromNdjson } from '../../packages/core/src/runner/event-replay.js';
import { CaptainService } from '../../packages/core/src/captain/index.js';

const roots: string[] = [];
const FIXTURE = new URL('../fixtures/w13-e2e/admin-cancel-sanitized.events.ndjson', import.meta.url).pathname;

function mkRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-w13-l1-'));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  delete process.env['WB_DATA_DIR'];
  delete process.env['WB_MODE'];
});

function writeCaptainConfig(dirPath: string): void {
  const path = join(dirPath, 'config.json');
  writeFileSync(path, JSON.stringify({
    captain: {
      bitable_base_id: 'app_fixture_base',
      sessions_table_id: 'tbl_fixture_sessions',
      app_id: 'cli_fixture_app',
      app_secret: 'fixture-secret-0000000000000000',
      lark_domain: 'LarkSuite',
      captain_state_path: join(dirPath, 'captain-state.ndjson'),
      captain_toml_path: join(dirPath, 'captain.json'),
    },
  }, null, 2));
  chmodSync(path, 0o600);
}

function createReadonlyWriteGuards() {
  return {
    replyCard: vi.fn(async (_messageId: string, _card: Record<string, unknown>) => 'reply-1'),
    updateCard: vi.fn(async (_messageId: string, _card: Record<string, unknown>) => undefined),
    replyText: vi.fn(async (_messageId: string, _text: string) => 'msg-1'),
    messageCreate: vi.fn(async () => { throw new Error('unexpected real egress path: message.create'); }),
    messageReply: vi.fn(async () => { throw new Error('unexpected real egress path: message.reply'); }),
    messagePatch: vi.fn(async () => { throw new Error('unexpected real egress path: message.patch'); }),
  };
}

function createActiveSessionFixture(root: string) {
  process.env['WB_DATA_DIR'] = root;
  process.env['WB_MODE'] = 'multi-bot';
  writeCaptainConfig(root);
  const store = new BindingStore(join(root, 'wb-bot.db'));
  const feishu = createReadonlyWriteGuards();
  const handler = new EventHandler({
    register() {},
    lookup() { return null; },
    list() { return []; },
    async isAvailable() { return null; },
  }, store, feishu, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined);

  const scopeKey = 'ou_operator:oc_fixture_group:claude-code';
  const runId = 'run-fixture-001';
  const shortId = 'sess-fixture-001';
  const replyMessageId = 'reply-1';
  const stopSpy = vi.fn(async () => undefined);
  const updates: Array<Record<string, unknown>> = [];
  const replay = replayEventsFromNdjson(FIXTURE);
  const session = {
    scopeKey,
    sourceMessageId: 'om_fixture_source',
    replyMessageId,
    run: { stop: stopSpy },
    runId,
    pipeline: {
      force: vi.fn(async (card: Record<string, unknown>) => { updates.push(card); }),
      flush: vi.fn(async () => undefined),
    },
    state: {
      ...createInitialState('claude-code', 'Claude Code', 'bot'),
      sessionShortId: shortId,
      adminCancelEnabled: true,
      cwd: '/tmp/w13-fixture',
      text: replay.events.filter((event) => event.type === 'text').map((event) => event.delta).join(''),
      continuationToken: replay.latestContinuationToken,
      hasContext: true,
    },
    extraMessageIds: [],
    startedAt: Date.now(),
    agentId: 'claude-code',
    sessionId: 'default:ou_operator:oc_fixture_group',
  };

  (handler as any).activeSessions.set(scopeKey, session);
  (handler as any).activeSessionsByMessageId.set(session.sourceMessageId, session);
  (handler as any).activeSessionsByMessageId.set(replyMessageId, session);
  (handler as any).activeSessionsByShortId.set(shortId, session);

  const captainService = new CaptainService({ dataDir: root });
  captainService.createSession({
    session_id: 'default:ou_operator:oc_fixture_group',
    captain_id: 'default',
    created_at: '2026-06-25T00:00:00.000Z',
    last_active_at: '2026-06-25T00:00:00.000Z',
    cwd: '/tmp/w13-fixture',
    scope: 'dev',
    project: 'weaverbird',
    home_group_id: 'oc_fixture_group',
    agent: 'claude-code',
    latest_run_id: null,
    operator: 'ou_operator',
    entry_form: 'im',
  });
  captainService.bindRun('default:ou_operator:oc_fixture_group', runId);
  (handler as any).captainService = captainService;

  return { handler, store, feishu, stopSpy, updates, shortId, replyMessageId, runId, root };
}

describe('W13 L1 harness + guard', () => {
  it('replays sanitized fixture without sensitive ids or tokens', () => {
    const replay = replayEventsFromNdjson(FIXTURE);
    expect(replay.skipped).toBe(false);
    expect(replay.errors).toHaveLength(0);
    expect(replay.events.map((event) => event.type)).toEqual(['system', 'text', 'tool_use', 'tool_result', 'done']);
    const raw = readFileSync(FIXTURE, 'utf8');
    expect(raw).not.toMatch(/ou_[0-9a-f]{16,}/i);
    expect(raw).not.toMatch(/oc_[0-9a-z]{8,}/i);
    expect(raw).not.toMatch(/tenant_access_token|app_secret|sk-/i);
    expect(raw).toContain('resume_fixture_1');
    expect(raw).toContain('resume_fixture_2');
  });

  it('admin text /cancel and admin button keep the same audit+notify semantics', async () => {
    const rootText = mkRoot();
    const textFx = createActiveSessionFixture(rootText);
    const notifyText = vi.fn(async () => undefined);
    (textFx.handler as any).reverseAtAdminRoleResolver = async (context: { userOpenId: string }) => context.userOpenId === 'ou_admin' ? 'whitelist' : null;
    (textFx.handler as any).reverseAtOperatorNotifier = notifyText;

    await textFx.handler.handleMessage({
      eventId: 'evt-text-cancel',
      userOpenId: 'ou_admin',
      threadId: 'oc_fixture_group',
      messageId: 'om_text_cancel',
      text: `/cancel ${textFx.shortId}`,
    });

    const textAudit = readFileSync(join(rootText, 'audit-mirror.ndjson'), 'utf8');
    expect(textAudit).toContain('event=admin_cancel:actor_role=whitelist');
    expect(textAudit).toContain(`target_session=${textFx.shortId}`);
    expect(notifyText).toHaveBeenCalledTimes(1);
    expect(textFx.stopSpy).toHaveBeenCalledTimes(1);
    expect(textFx.feishu.replyText).not.toHaveBeenCalled();
    expect(textFx.feishu.messageCreate).not.toHaveBeenCalled();
    expect(textFx.feishu.messageReply).not.toHaveBeenCalled();
    expect(textFx.feishu.messagePatch).not.toHaveBeenCalled();

    textFx.store.close();

    const rootButton = mkRoot();
    const buttonFx = createActiveSessionFixture(rootButton);
    const notifyButton = vi.fn(async () => undefined);
    (buttonFx.handler as any).reverseAtAdminRoleResolver = async (context: { userOpenId: string }) => context.userOpenId === 'ou_admin' ? 'whitelist' : null;
    (buttonFx.handler as any).reverseAtOperatorNotifier = notifyButton;

    const result = await buttonFx.handler.handleCardAction({
      eventId: 'evt-button-cancel',
      userOpenId: 'ou_admin',
      threadId: 'oc_fixture_group',
      messageId: buttonFx.replyMessageId,
      action: 'admin_cancel',
      shortId: buttonFx.shortId,
    });

    expect((result as { toast?: { content?: string } }).toast?.content).toBe('已提交');
    const buttonAudit = readFileSync(join(rootButton, 'audit-mirror.ndjson'), 'utf8');
    expect(buttonAudit).toContain('event=admin_cancel:actor_role=whitelist');
    expect(buttonAudit).toContain(`target_session=${buttonFx.shortId}`);
    expect(notifyButton).toHaveBeenCalledTimes(1);
    expect(buttonFx.stopSpy).toHaveBeenCalledTimes(1);
    expect(buttonFx.feishu.replyText).not.toHaveBeenCalled();
    expect(buttonFx.feishu.messageCreate).not.toHaveBeenCalled();
    expect(buttonFx.feishu.messageReply).not.toHaveBeenCalled();
    expect(buttonFx.feishu.messagePatch).not.toHaveBeenCalled();

    buttonFx.store.close();
  });

  it('fails closed and never touches unexpected write paths for non-admin and lookup failure', async () => {
    const root = mkRoot();
    const fx = createActiveSessionFixture(root);
    const notifyOperator = vi.fn(async () => undefined);
    (fx.handler as any).reverseAtOperatorNotifier = notifyOperator;

    (fx.handler as any).reverseAtAdminRoleResolver = async () => null;
    const denyResult = await fx.handler.handleCardAction({
      eventId: 'evt-member-deny',
      userOpenId: 'ou_member',
      threadId: 'oc_fixture_group',
      messageId: fx.replyMessageId,
      action: 'admin_cancel',
      shortId: fx.shortId,
    });
    expect((denyResult as { toast?: { content?: string } }).toast?.content).toBe('已提交');
    const denyAudit = readFileSync(join(root, 'audit-mirror.ndjson'), 'utf8');
    expect(denyAudit).not.toContain('event=admin_cancel');
    expect(denyAudit).toContain('reverse-channel:reverse-at:denied');
    expect(fx.stopSpy).not.toHaveBeenCalled();
    expect(notifyOperator).not.toHaveBeenCalled();

    (fx.handler as any).reverseAtAdminRoleResolver = async () => { throw new Error('lookup down'); };
    await fx.handler.handleMessage({
      eventId: 'evt-fail-closed',
      userOpenId: 'ou_admin',
      threadId: 'oc_fixture_group',
      messageId: 'om_fail_closed',
      text: `/cancel ${fx.shortId}`,
    });
    const failClosedAudit = readFileSync(join(root, 'audit-mirror.ndjson'), 'utf8');
    expect(failClosedAudit).toContain('reverse-channel:reverse-at:denied');
    expect(failClosedAudit).toContain('reverse-channel:reverse-at:denied_fail_closed');
    expect(fx.feishu.replyText).not.toHaveBeenCalled();
    expect(fx.feishu.messageCreate).not.toHaveBeenCalled();
    expect(fx.feishu.messageReply).not.toHaveBeenCalled();
    expect(fx.feishu.messagePatch).not.toHaveBeenCalled();
    fx.store.close();
  });

  it('operator button short-circuits to local stop path without admin_cancel audit', async () => {
    const root = mkRoot();
    const fx = createActiveSessionFixture(root);
    (fx.handler as any).reverseAtAdminRoleResolver = async () => 'whitelist';

    const result = await fx.handler.handleCardAction({
      eventId: 'evt-operator-shortcut',
      userOpenId: 'ou_operator',
      threadId: 'oc_fixture_group',
      messageId: fx.replyMessageId,
      action: 'admin_cancel',
      shortId: fx.shortId,
    });

    expect((result as { toast?: { content?: string } }).toast?.content).toBe('停止中...');
    expect(fx.stopSpy).toHaveBeenCalledTimes(1);
    const auditPath = join(root, 'audit-mirror.ndjson');
    expect(() => readFileSync(auditPath, 'utf8')).toThrow();
    fx.store.close();
  });
});
