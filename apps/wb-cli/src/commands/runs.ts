import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { runHeartbeatPath, runSpecPath, runStatusPath, runsRootDir, resolveDataDir } from '../../../../packages/core/src/paths.js';

type RunEntry = {
  runId: string;
  botId: string;
  agentId: string;
  status: string;
  startedAt: string;
  lastActive: number;
};

function getDataDir(): string {
  return resolveDataDir({ dataDir: process.env['WB_DATA_DIR'] });
}

export function listRuns(): RunEntry[] {
  const dataDir = getDataDir();
  const runsDir = runsRootDir(dataDir);
  if (!existsSync(runsDir)) return [];

  const entries: RunEntry[] = [];
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

  try {
    for (const botId of readdirSync(runsDir)) {
      const botDir = join(runsDir, botId);
      if (!statSync(botDir).isDirectory()) continue;

      for (const runId of readdirSync(botDir)) {
        const runDir = join(botDir, runId);
        if (!statSync(runDir).isDirectory()) continue;

        const specPath = runSpecPath(dataDir, runId, botId);
        const statusPath = runStatusPath(dataDir, runId, botId);
        const hbPath = runHeartbeatPath(dataDir, runId, botId);

        let agentId = 'unknown';
        let startedAt = '';
        try {
          const spec = JSON.parse(readFileSync(specPath, 'utf8'));
          agentId = spec.agentId ?? 'unknown';
          startedAt = spec.startedAt ?? '';
        } catch { /* spec may not exist */ }

        let status = 'unknown';
        try { status = readFileSync(statusPath, 'utf8').trim(); } catch { /* ok */ }

        let lastActive = 0;
        try {
          const hb = parseInt(readFileSync(hbPath, 'utf8').trim(), 10) * 1000;
          if (!isNaN(hb)) lastActive = hb;
        } catch { /* ok */ }
        if (!lastActive) {
          try { lastActive = statSync(runDir).mtimeMs; } catch { /* ok */ }
        }

        if (lastActive < sevenDaysAgo) continue;

        entries.push({ runId, botId, agentId, status, startedAt, lastActive });
      }
    }
  } catch { /* top-level read failure */ }

  entries.sort((a, b) => b.lastActive - a.lastActive);
  return entries;
}

export function runsCommand(): number {
  const entries = listRuns();
  if (entries.length === 0) {
    process.stderr.write('No runs found in the last 7 days.\n');
    return 0;
  }

  const mostActive = entries[0]!.runId;
  for (const e of entries) {
    const marker = e.runId === mostActive ? ' ★' : '';
    const short = e.runId.length > 20 ? e.runId.slice(0, 20) : e.runId;
    process.stdout.write(`${short}\t${e.botId}\t${e.agentId}\t${e.status}\t${e.startedAt || '-'}${marker}\n`);
  }
  return 0;
}
