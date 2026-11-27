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

describe('Supervisor lifecycle', () => {
  const bots: DiscoveredBot[] = [
    { botId: 'bot-a', configPath: '/tmp/.env.bot-a' },
    { botId: 'bot-b', configPath: '/tmp/.env.bot-b' },
  ];

  let now = 0;
  let pid = 100;
  let spawnFn: ReturnType<typeof vi.fn>;
  let children: FakeChild[];
  let markerCapable = true;

  beforeEach(() => {
    vi.useFakeTimers();
    now = 0;
    pid = 100;
    children = [];
    markerCapable = true;
    spawnFn = vi.fn(() => {
      const child = new FakeChild(pid++, markerCapable);
      children.push(child);
      return child;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createSupervisor(localBots: DiscoveredBot[] = bots): Supervisor {
    return new Supervisor(localBots, {
      bin: process.execPath,
      mainJs: '/tmp/wb-bot-main.js',
      baseEnv: { PATH: process.env['PATH'] },
      logger: pino({ enabled: false }),
      spawnFn: spawnFn as never,
      nowFn: () => now,
    });
  }

  it('startAll spawns one child per bot', () => {
    const supervisor = createSupervisor();
    supervisor.startAll();

    expect(spawnFn).toHaveBeenCalledTimes(2);
    const states = supervisor.getStates();
    expect(states.map((state) => state.status)).toEqual(['running', 'running']);
  });

  it('restarts a crashed child after backoff', async () => {
    const supervisor = createSupervisor([{ botId: 'bot-a', configPath: '/tmp/.env.bot-a' }]);
    supervisor.startAll();

    expect(spawnFn).toHaveBeenCalledTimes(1);
    children[0]!.emit('exit', 1, null);
    expect(supervisor.getStates()[0]?.status).toBe('restarting');

    await vi.advanceTimersByTimeAsync(999);
    expect(spawnFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(spawnFn).toHaveBeenCalledTimes(2);
    expect(supervisor.getStates()[0]?.restartCount).toBe(1);
  });

  it('waits for drain marker and natural exit before signaling', async () => {
    const supervisor = createSupervisor([{ botId: 'bot-a', configPath: '/tmp/.env.bot-a' }]);
    supervisor.startAll();

    const shutdownPromise = supervisor.shutdown('SIGTERM', 15_000);
    children[0]!.stdout?.write('__WB_DRAINED__\n');
    children[0]!.emit('exit', 0, null);
    await shutdownPromise;

    expect(children[0]?.kill).not.toHaveBeenCalled();
    const state = supervisor.getStates()[0]!;
    expect(state.status).toBe('stopped');
    expect(state.restartCount).toBe(0);
  });

  it('falls back to immediate SIGTERM when child has no marker stream', async () => {
    markerCapable = false;
    const supervisor = createSupervisor([{ botId: 'bot-a', configPath: '/tmp/.env.bot-a' }]);
    supervisor.startAll();

    const shutdownPromise = supervisor.shutdown('SIGTERM', 15_000);
    expect(children[0]?.kill).toHaveBeenCalledWith('SIGTERM');
    children[0]!.emit('exit', 0, 'SIGTERM');
    await shutdownPromise;
  });

  it('sends SIGTERM then SIGKILL after grace period if child does not exit', async () => {
    markerCapable = false;
    const supervisor = createSupervisor([{ botId: 'bot-a', configPath: '/tmp/.env.bot-a' }]);
    supervisor.startAll();

    const shutdownPromise = supervisor.shutdown('SIGTERM', 15_000);
    expect(children[0]?.kill).toHaveBeenCalledWith('SIGTERM');

    await vi.advanceTimersByTimeAsync(15_000);
    await shutdownPromise;
    expect(children[0]?.kill).toHaveBeenLastCalledWith('SIGKILL');
  });

  it('resets restart window after healthy uptime', async () => {
    const supervisor = createSupervisor([{ botId: 'bot-a', configPath: '/tmp/.env.bot-a' }]);
    supervisor.startAll();
    children[0]!.emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(1000);

    expect(spawnFn).toHaveBeenCalledTimes(2);
    now = 6 * 60 * 1000;
    await vi.advanceTimersByTimeAsync(60_000);

    const state = supervisor.getStates()[0]!;
    expect(state.restartCount).toBe(0);
    expect(state.crashWindow).toEqual([]);
  });

  it('marks child failed after too many crashes in window', async () => {
    const supervisor = createSupervisor([{ botId: 'bot-a', configPath: '/tmp/.env.bot-a' }]);
    supervisor.startAll();

    for (let i = 0; i < 9; i++) {
      children[children.length - 1]!.emit('exit', 1, null);
      await vi.advanceTimersByTimeAsync(1000 * Math.min(Math.pow(2, i), 30));
    }

    const activeChild = children[children.length - 1]!;
    activeChild.emit('exit', 1, null);

    const state = supervisor.getStates()[0]!;
    expect(state.status).toBe('failed');
    expect(state.failureReason).toContain('crashed');
  });

  it('untilAllExited resolves when all children stop during shutdown', async () => {
    const supervisor = createSupervisor();
    supervisor.startAll();

    const exited = vi.fn();
    void supervisor.untilAllExited().then(exited);
    const shutdownPromise = supervisor.shutdown('SIGTERM', 15_000);
    children[0]!.stdout?.write('__WB_DRAINED__\n');
    children[1]!.stdout?.write('__WB_DRAINED__\n');
    children[0]!.emit('exit', 0, null);
    children[1]!.emit('exit', 0, null);
    await shutdownPromise;

    expect(exited).toHaveBeenCalled();
  });

  it('passes BOT_ID and WB_MODE into child env', () => {
    const supervisor = createSupervisor([{ botId: 'bot-a', configPath: '/tmp/.env.bot-a' }]);
    supervisor.startAll();

    expect(spawnFn).toHaveBeenCalledWith(
      process.execPath,
      ['/tmp/wb-bot-main.js', '--bot', 'bot-a'],
      expect.objectContaining({
        stdio: ['ignore', 'pipe', 'inherit'],
        detached: false,
        env: expect.objectContaining({ BOT_ID: 'bot-a', WB_MODE: 'multi-bot' }),
      }),
    );
  });
});
