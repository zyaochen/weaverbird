import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { ControlPlaneConfig } from '../feishu/event-handler.js';

const DEFAULT_TAIL = 50;
const MAX_TAIL = 500;

/**
 * Resolve the current log file. pino-roll appends a rotation number suffix
 * (e.g. "wb-bot.log.1") so the configured logFilePath may not exist directly.
 * Fall back to the most-recently-modified file matching "<basename>.*" in
 * the same directory.
 */
function resolveCurrentLogFile(basePath: string): string | null {
  if (existsSync(basePath)) return basePath;
  const dir = dirname(basePath);
  const base = basename(basePath);
  if (!existsSync(dir)) return null;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  const candidates: { path: string; mtime: number }[] = [];
  for (const entry of entries) {
    if (!entry.startsWith(base)) continue;
    const candidatePath = join(dir, entry);
    try {
      candidates.push({ path: candidatePath, mtime: statSync(candidatePath).mtimeMs });
    } catch {
      // skip
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.path ?? null;
}

function parseTail(args: string[]): { tail: number; rejected: string | null } {
  for (const arg of args) {
    if (!arg) continue;
    if (arg.startsWith('bot=')) {
      return { tail: DEFAULT_TAIL, rejected: 'single-bot 模式下 /logs 不接 bot=<id> 参数 (启用 multi-bot 后才生效); 直接使用 /logs [tail=N] 即可' };
    }
    if (/^tail=\d+$/.test(arg)) {
      const v = parseInt(arg.slice('tail='.length), 10);
      return { tail: Math.min(MAX_TAIL, Math.max(1, v)), rejected: null };
    }
    if (/^\d+$/.test(arg)) {
      const v = parseInt(arg, 10);
      return { tail: Math.min(MAX_TAIL, Math.max(1, v)), rejected: null };
    }
    return { tail: DEFAULT_TAIL, rejected: `single-bot 模式下 /logs 不接 <botId> 参数 (启用 multi-bot 后才生效); 直接使用 /logs [tail=N] 即可` };
  }
  return { tail: DEFAULT_TAIL, rejected: null };
}

function readTail(filePath: string, tail: number): string[] {
  if (!existsSync(filePath)) return [];
  try {
    const content = readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines.slice(-tail);
  } catch {
    return [];
  }
}

export function renderLogs(args: string[], cp: ControlPlaneConfig): string {
  const { tail, rejected } = parseTail(args);
  if (rejected) return `❌ ${rejected}`;
  const actualFile = resolveCurrentLogFile(cp.logFilePath);
  const lines = actualFile ? readTail(actualFile, tail) : [];
  const header = [
    `📋 logs/${cp.botId}/wb-bot.log (tail ${tail}, single-bot mode)`,
    '─────────────────────────────────────',
  ];
  const body = lines.length === 0 ? ['(no log lines; file is empty or not yet created)'] : lines;
  const footer = [
    '─────────────────────────────────────',
    `(file: ${actualFile ?? cp.logFilePath})`,
  ];
  return [...header, ...body, ...footer].join('\n');
}
