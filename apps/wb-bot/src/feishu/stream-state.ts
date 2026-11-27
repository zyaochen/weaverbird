import type { AgentEvent } from '../../../../packages/core/src/index.js';

export type StopState = 'running' | 'stopping' | 'stopped';
export type TerminalState = 'running' | 'done' | 'error';

export type ToolEntry = {
  id: string;
  name: string;
  input: unknown;
  output?: string;
  isError?: boolean;
};

export type StreamState = {
  agentId: string;
  agentDisplayName: string;
  agentPersona: string;
  text: string;
  thinking: string;
  tools: ToolEntry[];
  cwd?: string;
  model?: string;
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
  continuationToken?: string;
  sessionShortId?: string;
  adminCancelEnabled?: boolean;
  hasContext: boolean;
  includeMeta: boolean;
  stopState: StopState;
  terminalState: TerminalState;
  errorMessage?: string;
  /** 输入组装告警 (附件下载失败等), 渲染在正文下方. */
  notices?: string[];
  /** 本轮进行中排队等待的消息数. */
  queuedCount?: number;
  /** 结束后在 cwd 里找到的产物 (artifacts.ts), 结束卡上给发送按钮. */
  artifacts?: Array<{ path: string; label: string }>;
  startedAt: number;
};

export function createInitialState(agentId: string, agentDisplayName: string, agentPersona: string): StreamState {
  return {
    agentId,
    agentDisplayName,
    agentPersona,
    text: '',
    thinking: '',
    tools: [],
    hasContext: false,
    includeMeta: true,
    stopState: 'running',
    terminalState: 'running',
    startedAt: Date.now(),
  };
}

export const SESSION_SHORT_ID_MIN_LEN = 8;

export function allocateSessionShortId(
  runId: string,
  existing: Iterable<string>,
  minLength = SESSION_SHORT_ID_MIN_LEN,
): string {
  const used = new Set(existing);
  for (let length = minLength; length <= runId.length; length += 1) {
    const candidate = runId.slice(0, length);
    if (!used.has(candidate)) return candidate;
  }
  return runId;
}

export function reduceStreamState(state: StreamState, event: AgentEvent): StreamState {
  if (event.type === 'text') return { ...state, text: `${state.text}${event.delta}` };
  if (event.type === 'thinking') return { ...state, thinking: `${state.thinking}${event.delta}` };
  if (event.type === 'system') {
    return {
      ...state,
      cwd: event.cwd ?? state.cwd,
      model: event.model ?? state.model,
      continuationToken: event.continuationToken ?? state.continuationToken,
      hasContext: Boolean(event.continuationToken ?? state.continuationToken),
    };
  }
  if (event.type === 'tool_use') {
    return { ...state, tools: [...state.tools, { id: event.id, name: event.name, input: event.input }] };
  }
  if (event.type === 'tool_result') {
    return {
      ...state,
      tools: state.tools.map((tool) => (
        tool.id === event.id ? { ...tool, output: event.output, isError: event.isError } : tool
      )),
    };
  }
  if (event.type === 'usage') return { ...state, usage: { inputTokens: event.inputTokens, outputTokens: event.outputTokens, costUsd: event.costUsd } };
  if (event.type === 'done') {
    return {
      ...state,
      terminalState: 'done',
      stopState: state.stopState === 'stopping' ? 'stopped' : state.stopState,
      continuationToken: event.continuationToken ?? state.continuationToken,
      hasContext: Boolean(event.continuationToken ?? state.continuationToken),
    };
  }
  if (event.type === 'error') {
    if (state.stopState === 'stopping') {
      return {
        ...state,
        terminalState: 'done',
        stopState: 'stopped',
        errorMessage: undefined,
      };
    }
    return { ...state, terminalState: 'error', errorMessage: event.message };
  }
  return state;
}
