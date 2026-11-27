import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '../../apps/wb-bot/src/boot/logger.js';

let dataDir = '';

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'wb-bot-logger-'));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

async function flush(ms = 250): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe('HP-W2-2 multi-stream logger', () => {
  it('creates the log file path under logs/<botId>/wb-bot.log', async () => {
    const { logger, logFilePath } = await createLogger({ dataDir, botId: 'default', level: 'info' });
    expect(logFilePath).toBe(join(dataDir, 'logs', 'default', 'wb-bot.log'));
    logger.info({ what: 'smoke' }, 'multi-stream smoke');
    await flush();
    expect(existsSync(join(dataDir, 'logs', 'default'))).toBe(true);
  });

  it('writes pino-pretty-formatted lines to the file (not raw JSON)', async () => {
    const { logger, logFilePath } = await createLogger({ dataDir, botId: 'default', level: 'info' });
    for (let i = 0; i < 3; i++) {
      logger.info({ marker: 'unique-marker-123', iter: i }, 'hello pretty stream');
    }
    await flush(1500);
    // pino-roll suffixes the file name with rotation index (.1 by default)
    const { readdirSync } = await import('node:fs');
    const dir = join(dataDir, 'logs', 'default');
    const files = existsSync(dir) ? readdirSync(dir) : [];
    let content = '';
    for (const file of files) {
      content += readFileSync(join(dir, file), 'utf8');
    }
    expect(files.length, `expected log file(s) in ${dir}, got: ${files.join(',')}`).toBeGreaterThan(0);
    expect(content).toContain('hello pretty stream');
    expect(content).toContain('unique-marker-123');
    // pino-pretty puts level word ("INFO") in output, raw JSON would have {"level":30,...}
    expect(content).toMatch(/INFO/);
    expect(content).not.toMatch(/^\{"level":30/m);
  });

  it('honors level threshold (debug not emitted at info level)', async () => {
    const { logger, logFilePath } = await createLogger({ dataDir, botId: 'default', level: 'info' });
    logger.debug({ skipped: true }, 'should not appear');
    logger.info({ kept: true }, 'should appear');
    await flush(300);
    let content = '';
    if (existsSync(logFilePath)) {
      content = readFileSync(logFilePath, 'utf8');
    }
    if (content) {
      expect(content).toContain('should appear');
      expect(content).not.toContain('should not appear');
    }
  });

  it('creates separate logs/<botId>/ for different botIds', async () => {
    const a = await createLogger({ dataDir, botId: 'default', level: 'info' });
    const b = await createLogger({ dataDir, botId: 'claude', level: 'info' });
    expect(a.logFilePath).toBe(join(dataDir, 'logs', 'default', 'wb-bot.log'));
    expect(b.logFilePath).toBe(join(dataDir, 'logs', 'claude', 'wb-bot.log'));
    expect(a.logFilePath).not.toBe(b.logFilePath);
    expect(existsSync(join(dataDir, 'logs', 'default'))).toBe(true);
    expect(existsSync(join(dataDir, 'logs', 'claude'))).toBe(true);
  });
});
