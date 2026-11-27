import { describe, expect, it } from 'vitest';
import { isHealthyUptime, nextBackoffMs, shouldGiveUp } from '../../apps/wb-bot/src/multi/supervisor.js';

describe('multi supervisor policy helpers', () => {
  it('backoff starts at 1 second', () => {
    expect(nextBackoffMs(0)).toBe(1000);
  });

  it('backoff doubles for restart count 1', () => {
    expect(nextBackoffMs(1)).toBe(2000);
  });

  it('backoff doubles for restart count 2', () => {
    expect(nextBackoffMs(2)).toBe(4000);
  });

  it('backoff doubles for restart count 3', () => {
    expect(nextBackoffMs(3)).toBe(8000);
  });

  it('backoff doubles for restart count 4', () => {
    expect(nextBackoffMs(4)).toBe(16000);
  });

  it('backoff caps at 30 seconds for restart count 5', () => {
    expect(nextBackoffMs(5)).toBe(30000);
  });

  it('backoff remains capped after restart count 5', () => {
    expect(nextBackoffMs(6)).toBe(30000);
  });

  it('does not give up at 9 crashes inside 10 minutes', () => {
    const now = 1_000_000;
    const window = Array.from({ length: 9 }, (_, index) => now - (index + 1) * 1000);
    expect(shouldGiveUp(window, now)).toBe(false);
  });

  it('gives up at 10 crashes inside 10 minutes', () => {
    const now = 1_000_000;
    const window = Array.from({ length: 10 }, (_, index) => now - (index + 1) * 1000);
    expect(shouldGiveUp(window, now)).toBe(true);
  });

  it('ignores crashes older than 10 minutes', () => {
    const now = 1_000_000;
    const old = Array.from({ length: 5 }, (_, index) => now - (11 * 60 * 1000) - index * 1000);
    const recent = Array.from({ length: 5 }, (_, index) => now - (index + 1) * 1000);
    expect(shouldGiveUp([...old, ...recent], now)).toBe(false);
  });

  it('treats exactly 10 fresh crashes as give-up even if more old crashes exist', () => {
    const now = 1_000_000;
    const old = [now - 12 * 60 * 1000];
    const recent = Array.from({ length: 10 }, (_, index) => now - (index + 1) * 2000);
    expect(shouldGiveUp([...old, ...recent], now)).toBe(true);
  });

  it('healthy uptime is false at 3 minutes', () => {
    expect(isHealthyUptime(0, 3 * 60 * 1000)).toBe(false);
  });

  it('healthy uptime is false exactly at 5 minutes', () => {
    expect(isHealthyUptime(0, 5 * 60 * 1000)).toBe(false);
  });

  it('healthy uptime is true after 5.1 minutes', () => {
    expect(isHealthyUptime(0, 5 * 60 * 1000 + 6000)).toBe(true);
  });

  it('healthy uptime is true far beyond threshold', () => {
    expect(isHealthyUptime(1000, 1000 + 30 * 60 * 1000)).toBe(true);
  });
});
