import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { buildFilteredEnv } from '../../apps/wb-bot/src/security/env-whitelist.js';

describe('wb-runner envFilter spawn integration', () => {
  const fakeEnv: NodeJS.ProcessEnv = {
    PATH: '/usr/bin:/bin',
    HOME: '/Users/test',
    LARK_APP_SECRET: 'secret-value-leak',
    WB_DATA_DIR: '/data',
    WB_HEARTBEAT_STALE_MS: '240000',
    BOT_ID: 'bot-123',
    ANTHROPIC_API_KEY: 'sk-ant-test123',
    GITHUB_TOKEN: 'ghp_secret',
    SSH_AUTH_SOCK: '/tmp/ssh',
    TERM: 'xterm-256color',
  };

  it('agent-cli target: denies secrets, allows base env + passthrough API key', () => {
    const filtered = buildFilteredEnv('agent-cli', fakeEnv, ['ANTHROPIC_API_KEY']);
    const output = execFileSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))'], {
      env: filtered,
      encoding: 'utf8',
    });
    const childEnv = JSON.parse(output) as Record<string, string>;

    expect(childEnv['LARK_APP_SECRET']).toBeUndefined();
    expect(childEnv['WB_DATA_DIR']).toBeUndefined();
    expect(childEnv['BOT_ID']).toBeUndefined();
    expect(childEnv['GITHUB_TOKEN']).toBeUndefined();
    expect(childEnv['SSH_AUTH_SOCK']).toBeUndefined();
    expect(childEnv['ANTHROPIC_API_KEY']).toBe('sk-ant-test123');
    expect(childEnv['PATH']).toBe('/usr/bin:/bin');
    expect(childEnv['HOME']).toBe('/Users/test');
  });

  it('wb-runner target: allows WB_DATA_DIR + WB_HEARTBEAT_STALE_MS, denies secrets', () => {
    const filtered = buildFilteredEnv('wb-runner', fakeEnv);
    const output = execFileSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))'], {
      env: filtered,
      encoding: 'utf8',
    });
    const childEnv = JSON.parse(output) as Record<string, string>;

    expect(childEnv['LARK_APP_SECRET']).toBeUndefined();
    expect(childEnv['BOT_ID']).toBeUndefined();
    expect(childEnv['GITHUB_TOKEN']).toBeUndefined();
    expect(childEnv['SSH_AUTH_SOCK']).toBeUndefined();
    expect(childEnv['WB_DATA_DIR']).toBe('/data');
    expect(childEnv['WB_HEARTBEAT_STALE_MS']).toBe('240000');
    expect(childEnv['PATH']).toBe('/usr/bin:/bin');
    expect(childEnv['HOME']).toBe('/Users/test');
  });

  it('double filter defense-in-depth: wb-runner env passed to agent-cli still safe', () => {
    const wbRunnerEnv = buildFilteredEnv('wb-runner', fakeEnv);
    const agentEnv = buildFilteredEnv('agent-cli', wbRunnerEnv, ['ANTHROPIC_API_KEY']);
    const output = execFileSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))'], {
      env: agentEnv,
      encoding: 'utf8',
    });
    const childEnv = JSON.parse(output) as Record<string, string>;

    expect(childEnv['LARK_APP_SECRET']).toBeUndefined();
    expect(childEnv['WB_DATA_DIR']).toBeUndefined();
    expect(childEnv['WB_HEARTBEAT_STALE_MS']).toBeUndefined();
    expect(childEnv['BOT_ID']).toBeUndefined();
    expect(childEnv['PATH']).toBe('/usr/bin:/bin');
    expect(childEnv['HOME']).toBe('/Users/test');
  });
});
