import { spawn, type ChildProcess, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { createInterface } from 'node:readline';
import type {
  AgentAdapter,
  AgentCapabilities,
  AgentEvent,
  AgentRun,
  ErrorCode,
  RunRequest,
} from './types.js';

const STDERR_RING_MAX_BYTES = 8 * 1024;

export interface CLIProcessSpec {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

type CLIAgentEvent = Exclude<AgentEvent, { type: 'consent_required' }>;
type QueueWaiter<T> = {
  resolve: (value: IteratorResult<T>) => void;
  reject: (reason?: unknown) => void;
};
type RunState = { sawError: boolean };
type StderrRingBuffer = { text: string };

function isCLIEvent(event: AgentEvent): event is CLIAgentEvent {
  return event.type !== 'consent_required';
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function inferErrorCode(stderr: string): ErrorCode {
  const message = stderr.toLowerCase();
  if (message.includes('auth')) return 'auth';
  if (message.includes('rate limit')) return 'rate_limit';
  if (message.includes('context')) return 'context_length';
  if (message.includes('network')) return 'network';
  return 'crashed';
}

function buildExitMessage(stderr: string, code: number | null, signal: NodeJS.Signals | null): string {
  const trimmed = stderr.trim();
  if (trimmed) return trimmed.split('\n').at(-1) ?? trimmed;
  if (signal) return `process exited with signal ${signal}`;
  return `process exited with code ${code ?? -1}`;
}

function buildCrashEvent(message: string, code: ErrorCode = 'crashed'): CLIAgentEvent {
  return { type: 'error', message, code, recoverable: false };
}

function raceExit(exitPromise: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    void exitPromise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function trimToMaxBytes(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value);
  if (buffer.length <= maxBytes) return value;
  let start = buffer.length - maxBytes;
  while (start < buffer.length) {
    const byte = buffer.at(start);
    if (byte === undefined || (byte & 0b1100_0000) !== 0b1000_0000) break;
    start += 1;
  }
  return buffer.subarray(start).toString('utf8');
}

function appendStderr(buffer: StderrRingBuffer, line: string): void {
  const next = buffer.text ? `${buffer.text}\n${line}` : line;
  buffer.text = trimToMaxBytes(next, STDERR_RING_MAX_BYTES);
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private readonly waiters: QueueWaiter<T>[] = [];
  private closed = false;
  private failure: unknown;

  push(value: T): void {
    if (this.closed || this.failure !== undefined) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.items.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ value: undefined as T, done: true });
    }
  }

  fail(error: unknown): void {
    if (this.closed) return;
    this.failure = error;
    this.closed = true;
    this.items.length = 0;
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(error);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        if (this.items.length > 0) return { value: this.items.shift() as T, done: false };
        if (this.failure !== undefined) throw this.failure;
        if (this.closed) return { value: undefined as T, done: true };
        return new Promise<IteratorResult<T>>((resolve, reject) => this.waiters.push({ resolve, reject }));
      },
      return: async () => {
        this.close();
        return { value: undefined as T, done: true };
      },
      throw: async (error?: unknown) => {
        this.fail(error);
        throw error;
      },
    };
  }
}

class ImmediateAgentRun implements AgentRun {
  constructor(private readonly immediateEvents: readonly CLIAgentEvent[]) {}

  get events(): AsyncIterable<AgentEvent> {
    const events = this.immediateEvents;
    return { [Symbol.asyncIterator]: async function* () { yield* events; } };
  }

  async stop(): Promise<void> {}
  async waitForExit(): Promise<boolean> { return true; }
}

class SubprocessAgentRun implements AgentRun {
  readonly events: AsyncIterable<AgentEvent>;
  private stopping = false;

  constructor(
    queue: AsyncEventQueue<CLIAgentEvent>,
    private readonly child: ChildProcess,
    private readonly exitPromise: Promise<void>,
    private readonly stopGraceMs: number,
  ) {
    this.events = queue;
  }

  async stop(): Promise<void> {
    if (this.stopping || hasExited(this.child)) return this.exitPromise;
    this.stopping = true;
    this.child.kill('SIGTERM');
    if (!(await this.waitForExit(this.stopGraceMs)) && !hasExited(this.child)) {
      this.child.kill('SIGKILL');
    }
    await this.exitPromise;
  }

  async waitForExit(timeoutMs?: number): Promise<boolean> {
    if (timeoutMs === undefined) {
      await this.exitPromise;
      return true;
    }
    if (timeoutMs <= 0) return hasExited(this.child);
    return raceExit(this.exitPromise, timeoutMs);
  }
}

export abstract class CLISubprocessAgent implements AgentAdapter {
  abstract readonly id: string;
  abstract readonly displayName: string;
  abstract isAvailable(): Promise<boolean>;
  abstract getCapabilities(): Promise<AgentCapabilities>;

  run(req: RunRequest): AgentRun {
    try {
      const spec = this.buildProcessSpec(req);
      const child = spawn(spec.command, spec.args, this.buildSpawnOptions(spec, req));
      const queue = new AsyncEventQueue<CLIAgentEvent>();
      const exitPromise = this.bindProcess(req, child, queue, { sawError: false });
      return new SubprocessAgentRun(queue, child, exitPromise, req.stopGraceMs ?? 500);
    } catch (error) {
      return new ImmediateAgentRun(this.mapSpawnError(error));
    }
  }

  protected abstract buildProcessSpec(req: RunRequest): CLIProcessSpec;
  protected abstract mapOutput(payload: unknown, req: RunRequest): AgentEvent[];

  protected envFilter?(env: NodeJS.ProcessEnv, req: RunRequest): NodeJS.ProcessEnv;
  protected cwdGuard?(cwd: string | undefined, req: RunRequest): string | undefined;
  protected writeStdin?(child: ChildProcess, req: RunRequest): Promise<void>;

  protected mapSpawnError(error: unknown): CLIAgentEvent[] {
    return [buildCrashEvent(getErrorMessage(error))];
  }

  protected mapExitError(stderr: string, code: number | null, signal: NodeJS.Signals | null): CLIAgentEvent {
    return buildCrashEvent(buildExitMessage(stderr, code, signal), inferErrorCode(stderr));
  }

  private buildSpawnOptions(spec: CLIProcessSpec, req: RunRequest): SpawnOptionsWithoutStdio {
    const cwd = this.cwdGuard ? this.cwdGuard(spec.cwd, req) : spec.cwd;
    const env = this.envFilter ? this.envFilter(spec.env ?? process.env, req) : (spec.env ?? process.env);
    return { cwd, env };
  }

  private bindProcess(
    req: RunRequest,
    child: ChildProcess,
    queue: AsyncEventQueue<CLIAgentEvent>,
    state: RunState,
  ): Promise<void> {
    const stderr: StderrRingBuffer = { text: '' };
    this.bindStdout(req, child, queue, state);
    this.bindStderr(child, stderr);
    this.bindStdin(req, child, queue, state);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (events: CLIAgentEvent[]) => {
        if (settled) return;
        settled = true;
        this.pushEvents(queue, state, events);
        queue.close();
        resolve();
      };
      child.once('error', (error) => finish(this.mapSpawnError(error)));
      child.once('close', (code, signal) => {
        const events = code === 0 || state.sawError ? [] : [this.mapExitError(stderr.text, code, signal)];
        finish(events);
      });
    });
  }

  private bindStdout(
    req: RunRequest,
    child: ChildProcess,
    queue: AsyncEventQueue<CLIAgentEvent>,
    state: RunState,
  ): void {
    const stdout = child.stdout;
    if (!stdout) return;
    const reader = createInterface({ input: stdout });
    reader.on('line', (line) => this.pushEvents(queue, state, this.parseOutputLine(line, req)));
  }

  private bindStderr(child: ChildProcess, stderr: StderrRingBuffer): void {
    const stream = child.stderr;
    if (!stream) return;
    const reader = createInterface({ input: stream });
    reader.on('line', (line) => appendStderr(stderr, line));
  }

  private bindStdin(
    req: RunRequest,
    child: ChildProcess,
    queue: AsyncEventQueue<CLIAgentEvent>,
    state: RunState,
  ): void {
    if (!this.writeStdin) return;
    void this.writeStdin(child, req).catch((error) => {
      this.pushEvents(queue, state, this.mapSpawnError(error));
      child.stdin?.destroy(error instanceof Error ? error : undefined);
      if (!hasExited(child)) child.kill('SIGTERM');
    });
  }

  private parseOutputLine(line: string, req: RunRequest): CLIAgentEvent[] {
    try {
      return this.mapOutput(JSON.parse(line), req).filter(isCLIEvent);
    } catch (error) {
      return [buildCrashEvent(getErrorMessage(error))];
    }
  }

  private pushEvents(queue: AsyncEventQueue<CLIAgentEvent>, state: RunState, events: CLIAgentEvent[]): void {
    for (const event of events) {
      state.sawError ||= event.type === 'error';
      queue.push(event);
    }
  }
}
