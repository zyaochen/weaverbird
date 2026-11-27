import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { botHeartbeatPath, botHeartbeatTempPath, runsDir } from '../../../../packages/core/src/paths.js';

export interface BotHeartbeatOptions {
  dataDir: string;
  botId: string;
  intervalMs?: number;
  nowFn?: () => number;
}

export interface BotHeartbeatHandle {
  stop(): void;
  writeOnce(): void;
}

export function startBotHeartbeat(opts: BotHeartbeatOptions): BotHeartbeatHandle {
  const intervalMs = opts.intervalMs ?? 10_000;
  const heartbeatDir = runsDir(opts.dataDir, opts.botId);
  const heartbeatPath = botHeartbeatPath(opts.dataDir, opts.botId);
  const tmpPath = botHeartbeatTempPath(opts.dataDir, opts.botId);
  const now = opts.nowFn ?? Date.now;

  function writeOnce(): void {
    mkdirSync(heartbeatDir, { recursive: true });
    writeFileSync(tmpPath, String(Math.floor(now() / 1000)));
    renameSync(tmpPath, heartbeatPath);
  }

  writeOnce();
  const timer = setInterval(writeOnce, intervalMs);
  return {
    stop: () => clearInterval(timer),
    writeOnce,
  };
}
