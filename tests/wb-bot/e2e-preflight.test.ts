import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  checkRoleApiReadable,
  formatReadonlyPreflightReport,
  loadReadonlyPreflightConfig,
  runReadonlyPreflight,
  type ReadonlyLarkClientLike,
} from '../../apps/wb-bot/src/e2e/preflight-env.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createReadonlyClient(overrides: Partial<ReadonlyLarkClientLike> = {}): ReadonlyLarkClientLike & {
  messageCreate: ReturnType<typeof vi.fn>;
  messageReply: ReturnType<typeof vi.fn>;
  messagePatch: ReturnType<typeof vi.fn>;
} {
  const messageCreate = vi.fn(async () => {
    throw new Error('write path should not be used in readonly preflight');
  });
  const messageReply = vi.fn(async () => {
    throw new Error('write path should not be used in readonly preflight');
  });
  const messagePatch = vi.fn(async () => {
    throw new Error('write path should not be used in readonly preflight');
  });

  const base: ReadonlyLarkClientLike = {
    request: vi.fn(async () => ({
      data: {
        bot: {
          open_id: 'ou_synthetic_bot',
          app_name: 'SyntheticBot',
        },
      },
    })),
    im: {
      v1: {
        chat: {
          get: vi.fn(async () => ({
            data: {
              owner_id: 'ou_synthetic_bot',
              user_manager_id_list: [],
            },
          })),
        },
        message: {
          create: messageCreate,
          reply: messageReply,
          patch: messagePatch,
        },
      },
    },
  } as unknown as ReadonlyLarkClientLike;

  const merged = {
    ...base,
    ...overrides,
    im: overrides.im ?? (base as any).im,
    messageCreate,
    messageReply,
    messagePatch,
  };
  return merged;
}

describe('W13 readonly preflight', () => {
  it('loads single-bot config from env input', () => {
    const config = loadReadonlyPreflightConfig({
      LARK_APP_ID: 'cli_test_id',
      LARK_APP_SECRET: 'secret_test',
      WB_DATA_DIR: '/tmp/wb-data',
      WB_E2E_PREFLIGHT_CHAT_ID: 'oc_test_chat',
    });

    expect(config.mode).toBe('single');
    expect(config.botId).toBe('default');
    expect(config.larkAppId).toBe('cli_test_id');
    expect(config.preflightChatId).toBe('oc_test_chat');
  });

  it('loads multi-bot config from bot env file', () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-preflight-'));
    roots.push(root);
    const configDir = join(root, 'configs');
    const envPath = join(configDir, '.env.claude');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(envPath, [
      'BOT_ID=claude',
      'LARK_APP_ID=cli_test_id',
      'LARK_APP_SECRET=secret_test',
      'AGENT_ALLOWED=claude-code,codex',
    ].join('\n'), { encoding: 'utf8', flag: 'w' });

    const config = loadReadonlyPreflightConfig({
      WB_MODE: 'multi-bot',
      BOT_ID: 'claude',
      WB_CONFIG_DIR: configDir,
      WB_DATA_DIR: join(root, 'data'),
      WB_ADMIN_THREAD_ID: 'oc_admin_thread',
    });

    expect(config.mode).toBe('multi-bot');
    expect(config.botId).toBe('claude');
    expect(config.configPath).toBe(envPath);
    expect(config.preflightChatId).toBe('oc_admin_thread');
  });

  it('runs four readonly checks and does not touch any write APIs', async () => {
    const client = createReadonlyClient();

    const report = await runReadonlyPreflight({
      LARK_APP_ID: 'cli_test_id',
      LARK_APP_SECRET: 'secret_test',
      WB_DATA_DIR: '/tmp/wb-data',
      WB_E2E_PREFLIGHT_CHAT_ID: 'oc_test_chat',
    }, {
      createClient: () => client,
    });

    expect(report.checks).toHaveLength(4);
    expect(report.checks.map((check) => check.label)).toEqual([
      'env completeness',
      'bot online',
      'group role API',
      'shortId parse',
    ]);
    expect(report.checks.every((check) => check.status === 'ok')).toBe(true);
    expect((client.request as any)).toHaveBeenCalledTimes(1);
    expect((client.im.v1.chat.get as any)).toHaveBeenCalledTimes(1);
    expect(client.messageCreate).not.toHaveBeenCalled();
    expect(client.messageReply).not.toHaveBeenCalled();
    expect(client.messagePatch).not.toHaveBeenCalled();
  });

  it('skips group role probe when no chat id is configured', async () => {
    const report = await runReadonlyPreflight({
      LARK_APP_ID: 'cli_test_id',
      LARK_APP_SECRET: 'secret_test',
      WB_DATA_DIR: '/tmp/wb-data',
    }, {
      createClient: () => createReadonlyClient(),
    });

    const roleCheck = report.checks.find((check) => check.label === 'group role API');
    expect(roleCheck?.status).toBe('warn');
    expect(roleCheck?.detail).toContain('skipped');
  });

  it('surfaces bot identity failures as errors', async () => {
    const client = createReadonlyClient({
      request: vi.fn(async () => {
        throw new Error('401 unauthorized');
      }),
    });

    const report = await runReadonlyPreflight({
      LARK_APP_ID: 'cli_test_id',
      LARK_APP_SECRET: 'secret_test',
      WB_DATA_DIR: '/tmp/wb-data',
      WB_E2E_PREFLIGHT_CHAT_ID: 'oc_test_chat',
    }, {
      createClient: () => client,
    });

    const botCheck = report.checks.find((check) => check.label === 'bot online');
    expect(botCheck?.status).toBe('error');
    expect(botCheck?.detail).toContain('401 unauthorized');
  });

  it('reads role api via chat.get only', async () => {
    const client = createReadonlyClient();
    const result = await checkRoleApiReadable(client, 'oc_test_chat', 'ou_probe');
    expect(result.status).toBe('ok');
    expect((client.im.v1.chat.get as any)).toHaveBeenCalledWith({
      path: { chat_id: 'oc_test_chat' },
      params: { user_id_type: 'open_id' },
    });
    expect(client.messageCreate).not.toHaveBeenCalled();
  });

  it('formats report with overall header and per-check lines', async () => {
    const report = await runReadonlyPreflight({
      LARK_APP_ID: 'cli_test_id',
      LARK_APP_SECRET: 'secret_test',
      WB_DATA_DIR: '/tmp/wb-data',
      WB_E2E_PREFLIGHT_CHAT_ID: 'oc_test_chat',
    }, {
      createClient: () => createReadonlyClient(),
    });

    const text = formatReadonlyPreflightReport(report);
    expect(text).toContain('W13 readonly preflight');
    expect(text).toContain('env completeness');
    expect(text).toContain('bot online');
    expect(text).toContain('group role API');
    expect(text).toContain('shortId parse');
  });
});
