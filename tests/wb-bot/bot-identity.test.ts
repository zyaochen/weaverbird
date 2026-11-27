import { describe, expect, it, vi } from 'vitest';
import { createLarkBotIdentityFetcher } from '../../apps/wb-bot/src/feishu/bot-identity.js';

describe('createLarkBotIdentityFetcher', () => {
  it('returns openId and appName from nested bot payload', async () => {
    const client = {
      request: vi.fn(async () => ({
        data: { bot: { open_id: 'ou_test_bot_self', app_name: 'TestApp' } },
      })),
    };

    const fetcher = createLarkBotIdentityFetcher(client as never);
    await expect(fetcher.fetch()).resolves.toEqual({ openId: 'ou_test_bot_self', appName: 'TestApp' });
    expect(client.request).toHaveBeenCalledWith({ method: 'GET', url: '/open-apis/bot/v3/info' });
  });

  it('parses raw lark-sdk shape without data wrapper (real /open-apis/bot/v3/info response)', async () => {
    // 实测 2026-06-03: lark-sdk node-sdk client.request() 返回 raw response 不包 data wrapper.
    // 形态: { bot: { open_id, app_name, activate_status, avatar_url, ip_white_list }, code: 0, msg: 'ok' }
    const client = {
      request: vi.fn(async () => ({
        bot: {
          activate_status: 2,
          app_name: '熊大',
          avatar_url: 'https://example.com/avatar.png',
          ip_white_list: [],
          open_id: 'ou_bot_self_example',
        },
        code: 0,
        msg: 'ok',
      })),
    };

    const fetcher = createLarkBotIdentityFetcher(client as never);
    await expect(fetcher.fetch()).resolves.toEqual({
      openId: 'ou_bot_self_example',
      appName: '熊大',
    });
  });

  it('falls back to raw top-level open_id without nested bot', async () => {
    const client = {
      request: vi.fn(async () => ({
        open_id: 'ou_raw_top_level',
        app_name: 'RawTopApp',
        code: 0,
      })),
    };

    const fetcher = createLarkBotIdentityFetcher(client as never);
    await expect(fetcher.fetch()).resolves.toEqual({ openId: 'ou_raw_top_level', appName: 'RawTopApp' });
  });

  it('falls back to top-level payload fields', async () => {
    const client = {
      request: vi.fn(async () => ({
        data: { open_id: 'ou_top_level', app_name: 'TopLevelApp' },
      })),
    };

    const fetcher = createLarkBotIdentityFetcher(client as never);
    await expect(fetcher.fetch()).resolves.toEqual({ openId: 'ou_top_level', appName: 'TopLevelApp' });
  });

  it('propagates client.request failure', async () => {
    const client = {
      request: vi.fn(async () => {
        throw new Error('401 unauthorized');
      }),
    };

    const fetcher = createLarkBotIdentityFetcher(client as never);
    await expect(fetcher.fetch()).rejects.toThrow('401 unauthorized');
  });

  it('throws when open_id is missing', async () => {
    const client = {
      request: vi.fn(async () => ({
        data: { bot: { app_name: 'NoIdApp' } },
      })),
    };

    const fetcher = createLarkBotIdentityFetcher(client as never);
    await expect(fetcher.fetch()).rejects.toThrow('bot identity fetch returned no open_id');
  });

  it('trims whitespace values', async () => {
    const client = {
      request: vi.fn(async () => ({
        data: { bot: { open_id: '  ou_trimmed  ', app_name: '  TrimApp  ' } },
      })),
    };

    const fetcher = createLarkBotIdentityFetcher(client as never);
    await expect(fetcher.fetch()).resolves.toEqual({ openId: 'ou_trimmed', appName: 'TrimApp' });
  });

  it('omits appName when it is blank', async () => {
    const client = {
      request: vi.fn(async () => ({
        data: { bot: { open_id: 'ou_no_name', app_name: '   ' } },
      })),
    };

    const fetcher = createLarkBotIdentityFetcher(client as never);
    await expect(fetcher.fetch()).resolves.toEqual({ openId: 'ou_no_name', appName: undefined });
  });

  it('throws for completely malformed payload', async () => {
    const client = {
      request: vi.fn(async () => ({})),
    };

    const fetcher = createLarkBotIdentityFetcher(client as never);
    await expect(fetcher.fetch()).rejects.toThrow('bot identity fetch returned no open_id');
  });

  it('ignores non-string open_id values', async () => {
    const client = {
      request: vi.fn(async () => ({
        data: { bot: { open_id: 12345 } },
      })),
    };

    const fetcher = createLarkBotIdentityFetcher(client as never);
    await expect(fetcher.fetch()).rejects.toThrow('bot identity fetch returned no open_id');
  });
});
