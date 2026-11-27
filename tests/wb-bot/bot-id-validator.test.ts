import { describe, expect, it } from 'vitest';
import { validateBotId, assertValidBotId } from '../../apps/wb-bot/src/security/bot-id-validator.js';

describe('botId regex validator (HP-W2.5-3)', () => {
  // positive cases
  it.each([
    'default',
    'claude',
    'a',
    'a1',
    'bot_1',
    'bot-2',
    'a23456789012345678901234567890ab', // 32 chars
    'mira',
  ])('valid: %s', (id) => {
    expect(validateBotId(id)).toEqual({ ok: true });
  });

  // negative cases
  it('empty string', () => {
    const r = validateBotId('');
    expect(r.ok).toBe(false);
    expect(r.reason).toBeTruthy();
  });

  it('uppercase', () => {
    const r = validateBotId('A');
    expect(r.ok).toBe(false);
  });

  it('digit start', () => {
    const r = validateBotId('1bot');
    expect(r.ok).toBe(false);
  });

  it('underscore start', () => {
    const r = validateBotId('_bot');
    expect(r.ok).toBe(false);
  });

  it('hyphen start', () => {
    const r = validateBotId('-bot');
    expect(r.ok).toBe(false);
  });

  it('illegal char !', () => {
    const r = validateBotId('bot!');
    expect(r.ok).toBe(false);
  });

  it('contains dot', () => {
    const r = validateBotId('bot.id');
    expect(r.ok).toBe(false);
  });

  it('33 chars (over limit)', () => {
    const r = validateBotId('a234567890123456789012345678901bc'); // 33 chars
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('32');
  });

  it('null → not string', () => {
    const r = validateBotId(null);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('string');
  });

  it('undefined → not string', () => {
    const r = validateBotId(undefined);
    expect(r.ok).toBe(false);
  });

  it('number → not string', () => {
    const r = validateBotId(123);
    expect(r.ok).toBe(false);
  });

  // assertValidBotId
  it('assertValidBotId returns valid id', () => {
    expect(assertValidBotId('claude', 'test')).toBe('claude');
  });

  it('assertValidBotId throws on invalid', () => {
    expect(() => assertValidBotId('INVALID!', 'BOT_ID env')).toThrowError(/invalid botId at BOT_ID env/);
  });
});
