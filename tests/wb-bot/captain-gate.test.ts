import { describe, expect, it } from 'vitest';
import { isCaptainEnabled } from '../../apps/wb-bot/src/captain/captain-gate.js';

describe('isCaptainEnabled', () => {
  it('returns false in single mode', () => {
    expect(isCaptainEnabled({ mode: 'single', botId: 'default' })).toBe(false);
  });

  it('returns false for non-default bot in multi-bot mode', () => {
    expect(isCaptainEnabled({ mode: 'multi-bot', botId: 'claude' })).toBe(false);
  });

  it('returns true for default bot in multi-bot mode', () => {
    expect(isCaptainEnabled({ mode: 'multi-bot', botId: 'default' })).toBe(true);
  });

  it('returns false when captain is disabled explicitly', () => {
    expect(isCaptainEnabled({ mode: 'multi-bot', botId: 'default', disableCaptainEnv: 'true' })).toBe(false);
    expect(isCaptainEnabled({ mode: 'multi-bot', botId: 'default', disableCaptainEnv: '1' })).toBe(false);
  });
});
