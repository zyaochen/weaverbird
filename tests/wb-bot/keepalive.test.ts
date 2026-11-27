import { describe, expect, it, vi } from 'vitest';
import { Keepalive, type ConnectionState } from '../../apps/wb-bot/src/feishu/keepalive.js';

function setup(states: ConnectionState[], reachable = true) {
  let clock = 1_000_000;
  let i = 0;
  const forceReconnect = vi.fn(async () => {});
  const keepalive = new Keepalive({
    connectionState: () => states[Math.min(i++, states.length - 1)],
    probe: async () => reachable,
    forceReconnect,
    logger: { info: vi.fn(), warn: vi.fn() },
    now: () => clock,
  });
  const tick = async (advance = 15_000) => { clock += advance; await keepalive.tick(); };
  return { keepalive, forceReconnect, tick };
}

describe('Keepalive', () => {
  it('rebuilds the client after three consecutive non-connected ticks', async () => {
    const { keepalive, forceReconnect, tick } = setup(['reconnecting']);
    await tick(); await tick();
    expect(forceReconnect).not.toHaveBeenCalled();
    await tick();
    expect(forceReconnect).toHaveBeenCalledTimes(1);
    expect(keepalive.forcedReconnects).toBe(1);
  });

  it('resets on connected and on wake-up from sleep', async () => {
    const { forceReconnect, tick } = setup(['failed', 'failed', 'connected', 'failed', 'failed', 'failed', 'failed']);
    await tick(); await tick(); await tick(); // 2 down, then connected resets
    await tick(); await tick();
    await tick(120_000); // slept: counters reset, state not read
    await tick();
    expect(forceReconnect).not.toHaveBeenCalled();
  });

  it('does not rebuild while feishu is unreachable over http', async () => {
    const { forceReconnect, tick } = setup(['failed'], false);
    for (let n = 0; n < 5; n++) await tick();
    expect(forceReconnect).not.toHaveBeenCalled();
  });

  it('ignores back-to-back timer storms', async () => {
    const { forceReconnect, tick } = setup(['failed']);
    await tick(); await tick(1_000); await tick(1_000); await tick(1_000);
    expect(forceReconnect).not.toHaveBeenCalled();
  });
});
