import { chmodSync, existsSync, mkdirSync, statSync, accessSync, constants } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from 'pino';

const REQUIRED_MODE = 0o700;
const REQUIRED_SUBDIRS = ['data', 'runs', 'logs'] as const;

function ensureDir(dir: string, logger: Logger): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: REQUIRED_MODE });
    logger.info({ dir }, 'created directory with mode 0700');
    return;
  }
  const stat = statSync(dir);
  const currentMode = stat.mode & 0o777;
  if (currentMode !== REQUIRED_MODE) {
    logger.warn({ dir, currentMode: `0${currentMode.toString(8)}`, requiredMode: '0700' }, 'directory mode incorrect, fixing');
    chmodSync(dir, REQUIRED_MODE);
  }
}

function isWritable(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export interface IntegrityResult {
  unwritable: string[];
}

export function ensureDataDirIntegrity(dataDir: string, logger: Logger): IntegrityResult {
  ensureDir(dataDir, logger);

  for (const sub of REQUIRED_SUBDIRS) {
    const subDir = join(dataDir, sub);
    ensureDir(subDir, logger);
  }

  const unwritable: string[] = [];
  for (const sub of REQUIRED_SUBDIRS) {
    const subDir = join(dataDir, sub);
    if (!isWritable(subDir)) {
      unwritable.push(subDir);
    }
  }
  if (!isWritable(dataDir)) {
    unwritable.push(dataDir);
  }

  if (unwritable.length > 0) {
    logger.warn({ unwritable }, 'some directories are not writable after chmod attempt; wb-bot may not function correctly');
  }

  return { unwritable };
}
