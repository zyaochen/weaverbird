import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { resolveConfigDir } from '../config/config-paths.js';
import { discoverBots } from './discovery.js';
import { parseMultiArgs } from './parse-args.js';
import { Supervisor } from './supervisor.js';

const DEFAULT_SHUTDOWN_GRACE_MS = 15_000;

async function main(): Promise<void> {
  const logger = pino({ level: process.env['LOG_LEVEL'] ?? 'info' });
  const cliArgs = parseMultiArgs(process.argv.slice(2));

  if (cliArgs.help) {
    console.log('Usage: wb-bot-multi [--config <path>] [--help]');
    process.exit(0);
  }

  const configDir = cliArgs.configDir ?? resolveConfigDir();
  const discovery = discoverBots(configDir);

  for (const warning of discovery.warnings) {
    logger.warn({ configDir, file: warning.file, reason: warning.reason }, 'skipping invalid bot config');
  }

  if (discovery.bots.length === 0) {
    logger.error({ configDir }, 'no valid bot configs discovered');
    process.exit(1);
  }

  const mainJs = fileURLToPath(new URL('../main.js', import.meta.url));
  const supervisor = new Supervisor(discovery.bots, {
    bin: process.execPath,
    mainJs,
    baseEnv: process.env,
    logger,
  });

  logger.info({ configDir, botIds: discovery.bots.map((bot) => bot.botId) }, 'starting multi-bot orchestrator');
  supervisor.startAll();

  let shuttingDown = false;
  async function handleSignal(signal: 'SIGINT' | 'SIGTERM'): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down multi-bot orchestrator');
    await supervisor.shutdown(signal, DEFAULT_SHUTDOWN_GRACE_MS);
    process.exit(0);
  }

  process.on('SIGINT', () => {
    void handleSignal('SIGINT');
  });
  process.on('SIGTERM', () => {
    void handleSignal('SIGTERM');
  });

  await supervisor.untilAllExited();
  logger.info('all supervised bots exited');
  process.exit(0);
}

void main().catch((error: unknown) => {
  const logger = pino({ level: process.env['LOG_LEVEL'] ?? 'info' });
  logger.error({ err: error }, 'wb-bot-multi failed');
  process.exit(1);
});
