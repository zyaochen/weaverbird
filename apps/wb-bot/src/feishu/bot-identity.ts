import * as Lark from '@larksuiteoapi/node-sdk';

export interface BotIdentity {
  openId: string;
  appName?: string;
}

export interface BotIdentityFetcher {
  fetch(): Promise<BotIdentity>;
}

// /open-apis/bot/v3/info 的 raw response shape 是 `{ bot: {...}, code, msg }`
// (实测 2026-06-03, 主设计师 curl 验证). lark-sdk node-sdk 的 `client.request()`
// 不在外面包 `data` wrapper, 直接返回 raw payload. 这里也兼容历史 `data.bot.*`
// 与 `data.open_id` 两种 fallback shape, 防 SDK 行为变化.
type BotInfoResponse = {
  bot?: {
    open_id?: unknown;
    app_name?: unknown;
  };
  open_id?: unknown;
  app_name?: unknown;
  data?: {
    bot?: {
      open_id?: unknown;
      app_name?: unknown;
    };
    open_id?: unknown;
    app_name?: unknown;
  };
};

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function extractOpenId(payload: BotInfoResponse): string | undefined {
  return (
    asNonEmptyString(payload.bot?.open_id) ??
    asNonEmptyString(payload.open_id) ??
    asNonEmptyString(payload.data?.bot?.open_id) ??
    asNonEmptyString(payload.data?.open_id)
  );
}

function extractAppName(payload: BotInfoResponse): string | undefined {
  return (
    asNonEmptyString(payload.bot?.app_name) ??
    asNonEmptyString(payload.app_name) ??
    asNonEmptyString(payload.data?.bot?.app_name) ??
    asNonEmptyString(payload.data?.app_name)
  );
}

export function createLarkBotIdentityFetcher(client: InstanceType<typeof Lark.Client>): BotIdentityFetcher {
  return {
    async fetch(): Promise<BotIdentity> {
      const result = await client.request({
        method: 'GET',
        url: '/open-apis/bot/v3/info',
      });
      const payload = result as BotInfoResponse;
      const openId = extractOpenId(payload);
      if (!openId) {
        throw new Error('bot identity fetch returned no open_id');
      }
      return {
        openId,
        appName: extractAppName(payload),
      };
    },
  };
}
