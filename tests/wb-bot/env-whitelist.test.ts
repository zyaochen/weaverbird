import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeCodeAgent } from '../../packages/core/src/agent/claude-code.js';
import { createBotAgentRegistry } from '../../apps/wb-bot/src/agent-registry.js';
import { readEnv } from '../../apps/wb-bot/src/config/env.js';
import {
  buildAgentEnv,
  buildClaudeAgentEnv,
  filterBaseEnv,
  shouldPreferClaudeOAuth,
} from '../../apps/wb-bot/src/security/env-whitelist.js';

describe('env whitelist', () => {
  it('drops secret-like env vars from base env', () => {
    const result = filterBaseEnv({
      PATH: '/bin',
      HOME: '/tmp/home',
      LARK_APP_SECRET: 'secret',
      OPENAI_API_KEY: 'key',
      CUSTOM_VALUE: 'x',
    });
    expect(result).toEqual({ PATH: '/bin', HOME: '/tmp/home' });
  });

  it('adds agent-specific passthrough keys back', () => {
    const result = buildAgentEnv({
      PATH: '/bin',
      HOME: '/tmp/home',
      OPENAI_API_KEY: 'key',
      OPENAI_BASE_URL: 'https://example.com',
      LARK_APP_SECRET: 'secret',
    }, ['OPENAI_API_KEY', 'OPENAI_BASE_URL']);
    expect(result['OPENAI_API_KEY']).toBe('key');
    expect(result['OPENAI_BASE_URL']).toBe('https://example.com');
    expect(result['LARK_APP_SECRET']).toBeUndefined();
  });

  it('prefers local Claude OAuth over Anthropic auth env when available', () => {
    const result = buildClaudeAgentEnv({
      HOME: '/tmp/home',
      PATH: '/bin',
      CLAUDE_CONFIG_DIR: '/tmp/claude',
      ANTHROPIC_API_KEY: 'sk-ant-test',
      ANTHROPIC_BASE_URL: 'https://example.com',
      ANTHROPIC_MODEL: 'sonnet',
    }, true);
    expect(result['CLAUDE_CONFIG_DIR']).toBe('/tmp/claude');
    expect(result['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(result['ANTHROPIC_BASE_URL']).toBeUndefined();
    expect(result['ANTHROPIC_MODEL']).toBe('sonnet');
  });

  it('falls back to Anthropic auth env when local Claude OAuth is unavailable', () => {
    const result = buildClaudeAgentEnv({
      HOME: '/tmp/home',
      PATH: '/bin',
      ANTHROPIC_API_KEY: 'sk-ant-test',
      ANTHROPIC_BASE_URL: 'https://example.com',
      ANTHROPIC_MODEL: 'sonnet',
    }, false);
    expect(result['ANTHROPIC_API_KEY']).toBe('sk-ant-test');
    expect(result['ANTHROPIC_BASE_URL']).toBe('https://example.com');
    expect(result['ANTHROPIC_MODEL']).toBe('sonnet');
  });

  it('detects when local Claude OAuth should be preferred', () => {
    expect(shouldPreferClaudeOAuth({ loggedIn: true, authMethod: 'oauth_token' })).toBe(true);
    expect(shouldPreferClaudeOAuth({ loggedIn: true, authMethod: 'api_key' })).toBe(false);
    expect(shouldPreferClaudeOAuth({ loggedIn: false, authMethod: 'oauth_token' })).toBe(false);
    expect(shouldPreferClaudeOAuth(null)).toBe(false);
  });

  it('keeps LARK secrets and OpenAI auth out of Claude subprocess env', async () => {
    const previousLarkSecret = process.env['LARK_APP_SECRET'];
    const previousOpenAiKey = process.env['OPENAI_API_KEY'];
    const previousAnthropicKey = process.env['ANTHROPIC_API_KEY'];
    process.env['LARK_APP_SECRET'] = 'secret';
    process.env['OPENAI_API_KEY'] = 'sk-openai-test';
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test';
    try {
      const agent = new ClaudeCodeAgent();
      const spec = (agent as unknown as { buildProcessSpec(req: { prompt: string }): { env?: NodeJS.ProcessEnv } }).buildProcessSpec({ prompt: 'hello' });
      expect(spec.env?.['LARK_APP_SECRET']).toBeUndefined();
      expect(spec.env?.['OPENAI_API_KEY']).toBeUndefined();
      expect(spec.env?.['ANTHROPIC_API_KEY']).toBe('sk-ant-test');
    } finally {
      if (previousLarkSecret === undefined) delete process.env['LARK_APP_SECRET'];
      else process.env['LARK_APP_SECRET'] = previousLarkSecret;
      if (previousOpenAiKey === undefined) delete process.env['OPENAI_API_KEY'];
      else process.env['OPENAI_API_KEY'] = previousOpenAiKey;
      if (previousAnthropicKey === undefined) delete process.env['ANTHROPIC_API_KEY'];
      else process.env['ANTHROPIC_API_KEY'] = previousAnthropicKey;
    }
  });

  it('keeps Anthropic and LARK secrets out of Codex subprocess env', async () => {
    const previousLarkSecret = process.env['LARK_APP_SECRET'];
    const previousOpenAiKey = process.env['OPENAI_API_KEY'];
    const previousAnthropicKey = process.env['ANTHROPIC_API_KEY'];
    process.env['LARK_APP_SECRET'] = 'secret';
    process.env['OPENAI_API_KEY'] = 'sk-openai-test';
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test';
    try {
      const registry = createBotAgentRegistry({ dataDir: '/tmp/wb-bot', claudeCommand: 'claude-w', codexCommand: 'codex-w' });
      const agent = registry.lookup('codex') as unknown as {
        buildProcessSpec(req: { prompt: string }): { env?: NodeJS.ProcessEnv };
      };
      const spec = agent.buildProcessSpec({ prompt: 'hello' });
      expect(spec.env?.['LARK_APP_SECRET']).toBeUndefined();
      expect(spec.env?.['ANTHROPIC_API_KEY']).toBeUndefined();
      expect(spec.env?.['OPENAI_API_KEY']).toBe('sk-openai-test');
    } finally {
      if (previousLarkSecret === undefined) delete process.env['LARK_APP_SECRET'];
      else process.env['LARK_APP_SECRET'] = previousLarkSecret;
      if (previousOpenAiKey === undefined) delete process.env['OPENAI_API_KEY'];
      else process.env['OPENAI_API_KEY'] = previousOpenAiKey;
      if (previousAnthropicKey === undefined) delete process.env['ANTHROPIC_API_KEY'];
      else process.env['ANTHROPIC_API_KEY'] = previousAnthropicKey;
    }
  });

  it('reads custom agent commands from wb-bot env', () => {
    const env = readEnv({
      LARK_APP_ID: 'cli_xxx',
      LARK_APP_SECRET: 'secret',
      WB_CLAUDE_COMMAND: 'claude-w',
      WB_CODEX_COMMAND: 'codex-w',
    });
    expect(env.claudeCommand).toBe('claude-w');
    expect(env.codexCommand).toBe('codex-w');
  });

  it('defaults agent commands to claude and codex', () => {
    const env = readEnv({
      LARK_APP_ID: 'cli_xxx',
      LARK_APP_SECRET: 'secret',
    });
    expect(env.claudeCommand).toBe('claude');
    expect(env.codexCommand).toBe('codex');
  });

  it('marks wrapper agent commands as available when they exist on PATH', async () => {
    const registry = createBotAgentRegistry({ dataDir: '/tmp/wb-bot', claudeCommand: 'claude-w', codexCommand: 'codex-w' });
    expect(registry.lookup('claude-code')).not.toBeNull();
    expect(registry.lookup('codex')).not.toBeNull();
    expect(await registry.isAvailable('claude-code')).toBe(true);
    expect(await registry.isAvailable('codex')).toBe(true);
  });

  it('maps codex wrapper model selection into -c args', () => {
    const registry = createBotAgentRegistry({ dataDir: '/tmp/wb-bot', claudeCommand: 'claude-w', codexCommand: 'codex-w' });
    const agent = registry.lookup('codex') as unknown as {
      buildProcessSpec(req: { prompt: string; model: string }): { command: string; args: string[] };
    };
    const spec = agent.buildProcessSpec({ prompt: 'hello', model: 'gpt-5.4' });
    expect(spec.command).toBe('codex-w');
    expect(spec.args.slice(0, 2)).toEqual(['-c', 'model=gpt-5.4']);
    expect(spec.args).not.toContain('--model');
  });

  it('treats absolute agent command paths as available when executables exist', async () => {
    const registry = createBotAgentRegistry({ dataDir: '/tmp/wb-bot', claudeCommand: '/bin/sh', codexCommand: '/bin/sh' });
    expect(await registry.isAvailable('claude-code')).toBe(true);
    expect(await registry.isAvailable('codex')).toBe(true);
  });

  it('splits agent commands written with arguments (as in .env.example)', async () => {
    const registry = createBotAgentRegistry({ dataDir: '/tmp/wb-bot', claudeCommand: '/bin/sh --model gpt-5.4', codexCommand: '/bin/sh -c model=gpt-5.3-codex' });
    expect(await registry.isAvailable('claude-code')).toBe(true);
    expect(await registry.isAvailable('codex')).toBe(true);

    type SpecAgent = { buildProcessSpec(req: { prompt: string; model?: string }): { command: string; args: string[] } };
    const claude = (registry.lookup('claude-code') as unknown as SpecAgent).buildProcessSpec({ prompt: 'hello' });
    expect(claude.command).toBe('/bin/sh');
    expect(claude.args.filter((arg) => arg === '--model')).toHaveLength(1);
    expect(claude.args[claude.args.indexOf('--model') + 1]).toBe('gpt-5.4');

    const codex = (registry.lookup('codex') as unknown as SpecAgent).buildProcessSpec({ prompt: 'hello' });
    expect(codex.command).toBe('/bin/sh');
    expect(codex.args.slice(0, 2)).toEqual(['-c', 'model=gpt-5.3-codex']);
  });

  it('returns false for agent probing when spawnSync times out (simulated with non-existing command)', async () => {
    const registry = createBotAgentRegistry({ dataDir: '/tmp/wb-bot', claudeCommand: 'no-such-command-xyz', codexCommand: 'no-such-codex-xyz' });
    expect(await registry.isAvailable('claude-code')).toBe(false);
    expect(await registry.isAvailable('codex')).toBe(false);
  });

  it('sanitizes deprecated codex_hooks into bot-local CODEX_HOME', () => {
    const sourceHome = mkdtempSync(join(tmpdir(), 'wb-bot-codex-source-'));
    const targetDataDir = mkdtempSync(join(tmpdir(), 'wb-bot-data-'));
    writeFileSync(join(sourceHome, 'config.toml'), '[features]\nhooks = true\ncodex_hooks = true\n');
    writeFileSync(join(sourceHome, 'hooks.json'), '{"hooks":true}');
    const agentsPath = join(sourceHome, 'AGENTS.md');
    writeFileSync(agentsPath, '# agent\n');

    const registry = createBotAgentRegistry({ dataDir: targetDataDir, claudeCommand: 'claude-w', codexCommand: 'codex-w' });
    const agent = registry.lookup('codex') as unknown as {
      envFilter(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
    };

    const env = agent.envFilter({ CODEX_HOME: sourceHome, PATH: '/bin', HOME: '/tmp/home' });
    const isolatedHome = env['CODEX_HOME'];
    expect(isolatedHome).toBe(join(targetDataDir, 'wb-bot-codex-home'));
    expect(readFileSync(join(isolatedHome as string, 'config.toml'), 'utf8')).toBe('[features]\nhooks = true\n');
    expect(readFileSync(join(isolatedHome as string, 'hooks.json'), 'utf8')).toBe('{"hooks":true}');
    expect(readFileSync(join(isolatedHome as string, 'AGENTS.md'), 'utf8')).toBe('# agent\n');
    expect(env['CODEX_CONFIG_DIR']).toBeUndefined();
  });

  it('keeps original CODEX_HOME when config has no deprecated codex hooks', () => {
    const sourceHome = mkdtempSync(join(tmpdir(), 'wb-bot-codex-source-'));
    writeFileSync(join(sourceHome, 'config.toml'), '[features]\nhooks = true\n');
    const registry = createBotAgentRegistry({ dataDir: '/tmp/wb-bot', claudeCommand: 'claude-w', codexCommand: 'codex-w' });
    const agent = registry.lookup('codex') as unknown as {
      envFilter(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
    };

    const env = agent.envFilter({ CODEX_HOME: sourceHome, CODEX_CONFIG_DIR: '/tmp/config', PATH: '/bin', HOME: '/tmp/home' });
    expect(env['CODEX_HOME']).toBe(sourceHome);
    expect(env['CODEX_CONFIG_DIR']).toBe('/tmp/config');
  });

  it('refreshes mirrored codex home when source entries change', () => {
    const sourceHome = mkdtempSync(join(tmpdir(), 'wb-bot-codex-source-'));
    const targetDataDir = mkdtempSync(join(tmpdir(), 'wb-bot-data-'));
    writeFileSync(join(sourceHome, 'config.toml'), '[features]\nhooks = true\ncodex_hooks = true\n');
    const originalTarget = join(targetDataDir, 'wb-bot-codex-home');
    mkdirSync(originalTarget, { recursive: true });
    const stalePath = join(originalTarget, 'stale.txt');
    writeFileSync(stalePath, 'stale');
    const sharedPath = join(sourceHome, 'shared.md');
    writeFileSync(sharedPath, 'source');

    const registry = createBotAgentRegistry({ dataDir: targetDataDir, claudeCommand: 'claude-w', codexCommand: 'codex-w' });
    const agent = registry.lookup('codex') as unknown as {
      envFilter(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
    };

    agent.envFilter({ CODEX_HOME: sourceHome, PATH: '/bin', HOME: '/tmp/home' });
    expect(() => readFileSync(stalePath, 'utf8')).toThrow();
    expect(readFileSync(join(originalTarget, 'shared.md'), 'utf8')).toBe('source');
  });
});

describe('HP-W2-4 WB_* explicit deny (≥5 examples)', () => {
  const wbDenyKeys = [
    'WB_MODE',
    'WB_CLAUDE_COMMAND',
    'WB_CODEX_COMMAND',
    'WB_DATA_DIR',
    'WB_DEFAULT_CWD',
    'BOT_ID',
    'WB_HEARTBEAT_STALE_MS',
  ] as const;

  for (const key of wbDenyKeys) {
    it(`denies ${key} from agent CLI env via filterBaseEnv`, () => {
      const result = filterBaseEnv({ [key]: 'sensitive-value', PATH: '/bin', HOME: '/tmp' });
      expect(result[key], `${key} must not leak to agent CLI`).toBeUndefined();
      expect(result['PATH']).toBe('/bin');
    });
  }

  it('denies all WB_* keys from Claude subprocess env', () => {
    const previousKeys: Record<string, string | undefined> = {};
    const testKeys = ['WB_MODE', 'WB_CLAUDE_COMMAND', 'WB_DATA_DIR', 'WB_DEFAULT_CWD', 'WB_HEARTBEAT_STALE_MS'];
    for (const key of testKeys) {
      previousKeys[key] = process.env[key];
      process.env[key] = 'test-value';
    }
    try {
      const agent = new ClaudeCodeAgent();
      const spec = (agent as unknown as { buildProcessSpec(req: { prompt: string }): { env?: NodeJS.ProcessEnv } }).buildProcessSpec({ prompt: 'hello' });
      for (const key of testKeys) {
        expect(spec.env?.[key], `${key} must not appear in Claude subprocess env`).toBeUndefined();
      }
    } finally {
      for (const key of testKeys) {
        if (previousKeys[key] === undefined) delete process.env[key];
        else process.env[key] = previousKeys[key];
      }
    }
  });

  it('denies BOT_ID from Codex subprocess env', () => {
    const prev = process.env['BOT_ID'];
    process.env['BOT_ID'] = 'some-bot';
    try {
      const registry = createBotAgentRegistry({ dataDir: '/tmp/wb-bot', claudeCommand: 'claude-w', codexCommand: 'codex-w' });
      const agent = registry.lookup('codex') as unknown as {
        buildProcessSpec(req: { prompt: string }): { env?: NodeJS.ProcessEnv };
      };
      const spec = agent.buildProcessSpec({ prompt: 'hello' });
      expect(spec.env?.['BOT_ID'], 'BOT_ID must not leak to codex').toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env['BOT_ID'];
      else process.env['BOT_ID'] = prev;
    }
  });
});

describe('HP-1 SECRET_PATTERNS coverage', () => {
  const cases: Array<{ group: string; positive: string; baseline: string }> = [
    { group: '*_TOKEN', positive: 'GITHUB_TOKEN', baseline: 'PATH' },
    { group: '*_SECRET', positive: 'LARK_APP_SECRET', baseline: 'HOME' },
    { group: '*_KEY', positive: 'OPENAI_API_KEY', baseline: 'TERM' },
    { group: '*_PASSWORD', positive: 'DB_PASSWORD', baseline: 'USER' },
    { group: 'LARK_*', positive: 'LARK_APP_ID', baseline: 'LANG' },
    { group: 'FEISHU_*', positive: 'FEISHU_BOT_TOKEN', baseline: 'SHELL' },
    { group: 'AWS_*', positive: 'AWS_SECRET_ACCESS_KEY', baseline: 'TMPDIR' },
    { group: 'SSH_*', positive: 'SSH_AUTH_SOCK', baseline: 'NO_COLOR' },
    { group: 'GCP_*', positive: 'GCP_SERVICE_ACCOUNT_KEY', baseline: 'FORCE_COLOR' },
  ];

  for (const c of cases) {
    it(`denies ${c.group} positive (${c.positive}), keeps baseline (${c.baseline})`, () => {
      const result = filterBaseEnv({ [c.positive]: 'secret-value', [c.baseline]: 'safe-value' });
      expect(result[c.positive], `${c.positive} should be denied`).toBeUndefined();
      expect(result[c.baseline], `${c.baseline} should be allowed`).toBe('safe-value');
    });
  }
});
