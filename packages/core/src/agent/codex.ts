import { spawnSync, type ChildProcess } from 'node:child_process';
import { CLISubprocessAgent, type CLIProcessSpec } from './cli-subprocess.js';
import type { AgentCapabilities, AgentEvent, AgentRun, ErrorCode, RunRequest } from './types.js';

type JSONRecord = Record<string, unknown>;

type TokenUsage = {
  inputTokens?: number;
  outputTokens?: number;
};

/**
 * Codex CLI 子进程允许透传的 env keys. wb-bot 也需要这份名单 (handleMessageViaWbRunner),
 * 防止两边漂移. 单一 source of truth. 不要复制 keys 数组到别处.
 */
export const CODEX_PASSTHROUGH_KEYS = [
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'CODEX_HOME',
  'CODEX_CONFIG_DIR',
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
  input: { images: true, attachments: false },
  output: { streaming: true, thinking: false, toolUse: true, citations: false },
  context: { window: 200000, costClass: 'standard' },
  skills: { code: 'A', review: 'A', plan: 'B', research: 'B', ops: 'B' },
  tools: {
    builtin: ['read_file', 'write_file', 'apply_patch', 'shell'],
    canExtend: true,
  },
  session: { resumable: true, tokenKind: 'opaque' },
  tokenRotation: 'static',
};

function asRecord(value: unknown): JSONRecord | null {
  return value !== null && typeof value === 'object' ? (value as JSONRecord) : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function pickEnv(source: NodeJS.ProcessEnv, keys: readonly string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function readUsage(payload: JSONRecord): TokenUsage {
  const usage = asRecord(payload['usage']);
  return {
    inputTokens: typeof usage?.['input_tokens'] === 'number' ? usage['input_tokens'] : undefined,
    outputTokens: typeof usage?.['output_tokens'] === 'number' ? usage['output_tokens'] : undefined,
  };
}

function joinTextParts(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => {
      const record = asRecord(item);
      return readString(record?.['text']) ?? readString(record?.['content']) ?? '';
    })
    .filter(Boolean)
    .join('\n');
}

function mapItemEvent(eventType: string, payload: JSONRecord): AgentEvent[] {
  const item = asRecord(payload['item']);
  if (!item) return [];
  const itemType = readString(item['type']);
  if (eventType === 'item.started' && itemType === 'command_execution') {
    return [{
      type: 'tool_use',
      id: readString(item['id']) ?? '',
      name: 'shell',
      input: { command: readString(item['command']) ?? '' },
    }];
  }
  if (eventType === 'item.completed' && itemType === 'command_execution') {
    const output = readString(item['aggregated_output']) ?? '';
    const status = readString(item['status']) ?? '';
    const exitCode = item['exit_code'];
    return [{
      type: 'tool_result',
      id: readString(item['id']) ?? '',
      output: output || `status=${status} exit_code=${typeof exitCode === 'number' ? exitCode : '-'}`,
      isError: status === 'failed' || (typeof exitCode === 'number' && exitCode !== 0),
    }];
  }
  if (eventType === 'item.completed' && itemType === 'error') {
    const message = readString(item['message']) ?? 'codex exec failed';
    return [{ type: 'error', message, code: inferErrorCode(message), recoverable: inferRecoverable(message) }];
  }
  return [];
}

function inferRecoverable(message: string): boolean {
  const text = message.toLowerCase();
  return text.includes('rate limit') || text.includes('network') || text.includes('timed out');
}

function inferErrorCode(message: string): ErrorCode {
  const text = message.toLowerCase();
  if (text.includes('401') || text.includes('unauthorized') || text.includes('auth')) return 'auth';
  if (text.includes('rate limit')) return 'rate_limit';
  if (text.includes('context')) return 'context_length';
  if (text.includes('network') || text.includes('connect') || text.includes('timeout')) return 'network';
  return 'crashed';
}

export function mapCodexStreamEvent(payload: unknown, req: RunRequest): AgentEvent[] {
  const event = asRecord(payload);
  if (!event) return [];
  const eventType = readString(event['type']) ?? '';
  if (eventType === 'thread.started') {
    const continuationToken = readString(event['thread_id']) ?? readString(event['session_id']);
    return [{ type: 'system', continuationToken, cwd: req.cwd, model: req.model }];
  }
  if (eventType === 'turn.completed') {
    const usage = readUsage(event);
    return [
      {
        type: 'usage',
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      },
      { type: 'done', continuationToken: readString(event['thread_id']) ?? readString(event['session_id']) },
    ];
  }
  if (eventType === 'agent_message' || eventType === 'assistant_message') {
    const text = readString(event['message']) ?? readString(event['text']) ?? '';
    return text ? [{ type: 'text', delta: text }] : [];
  }
  if (eventType === 'message' || eventType === 'response.output_text.done') {
    const text = readString(event['text']) ?? readString(event['delta']) ?? '';
    return text ? [{ type: 'text', delta: text }] : [];
  }
  if (eventType === 'error' || eventType === 'turn.failed') {
    const detail = readString(asRecord(event['error'])?.['message']) ?? readString(event['message']) ?? 'codex exec failed';
    return [{ type: 'error', message: detail, code: inferErrorCode(detail), recoverable: inferRecoverable(detail) }];
  }
  const itemEvents = mapItemEvent(eventType, event);
  if (itemEvents.length > 0) return itemEvents;
  const item = asRecord(event['item']);
  const assistantText = item ? joinTextParts(item['content']) : '';
  if (assistantText) return [{ type: 'text', delta: assistantText }];
  return [];
}

export class CodexAgent extends CLISubprocessAgent {
  readonly id = 'codex';
  readonly displayName = 'Codex';
  private availability?: Promise<boolean>;
  private capabilities?: Promise<AgentCapabilities>;

  run(req: RunRequest): AgentRun {
    const baseRun = super.run(req);
    const prefixEvent: AgentEvent = {
      type: 'system',
      continuationToken: req.continuationToken,
      cwd: req.cwd,
      model: req.model,
    };
    return {
      events: {
        async *[Symbol.asyncIterator]() {
          yield prefixEvent;
          for await (const event of baseRun.events) {
            yield event;
          }
        },
      },
      stop: () => baseRun.stop(),
      waitForExit: (timeoutMs?: number) => baseRun.waitForExit(timeoutMs),
    };
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
    const args = req.continuationToken
      ? ['exec', 'resume', '--json', '--skip-git-repo-check', req.continuationToken, '-']
      : ['exec', '--json', '--skip-git-repo-check', '-'];
    if (req.model) args.splice(req.continuationToken ? 3 : 2, 0, '--model', req.model);
    // `--image <FILE>...` is variadic: keep it right after the subcommand so the
    // following `--json` flag terminates it instead of swallowing the trailing `-`.
    const images = req.images ?? [];
    if (images.length > 0) args.splice(req.continuationToken ? 2 : 1, 0, ...images.flatMap((path) => ['--image', path]));
    return {
      command: 'codex',
      args,
      cwd: req.cwd,
      env: pickEnv(process.env, CODEX_PASSTHROUGH_KEYS),
    };
  }

  protected override async writeStdin(child: ChildProcess, req: RunRequest): Promise<void> {
    child.stdin?.end(`${req.prompt}\n`);
  }

  protected mapOutput(payload: unknown, req: RunRequest): AgentEvent[] {
    return mapCodexStreamEvent(payload, req);
  }

  private checkAvailability(): boolean {
    const result = spawnSync('codex', ['--version'], { encoding: 'utf8' });
    return result.status === 0 && result.stdout.toLowerCase().includes('codex');
  }
}
