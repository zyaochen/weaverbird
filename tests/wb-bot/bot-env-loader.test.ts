import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveBotConfigDir, resolveConfigDir, botEnvPath } from '../../apps/wb-bot/src/config/config-paths.js';
import { loadBotEnvFromFile, normalizeBotConsentLevel, resolveBotEnvPath } from '../../apps/wb-bot/src/config/bot-env.js';

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

describe('HP-W2.5-2 config paths + bot env loader', () => {
  // resolveConfigDir tests
  it('resolveConfigDir: env unset → ~/.weaverbird/configs', () => {
    setEnv('WB_CONFIG_DIR', undefined);
    expect(resolveConfigDir()).toBe(join(homedir(), '.weaverbird', 'configs'));
  });

  it('resolveConfigDir: env set non-empty → returns env value', () => {
    setEnv('WB_CONFIG_DIR', '/custom/config/dir');
    expect(resolveConfigDir()).toBe('/custom/config/dir');
  });

  it('resolveBotConfigDir: explicit configDir overrides env', () => {
    setEnv('WB_CONFIG_DIR', '/env/config/dir');
    expect(resolveBotConfigDir({ configDir: '/explicit/config/dir' })).toBe('/explicit/config/dir');
  });

  // loadBotEnvFromFile tests
  it('loadBotEnvFromFile: valid file → returns BotConfig', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-botenv-'));
    roots.push(dir);
    const filePath = join(dir, '.env.claude');
    writeFileSync(filePath, [
      'BOT_ID=claude',
      'LARK_APP_ID=cli_test_id',
      'LARK_APP_SECRET=secret_test',
      'LARK_ENCRYPT_KEY=enc_key',
      'AGENT_ALLOWED=claude-code',
      'WB_DEFAULT_CWD=/home/user',
      'LOG_LEVEL=debug',
    ].join('\n'));

    const config = loadBotEnvFromFile(filePath);
    expect(config.botId).toBe('claude');
    expect(config.larkAppId).toBe('cli_test_id');
    expect(config.larkAppSecret).toBe('secret_test');
    expect(config.larkEncryptKey).toBe('enc_key');
    expect(config.agentAllowed).toEqual(['claude-code']);
    expect(config.defaultCwd).toBe('/home/user');
    expect(config.logLevel).toBe('debug');
    expect(config.claudeCommand).toBe('claude');
    expect(config.consentLevel).toBe('auto');
  });

  it('loadBotEnvFromFile: missing required field → throw', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-botenv-'));
    roots.push(dir);
    const filePath = join(dir, '.env.claude');
    writeFileSync(filePath, 'BOT_ID=claude\n');

    expect(() => loadBotEnvFromFile(filePath)).toThrow();
  });

  it('loadBotEnvFromFile: BOT_ID mismatch with filename → throw', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-botenv-'));
    roots.push(dir);
    const filePath = join(dir, '.env.codex');
    writeFileSync(filePath, [
      'BOT_ID=claude',
      'LARK_APP_ID=cli_test_id',
      'LARK_APP_SECRET=secret_test',
    ].join('\n'));

    expect(() => loadBotEnvFromFile(filePath)).toThrowError(/BOT_ID mismatch/);
  });

  it('loadBotEnvFromFile: file not found → throw with helpful message', () => {
    expect(() => loadBotEnvFromFile('/nonexistent/.env.ghost')).toThrowError(/not found/);
  });

  it('loadBotEnvFromFile: shipped Lark placeholders → throw actionable config error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-botenv-placeholder-'));
    roots.push(dir);
    const filePath = join(dir, '.env.claude');
    writeFileSync(filePath, [
      'BOT_ID=claude',
      'LARK_APP_ID=your_lark_app_id_here',
      'LARK_APP_SECRET=your_lark_app_secret_here',
    ].join('\n'));

    expect(() => loadBotEnvFromFile(filePath)).toThrowError(/shipped placeholder/);
  });

  it('AGENT_ALLOWED comma split + trim', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-botenv-'));
    roots.push(dir);
    const filePath = join(dir, '.env.mybot');
    writeFileSync(filePath, [
      'BOT_ID=mybot',
      'LARK_APP_ID=cli_test_id',
      'LARK_APP_SECRET=secret_test',
      'AGENT_ALLOWED=claude-code, codex , mira ',
    ].join('\n'));

    const config = loadBotEnvFromFile(filePath);
    expect(config.agentAllowed).toEqual(['claude-code', 'codex', 'mira']);
  });

  // botEnvPath helper
  it('botEnvPath returns correct path', () => {
    expect(botEnvPath('/config', 'claude')).toBe('/config/.env.claude');
  });

  it('resolveBotEnvPath uses unified bot config dir resolver', () => {
    setEnv('WB_CONFIG_DIR', '/env/config/dir');
    expect(resolveBotEnvPath('claude')).toBe('/env/config/dir/.env.claude');
    expect(resolveBotEnvPath('claude', { configDir: '/explicit/config/dir' })).toBe('/explicit/config/dir/.env.claude');
  });
});

describe('W2.5-Hotfix-batch-C P1-4 · Consent contract in wb-bot (no-TTY invariant)', () => {
  it('normalizeBotConsentLevel: strict → plan-only (no-TTY 不可兑现)', () => {
    expect(normalizeBotConsentLevel('strict')).toBe('plan-only');
  });

  it('normalizeBotConsentLevel: 其余 4 档原样透传', () => {
    expect(normalizeBotConsentLevel('plan-only')).toBe('plan-only');
    expect(normalizeBotConsentLevel('normal')).toBe('normal');
    expect(normalizeBotConsentLevel('relaxed')).toBe('relaxed');
    expect(normalizeBotConsentLevel('auto')).toBe('auto');
  });

  it('loadBotEnvFromFile: WB_CLAUDE_CONSENT_LEVEL=strict → config.consentLevel="plan-only"', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-botenv-strict-'));
    roots.push(dir);
    const filePath = join(dir, '.env.claude');
    writeFileSync(filePath, [
      'BOT_ID=claude',
      'LARK_APP_ID=cli_test_id',
      'LARK_APP_SECRET=secret_test',
      'WB_CLAUDE_CONSENT_LEVEL=strict',
    ].join('\n'));

    const config = loadBotEnvFromFile(filePath);
    expect(config.consentLevel).toBe('plan-only');
  });

  it('loadBotEnvFromFile: WB_CLAUDE_CONSENT_LEVEL=plan-only → consentLevel="plan-only" (passthrough)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-botenv-plan-'));
    roots.push(dir);
    const filePath = join(dir, '.env.claude');
    writeFileSync(filePath, [
      'BOT_ID=claude',
      'LARK_APP_ID=cli_test_id',
      'LARK_APP_SECRET=secret_test',
      'WB_CLAUDE_CONSENT_LEVEL=plan-only',
    ].join('\n'));

    const config = loadBotEnvFromFile(filePath);
    expect(config.consentLevel).toBe('plan-only');
  });

  it('loadBotEnvFromFile: 未设置 → 默认 auto (passthrough, 不被 strict-alias 影响)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-botenv-default-'));
    roots.push(dir);
    const filePath = join(dir, '.env.claude');
    writeFileSync(filePath, [
      'BOT_ID=claude',
      'LARK_APP_ID=cli_test_id',
      'LARK_APP_SECRET=secret_test',
    ].join('\n'));

    const config = loadBotEnvFromFile(filePath);
    expect(config.consentLevel).toBe('auto');
  });

  it('loadBotEnvFromFile: 非法 level → schema reject (e.g. typo "stricty")', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-botenv-bad-'));
    roots.push(dir);
    const filePath = join(dir, '.env.claude');
    writeFileSync(filePath, [
      'BOT_ID=claude',
      'LARK_APP_ID=cli_test_id',
      'LARK_APP_SECRET=secret_test',
      'WB_CLAUDE_CONSENT_LEVEL=stricty',
    ].join('\n'));

    expect(() => loadBotEnvFromFile(filePath)).toThrow();
  });
});
