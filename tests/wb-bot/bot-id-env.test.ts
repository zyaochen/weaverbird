import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readEnv } from '../../apps/wb-bot/src/config/env.js';
import { createLogger } from '../../apps/wb-bot/src/boot/logger.js';

const roots: string[] = [];
const envBackup: Record<string, string | undefined> = {};

function setEnv(key: string, value: string | undefined): void {
  if (!(key in envBackup)) envBackup[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterEach(() => {
  for (const [key, value] of Object.entries(envBackup)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  Object.keys(envBackup).forEach((k) => delete envBackup[k]);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('HP-W2.5-5 BOT_ID env wiring', () => {
  it('readEnv default: BOT_ID unset → env.botId = "default"', () => {
    setEnv('BOT_ID', undefined);
    const env = readEnv({
      ...process.env,
      LARK_APP_ID: 'test_id', LARK_APP_SECRET: 'test_secret',
      BOT_ID: undefined,
    });
    expect(env.botId).toBe('default');
  });

  it('readEnv: BOT_ID = "claude" → env.botId = "claude"', () => {
    const env = readEnv({
      ...process.env,
      LARK_APP_ID: 'test_id', LARK_APP_SECRET: 'test_secret',
      BOT_ID: 'claude',
    });
    expect(env.botId).toBe('claude');
  });

  it('readEnv: BOT_ID = "INVALID!" → throw', () => {
    expect(() => readEnv({
      ...process.env,
      LARK_APP_ID: 'test_id', LARK_APP_SECRET: 'test_secret',
      BOT_ID: 'INVALID!',
    })).toThrowError(/invalid botId/);
  });

  it('readEnv: shipped Lark placeholders → throw actionable config error', () => {
    expect(() => readEnv({
      ...process.env,
      LARK_APP_ID: 'your_lark_app_id_here',
      LARK_APP_SECRET: 'your_lark_app_secret_here',
    })).toThrowError(/shipped placeholder/);
  });

  it('multi-bot logger path isolation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-botid-'));
    roots.push(dir);

    const { logFilePath: pathDefault } = await createLogger({ dataDir: dir, botId: 'default', level: 'info' });
    const { logFilePath: pathClaude } = await createLogger({ dataDir: dir, botId: 'claude', level: 'info' });

    expect(pathDefault).toBe(join(dir, 'logs', 'default', 'wb-bot.log'));
    expect(pathClaude).toBe(join(dir, 'logs', 'claude', 'wb-bot.log'));
    expect(pathDefault).not.toBe(pathClaude);

    expect(existsSync(join(dir, 'logs', 'default'))).toBe(true);
    expect(existsSync(join(dir, 'logs', 'claude'))).toBe(true);
  });
});
