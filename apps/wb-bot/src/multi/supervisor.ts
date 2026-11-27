import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import type { Logger } from 'pino';
import type { DiscoveredBot } from './discovery.js';

const HEALTHY_UPTIME_MS = 5 * 60 * 1000;
const HEALTH_CHECK_INTERVAL_MS = 60 * 1000;
const CRASH_WINDOW_MS = 10 * 60 * 1000;
const MAX_CRASHES_PER_WINDOW = 10;
const DRAIN_MARKER = '__WB_DRAINED__';

type ChildStatus = 'starting' | 'running' | 'restarting' | 'failed' | 'stopping' | 'stopped';

type SpawnLike = typeof spawn;

export interface ChildState {
  botId: string;
  configPath: string;
  child: ChildProcess | null;
  startedAt: number | null;
  restartCount: number;
  crashWindow: number[];
  status: ChildStatus;
  failureReason?: string;
}

interface ManagedChildState extends ChildState {
  restartTimer: ReturnType<typeof setTimeout> | null;
  drainSeen: boolean;
  drainReader: Interface | null;
  canObserveDrain: boolean;
  signalSent: boolean;
}

export interface SupervisorOptions {
  bin: string;
  mainJs: string;
  baseEnv: NodeJS.ProcessEnv;
  logger: Logger;
  spawnFn?: SpawnLike;
  nowFn?: () => number;
}

export function nextBackoffMs(restartCount: number): number {
  return Math.min(1000 * Math.pow(2, restartCount), 30_000);
}

export function shouldGiveUp(crashWindow: number[], now: number): boolean {
  const recent = crashWindow.filter((timestamp) => timestamp > now - CRASH_WINDOW_MS);
  return recent.length >= MAX_CRASHES_PER_WINDOW;
}

export function isHealthyUptime(startedAt: number, now: number): boolean {
  return now - startedAt > HEALTHY_UPTIME_MS;
}

export class Supervisor {
  private readonly states = new Map<string, ManagedChildState>();
  private readonly spawnFn: SpawnLike;
  private readonly nowFn: () => number;
  private readonly waiters = new Set<() => void>();
  private readonly changeWaiters = new Set<() => void>();
  private healthyTimer: ReturnType<typeof setInterval> | null = null;
  private shuttingDown = false;
  private started = false;

  constructor(bots: DiscoveredBot[], private readonly opts: SupervisorOptions) {
    this.spawnFn = opts.spawnFn ?? spawn;
    this.nowFn = opts.nowFn ?? Date.now;
    for (const bot of bots) {
      this.states.set(bot.botId, {
        botId: bot.botId,
        configPath: bot.configPath,
        child: null,
        startedAt: null,
        restartCount: 0,
        crashWindow: [],
        status: 'stopped',
        restartTimer: null,
        drainSeen: false,
        drainReader: null,
        canObserveDrain: false,
        signalSent: false,
      });
    }
  }

  startAll(): void {
    if (this.started) return;
    this.started = true;
    this.healthyTimer = setInterval(() => this.checkHealthy(), HEALTH_CHECK_INTERVAL_MS);
    for (const state of this.states.values()) {
      this.spawnOne(state);
    }
    this.checkTerminal();
  }

  async shutdown(signal: 'SIGINT' | 'SIGTERM', gracePeriodMs: number): Promise<void> {
    this.shuttingDown = true;
    if (this.healthyTimer) {
      clearInterval(this.healthyTimer);
      this.healthyTimer = null;
    }

    const deadline = this.nowFn() + gracePeriodMs;
    for (const state of this.states.values()) {
      if (state.restartTimer) {
        clearTimeout(state.restartTimer);
        state.restartTimer = null;
      }
      if (state.status === 'failed' || state.status === 'stopped') continue;
      if (!state.child) {
        state.status = 'stopped';
        continue;
      }
      if (!state.canObserveDrain) {
        state.status = 'stopping';
        state.signalSent = true;
        this.killChild(state, signal);
      }
    }

    this.checkTerminal();
    if (!this.areAllExited() && this.hasDrainAwareChildren()) {
      await this.waitForDrainOrExit(deadline);
    }
    if (this.areAllExited()) return;

    for (const state of this.states.values()) {
      if (!state.child || state.status === 'failed' || state.status === 'stopped' || state.signalSent) continue;
      state.status = 'stopping';
      state.signalSent = true;
      this.killChild(state, signal);
    }

    const remainingMs = Math.max(0, deadline - this.nowFn());
    await Promise.race([
      this.untilAllExited(),
      new Promise<void>((resolve) => setTimeout(resolve, remainingMs)),
    ]);
    if (this.areAllExited()) return;

    for (const state of this.states.values()) {
      if (!state.child) continue;
      state.status = 'stopping';
      this.killChild(state, 'SIGKILL');
    }
  }

  untilAllExited(): Promise<void> {
    if (this.areAllExited()) return Promise.resolve();
    return new Promise((resolve) => {
      this.waiters.add(resolve);
    });
  }

  getStates(): ReadonlyArray<Readonly<ChildState>> {
    return Array.from(this.states.values(), (state) => ({
      botId: state.botId,
      configPath: state.configPath,
      child: state.child,
      startedAt: state.startedAt,
      restartCount: state.restartCount,
      crashWindow: [...state.crashWindow],
      status: state.status,
      failureReason: state.failureReason,
    }));
  }

  private spawnOne(state: ManagedChildState): void {
    if (this.shuttingDown) {
      state.status = 'stopped';
      this.checkTerminal();
      return;
    }

    state.restartTimer = null;
    state.failureReason = undefined;
    state.status = 'starting';
    state.drainSeen = false;
    state.canObserveDrain = false;
    state.signalSent = false;
    state.drainReader?.close();
    state.drainReader = null;

    const child = this.spawnFn(this.opts.bin, [this.opts.mainJs, '--bot', state.botId], {
      env: { ...this.opts.baseEnv, BOT_ID: state.botId, WB_MODE: 'multi-bot' },
      stdio: ['ignore', 'pipe', 'inherit'],
      detached: false,
    });

    state.child = child;
    state.startedAt = this.nowFn();
    state.status = 'running';
    this.attachDrainReader(state, child);

    this.opts.logger.info({ botId: state.botId, pid: child.pid, configPath: state.configPath }, 'started wb-bot child');

    let handled = false;
    const finalize = (code: number | null, signal: NodeJS.Signals | null, error?: Error): void => {
      if (handled) return;
      handled = true;
      state.child = null;
      state.startedAt = null;
      state.drainReader?.close();
      state.drainReader = null;
      state.drainSeen = false;
      state.canObserveDrain = false;
      state.signalSent = false;
      this.notifyChange();

      if (this.shuttingDown || state.status === 'stopping') {
        state.status = 'stopped';
        this.opts.logger.info({ botId: state.botId, code, signal }, 'wb-bot child stopped');
        this.checkTerminal();
        return;
      }

      const now = this.nowFn();
      state.crashWindow = state.crashWindow.filter((timestamp) => timestamp > now - CRASH_WINDOW_MS);
      state.crashWindow.push(now);

      if (shouldGiveUp(state.crashWindow, now)) {
        state.status = 'failed';
        state.failureReason = error?.message ?? `crashed ${state.crashWindow.length} times in 10 min`;
        this.opts.logger.error({ botId: state.botId, code, signal, failureReason: state.failureReason }, 'bot give-up, no more restart');
        this.checkTerminal();
        return;
      }

      const backoffMs = nextBackoffMs(state.restartCount);
      state.restartCount += 1;
      state.status = 'restarting';
      this.opts.logger.warn({ botId: state.botId, code, signal, restartCount: state.restartCount, backoffMs }, 'bot crashed, scheduling restart');
      state.restartTimer = setTimeout(() => {
        state.restartTimer = null;
        if (state.status !== 'restarting') {
          this.checkTerminal();
          return;
        }
        this.spawnOne(state);
      }, backoffMs);
      this.checkTerminal();
    };

    child.once('exit', (code, signal) => finalize(code, signal));
    child.once('error', (error) => finalize(null, null, error instanceof Error ? error : new Error(String(error))));
  }

  private attachDrainReader(state: ManagedChildState, child: ChildProcess): void {
    if (!child.stdout) return;
    state.canObserveDrain = true;
    const reader = createInterface({ input: child.stdout });
    state.drainReader = reader;
    let buffered = '';
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      buffered += text;
      process.stdout.write(chunk);
      if (buffered.includes(`${DRAIN_MARKER}\n`)) {
        state.drainSeen = true;
        this.notifyChange();
      }
      if (buffered.length > DRAIN_MARKER.length * 4) {
        buffered = buffered.slice(-DRAIN_MARKER.length * 2);
      }
    });
    reader.on('line', (line) => {
      if (line !== DRAIN_MARKER) return;
      state.drainSeen = true;
      this.notifyChange();
    });
  }

  private hasDrainAwareChildren(): boolean {
    return Array.from(this.states.values()).some((state) => state.child && state.canObserveDrain && !state.drainSeen);
  }

  private async waitForDrainOrExit(deadline: number): Promise<void> {
    while (this.nowFn() < deadline) {
      if (this.areAllExited()) return;
      const waiting = Array.from(this.states.values()).filter((state) => state.child && state.canObserveDrain && !state.drainSeen);
      if (waiting.length === 0) return;
      const remainingMs = Math.max(0, deadline - this.nowFn());
      await Promise.race([
        this.untilChanged(),
        new Promise<void>((resolve) => setTimeout(resolve, remainingMs)),
      ]);
    }
  }

  private untilChanged(): Promise<void> {
    return new Promise((resolve) => {
      this.changeWaiters.add(resolve);
    });
  }

  private notifyChange(): void {
    for (const resolve of this.changeWaiters) resolve();
    this.changeWaiters.clear();
  }

  private checkHealthy(): void {
    const now = this.nowFn();
    for (const state of this.states.values()) {
      if (state.status !== 'running' || state.startedAt === null) continue;
      if (!isHealthyUptime(state.startedAt, now)) continue;
      if (state.restartCount === 0 && state.crashWindow.length === 0) continue;
      state.restartCount = 0;
      state.crashWindow = [];
      this.opts.logger.info({ botId: state.botId }, 'wb-bot child healthy, reset restart window');
    }
  }

  private killChild(state: ManagedChildState, signal: NodeJS.Signals): void {
    try {
      state.child?.kill(signal);
    } catch (error) {
      this.opts.logger.warn({ botId: state.botId, signal, err: error }, 'failed to signal wb-bot child');
    }
  }

  private areAllExited(): boolean {
    return Array.from(this.states.values()).every((state) => state.status === 'stopped' || state.status === 'failed');
  }

  private checkTerminal(): void {
    if (!this.areAllExited()) return;
    if (this.healthyTimer) {
      clearInterval(this.healthyTimer);
      this.healthyTimer = null;
    }
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
  }
}
