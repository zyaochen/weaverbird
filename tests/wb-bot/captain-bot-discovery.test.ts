import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverBotsWithStatus } from '../../apps/wb-bot/src/captain/bot-discovery.js';

let root = '';

function writeBotEnv(configDir: string, botId: string, agentAllowed = 'claude-code'): void {
  writeFileSync(join(configDir, `.env.${botId}`), [
    `BOT_ID=${botId}`,
    `LARK_APP_ID=app_${botId}`,
    `LARK_APP_SECRET=secret_${botId}`,
    `AGENT_ALLOWED=${agentAllowed}`,
  ].join('\n'));
}

function writeHeartbeat(dataDir: string, botId: string, tsSec: string): void {
  const dir = join(dataDir, 'runs', botId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'heartbeat'), tsSec);
}

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
});

describe('discoverBotsWithStatus', () => {
  it('marks bots online when heartbeat is fresh and extracts agentAllowed', () => {
    root = mkdtempSync(join(tmpdir(), 'wb-captain-discovery-'));
    const configDir = join(root, 'configs');
    const dataDir = join(root, 'data');
    mkdirSync(configDir, { recursive: true });

    writeBotEnv(configDir, 'default', 'claude-code,codex');
    writeBotEnv(configDir, 'claude', 'claude-code');
    writeBotEnv(configDir, 'codex', 'codex');
    writeHeartbeat(dataDir, 'default', '100');
    writeHeartbeat(dataDir, 'claude', '100');
    writeHeartbeat(dataDir, 'codex', '100');

    const result = discoverBotsWithStatus({ configDir, dataDir, staleMs: 30_000, nowFn: () => 120_000 });
    expect(result.warnings).toEqual([]);
    expect(result.bots.map((bot) => bot.botId)).toEqual(['claude', 'codex', 'default']);
    expect(result.bots.every((bot) => bot.online)).toBe(true);
    expect(result.bots.find((bot) => bot.botId === 'default')?.agentAllowed).toEqual(['claude-code', 'codex']);
  });

  it('marks missing heartbeat as offline with null timestamp', () => {
    root = mkdtempSync(join(tmpdir(), 'wb-captain-discovery-'));
    const configDir = join(root, 'configs');
    const dataDir = join(root, 'data');
    mkdirSync(configDir, { recursive: true });

    writeBotEnv(configDir, 'default');
    const result = discoverBotsWithStatus({ configDir, dataDir, nowFn: () => 120_000 });
    expect(result.bots[0]).toMatchObject({ online: false, lastHeartbeatAt: null });
  });

  it('marks stale heartbeat as offline with timestamp retained', () => {
    root = mkdtempSync(join(tmpdir(), 'wb-captain-discovery-'));
    const configDir = join(root, 'configs');
    const dataDir = join(root, 'data');
    mkdirSync(configDir, { recursive: true });

    writeBotEnv(configDir, 'default');
    writeHeartbeat(dataDir, 'default', '10');
    const result = discoverBotsWithStatus({ configDir, dataDir, staleMs: 30_000, nowFn: () => 120_000 });
    expect(result.bots[0]).toMatchObject({ online: false, lastHeartbeatAt: 10_000 });
  });

  it('swallows malformed heartbeat files and keeps bot offline', () => {
    root = mkdtempSync(join(tmpdir(), 'wb-captain-discovery-'));
    const configDir = join(root, 'configs');
    const dataDir = join(root, 'data');
    mkdirSync(configDir, { recursive: true });

    writeBotEnv(configDir, 'default');
    writeHeartbeat(dataDir, 'default', 'not-a-number');
    const logger = { warn: vi.fn(), info: vi.fn() };
    const result = discoverBotsWithStatus({ configDir, dataDir, logger, nowFn: () => 120_000 });
    expect(result.bots[0]).toMatchObject({ online: false, lastHeartbeatAt: null });
  });

  it('returns empty lists for empty config dir', () => {
    root = mkdtempSync(join(tmpdir(), 'wb-captain-discovery-'));
    const configDir = join(root, 'configs');
    const dataDir = join(root, 'data');
    mkdirSync(configDir, { recursive: true });

    expect(discoverBotsWithStatus({ configDir, dataDir })).toEqual({ bots: [], warnings: [] });
  });

  it('preserves warnings from invalid env files and excludes them from bots', () => {
    root = mkdtempSync(join(tmpdir(), 'wb-captain-discovery-'));
    const configDir = join(root, 'configs');
    const dataDir = join(root, 'data');
    mkdirSync(configDir, { recursive: true });

    writeBotEnv(configDir, 'default');
    writeFileSync(join(configDir, '.env.INVALID!'), 'BOT_ID=INVALID!\nLARK_APP_ID=x\nLARK_APP_SECRET=y\n');

    const result = discoverBotsWithStatus({ configDir, dataDir, nowFn: () => 120_000 });
    expect(result.bots.map((bot) => bot.botId)).toEqual(['default']);
    expect(result.warnings).toHaveLength(1);
  });
});
