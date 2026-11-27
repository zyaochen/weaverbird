import { existsSync, readFileSync, statSync } from 'node:fs';
import { runEventsPath, runHeartbeatPath, runStatusPath } from '../../../../packages/core/src/paths.js';

export interface JudgeRunStateOptions {
  dataDir: string;
  staleMs: number;
  now?: number;
}

export function judgeRunState(botId: string, runId: string, opts: JudgeRunStateOptions): 'resumed' | 'lost' {
  if (botId.includes('..')) return 'lost';
  const statusPath = runStatusPath(opts.dataDir, runId, botId);
  if (!existsSync(statusPath)) return 'lost';

  const status = readFileSync(statusPath, 'utf8').trim();
  if (status !== 'running') return 'lost';

  const now = opts.now ?? Date.now();
  const l1Fresh = isHeartbeatFresh(runHeartbeatPath(opts.dataDir, runId, botId), now, opts.staleMs, 'file');
  const l2Fresh = isHeartbeatFresh(runEventsPath(opts.dataDir, runId, botId), now, opts.staleMs, 'mtime');
  return l1Fresh || l2Fresh ? 'resumed' : 'lost';
}

function isHeartbeatFresh(path: string, now: number, staleMs: number, mode: 'file' | 'mtime'): boolean {
  if (!existsSync(path)) return false;
  try {
    if (mode === 'file') {
      const ts = parseInt(readFileSync(path, 'utf8').trim(), 10) * 1000;
      return (now - ts) < staleMs;
    }
    return (now - statSync(path).mtimeMs) < staleMs;
  } catch {
    return false;
  }
}
