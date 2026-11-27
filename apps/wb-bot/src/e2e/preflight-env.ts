import * as Lark from '@larksuiteoapi/node-sdk';
import { resolveDataDir } from '../../../../packages/core/src/paths.js';
import { readEnv, type BotEnv } from '../config/env.js';
import { botEnvPath, resolveBotConfigDir } from '../config/config-paths.js';
import { loadBotEnvFromFile } from '../config/bot-env.js';
import { createLarkBotIdentityFetcher } from '../feishu/bot-identity.js';
import { createLarkReverseAtAdminRoleResolver } from '../feishu/reverse-at-im-handler.js';
import { allocateSessionShortId } from '../feishu/stream-state.js';
import { resolveReverseAtCancelTargetFromSession } from '../feishu/session-short-id.js';

export type ReadonlyPreflightStatus = 'ok' | 'warn' | 'error';

export type ReadonlyPreflightCheck = {
  status: ReadonlyPreflightStatus;
  label: string;
  detail: string;
};

export type ReadonlyPreflightConfig = {
  botId: string;
  dataDir: string;
  larkAppId: string;
  larkAppSecret: string;
  mode: 'single' | 'multi-bot';
  source: 'env' | 'bot-env-file';
  configPath?: string;
  preflightChatId?: string;
};

export type ReadonlyPreflightReport = {
  mode: 'single' | 'multi-bot';
  botId: string;
  checks: ReadonlyPreflightCheck[];
};

export type ReadonlyLarkClientLike = {
  request(req: { method: string; url: string }): Promise<unknown>;
  im: {
    v1: {
      chat: {
        get(req: { path: { chat_id: string }; params: { user_id_type: string } }): Promise<unknown>;
      };
    };
  };
};

function ok(label: string, detail: string): ReadonlyPreflightCheck {
  return { status: 'ok', label, detail };
}

function warn(label: string, detail: string): ReadonlyPreflightCheck {
  return { status: 'warn', label, detail };
}

function errorCheck(label: string, detail: string): ReadonlyPreflightCheck {
  return { status: 'error', label, detail };
}

function trimOrUndefined(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function detectPreflightChatId(input: NodeJS.ProcessEnv): string | undefined {
  return trimOrUndefined(input['WB_E2E_PREFLIGHT_CHAT_ID']) ?? trimOrUndefined(input['WB_ADMIN_THREAD_ID']);
}

function resolvePreflightDataDir(input: NodeJS.ProcessEnv): string {
  const configured = trimOrUndefined(input['WB_DATA_DIR']);
  return resolveDataDir({ dataDir: configured });
}

function loadMultiBotConfig(input: NodeJS.ProcessEnv): ReadonlyPreflightConfig {
  const rawBotId = trimOrUndefined(input['BOT_ID']);
  if (!rawBotId) {
    throw new Error('multi-bot preflight requires BOT_ID env');
  }
  const configDir = resolveBotConfigDir({ configDir: trimOrUndefined(input['WB_CONFIG_DIR']) });
  const configPath = botEnvPath(configDir, rawBotId);
  const botCfg = loadBotEnvFromFile(configPath);
  const dataDir = resolvePreflightDataDir(input);
  return {
    botId: botCfg.botId,
    dataDir,
    larkAppId: botCfg.larkAppId,
    larkAppSecret: botCfg.larkAppSecret,
    mode: 'multi-bot',
    source: 'bot-env-file',
    configPath,
    preflightChatId: detectPreflightChatId(input),
  };
}

function loadSingleBotConfig(input: NodeJS.ProcessEnv): ReadonlyPreflightConfig {
  const env: BotEnv = readEnv(input);
  return {
    botId: env.botId,
    dataDir: env.dataDir,
    larkAppId: env.LARK_APP_ID,
    larkAppSecret: env.LARK_APP_SECRET,
    mode: 'single',
    source: 'env',
    preflightChatId: detectPreflightChatId(input),
  };
}

export function loadReadonlyPreflightConfig(input: NodeJS.ProcessEnv = process.env): ReadonlyPreflightConfig {
  return input['WB_MODE'] === 'multi-bot'
    ? loadMultiBotConfig(input)
    : loadSingleBotConfig(input);
}

export function createReadonlyPreflightClient(config: ReadonlyPreflightConfig): ReadonlyLarkClientLike {
  return new Lark.Client({ appId: config.larkAppId, appSecret: config.larkAppSecret }) as unknown as ReadonlyLarkClientLike;
}

export async function checkBotIdentityReadable(client: ReadonlyLarkClientLike): Promise<ReadonlyPreflightCheck> {
  try {
    const identity = await createLarkBotIdentityFetcher(client as never).fetch();
    return ok('bot online', `bot identity readable · open_id=${identity.openId}${identity.appName ? ` · app=${identity.appName}` : ''}`);
  } catch (err) {
    return errorCheck('bot online', err instanceof Error ? err.message : String(err));
  }
}

export async function checkRoleApiReadable(
  client: ReadonlyLarkClientLike,
  chatId: string | undefined,
  probeOpenId: string,
): Promise<ReadonlyPreflightCheck> {
  if (!chatId) {
    return warn('group role API', 'skipped (set WB_E2E_PREFLIGHT_CHAT_ID or WB_ADMIN_THREAD_ID for readonly chat.get probe)');
  }
  const resolver = createLarkReverseAtAdminRoleResolver(client as never, new Set());
  try {
    const role = await resolver({
      messageId: 'readonly-preflight',
      threadId: chatId,
      userOpenId: probeOpenId,
    });
    return ok('group role API', `chat.get readable · chat_id=${chatId} · resolved_role=${role ?? 'none'}`);
  } catch (err) {
    return errorCheck('group role API', err instanceof Error ? err.message : String(err));
  }
}

export function checkShortIdParseability(): ReadonlyPreflightCheck {
  const runId = 'syntheticrun0001';
  const shortId = allocateSessionShortId(runId, []);
  const target = resolveReverseAtCancelTargetFromSession({
    agentId: 'claude-code',
    runId,
    sessionShortId: shortId,
  });
  if (!target) {
    return errorCheck('shortId parse', 'failed to resolve synthetic shortId target');
  }
  return ok('shortId parse', `synthetic shortId resolves · ${target.shortId} -> ${target.runId}`);
}

export function checkReadonlyEnvCompleteness(config: ReadonlyPreflightConfig): ReadonlyPreflightCheck {
  const source = config.source === 'env' ? 'process env' : config.configPath ?? 'bot env file';
  const roleProbe = config.preflightChatId ? `chat probe configured (${config.preflightChatId})` : 'chat probe not configured';
  return ok(
    'env completeness',
    `mode=${config.mode} · bot=${config.botId} · source=${source} · dataDir=${config.dataDir} · ${roleProbe}`,
  );
}

export async function runReadonlyPreflight(
  input: NodeJS.ProcessEnv = process.env,
  deps: {
    createClient?: (config: ReadonlyPreflightConfig) => ReadonlyLarkClientLike;
  } = {},
): Promise<ReadonlyPreflightReport> {
  const config = loadReadonlyPreflightConfig(input);
  const client = (deps.createClient ?? createReadonlyPreflightClient)(config);
  const envCheck = checkReadonlyEnvCompleteness(config);
  const botCheck = await checkBotIdentityReadable(client);
  const probeOpenId = botCheck.status === 'ok'
    ? botCheck.detail.match(/open_id=([^\s]+)/)?.[1] ?? 'readonly-preflight-open-id'
    : 'readonly-preflight-open-id';
  const roleCheck = await checkRoleApiReadable(client, config.preflightChatId, probeOpenId);
  const shortIdCheck = checkShortIdParseability();
  return {
    mode: config.mode,
    botId: config.botId,
    checks: [envCheck, botCheck, roleCheck, shortIdCheck],
  };
}

function emoji(status: ReadonlyPreflightStatus): string {
  return status === 'ok' ? '✅' : status === 'warn' ? '⚠️' : '❌';
}

function overallStatus(checks: ReadonlyPreflightCheck[]): ReadonlyPreflightStatus {
  if (checks.some((check) => check.status === 'error')) return 'error';
  if (checks.some((check) => check.status === 'warn')) return 'warn';
  return 'ok';
}

export function formatReadonlyPreflightReport(report: ReadonlyPreflightReport): string {
  const overall = overallStatus(report.checks);
  const header = `${emoji(overall)} W13 readonly preflight (${report.mode}) · bot=${report.botId}`;
  const body = report.checks.map((check) => `${emoji(check.status)} ${check.label}: ${check.detail}`);
  return [header, ...body].join('\n');
}
