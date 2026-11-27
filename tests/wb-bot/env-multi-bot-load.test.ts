import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readEnv } from '../../apps/wb-bot/src/config/env.js';

describe('readEnv multi-bot mode', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    process.env['LARK_APP_ID'] = 'cli_test';
    process.env['LARK_APP_SECRET'] = 'secret_test';
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it('single mode default: WB_MODE unset + BOT_ID unset → mode=single, botId=default', () => {
    delete process.env['WB_MODE'];
    delete process.env['BOT_ID'];
    const env = readEnv();
    expect(env.mode).toBe('single');
    expect(env.botId).toBe('default');
  });

  it('single mode explicit: WB_MODE=single + BOT_ID=default → mode=single, botId=default', () => {
    process.env['WB_MODE'] = 'single';
    process.env['BOT_ID'] = 'default';
    const env = readEnv();
    expect(env.mode).toBe('single');
    expect(env.botId).toBe('default');
  });

  it('multi-bot via WB_MODE env: WB_MODE=multi-bot + BOT_ID=claude → mode=multi-bot, botId=claude', () => {
    process.env['WB_MODE'] = 'multi-bot';
    process.env['BOT_ID'] = 'claude';
    const env = readEnv();
    expect(env.mode).toBe('multi-bot');
    expect(env.botId).toBe('claude');
  });

  it('BOT_ID with valid custom value in single mode → botId matches', () => {
    process.env['BOT_ID'] = 'mybot';
    delete process.env['WB_MODE'];
    const env = readEnv();
    expect(env.mode).toBe('single');
    expect(env.botId).toBe('mybot');
  });

  it('invalid BOT_ID throws assertValidBotId error', () => {
    process.env['BOT_ID'] = 'INVALID!';
    expect(() => readEnv()).toThrow('invalid botId');
  });

  it('WB_MODE invalid value throws zod error', () => {
    process.env['WB_MODE'] = 'bad-mode';
    expect(() => readEnv()).toThrow();
  });
});
