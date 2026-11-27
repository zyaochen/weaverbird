import { spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync, mkdirSync, writeFileSync, renameSync, appendFileSync,
  openSync, statSync, readSync, closeSync, readFileSync,
} from 'node:fs';
import {
  runDir,
  runErrorLogPath,
  runEventsPath,
  runHeartbeatPath,
  runOutputLogPath,
  runPidPath,
  runSpecPath,
  runStatusPath,
  runStopSignalPath,
} from '../paths.js';

export const CURRENT_SCHEMA_VERSION = 1;
export const HEARTBEAT_INTERVAL_MS = 5_000;
export const STOP_POLL_INTERVAL_MS = 500;
export const STOP_GRACE_MS = 500;

export interface RunSpec {
  runId: string;
  botId: string;
  agentId: string;
  agentCommand: string;
  agentArgs: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  userOpenId: string;
  threadId: string;
  sourceMessageId: string;
  replyMessageId: string;
  continuationToken?: string;
  consentLevel?: string;
  model?: string;
  schemaVersion?: number;
  host?: string;
  /**
   * 可选: prompt 通过 stdin 写给 grandchild (codex `exec --json -` 这种 stdin-only
   * 模式). 设置后, wb-runner spawn 时 stdio[0]='pipe', 起完即 `child.stdin.end(stdinInput)`
   * 然后 unref. 未设置 (claude-code 默认路径) 保持 stdio[0]='ignore' 原行为不变.
   */
  stdinInput?: string;
}

export type RunStatus = 'running' | 'done' | 'error' | 'stopped';

function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

const VALID_ID_PATTERN = /^[a-zA-Z0-9._-]{1,64}$/;

export function validateSpecId(id: string, field: string): void {
  if (!VALID_ID_PATTERN.test(id)) {
    throw new Error(`invalid ${field}: must match /^[a-zA-Z0-9._-]{1,64}$/, got "${id}"`);
  }
}

export class WbRunner {
  private readonly runDir: string;
  private child: ChildProcess | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private stopPollTimer: ReturnType<typeof setInterval> | null = null;
  private eventTailTimer: ReturnType<typeof setInterval> | null = null;
  private handlingStop = false;

  constructor(
    private readonly dataDir: string,
    private readonly spec: RunSpec,
  ) {
    validateSpecId(spec.runId, 'runId');
    validateSpecId(spec.botId, 'botId');
    this.runDir = runDir(dataDir, spec.runId, spec.botId);
  }

  get runDirectory(): string {
    return this.runDir;
  }

  async start(): Promise<void> {
    mkdirSync(this.runDir, { recursive: true });

    const specToWrite = {
      runId: this.spec.runId,
      botId: this.spec.botId,
      agentId: this.spec.agentId,
      model: this.spec.model ?? null,
      cwd: this.spec.cwd,
      userOpenId: this.spec.userOpenId,
      threadId: this.spec.threadId,
      sourceMessageId: this.spec.sourceMessageId,
      replyMessageId: this.spec.replyMessageId,
      continuationToken: this.spec.continuationToken ?? null,
      consentLevel: this.spec.consentLevel ?? 'normal',
      startedAt: new Date().toISOString(),
      schemaVersion: this.spec.schemaVersion ?? CURRENT_SCHEMA_VERSION,
      host: this.spec.host ?? 'local',
    };
    writeFileSync(runSpecPath(this.dataDir, this.spec.runId, this.spec.botId), JSON.stringify(specToWrite, null, 2));
    this.writeStatus('running');
    this.writeHeartbeat();

    const outputFd = openSync(runOutputLogPath(this.dataDir, this.spec.runId, this.spec.botId), 'a');
    const errFd = openSync(runErrorLogPath(this.dataDir, this.spec.runId, this.spec.botId), 'a');

    // D1: codex 等 stdin-only CLI 需要把 prompt 通过 stdin 写给 grandchild,
    // 默认 claude-code 路径仍走 stdio[0]='ignore' (no TTY, no stdin, contract 不变).
    const stdinSpec: 'pipe' | 'ignore' = this.spec.stdinInput !== undefined ? 'pipe' : 'ignore';
    this.child = spawn(this.spec.agentCommand, this.spec.agentArgs, {
      cwd: this.spec.cwd,
      env: this.spec.env,
      stdio: [stdinSpec, outputFd, errFd],
      detached: true,
    });
    if (stdinSpec === 'pipe' && this.child.stdin) {
      // .end() 在 unref 之前调用, Node 会先 flush stdin buffer 再让 fd close, 然后才允许 parent exit.
      this.child.stdin.end(this.spec.stdinInput);
    }
    this.child.unref();

    writeFileSync(runPidPath(this.dataDir, this.spec.runId, this.spec.botId), String(this.child.pid ?? ''));

    this.heartbeatTimer = setInterval(() => this.writeHeartbeat(), HEARTBEAT_INTERVAL_MS);
    this.stopPollTimer = setInterval(() => this.checkStopSignal(), STOP_POLL_INTERVAL_MS);

    const tailState = this.startEventTailer();

    return new Promise((resolve) => {
      this.child!.once('close', (code) => {
        this.flushEventTailer(tailState);
        this.cleanup();
        if (this.handlingStop) {
          if (!this.hasTerminalEvent()) {
            this.appendErrorEvent('stopped by user');
          }
          this.writeStatus('stopped');
        } else if (code === 0) {
          if (!this.hasTerminalEvent()) {
            this.appendDoneEvent();
          }
          this.writeStatus('done');
        } else {
          if (!this.hasTerminalEvent()) {
            this.appendErrorEvent(`child exited with code ${code}`);
          }
          this.writeStatus('error');
        }
        resolve();
      });

      this.child!.once('error', (err) => {
        this.flushEventTailer(tailState);
        this.cleanup();
        appendFileSync(runErrorLogPath(this.dataDir, this.spec.runId, this.spec.botId), `spawn error: ${err.message}\n`);
        if (!this.hasTerminalEvent()) {
          this.appendErrorEvent(`spawn failed: ${err.message}`);
        }
        this.writeStatus('error');
        resolve();
      });
    });
  }

  private startEventTailer(): { offset: number } {
    const state = { offset: 0 };
    const outputLog = runOutputLogPath(this.dataDir, this.spec.runId, this.spec.botId);
    this.eventTailTimer = setInterval(() => {
      this.tailOutputLog(outputLog, state);
    }, 200);
    return state;
  }

  private flushEventTailer(state: { offset: number }): void {
    const outputLog = runOutputLogPath(this.dataDir, this.spec.runId, this.spec.botId);
    this.tailOutputLog(outputLog, state);
  }

  private tailOutputLog(outputLog: string, state: { offset: number }): void {
    try {
      const { size } = statSync(outputLog);
      if (size <= state.offset) return;
      const buf = Buffer.alloc(size - state.offset);
      const fd = openSync(outputLog, 'r');
      readSync(fd, buf, 0, buf.length, state.offset);
      closeSync(fd);
      state.offset = size;
      const lines = buf.toString('utf8').split('\n');
      for (const line of lines) {
        if (line.trim()) this.appendEvent(line);
      }
    } catch {
      // file may not exist yet
    }
  }

  private appendEvent(line: string): void {
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed === 'object' && parsed !== null) {
        const event = ('schemaVersion' in parsed) ? parsed : { ...parsed, schemaVersion: CURRENT_SCHEMA_VERSION };
        appendFileSync(runEventsPath(this.dataDir, this.spec.runId, this.spec.botId), `${JSON.stringify(event)}\n`);
      }
    } catch {
      // non-JSON stdout lines are not events, skip
    }
  }

  private appendErrorEvent(message: string): void {
    const event = { type: 'error', message, schemaVersion: CURRENT_SCHEMA_VERSION };
    appendFileSync(runEventsPath(this.dataDir, this.spec.runId, this.spec.botId), `${JSON.stringify(event)}\n`);
  }

  private appendDoneEvent(): void {
    const event = { type: 'done', schemaVersion: CURRENT_SCHEMA_VERSION };
    appendFileSync(runEventsPath(this.dataDir, this.spec.runId, this.spec.botId), `${JSON.stringify(event)}\n`);
  }

  // D0 hotfix idempotency guard: skip terminal-event fallback when child 已写过 done/error.
  // 读 events.ndjson 最后非空行, 判断 type ∈ {done, error}.
  private hasTerminalEvent(): boolean {
    const ndjsonPath = runEventsPath(this.dataDir, this.spec.runId, this.spec.botId);
    if (!existsSync(ndjsonPath)) return false;
    try {
      const raw = readFileSync(ndjsonPath, 'utf8');
      const lines = raw.split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line || !line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as { type?: unknown };
          if (parsed && typeof parsed === 'object' &&
              (parsed.type === 'done' || parsed.type === 'error')) {
            return true;
          }
        } catch {
          // last non-empty line corrupt — treat as no terminal event
        }
        return false;
      }
      return false;
    } catch {
      return false;
    }
  }

  private writeStatus(status: RunStatus): void {
    atomicWrite(runStatusPath(this.dataDir, this.spec.runId, this.spec.botId), status);
  }

  private writeHeartbeat(): void {
    atomicWrite(runHeartbeatPath(this.dataDir, this.spec.runId, this.spec.botId), String(Math.floor(Date.now() / 1000)));
  }

  private checkStopSignal(): void {
    if (this.handlingStop) return;
    const signalPath = runStopSignalPath(this.dataDir, this.spec.runId, this.spec.botId);
    if (!existsSync(signalPath)) return;

    this.handlingStop = true;
    if (this.child && this.child.exitCode === null) {
      this.child.kill('SIGTERM');
      setTimeout(() => {
        if (this.child && this.child.exitCode === null) {
          this.child.kill('SIGKILL');
        }
      }, STOP_GRACE_MS);
    }
  }

  private cleanup(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.stopPollTimer) {
      clearInterval(this.stopPollTimer);
      this.stopPollTimer = null;
    }
    if (this.eventTailTimer) {
      clearInterval(this.eventTailTimer);
      this.eventTailTimer = null;
    }
  }
}

export function validateRunCwd(specCwd: string): boolean {
  return existsSync(specCwd);
}
