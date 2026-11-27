import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { runPidPath, runsRootDir } from '../paths.js';

/**
 * Resolve cli subprocess pid from wb-runner's pid file convention.
 * Layout: <dataDir>/runs/<botId>/<runId>/pid
 */
export function resolveCliPid(dataDir: string, runId: string): number | null {
  const runsDir = runsRootDir(dataDir);
  if (!existsSync(runsDir)) return null;

  let botIds: string[];
  try {
    botIds = readdirSync(runsDir).filter((name) => {
      try {
        return statSync(join(runsDir, name)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return null;
  }

  for (const botId of botIds) {
    const pidPath = runPidPath(dataDir, runId, botId);
    if (!existsSync(pidPath)) continue;
    try {
      const raw = readFileSync(pidPath, 'utf8').trim();
      const pid = Number.parseInt(raw, 10);
      if (Number.isFinite(pid) && pid > 0) return pid;
    } catch {
      // try next botId directory
    }
  }

  return null;
}
