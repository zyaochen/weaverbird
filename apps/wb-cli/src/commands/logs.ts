import { existsSync, readFileSync, statSync, openSync, readSync, closeSync, watch } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runHeartbeatPath, runDir as runPath, runsRootDir, resolveDataDir } from '../../../../packages/core/src/paths.js';

function getDataDir(): string {
  return resolveDataDir({ dataDir: process.env['WB_DATA_DIR'] });
}

function findLastActiveRunDir(): string | null {
  const dataDir = getDataDir();
  const runsDir = runsRootDir(dataDir);
  if (!existsSync(runsDir)) return null;

  let best: { dir: string; mtime: number } | null = null;

  try {
    for (const botId of readdirSync(runsDir)) {
      const botDir = join(runsDir, botId);
      if (!statSync(botDir).isDirectory()) continue;
      for (const runId of readdirSync(botDir)) {
        const runDir = join(botDir, runId);
        if (!statSync(runDir).isDirectory()) continue;
        const hbPath = runHeartbeatPath(dataDir, runId, botId);
        let mtime = 0;
        try {
          mtime = parseInt(readFileSync(hbPath, 'utf8').trim(), 10) * 1000;
        } catch {
          try { mtime = statSync(runDir).mtimeMs; } catch { /* ok */ }
        }
        if (!best || mtime > best.mtime) best = { dir: runDir, mtime };
      }
    }
  } catch { /* ok */ }

  return best?.dir ?? null;
}

function resolveLogFile(runDir: string): string | null {
  const typescript = join(runDir, 'typescript.log');
  if (existsSync(typescript)) return typescript;
  const output = join(runDir, 'output.log');
  if (existsSync(output)) return output;
  return null;
}

export function logsCommand(args: { follow: boolean; tail: number; runId?: string }): number {
  let runDir: string | null;

  if (args.runId) {
    const dataDir = getDataDir();
    const runsDir = runsRootDir(dataDir);
    // search across botIds
    runDir = null;
    try {
      for (const botId of readdirSync(runsDir)) {
        const candidate = runPath(dataDir, args.runId, botId);
        if (existsSync(candidate) && statSync(candidate).isDirectory()) {
          runDir = candidate;
          break;
        }
      }
    } catch { /* ok */ }
  } else {
    runDir = findLastActiveRunDir();
  }

  if (!runDir) {
    process.stderr.write('No run directory found. Use --run-id or ensure WB_DATA_DIR is set.\n');
    return 1;
  }

  const logFile = resolveLogFile(runDir);
  if (!logFile) {
    process.stderr.write(`No log file in ${runDir}\n`);
    return 1;
  }

  if (args.follow) {
    return followFile(logFile);
  }

  const content = readFileSync(logFile, 'utf8');
  const lines = content.split('\n');
  const start = args.tail > 0 ? Math.max(0, lines.length - args.tail) : 0;
  process.stdout.write(lines.slice(start).join('\n'));
  if (!content.endsWith('\n')) process.stdout.write('\n');
  return 0;
}

function followFile(path: string): number {
  let offset = 0;
  try { offset = statSync(path).size; } catch { /* start from 0 */ }

  const read = () => {
    try {
      const size = statSync(path).size;
      if (size <= offset) return;
      const fd = openSync(path, 'r');
      const buf = Buffer.alloc(size - offset);
      readSync(fd, buf, 0, buf.length, offset);
      closeSync(fd);
      offset = size;
      process.stdout.write(buf);
    } catch { /* file may not exist yet */ }
  };

  read();
  const watcher = watch(path, { persistent: true }, () => read());
  const timer = setInterval(read, 1000);

  process.on('SIGINT', () => {
    watcher.close();
    clearInterval(timer);
    process.exit(0);
  });

  // Keep process alive
  return 0;
}
