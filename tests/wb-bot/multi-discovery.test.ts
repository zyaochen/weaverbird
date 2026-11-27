import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverBots } from '../../apps/wb-bot/src/multi/discovery.js';

function writeBotEnv(dir: string, botId: string, extra: Record<string, string> = {}): void {
  const lines = {
    BOT_ID: botId,
    LARK_APP_ID: `app_${botId}`,
    LARK_APP_SECRET: `secret_${botId}`,
    AGENT_ALLOWED: 'claude-code',
    ...extra,
  };
  writeFileSync(join(dir, `.env.${botId}`), Object.entries(lines).map(([key, value]) => `${key}=${value}`).join('\n'));
}

describe('discoverBots', () => {
  let dir = '';

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  it('throws when configDir does not exist', () => {
    expect(() => discoverBots('/tmp/does-not-exist-weaverbird')).toThrow('configDir not found');
  });

  it('returns empty result for empty directory', () => {
    dir = mkdtempSync(join(tmpdir(), 'wb-multi-discovery-'));
    expect(discoverBots(dir)).toEqual({ bots: [], warnings: [] });
  });

  it('discovers valid bots sorted by botId', () => {
    dir = mkdtempSync(join(tmpdir(), 'wb-multi-discovery-'));
    writeBotEnv(dir, 'codex');
    writeBotEnv(dir, 'claude');

    const result = discoverBots(dir);
    expect(result.warnings).toEqual([]);
    expect(result.bots.map((bot) => bot.botId)).toEqual(['claude', 'codex']);
  });

  it('ignores .env.local and .env.example helper files', () => {
    dir = mkdtempSync(join(tmpdir(), 'wb-multi-discovery-'));
    writeFileSync(join(dir, '.env.local'), 'BOT_ID=local\n');
    writeFileSync(join(dir, '.env.example'), 'BOT_ID=example\n');
    writeBotEnv(dir, 'claude');

    const result = discoverBots(dir);
    expect(result.bots.map((bot) => bot.botId)).toEqual(['claude']);
    expect(result.warnings).toEqual([]);
  });

  it('warns and skips invalid filename botId', () => {
    dir = mkdtempSync(join(tmpdir(), 'wb-multi-discovery-'));
    writeFileSync(join(dir, '.env.INVALID!'), 'BOT_ID=INVALID!\nLARK_APP_ID=a\nLARK_APP_SECRET=b\n');

    const logger = { warn: vi.fn() };
    const result = discoverBots(dir, logger as never);
    expect(result.bots).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.file).toBe('.env.INVALID!');
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('warns and skips BOT_ID mismatch', () => {
    dir = mkdtempSync(join(tmpdir(), 'wb-multi-discovery-'));
    writeBotEnv(dir, 'claude', { BOT_ID: 'codex' });

    const result = discoverBots(dir);
    expect(result.bots).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.reason).toContain('BOT_ID mismatch');
  });

  it('warns and skips invalid config contents', () => {
    dir = mkdtempSync(join(tmpdir(), 'wb-multi-discovery-'));
    writeFileSync(join(dir, '.env.claude'), 'BOT_ID=claude\nLARK_APP_ID=app_only\n');

    const result = discoverBots(dir);
    expect(result.bots).toEqual([]);
    expect(result.warnings).toHaveLength(1);
  });

  it('keeps valid bots when another config is broken', () => {
    dir = mkdtempSync(join(tmpdir(), 'wb-multi-discovery-'));
    writeBotEnv(dir, 'claude');
    writeFileSync(join(dir, '.env.codex'), 'BOT_ID=codex\nLARK_APP_ID=codex-only\n');

    const result = discoverBots(dir);
    expect(result.bots.map((bot) => bot.botId)).toEqual(['claude']);
    expect(result.warnings).toHaveLength(1);
  });

  it('ignores nested files in subdirectories', () => {
    dir = mkdtempSync(join(tmpdir(), 'wb-multi-discovery-'));
    mkdirSync(join(dir, 'nested'));
    writeFileSync(join(dir, 'nested', '.env.claude'), 'BOT_ID=claude\nLARK_APP_ID=a\nLARK_APP_SECRET=b\n');

    const result = discoverBots(dir);
    expect(result).toEqual({ bots: [], warnings: [] });
  });

  it('returns all invalid files as warnings', () => {
    dir = mkdtempSync(join(tmpdir(), 'wb-multi-discovery-'));
    writeFileSync(join(dir, '.env.INVALID!'), 'BOT_ID=INVALID!\nLARK_APP_ID=a\nLARK_APP_SECRET=b\n');
    writeFileSync(join(dir, '.env.claude'), 'BOT_ID=claude\nLARK_APP_ID=app_only\n');

    const result = discoverBots(dir);
    expect(result.bots).toEqual([]);
    expect(result.warnings).toHaveLength(2);
  });

  it('accepts multiple valid bots with warnings mixed in', () => {
    dir = mkdtempSync(join(tmpdir(), 'wb-multi-discovery-'));
    writeBotEnv(dir, 'claude');
    writeBotEnv(dir, 'codex');
    writeFileSync(join(dir, '.env.BAD!'), 'BOT_ID=BAD!\nLARK_APP_ID=a\nLARK_APP_SECRET=b\n');

    const result = discoverBots(dir);
    expect(result.bots.map((bot) => bot.botId)).toEqual(['claude', 'codex']);
    expect(result.warnings).toHaveLength(1);
  });

  it('does not treat plain .env as a bot config', () => {
    dir = mkdtempSync(join(tmpdir(), 'wb-multi-discovery-'));
    writeFileSync(join(dir, '.env'), 'BOT_ID=default\n');
    writeBotEnv(dir, 'claude');

    const result = discoverBots(dir);
    expect(result.bots.map((bot) => bot.botId)).toEqual(['claude']);
  });
});
