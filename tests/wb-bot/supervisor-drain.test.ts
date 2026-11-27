import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Supervisor } from '../../apps/wb-bot/src/multi/supervisor.js';
import type { DiscoveredBot } from '../../apps/wb-bot/src/multi/discovery.js';

class FakeChild extends EventEmitter {
  pid: number;
  stdout: PassThrough | null;
  kill = vi.fn((signal?: NodeJS.Signals) => {
    this.lastSignal = signal ?? null;
    return true;
  });
  lastSignal: NodeJS.Signals | null = null;

  constructor(pid: number, markerCapable = true) {
    super();
    this.pid = pid;
    this.stdout = markerCapable ? new PassThrough() : null;
  }
}

describe('Supervisor drain gate', () => {
  const bot: DiscoveredBot = { botId: 'bot-a', configPath: '/tmp/.env.bot-a' };
  let spawnFn: ReturnType<typeof vi.fn>;
  let children: FakeChild[];
  let markerCapable = true;
  let now = 0;

  beforeEach(() => {
    vi.useFakeTimers();
    children = [];
    markerCapable = true;
    now = 0;
    let pid = 100;
    spawnFn = vi.fn(() => {
      const child = new FakeChild(pid++, markerCapable);
      children.push(child);
      return child;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createSupervisor(): Supervisor {
    return new Supervisor([bot], {
      bin: process.execPath,
      mainJs: '/tmp/wb-bot-main.js',
      baseEnv: { PATH: process.env['PATH'] },
      logger: pino({ enabled: false }),
      spawnFn: spawnFn as never,
      nowFn: () => now,
    });
  }

  it('child outputs marker and exits naturally without SIGTERM', async () => {
    const supervisor = createSupervisor();
    supervisor.startAll();

    const shutdownPromise = supervisor.shutdown('SIGTERM', 15_000);
    children[0]!.stdout?.write('__WB_DRAINED__\n');
    children[0]!.emit('exit', 0, null);
    await shutdownPromise;

    expect(children[0]?.kill).not.toHaveBeenCalled();
  });

  it('child outputs marker but does not exit, then falls back to SIGTERM and SIGKILL', async () => {
    const supervisor = createSupervisor();
    supervisor.startAll();

    const shutdownPromise = supervisor.shutdown('SIGTERM', 15_000);
    children[0]!.stdout?.write('__WB_DRAINED__\n');
    now = 15_000;
    await vi.advanceTimersByTimeAsync(15_000);
    await shutdownPromise;

    expect(children[0]?.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
    expect(children[0]?.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
  });

  it('child without marker stream degrades to immediate SIGTERM', async () => {
    markerCapable = false;
    const supervisor = createSupervisor();
    supervisor.startAll();

    const shutdownPromise = supervisor.shutdown('SIGTERM', 15_000);
    expect(children[0]?.kill).toHaveBeenCalledWith('SIGTERM');
    children[0]!.emit('exit', 0, 'SIGTERM');
    await shutdownPromise;
  });

  it('total drain wait never exceeds gracePeriodMs', async () => {
    const supervisor = createSupervisor();
    supervisor.startAll();

    const shutdownPromise = supervisor.shutdown('SIGTERM', 15_000);
    children[0]!.stdout?.write('__WB_DRAINED__\n');
    now = 15_000;
    await vi.advanceTimersByTimeAsync(15_000);
    await shutdownPromise;

    expect(now).toBe(15_000);
  });
});
