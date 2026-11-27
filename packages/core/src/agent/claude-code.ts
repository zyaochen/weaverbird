import { spawnSync } from 'node:child_process';
import { CLISubprocessAgent, type CLIProcessSpec } from './cli-subprocess.js';
import type { AgentCapabilities, AgentEvent, AgentRun, ConsentLevel, ErrorCode, RunRequest } from './types.js';

type JSONRecord = Record<string, unknown>;
type PermissionMode = 'plan' | 'default' | 'acceptEdits' | 'bypassPermissions';

const CLAUDE_PASSTHROUGH_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'CLAUDE_MD_PATH',
  'CLAUDE_CONFIG_DIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'PWD',
  'LANG',
  'LC_ALL',
  'TERM',
  'TMPDIR',
  'NO_COLOR',
  'FORCE_COLOR',
  'SSL_CERT_FILE',
  'NODE_EXTRA_CA_CERTS',
] as const;

const CAPABILITIES: AgentCapabilities = {
  type: 'cli',
  input: { images: true, attachments: true },
  output: { streaming: true, thinking: true, toolUse: true, citations: false },
  context: { window: 200000, costClass: 'premium' },
  skills: { code: 'A+', review: 'A', plan: 'A', research: 'A', ops: 'B' },
  tools: {
    builtin: ['Read', 'Write', 'Bash', 'Edit', 'Glob', 'Grep', 'Task', 'WebSearch'],
    canExtend: true,
  },
  session: { resumable: true, tokenKind: 'opaque' },
  tokenRotation: 'rotating',
};

function pickEnv(source: NodeJS.ProcessEnv, keys: readonly string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function asRecord(value: unknown): JSONRecord | null {
  return value !== null && typeof value === 'object' ? (value as JSONRecord) : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readErrorMessage(payload: JSONRecord): string {
  const error = asRecord(payload['error']);
  return readString(error?.['message']) ?? readString(payload['result']) ?? 'claude run failed';
}

function inferRecoverable(code?: ErrorCode): boolean {
  return code === 'rate_limit' || code === 'network' || code === 'context_length';
}

function inferErrorCode(message: string): ErrorCode {
  const text = message.toLowerCase();
  if (text.includes('auth')) return 'auth';
  if (text.includes('rate limit')) return 'rate_limit';
  if (text.includes('context')) return 'context_length';
  if (text.includes('network')) return 'network';
  return 'crashed';
}

function stringifyToolResult(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return JSON.stringify(value ?? '');
  return value
    .map((item) => (typeof item === 'string' ? item : readString(asRecord(item)?.['text']) ?? JSON.stringify(item)))
    .join('\n');
}

function extractSubagentId(event: JSONRecord): string | undefined {
  if (event['isSidechain'] === true) {
    const rawAgentId = readString(event['agentId']);
    if (rawAgentId) return rawAgentId;
  }
  return undefined;
}

function mapAssistantContent(item: JSONRecord, subagentId?: string): AgentEvent[] {
  const type = readString(item['type']);
  if (type === 'text') return [{ type: 'text', delta: readString(item['text']) ?? '' }];
  if (type === 'thinking') return [{ type: 'thinking', delta: readString(item['thinking']) ?? '' }];
  if (type === 'tool_use') {
    const event: AgentEvent = { type: 'tool_use', id: readString(item['id']) ?? '', name: readString(item['name']) ?? '', input: item['input'] };
    if (subagentId) (event as any).subagentId = subagentId;
    return [event];
  }
  return [];
}

function mapToolResult(item: JSONRecord, subagentId?: string): AgentEvent[] {
  if (readString(item['type']) !== 'tool_result') return [];
  const event: AgentEvent = {
    type: 'tool_result',
    id: readString(item['tool_use_id']) ?? '',
    output: stringifyToolResult(item['content']),
    isError: Boolean(item['is_error']),
  };
  if (subagentId) (event as any).subagentId = subagentId;
  return [event];
}

function mapMessage(payload: JSONRecord): AgentEvent[] {
  const message = asRecord(payload['message']);
  const rawContent = message?.['content'];
  const content = Array.isArray(rawContent) ? rawContent : [];
  const subagentId = extractSubagentId(payload);
  if (readString(payload['type']) === 'assistant') return content.flatMap((item) => mapAssistantContent(asRecord(item) ?? {}, subagentId));
  if (readString(payload['type']) === 'user') return content.flatMap((item) => mapToolResult(asRecord(item) ?? {}, subagentId));
  return [];
}

export function mapConsentLevelToPermissionMode(level: ConsentLevel = 'normal'): PermissionMode {
  if (level === 'plan-only') return 'plan';
  if (level === 'relaxed') return 'acceptEdits';
  if (level === 'auto') return 'bypassPermissions';
  return 'default';
}

export function mapClaudeStreamEvent(payload: unknown): AgentEvent[] {
  const event = asRecord(payload);
  if (!event) return [];
  if (readString(event['type']) === 'system' && readString(event['subtype']) === 'init') {
    return [{
      type: 'system',
      continuationToken: readString(event['session_id']),
      cwd: readString(event['cwd']),
      model: readString(event['model']),
    }];
  }
  if (readString(event['type']) === 'assistant' || readString(event['type']) === 'user') return mapMessage(event);
  if (readString(event['type']) === 'result' && readString(event['subtype']) === 'success') {
    const usage = asRecord(event['usage']);
    return [
      {
        type: 'usage',
        inputTokens: typeof usage?.['input_tokens'] === 'number' ? usage['input_tokens'] : undefined,
        outputTokens: typeof usage?.['output_tokens'] === 'number' ? usage['output_tokens'] : undefined,
        costUsd: typeof event['total_cost_usd'] === 'number' ? event['total_cost_usd'] : undefined,
      },
      { type: 'done', continuationToken: readString(event['session_id']) },
    ];
  }
  if (readString(event['type']) === 'result' && readString(event['subtype'])?.startsWith('error')) {
    const message = readErrorMessage(event);
    const code = inferErrorCode(message);
    return [{ type: 'error', message, code, recoverable: inferRecoverable(code) }];
  }
  return [];
}

const TOOL_PROGRESS_DEFAULT_MS = 2000;
const TOOL_PROGRESS_MIN_MS = 100;
const TOOL_PROGRESS_MAX_MS = 60000;

export function parseToolProgressInterval(envValue: string | undefined): number {
  if (envValue === undefined) return TOOL_PROGRESS_DEFAULT_MS;
  const parsed = Number.parseInt(envValue, 10);
  if (Number.isNaN(parsed) || parsed < TOOL_PROGRESS_MIN_MS || parsed > TOOL_PROGRESS_MAX_MS) return TOOL_PROGRESS_DEFAULT_MS;
  return parsed;
}

/**
 * claude CLI has no image / attachment flag; it reads local files with its own
 * Read tool. Paths the caller already wrote into the prompt are left alone, the
 * rest are listed after the prompt so `images` / `attachments` are never dropped.
 */
export function promptWithLocalFiles(req: Pick<RunRequest, 'prompt' | 'images' | 'attachments'>): string {
  const missing = [...(req.images ?? []), ...(req.attachments ?? [])].filter((path) => !req.prompt.includes(path));
  if (missing.length === 0) return req.prompt;
  return `${req.prompt}\n\n${missing.map((path) => `附件: ${path}`).join('\n')}`;
}

export class ClaudeCodeAgent extends CLISubprocessAgent {
  readonly id = 'claude-code';
  readonly displayName = 'Claude Code';
  private availability?: Promise<boolean>;
  private capabilities?: Promise<AgentCapabilities>;

  run(req: RunRequest): AgentRun {
    const baseRun = super.run(req);
    const intervalMs = parseToolProgressInterval(process.env['WB_TOOL_PROGRESS_INTERVAL_MS']);
    return new ToolProgressWrappedRun(baseRun, intervalMs);
  }

  async isAvailable(): Promise<boolean> {
    this.availability ??= Promise.resolve(this.checkAvailability());
    return this.availability;
  }

  async getCapabilities(): Promise<AgentCapabilities> {
    this.capabilities ??= Promise.resolve(CAPABILITIES);
    return this.capabilities;
  }

  protected buildProcessSpec(req: RunRequest): CLIProcessSpec {
    const args = ['--print', '--output-format', 'stream-json', '--verbose'];
    if (req.continuationToken) args.push('--resume', req.continuationToken);
    if (req.model) args.push('--model', req.model);
    args.push('--permission-mode', mapConsentLevelToPermissionMode(req.consentLevel), promptWithLocalFiles(req));
    return { command: 'claude', args, cwd: req.cwd, env: pickEnv(process.env, CLAUDE_PASSTHROUGH_KEYS) };
  }

  protected mapOutput(payload: unknown): AgentEvent[] {
    return mapClaudeStreamEvent(payload);
  }

  private checkAvailability(): boolean {
    const result = spawnSync('claude', ['--version'], { encoding: 'utf8' });
    return result.status === 0 && result.stdout.includes('Claude Code');
  }
}

type DeltaBuffer = { id: string; message?: string; subagentId?: string; updated: boolean };

class ToolProgressWrappedRun implements AgentRun {
  readonly events: AsyncIterable<AgentEvent>;
  private timer: ReturnType<typeof setInterval> | null = null;
  private buffer: DeltaBuffer | null = null;
  private pending: AgentEvent[] = [];
  private done = false;

  constructor(private readonly baseRun: AgentRun, private readonly intervalMs: number) {
    this.events = this.wrapEvents();
  }

  async stop(): Promise<void> {
    return this.baseRun.stop();
  }

  async waitForExit(timeoutMs?: number): Promise<boolean> {
    return this.baseRun.waitForExit(timeoutMs);
  }

  private async *wrapEvents(): AsyncGenerator<AgentEvent> {
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    try {
      for await (const event of this.baseRun.events) {
        this.trackDelta(event);
        yield event;
        yield* this.drainPending();
        if (event.type === 'done' || event.type === 'error') {
          this.done = true;
          break;
        }
      }
    } finally {
      this.cleanup();
    }
  }

  private trackDelta(event: AgentEvent): void {
    if (event.type === 'tool_use') {
      const snippet = typeof event.input === 'string' ? event.input.slice(0, 200) : undefined;
      this.buffer = { id: event.id, message: snippet, subagentId: (event as any).subagentId, updated: true };
    } else if (event.type === 'text' || event.type === 'thinking') {
      const id = this.buffer?.id ?? '_text';
      this.buffer = { id, message: event.delta.slice(0, 200), subagentId: this.buffer?.subagentId, updated: true };
    }
  }

  private tick(): void {
    if (this.done || !this.buffer?.updated) return;
    const progress: AgentEvent = { type: 'tool_progress', id: this.buffer.id };
    if (this.buffer.message) (progress as any).message = this.buffer.message;
    if (this.buffer.subagentId) (progress as any).subagentId = this.buffer.subagentId;
    this.pending.push(progress);
    this.buffer.updated = false;
  }

  private *drainPending(): Generator<AgentEvent> {
    while (this.pending.length > 0) {
      yield this.pending.shift()!;
    }
  }

  private cleanup(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.buffer = null;
  }
}
