import pino from 'pino';
import pinoPretty from 'pino-pretty';
import pinoRoll from 'pino-roll';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { botLogPath } from '../../../../packages/core/src/paths.js';

export type CreateLoggerOptions = {
  dataDir: string;
  botId: string;
  level: string;
};

export type LoggerHandle = {
  logger: pino.Logger;
  logFilePath: string;
};

/**
 * Two-stream pino logger (HP-W2-2 + Block E E0):
 *
 *   stdout (raw JSON)  → launchd captures, /var/log diagnostics path
 *   file               → pino-pretty (colorize=false) → pino-roll
 *                          path: <dataDir>/logs/<botId>/wb-bot.log
 *                          rotation: daily, keep 7 (limit.count=7)
 *
 * Both streams receive every record at the same level. Stdout vs file are
 * not mutually exclusive (A.M-5): launchd / stdout redirection still works,
 * and /logs can read the pretty-formatted file (C.M-4).
 *
 * The function is async because pino-roll initialization needs to detect
 * the current rotation file. main.ts awaits this before booting transport.
 */
export async function createLogger(opts: CreateLoggerOptions): Promise<LoggerHandle> {
  const logFilePath = botLogPath(opts.dataDir, opts.botId);
  mkdirSync(dirname(logFilePath), { recursive: true, mode: 0o700 });

  const rollStream = await pinoRoll({
    file: logFilePath,
    frequency: 'daily',
    mkdir: true,
    limit: { count: 7 },
  });

  const prettyStream = pinoPretty({
    colorize: false,
    destination: rollStream,
    sync: true,
    translateTime: 'yyyy-mm-dd HH:MM:ss.l',
    ignore: 'pid,hostname',
  });

  const stdoutStream = pino.destination(1);

  const logger = pino(
    { level: opts.level },
    pino.multistream([
      { stream: stdoutStream, level: opts.level as pino.Level },
      { stream: prettyStream as unknown as NodeJS.WritableStream, level: opts.level as pino.Level },
    ]),
  );

  return { logger, logFilePath };
}
