import { existsSync, readFileSync } from 'node:fs';
import { parse as dotenvParse } from 'dotenv';
import { z } from 'zod';
import { assertValidBotId } from '../security/bot-id-validator.js';
import { basename } from 'node:path';
import { botEnvPath, resolveBotConfigDir } from './config-paths.js';
import { assertNoPlaceholderLarkCredentials } from './lark-credentials.js';

const BotConfigSchema = z.object({
  BOT_ID: z.string().min(1),
  LARK_APP_ID: z.string().min(1),
  LARK_APP_SECRET: z.string().min(1),
  LARK_ENCRYPT_KEY: z.string().optional().default(''),
  LARK_VERIFICATION_TOKEN: z.string().optional().default(''),
  AGENT_ALLOWED: z.string().optional().default('claude-code,codex'),
  WB_DEFAULT_CWD: z.string().optional(),
  WB_APPROVAL_CODE_OWNER_CONFIG_PATH: z.string().optional(),
  WB_CLAUDE_COMMAND: z.string().optional(),
  WB_CODEX_COMMAND: z.string().optional(),
  // `strict` 接受输入但由 wb-bot 内部 alias 为 `plan-only` (见 §下方 normalize).
  // 见 docs/product-strategy.md "Consent contract in wb-bot (no-TTY invariant)".
  WB_CLAUDE_CONSENT_LEVEL: z.enum(['normal', 'relaxed', 'auto', 'plan-only', 'strict']).optional().default('auto'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).optional().default('info'),
});

export interface BotConfig {
  botId: string;
  larkAppId: string;
  larkAppSecret: string;
  larkEncryptKey: string;
  larkVerificationToken: string;
  agentAllowed: string[];
  defaultCwd?: string;
  approvalCodeOwnerConfigPath?: string;
  claudeCommand: string;
  codexCommand: string;
  consentLevel: 'normal' | 'relaxed' | 'auto' | 'plan-only';
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
}

/**
 * wb-bot consent normalize (W2.5-Hotfix-batch-C P1-4):
 *
 * wb-bot 永远以 backend 进程 `spawn` agent CLI, 无 TTY 无 stdin.
 * 任何 startup-phase interactive prompt 都会 hang 子进程 → 卡片冻在 running.
 * 因此 wb-bot 对 `claude-code` 路径除 `plan-only` 之外一律附加
 * `--dangerously-skip-permissions` 短路底层 CLI permission UI.
 *
 * `strict` consent 在 core/CLI 语义里 = "ask me for everything", 在 no-TTY
 * 环境无法兑现. 这里把它 alias 为 `plan-only` (功能等价于 wb-bot 能保证的最严
 * 模式: 只产 plan 不执行 tool, trust 风险 = 0).
 *
 * 这不是把 contract 收窄, 而是把 wb-bot 在 contract 上的真实可兑现集明文化.
 * 完整漂移说明: docs/product-strategy.md "Consent contract in wb-bot".
 */
export function normalizeBotConsentLevel(
  level: 'normal' | 'relaxed' | 'auto' | 'plan-only' | 'strict',
): 'normal' | 'relaxed' | 'auto' | 'plan-only' {
  if (level === 'strict') return 'plan-only';
  return level;
}

export function resolveBotEnvPath(botId: string, opts: { configDir?: string } = {}): string {
  return botEnvPath(resolveBotConfigDir(opts), botId);
}

export function loadBotEnvFromFile(filePath: string): BotConfig {
  if (!existsSync(filePath)) {
    throw new Error(`Bot env file not found: ${filePath} — check \${WB_CONFIG_DIR} and ensure the file exists`);
  }

  const raw = readFileSync(filePath, 'utf8');
  const parsed = dotenvParse(raw);
  const validated = BotConfigSchema.parse(parsed);
  assertNoPlaceholderLarkCredentials({
    appId: validated.LARK_APP_ID,
    appSecret: validated.LARK_APP_SECRET,
    sourceLabel: filePath,
  });

  const botId = assertValidBotId(validated.BOT_ID, `BOT_ID in ${filePath}`);

  // verify BOT_ID matches filename convention (.env.<botId>)
  const fileName = basename(filePath);
  const expectedPrefix = `.env.${botId}`;
  if (fileName !== expectedPrefix) {
    throw new Error(`BOT_ID mismatch: file "${fileName}" contains BOT_ID="${botId}", expected file ".env.${botId}" — path: ${filePath}`);
  }

  return {
    botId,
    larkAppId: validated.LARK_APP_ID,
    larkAppSecret: validated.LARK_APP_SECRET,
    larkEncryptKey: validated.LARK_ENCRYPT_KEY,
    larkVerificationToken: validated.LARK_VERIFICATION_TOKEN,
    agentAllowed: validated.AGENT_ALLOWED.split(',').map((s) => s.trim()).filter(Boolean),
    defaultCwd: validated.WB_DEFAULT_CWD?.trim() || undefined,
    approvalCodeOwnerConfigPath: validated.WB_APPROVAL_CODE_OWNER_CONFIG_PATH?.trim() || undefined,
    claudeCommand: validated.WB_CLAUDE_COMMAND?.trim() || 'claude',
    codexCommand: validated.WB_CODEX_COMMAND?.trim() || 'codex',
    consentLevel: normalizeBotConsentLevel(validated.WB_CLAUDE_CONSENT_LEVEL),
    logLevel: validated.LOG_LEVEL,
  };
}
