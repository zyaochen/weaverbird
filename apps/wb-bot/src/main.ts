import pino from 'pino';
import { botDbPath, resolveDataDir } from '../../../packages/core/src/paths.js';
import { BindingStore } from './binding/store.js';
import { readEnv } from './config/env.js';
import { startTransport } from './feishu/transport.js';
import { createBotAgentRegistry } from './agent-registry.js';
import { validateCwd, CWD_DENYLIST } from './security/cwd-guard.js';
import { ensureDataDirIntegrity } from './boot/integrity.js';
import { createLogger } from './boot/logger.js';
import { TaskIndex } from './binding/task-index.js';
import { sendAdminAlert } from './feishu/admin-alert.js';
import { parseArgs } from './cli/parse-args.js';
import { assertValidBotId } from './security/bot-id-validator.js';
import { resolveConfigDir, botEnvPath } from './config/config-paths.js';
import { loadBotEnvFromFile } from './config/bot-env.js';
import { loadApprovalCodeOwnerConfig } from './config/approval-code-owners.js';
import { startBotHeartbeat } from './heartbeat/bot-heartbeat.js';
import { COMMAND_CATALOG, validateCatalog } from '../../../packages/core/src/captain/index.js';

const TASK_INDEX_SCAN_INTERVAL_MS = 5 * 60 * 1000;
const SHUTDOWN_GRACE_MS = 15_000;
const DRAIN_MARKER = '__WB_DRAINED__';

async function main(): Promise<void> {
  const cliArgs = parseArgs(process.argv.slice(2));
  if (cliArgs.help) {
    console.log('Usage: wb-bot [--bot <botId>] [--help]');
    process.exit(0);
  }

  const isMultiBot = cliArgs.botId !== undefined || process.env['WB_MODE'] === 'multi-bot';
  if (isMultiBot) {
    const raw = cliArgs.botId ?? process.env['BOT_ID'];
    if (!raw) {
      console.error('multi-bot mode requires --bot <botId> or BOT_ID env');
      process.exit(1);
    }
    const botId = assertValidBotId(raw, 'CLI --bot or BOT_ID env');
    const configDir = resolveConfigDir();
    const filePath = botEnvPath(configDir, botId);
    const botCfg = loadBotEnvFromFile(filePath);
    process.env['BOT_ID'] = botCfg.botId;
    process.env['LARK_APP_ID'] = botCfg.larkAppId;
    process.env['LARK_APP_SECRET'] = botCfg.larkAppSecret;
    process.env['LARK_ENCRYPT_KEY'] = botCfg.larkEncryptKey;
    process.env['LARK_VERIFICATION_TOKEN'] = botCfg.larkVerificationToken;
    process.env['AGENT_ALLOWED'] = botCfg.agentAllowed.join(',');
    if (botCfg.defaultCwd) process.env['WB_DEFAULT_CWD'] = botCfg.defaultCwd;
    if (botCfg.approvalCodeOwnerConfigPath) {
      process.env['WB_APPROVAL_CODE_OWNER_CONFIG_PATH'] = botCfg.approvalCodeOwnerConfigPath;
    }
    process.env['WB_CLAUDE_COMMAND'] = botCfg.claudeCommand;
    process.env['WB_CODEX_COMMAND'] = botCfg.codexCommand;
    process.env['WB_CLAUDE_CONSENT_LEVEL'] = botCfg.consentLevel;
    process.env['LOG_LEVEL'] = botCfg.logLevel;
    process.env['WB_MODE'] = 'multi-bot';
  }

  const env = readEnv();
  if (env.WB_APPROVAL_CODE_OWNER_CONFIG_PATH) {
    loadApprovalCodeOwnerConfig({ configPath: env.WB_APPROVAL_CODE_OWNER_CONFIG_PATH });
  }
  const bootLogger = pino({ level: env.LOG_LEVEL });
  validateCatalog(Object.keys(COMMAND_CATALOG));

  const integrity = ensureDataDirIntegrity(env.dataDir, bootLogger);
  if (integrity.unwritable.length > 0) {
    void sendAdminAlert(null, env.dataDir, `boot integrity: ${integrity.unwritable.length} directories not writable: ${integrity.unwritable.join(', ')}`, 'error');
  }

  const { logger, logFilePath } = await createLogger({
    dataDir: env.dataDir,
    botId: env.botId,
    level: env.LOG_LEVEL,
  });
  logger.info({ logFilePath, botId: env.botId, mode: env.mode }, '📝 logger multi-stream ready (stdout + pino-pretty file, daily rotation, retain 7)');

  const store = new BindingStore(botDbPath(env.dataDir));

  if (store.isReadOnly) {
    logger.error({ error: store.migrationResult.error }, '⛔ database migration failed, wb-bot starting in read-only mode');
    void sendAdminAlert(null, env.dataDir, `database migration failed: ${store.migrationResult.error ?? 'unknown'}; wb-bot started in read-only mode`, 'error');
  } else {
    logger.info({ migration: store.migrationResult }, '✅ database migrations completed');
  }

  let defaultCwd: string | undefined;
  if (env.defaultCwd) {
    // WB_DEFAULT_CWD is operator-controlled startup config; only check denylist
    const result = validateCwd(env.defaultCwd, [env.defaultCwd], CWD_DENYLIST);
    if (!result.ok) {
      logger.error({ WB_DEFAULT_CWD: env.defaultCwd, reason: result.reason }, '⛔ WB_DEFAULT_CWD is not valid, ignoring');
      void sendAdminAlert(null, env.dataDir, `WB_DEFAULT_CWD invalid (${env.defaultCwd}): ${result.reason}; falling back to per-message cwd`, 'warn');
    } else {
      defaultCwd = result.path;
      logger.info({ defaultCwd }, '✅ using WB_DEFAULT_CWD as fallback cwd');
    }
  }

  const taskIndex = new TaskIndex(env.dataDir, env.botId);
  taskIndex.scan();
  const taskIndexInterval = setInterval(() => taskIndex.scheduleScan(), TASK_INDEX_SCAN_INTERVAL_MS);
  logger.info({ taskIndexSize: taskIndex.size }, '📚 TaskIndex initialized + scheduled');

  const botHeartbeat = startBotHeartbeat({ dataDir: env.dataDir, botId: env.botId });
  logger.info({ botId: env.botId }, '💓 bot self-heartbeat started');

  logger.info({ dataDir: env.dataDir, claudeCommand: env.claudeCommand, codexCommand: env.codexCommand }, '🚀 starting wb-bot');
  const { handler, close } = await startTransport(
    createBotAgentRegistry({ dataDir: env.dataDir, claudeCommand: env.claudeCommand, codexCommand: env.codexCommand }),
    store,
    defaultCwd,
    env.WB_CLAUDE_CONSENT_LEVEL,
    env.dataDir,
    { botId: env.botId, taskIndex, logFilePath },
  );
  logger.info('✅ wb-bot transport started');

  let shuttingDown = false;
  async function shutdown(signal: 'SIGINT' | 'SIGTERM'): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, '🛑 shutting down');
    clearInterval(taskIndexInterval);
    botHeartbeat.stop();
    handler.beginDraining();
    await handler.stopAllSessions(SHUTDOWN_GRACE_MS);
    process.stdout.write(`${DRAIN_MARKER}\n`);
    await close();
    store.close();
    process.exit(0);
  }

  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
}

void main().catch((error: unknown) => {
  const logger = pino({ level: process.env['LOG_LEVEL'] ?? 'info' });
  logger.error({ err: error }, '🔥 wb-bot failed');
  // Best-effort fatal admin alert; readEnv() may itself have failed, so fall back to env or default
  const dataDir = resolveDataDir();
  const message = error instanceof Error ? error.message : String(error);
  void sendAdminAlert(null, dataDir, `wb-bot fatal startup failure: ${message}`, 'fatal').catch(() => {
    // file write may also fail (e.g. dataDir missing); nothing more we can do
  });
  process.exit(1);
});
