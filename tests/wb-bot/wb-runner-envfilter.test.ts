import { describe, expect, it } from 'vitest';
import { filterBaseEnv, buildAgentEnv } from '../../apps/wb-bot/src/security/env-whitelist.js';

describe('A1.6 wb-runner envFilter integration', () => {
  const fullEnv: NodeJS.ProcessEnv = {
    PATH: '/usr/bin:/usr/local/bin',
    HOME: '/Users/testuser',
    USER: 'testuser',
    LANG: 'en_US.UTF-8',
    SHELL: '/bin/zsh',
    ANTHROPIC_API_KEY: 'sk-ant-xxx',
    ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
    OPENAI_API_KEY: 'sk-openai-xxx',
    OPENAI_BASE_URL: 'https://api.openai.com',
    LARK_APP_SECRET: 'lark-secret-do-not-leak',
    LARK_APP_ID: 'cli_xxx',
    WB_DATA_DIR: '/tmp/.weaverbird',
    WB_MODE: 'production',
    WB_CLAUDE_COMMAND: 'claude-w',
    WB_CODEX_COMMAND: 'codex-w',
    WB_DEFAULT_CWD: '/Users/testuser/code',
    WB_HEARTBEAT_STALE_MS: '120000',
    BOT_ID: 'default',
    GITHUB_TOKEN: 'ghp_xxx',
    SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
  };

  describe('fixture: claude agent CLI env', () => {
    it('allows only ANTHROPIC_* vendor keys + base env', () => {
      const env = buildAgentEnv(fullEnv, ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL']);
      expect(env['PATH']).toBe('/usr/bin:/usr/local/bin');
      expect(env['HOME']).toBe('/Users/testuser');
      expect(env['ANTHROPIC_API_KEY']).toBe('sk-ant-xxx');
      expect(env['ANTHROPIC_BASE_URL']).toBe('https://api.anthropic.com');
    });

    it('blocks LARK_APP_SECRET from claude env', () => {
      const env = buildAgentEnv(fullEnv, ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL']);
      expect(env['LARK_APP_SECRET']).toBeUndefined();
      expect(env['LARK_APP_ID']).toBeUndefined();
    });

    it('blocks all WB_* keys from claude env', () => {
      const env = buildAgentEnv(fullEnv, ['ANTHROPIC_API_KEY']);
      expect(env['WB_DATA_DIR']).toBeUndefined();
      expect(env['WB_MODE']).toBeUndefined();
      expect(env['WB_CLAUDE_COMMAND']).toBeUndefined();
      expect(env['WB_CODEX_COMMAND']).toBeUndefined();
      expect(env['WB_DEFAULT_CWD']).toBeUndefined();
      expect(env['WB_HEARTBEAT_STALE_MS']).toBeUndefined();
    });

    it('blocks OPENAI keys from claude env', () => {
      const env = buildAgentEnv(fullEnv, ['ANTHROPIC_API_KEY']);
      expect(env['OPENAI_API_KEY']).toBeUndefined();
      expect(env['OPENAI_BASE_URL']).toBeUndefined();
    });

    it('blocks BOT_ID from claude env', () => {
      const env = buildAgentEnv(fullEnv, ['ANTHROPIC_API_KEY']);
      expect(env['BOT_ID']).toBeUndefined();
    });
  });

  describe('fixture: codex agent CLI env', () => {
    it('allows only OPENAI_* vendor keys + base env', () => {
      const env = buildAgentEnv(fullEnv, ['OPENAI_API_KEY', 'OPENAI_BASE_URL']);
      expect(env['PATH']).toBe('/usr/bin:/usr/local/bin');
      expect(env['HOME']).toBe('/Users/testuser');
      expect(env['OPENAI_API_KEY']).toBe('sk-openai-xxx');
      expect(env['OPENAI_BASE_URL']).toBe('https://api.openai.com');
    });

    it('blocks LARK_APP_SECRET from codex env', () => {
      const env = buildAgentEnv(fullEnv, ['OPENAI_API_KEY']);
      expect(env['LARK_APP_SECRET']).toBeUndefined();
      expect(env['LARK_APP_ID']).toBeUndefined();
    });

    it('blocks all WB_* keys from codex env', () => {
      const env = buildAgentEnv(fullEnv, ['OPENAI_API_KEY']);
      expect(env['WB_DATA_DIR']).toBeUndefined();
      expect(env['WB_MODE']).toBeUndefined();
      expect(env['WB_HEARTBEAT_STALE_MS']).toBeUndefined();
    });

    it('blocks ANTHROPIC keys from codex env', () => {
      const env = buildAgentEnv(fullEnv, ['OPENAI_API_KEY']);
      expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
    });

    it('blocks BOT_ID and GITHUB_TOKEN from codex env', () => {
      const env = buildAgentEnv(fullEnv, ['OPENAI_API_KEY']);
      expect(env['BOT_ID']).toBeUndefined();
      expect(env['GITHUB_TOKEN']).toBeUndefined();
      expect(env['SSH_AUTH_SOCK']).toBeUndefined();
    });
  });
});
