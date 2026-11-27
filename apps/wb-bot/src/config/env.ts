import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';
import { resolveDataDir } from '../../../../packages/core/src/paths.js';
import { assertValidBotId } from '../security/bot-id-validator.js';
import { normalizeBotConsentLevel } from './bot-env.js';
import { assertNoPlaceholderLarkCredentials } from './lark-credentials.js';

loadDotenv({ path: new URL('../../.env', import.meta.url).pathname, override: false });
loadDotenv({ override: false });

const EnvSchema = z.object({
  LARK_APP_ID: z.string().min(1),
  LARK_APP_SECRET: z.string().min(1),
  LARK_ENCRYPT_KEY: z.string().optional().default(''),
  LARK_VERIFICATION_TOKEN: z.string().optional().default(''),
  WB_DATA_DIR: z.string().optional(),
  WB_CLAUDE_COMMAND: z.string().optional(),
  WB_CODEX_COMMAND: z.string().optional(),
  WB_DEFAULT_CWD: z.string().optional(),
  WB_REVERSE_AT_ADMIN_OPEN_IDS: z.string().optional(),
  WB_APPROVAL_CODE_OWNER_CONFIG_PATH: z.string().optional(),
  // `strict` 接受输入但 alias 为 `plan-only` (no-TTY invariant, 见 bot-env.ts normalizeBotConsentLevel).
  WB_CLAUDE_CONSENT_LEVEL: z.enum(['normal', 'relaxed', 'auto', 'plan-only', 'strict']).optional().default('auto'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).optional().default('info'),
  BOT_ID: z.string().optional(),
  WB_MODE: z.enum(['single', 'multi-bot']).optional().default('single'),
});

export type BotEnv = Omit<z.infer<typeof EnvSchema>, 'WB_CLAUDE_CONSENT_LEVEL'> & {
  WB_CLAUDE_CONSENT_LEVEL: 'normal' | 'relaxed' | 'auto' | 'plan-only';
  dataDir: string;
  claudeCommand: string;
  codexCommand: string;
  defaultCwd: string | undefined;
  botId: string;
  mode: 'single' | 'multi-bot';
};

export function readEnv(input: NodeJS.ProcessEnv = process.env): BotEnv {
  const env = EnvSchema.parse(input);
  assertNoPlaceholderLarkCredentials({
    appId: env.LARK_APP_ID,
    appSecret: env.LARK_APP_SECRET,
    sourceLabel: 'process env / apps/wb-bot/.env',
  });
  return {
    ...env,
    WB_CLAUDE_CONSENT_LEVEL: normalizeBotConsentLevel(env.WB_CLAUDE_CONSENT_LEVEL),
    dataDir: resolveDataDir({ dataDir: env.WB_DATA_DIR && env.WB_DATA_DIR.trim() ? env.WB_DATA_DIR : undefined }),
    claudeCommand: env.WB_CLAUDE_COMMAND && env.WB_CLAUDE_COMMAND.trim() ? env.WB_CLAUDE_COMMAND.trim() : 'claude',
    codexCommand: env.WB_CODEX_COMMAND && env.WB_CODEX_COMMAND.trim() ? env.WB_CODEX_COMMAND.trim() : 'codex',
    defaultCwd: env.WB_DEFAULT_CWD && env.WB_DEFAULT_CWD.trim() ? env.WB_DEFAULT_CWD.trim() : undefined,
    botId: assertValidBotId(env.BOT_ID ?? 'default', 'BOT_ID env'),
    mode: env.WB_MODE,
  };
}
