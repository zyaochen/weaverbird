import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CaptainService } from '../../packages/core/src/captain/index.js';
import { createConcurrencyQueueIndex } from '../../packages/core/src/captain/concurrency-queue-index.js';
import { REVERSE_CHANNEL_ERROR_CODES, type ReverseAtCommand } from '../../packages/core/src/reverse-channel/contracts.js';
import {
  createLarkReverseAtAdminRoleResolver,
  handleReverseAtImCommand,
  parseReverseAtAdminWhitelist,
  type ReverseAtOperatorNotifier,
} from '../../apps/wb-bot/src/feishu/reverse-at-im-handler.js';

const roots: string[] = [];

function writeConfig(dir: string): void {
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({
    captain: {
      bitable_base_id: 'Uq6hb0dUaaYiDQsunHel7EisgWd',
      sessions_table_id: 'tblyqLE52hgNO7UA',
      app_id: 'cli_yyyyyyyyyyyyyyyy',
      app_secret: 'secret-32-characters-000000000000',
      lark_domain: 'LarkSuite',
      captain_state_path: join(dir, 'captain-state.ndjson'),
      captain_toml_path: join(dir, 'captain.json'),
    },
  }, null, 2));
  chmodSync(path, 0o600);
}

function createService(dir: string): CaptainService {
  writeConfig(dir);
  return new CaptainService({ dataDir: dir });
}

function command(overrides: Partial<ReverseAtCommand> = {}): ReverseAtCommand {
  return {
    command: 'pause',
    run_id: 'run-001',
    requester_open_id: 'ou_owner',
    requested_at: '2026-06-08T00:00:00.000Z',
    message_id: 'm1',
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('reverse-at-im-handler', () => {
  it('lets group admins cancel a valid visible short id and notifies operator with one audit entry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-reverse-im-'));
    roots.push(dir);
    const service = createService(dir);
    service.createSession({
      session_id: 'sid-001',
      captain_id: 'default',
      created_at: '2026-06-08T00:00:00.000Z',
      last_active_at: '2026-06-08T00:00:00.000Z',
      cwd: '/repo',
      scope: 'dev',
      project: 'weaverbird',
      home_group_id: 'grp',
      agent: 'claude-code',
      latest_run_id: null,
      operator: 'ou_owner',
      entry_form: 'im',
    });
    service.bindRun('sid-001', 'run-001');
    const replyCard = vi.fn(async (_messageId: string, _card: Record<string, unknown>) => 'reply-1');
    const executeCancel = vi.fn(async () => 'cancelled' as const);
    const notifyOperator: ReverseAtOperatorNotifier = vi.fn(async () => undefined);

    await handleReverseAtImCommand({
      command: '/cancel',
      run_id: 'sess-001',
      requester_open_id: 'ou_admin',
      requested_at: '2026-06-08T00:00:00.000Z',
      message_id: 'm1',
    }, {
      messageId: 'm1',
      threadId: 'grp',
      userOpenId: 'ou_admin',
    }, {
      captainService: service,
      dataDir: dir,
      feishu: { replyCard },
      resolveAdminRole: async () => 'group_admin' as const,
      resolveCancelTarget: (identifier) => identifier === 'sess-001'
        ? { runId: 'run-001', shortId: 'sess-001', label: 'claude-code · sess-001' }
        : null,
      listCancelableTargets: () => ['sess-001 · claude-code'],
      executeCancel,
      notifyOperator,
    });

    expect(executeCancel).toHaveBeenCalledWith('run-001');
    expect(notifyOperator).toHaveBeenCalledWith({
      runId: 'run-001',
      shortId: 'sess-001',
      actorOpenId: 'ou_admin',
      actorRole: 'group_admin',
      operatorOpenId: 'ou_owner',
      result: 'cancelled',
    });
    expect(JSON.stringify(replyCard.mock.calls.at(-1)?.[1] as Record<string, unknown>)).toContain('已叫停');
    const audit = readFileSync(join(dir, 'audit-mirror.ndjson'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(audit).toHaveLength(1);
    expect(audit[0]?.resource).toContain('admin_cancel:actor_role=group_admin:target_session=sess-001:result=cancelled');
  });

  it('keeps operator-only behavior when admin set is empty', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-reverse-im-'));
    roots.push(dir);
    const service = createService(dir);
    service.createSession({
      session_id: 'sid-001',
      captain_id: 'default',
      created_at: '2026-06-08T00:00:00.000Z',
      last_active_at: '2026-06-08T00:00:00.000Z',
      cwd: '/repo',
      scope: 'dev',
      project: 'weaverbird',
      home_group_id: 'grp',
      agent: 'claude-code',
      latest_run_id: null,
      operator: 'ou_owner',
      entry_form: 'im',
    });
    service.bindRun('sid-001', 'run-001');
    const replyCard = vi.fn(async (_messageId: string, _card: Record<string, unknown>) => 'reply-1');
    const openSession = vi.fn();

    await handleReverseAtImCommand(command({ requester_open_id: 'ou_other' }), {
      messageId: 'm1',
      threadId: 't1',
      userOpenId: 'ou_other',
    }, {
      captainService: service,
      dataDir: dir,
      feishu: { replyCard },
      resolveAdminRole: async () => null,
      createIpcClient: () => ({ openSession }),
    });

    expect(openSession).not.toHaveBeenCalled();
    expect(JSON.stringify(replyCard.mock.calls.at(-1)?.[1] as Record<string, unknown>)).toContain('无权操作');
  });

  it('rejects requester that is not operator and does not send IPC', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-reverse-im-'));
    roots.push(dir);
    const service = createService(dir);
    service.createSession({
      session_id: 'sid-001',
      captain_id: 'default',
      created_at: '2026-06-08T00:00:00.000Z',
      last_active_at: '2026-06-08T00:00:00.000Z',
      cwd: '/repo',
      scope: 'dev',
      project: 'weaverbird',
      home_group_id: 'grp',
      agent: 'claude-code',
      latest_run_id: null,
      operator: 'ou_owner',
      entry_form: 'im',
    });
    service.bindRun('sid-001', 'run-001');
    const replyCard = vi.fn(async (_messageId: string, _card: Record<string, unknown>) => 'reply-1');
    const openSession = vi.fn();

    await handleReverseAtImCommand(command({ requester_open_id: 'ou_other' }), {
      messageId: 'm1',
      threadId: 't1',
      userOpenId: 'ou_other',
    }, {
      captainService: service,
      dataDir: dir,
      feishu: { replyCard },
      createIpcClient: () => ({ openSession }),
    });

    expect(openSession).not.toHaveBeenCalled();
    expect(replyCard).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(replyCard.mock.calls.at(-1)?.[1] as Record<string, unknown>)).toContain('无权操作');
  });

  it('returns current state instead of error on concurrent double /cancel', async () => {
    const replyCard = vi.fn(async (_messageId: string, _card: Record<string, unknown>) => 'reply-1');
    let first = true;
    const executeCancel = vi.fn(async () => {
      if (first) {
        first = false;
        return 'cancelled' as const;
      }
      return 'noop_already_ended' as const;
    });

    const dir = mkdtempSync(join(tmpdir(), 'wb-reverse-im-'));
    roots.push(dir);
    const service = createService(dir);
    service.createSession({
      session_id: 'sid-001',
      captain_id: 'default',
      created_at: '2026-06-08T00:00:00.000Z',
      last_active_at: '2026-06-08T00:00:00.000Z',
      cwd: '/repo',
      scope: 'dev',
      project: 'weaverbird',
      home_group_id: 'grp',
      agent: 'claude-code',
      latest_run_id: null,
      operator: 'ou_owner',
      entry_form: 'im',
    });
    service.bindRun('sid-001', 'run-001');
    const commonOptions = {
      captainService: service,
      dataDir: dir,
      feishu: { replyCard },
      resolveAdminRole: async () => 'group_admin' as const,
      resolveCancelTarget: (identifier: string) => identifier === 'sess-001'
        ? { runId: 'run-001', shortId: 'sess-001', label: 'claude-code · sess-001' }
        : null,
      listCancelableTargets: () => ['sess-001 · claude-code'],
      executeCancel,
    };

    await handleReverseAtImCommand({
      command: '/cancel',
      run_id: 'sess-001',
      requester_open_id: 'ou_admin',
      requested_at: '2026-06-08T00:00:00.000Z',
      message_id: 'm1',
    }, {
      messageId: 'm1',
      threadId: 'grp',
      userOpenId: 'ou_admin',
    }, commonOptions);

    await handleReverseAtImCommand({
      command: '/cancel',
      run_id: 'sess-001',
      requester_open_id: 'ou_admin',
      requested_at: '2026-06-08T00:00:01.000Z',
      message_id: 'm2',
    }, {
      messageId: 'm2',
      threadId: 'grp',
      userOpenId: 'ou_admin',
    }, commonOptions);

    expect(executeCancel).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(replyCard.mock.calls[0]?.[1] as Record<string, unknown>)).toContain('已叫停');
    expect(JSON.stringify(replyCard.mock.calls[1]?.[1] as Record<string, unknown>)).toContain('已结束，无需再叫停');
  });

  it('returns list when /cancel identifier cannot be resolved', async () => {
    const replyCard = vi.fn(async (_messageId: string, _card: Record<string, unknown>) => 'reply-1');

    await handleReverseAtImCommand({
      command: '/cancel',
      run_id: 'missing-id',
      requester_open_id: 'ou_admin',
      requested_at: '2026-06-08T00:00:00.000Z',
      message_id: 'm1',
    }, {
      messageId: 'm1',
      threadId: 'grp',
      userOpenId: 'ou_admin',
    }, {
      captainService: { listActiveSessions: () => [] },
      dataDir: '/tmp',
      feishu: { replyCard },
      resolveAdminRole: async () => 'group_admin' as const,
      resolveCancelTarget: () => null,
      listCancelableTargets: () => ['sess-001 · claude-code', 'sess-002 · codex'],
      executeCancel: async () => 'cancelled',
    });

    const body = JSON.stringify(replyCard.mock.calls.at(-1)?.[1] as Record<string, unknown>);
    expect(body).toContain('未找到目标');
    expect(body).toContain('可叫停列表');
    expect(body).toContain('sess-001 · claude-code');
  });

  it('lets group admins cancel when requester is not operator', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-reverse-im-'));
    roots.push(dir);
    const service = createService(dir);
    service.createSession({
      session_id: 'sid-001',
      captain_id: 'default',
      created_at: '2026-06-08T00:00:00.000Z',
      last_active_at: '2026-06-08T00:00:00.000Z',
      cwd: '/repo',
      scope: 'dev',
      project: 'weaverbird',
      home_group_id: 'grp',
      agent: 'claude-code',
      latest_run_id: null,
      operator: 'ou_owner',
      entry_form: 'im',
    });
    service.bindRun('sid-001', 'run-001');
    const replyCard = vi.fn(async (_messageId: string, _card: Record<string, unknown>) => 'reply-1');
    const send = vi.fn(async () => ({ kind: 'ack' as const, command: 'pause', run_id: 'run-001', ok: true }));
    const close = vi.fn(async () => undefined);
    const openSession = vi.fn(async () => ({ send, close }));

    await handleReverseAtImCommand(command({ requester_open_id: 'ou_admin' }), {
      messageId: 'm1',
      threadId: 'grp',
      userOpenId: 'ou_admin',
    }, {
      captainService: service,
      dataDir: dir,
      feishu: { replyCard },
      resolveAdminRole: async () => 'group_admin' as const,
      createIpcClient: () => ({ openSession }),
    });

    expect(openSession).toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith({ kind: 'control', command: 'pause', run_id: 'run-001' });
    expect(JSON.stringify(replyCard.mock.calls.at(-1)?.[1] as Record<string, unknown>)).toContain('✅ pause run-001');
  });

  it('keeps operator precedence when requester is both operator and admin', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-reverse-im-'));
    roots.push(dir);
    const service = createService(dir);
    service.createSession({
      session_id: 'sid-001',
      captain_id: 'default',
      created_at: '2026-06-08T00:00:00.000Z',
      last_active_at: '2026-06-08T00:00:00.000Z',
      cwd: '/repo',
      scope: 'dev',
      project: 'weaverbird',
      home_group_id: 'grp',
      agent: 'claude-code',
      latest_run_id: null,
      operator: 'ou_owner',
      entry_form: 'im',
    });
    service.bindRun('sid-001', 'run-001');
    const replyCard = vi.fn(async (_messageId: string, _card: Record<string, unknown>) => 'reply-1');
    const send = vi.fn(async () => ({ kind: 'ack' as const, command: 'pause', run_id: 'run-001', ok: true }));
    const close = vi.fn(async () => undefined);
    const openSession = vi.fn(async () => ({ send, close }));
    const resolver = vi.fn(async () => 'group_admin' as const);

    await handleReverseAtImCommand(command({ requester_open_id: 'ou_owner' }), {
      messageId: 'm1',
      threadId: 'grp',
      userOpenId: 'ou_owner',
    }, {
      captainService: service,
      dataDir: dir,
      feishu: { replyCard },
      resolveAdminRole: resolver,
      createIpcClient: () => ({ openSession }),
    });

    expect(resolver).not.toHaveBeenCalled();
    expect(openSession).toHaveBeenCalled();
    expect(JSON.stringify(replyCard.mock.calls.at(-1)?.[1] as Record<string, unknown>)).toContain('✅ pause run-001');
  });

  it('fails closed when admin role lookup errors', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-reverse-im-'));
    roots.push(dir);
    const service = createService(dir);
    service.createSession({
      session_id: 'sid-001',
      captain_id: 'default',
      created_at: '2026-06-08T00:00:00.000Z',
      last_active_at: '2026-06-08T00:00:00.000Z',
      cwd: '/repo',
      scope: 'dev',
      project: 'weaverbird',
      home_group_id: 'grp',
      agent: 'claude-code',
      latest_run_id: null,
      operator: 'ou_owner',
      entry_form: 'im',
    });
    service.bindRun('sid-001', 'run-001');
    const replyCard = vi.fn(async (_messageId: string, _card: Record<string, unknown>) => 'reply-1');
    const openSession = vi.fn();

    await handleReverseAtImCommand(command({ requester_open_id: 'ou_admin' }), {
      messageId: 'm1',
      threadId: 'grp',
      userOpenId: 'ou_admin',
    }, {
      captainService: service,
      dataDir: dir,
      feishu: { replyCard },
      resolveAdminRole: async () => { throw new Error('lookup down'); },
      createIpcClient: () => ({ openSession }),
    });

    expect(openSession).not.toHaveBeenCalled();
    expect(JSON.stringify(replyCard.mock.calls.at(-1)?.[1] as Record<string, unknown>)).toContain('fail-closed');
  });

  it('parses admin whitelist and resolves owner/group_admin/whitelist roles', async () => {
    expect(Array.from(parseReverseAtAdminWhitelist('ou_a, ou_b ,,ou_c'))).toEqual(['ou_a', 'ou_b', 'ou_c']);

    const client = {
      im: {
        v1: {
          chat: {
            get: vi.fn(async ({ path }: { path: { chat_id: string } }) => {
              if (path.chat_id === 'owner-chat') {
                return { data: { owner_id: 'ou_owner', user_manager_id_list: ['ou_admin'] } };
              }
              return { data: { owner_id: 'ou_someone', user_manager_id_list: ['ou_admin'] } };
            }),
          },
        },
      },
    } as any;
    const resolver = createLarkReverseAtAdminRoleResolver(client, new Set(['ou_white']));

    await expect(resolver({ messageId: 'm1', threadId: 'owner-chat', userOpenId: 'ou_owner' })).resolves.toBe('owner');
    await expect(resolver({ messageId: 'm1', threadId: 'other-chat', userOpenId: 'ou_admin' })).resolves.toBe('group_admin');
    await expect(resolver({ messageId: 'm1', threadId: 'other-chat', userOpenId: 'ou_white' })).resolves.toBe('whitelist');
    await expect(resolver({ messageId: 'm1', threadId: 'other-chat', userOpenId: 'ou_none' })).resolves.toBeNull();
  });

  it('replies success when IPC ack ok is returned', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-reverse-im-'));
    roots.push(dir);
    const service = createService(dir);
    service.createSession({
      session_id: 'sid-001',
      captain_id: 'default',
      created_at: '2026-06-08T00:00:00.000Z',
      last_active_at: '2026-06-08T00:00:00.000Z',
      cwd: '/repo',
      scope: 'dev',
      project: 'weaverbird',
      home_group_id: 'grp',
      agent: 'claude-code',
      latest_run_id: null,
      operator: 'ou_owner',
      entry_form: 'im',
    });
    service.bindRun('sid-001', 'run-001');
    const replyCard = vi.fn(async (_messageId: string, _card: Record<string, unknown>) => 'reply-1');
    const send = vi.fn(async () => ({ kind: 'ack' as const, command: 'pause', run_id: 'run-001', ok: true }));
    const close = vi.fn(async () => undefined);
    const openSession = vi.fn(async () => ({ send, close }));

    await handleReverseAtImCommand(command(), {
      messageId: 'm1',
      threadId: 't1',
      userOpenId: 'ou_owner',
    }, {
      captainService: service,
      dataDir: dir,
      feishu: { replyCard },
      createIpcClient: () => ({ openSession }),
    });

    expect(openSession).toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith({ kind: 'control', command: 'pause', run_id: 'run-001' });
    expect(JSON.stringify(replyCard.mock.calls.at(-1)?.[1] as Record<string, unknown>)).toContain('✅ pause run-001');
  });

  it('replies error when IPC ack is not ok', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-reverse-im-'));
    roots.push(dir);
    const service = createService(dir);
    service.createSession({
      session_id: 'sid-001',
      captain_id: 'default',
      created_at: '2026-06-08T00:00:00.000Z',
      last_active_at: '2026-06-08T00:00:00.000Z',
      cwd: '/repo',
      scope: 'dev',
      project: 'weaverbird',
      home_group_id: 'grp',
      agent: 'claude-code',
      latest_run_id: null,
      operator: 'ou_owner',
      entry_form: 'im',
    });
    service.bindRun('sid-001', 'run-001');
    const replyCard = vi.fn(async (_messageId: string, _card: Record<string, unknown>) => 'reply-1');
    const send = vi.fn(async () => ({ kind: 'ack' as const, command: 'pause', run_id: 'run-001', ok: false, reason: 'reverse.signal.send_failed' }));
    const close = vi.fn(async () => undefined);
    const openSession = vi.fn(async () => ({ send, close }));

    await handleReverseAtImCommand(command(), {
      messageId: 'm1',
      threadId: 't1',
      userOpenId: 'ou_owner',
    }, {
      captainService: service,
      dataDir: dir,
      feishu: { replyCard },
      createIpcClient: () => ({ openSession }),
    });

    expect(JSON.stringify(replyCard.mock.calls.at(-1)?.[1] as Record<string, unknown>)).toContain('❌ pause run-001: reverse.signal.send_failed');
  });
});
