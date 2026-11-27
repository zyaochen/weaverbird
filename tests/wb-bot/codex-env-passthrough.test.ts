import { describe, expect, it } from 'vitest';
import { CODEX_PASSTHROUGH_KEYS } from '../../packages/core/src/agent/codex.js';
import { buildFilteredEnv } from '../../apps/wb-bot/src/security/env-whitelist.js';

// D1 hotfix · 验证 wb-bot 给 codex 子进程的 env 透传跟 core CodexAgent 一致
// (复用 core 的 CODEX_PASSTHROUGH_KEYS export, 单一 source of truth).
//
// 关键不变量:
// - codex 路径必须透 OPENAI_API_KEY / OPENAI_BASE_URL / CODEX_HOME 等 codex 需要的
// - codex 路径必须**不**透 ANTHROPIC_API_KEY (不能把 claude 凭据漏给 codex)
// - claude 路径必须**不**被 codex 改动污染 (双向隔离)
describe('D1 codex env passthrough', () => {
  const fakeEnv: NodeJS.ProcessEnv = {
    OPENAI_API_KEY: 'sk-fake-openai-key',
    OPENAI_BASE_URL: 'https://api.example.com',
    CODEX_HOME: '/home/user/.codex',
    CODEX_CONFIG_DIR: '/home/user/.codex-config',
    XDG_CONFIG_HOME: '/home/user/.config',
    ANTHROPIC_API_KEY: 'sk-ant-fake',
    ANTHROPIC_BASE_URL: 'https://anthropic.example.com',
    ANTHROPIC_MODEL: 'claude-fake',
    PATH: '/usr/bin:/bin',
    HOME: '/home/user',
  };

  it('CODEX_PASSTHROUGH_KEYS is exported and includes core codex env keys', () => {
    expect(Array.isArray(CODEX_PASSTHROUGH_KEYS) || (CODEX_PASSTHROUGH_KEYS as readonly string[]).length > 0).toBe(true);
    const keys = CODEX_PASSTHROUGH_KEYS as readonly string[];
    expect(keys).toContain('OPENAI_API_KEY');
    expect(keys).toContain('OPENAI_BASE_URL');
    expect(keys).toContain('CODEX_HOME');
  });

  it('codex passthrough includes OPENAI_API_KEY / OPENAI_BASE_URL / CODEX_HOME', () => {
    const env = buildFilteredEnv('agent-cli', fakeEnv, CODEX_PASSTHROUGH_KEYS);
    expect(env['OPENAI_API_KEY']).toBe('sk-fake-openai-key');
    expect(env['OPENAI_BASE_URL']).toBe('https://api.example.com');
    expect(env['CODEX_HOME']).toBe('/home/user/.codex');
  });

  it('codex passthrough does NOT leak ANTHROPIC_API_KEY to codex subprocess', () => {
    const env = buildFilteredEnv('agent-cli', fakeEnv, CODEX_PASSTHROUGH_KEYS);
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(env['ANTHROPIC_BASE_URL']).toBeUndefined();
    expect(env['ANTHROPIC_MODEL']).toBeUndefined();
  });

  it('claude passthrough is unaffected by codex changes — still gets ANTHROPIC_*, no OPENAI_*', () => {
    const env = buildFilteredEnv('agent-cli', fakeEnv, ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL']);
    expect(env['ANTHROPIC_API_KEY']).toBe('sk-ant-fake');
    expect(env['ANTHROPIC_BASE_URL']).toBe('https://anthropic.example.com');
    expect(env['ANTHROPIC_MODEL']).toBe('claude-fake');
    expect(env['OPENAI_API_KEY']).toBeUndefined();
    expect(env['CODEX_HOME']).toBeUndefined();
  });

  it('base env (PATH/HOME) still flows through for both paths', () => {
    const codexEnv = buildFilteredEnv('agent-cli', fakeEnv, CODEX_PASSTHROUGH_KEYS);
    const claudeEnv = buildFilteredEnv('agent-cli', fakeEnv, ['ANTHROPIC_API_KEY']);
    expect(codexEnv['PATH']).toBe('/usr/bin:/bin');
    expect(codexEnv['HOME']).toBe('/home/user');
    expect(claudeEnv['PATH']).toBe('/usr/bin:/bin');
    expect(claudeEnv['HOME']).toBe('/home/user');
  });
});
