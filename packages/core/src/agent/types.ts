export type ConsentLevel = 'plan-only' | 'strict' | 'normal' | 'relaxed' | 'auto';

export type ErrorCode =
  | 'auth'
  | 'rate_limit'
  | 'context_length'
  | 'network'
  | 'tool_failure'
  | 'crashed';

export interface RunRequest {
  prompt: string;
  cwd?: string;
  continuationToken?: string;
  model?: string;
  images?: string[];
  attachments?: string[];
  tools?: ToolDescriptor[];
  consentLevel?: ConsentLevel;
  stopGraceMs?: number;
}

/**
 * Frozen since v0.2 per docs/product-strategy.md §1.2.
 * Do NOT add fields, refine substructure, or introduce subtypes
 * until a real flying-feishu product consumer for this field exists.
 * See docs/topics/agent-adapter.md §11.3 for frozen list.
 */
export interface ToolDescriptor {
  id: string;
  name: string;
  description: string;
  inputSchema: unknown;
  capabilities: {
    kind: 'read' | 'write' | 'network' | 'shell' | 'feishu';
    danger: 'safe' | 'caution' | 'destructive';
  };
}

/**
 * AgentEvent union.
 *
 * Frozen variants per docs/product-strategy.md §1.2:
 * - `consent_required`: never emitted by CLI agents (consent managed by
 *   underlying CLI); reserved for API agents in W1+.
 *
 * Unfrozen in W2 for dynamic workflow long-run heartbeat use case
 * (Phase 4 C2 sync, A.H-4):
 * - `tool_progress`: ClaudeCodeAgent emits at default 2s interval
 *   (env WB_TOOL_PROGRESS_INTERVAL_MS adjustable) for dynamic workflow
 *   30+ min long-run heartbeat. See docs/topics/agent-adapter.md §11.5 #24.
 *
 * Frozen exception since v0.3 (Phase 4 C2 sync, B.H-2):
 * - `subagentId?: string` on `tool_use` / `tool_result` / `tool_progress`
 *   variants — exception to §1.2 freeze, real consumer = W2 Block B5
 *   dynamic workflow card folding. See docs/topics/agent-adapter.md §11.5 #22.
 *
 * Do NOT add other fields to these variants or introduce new event types
 * until a real flying-feishu product consumer exists.
 * See docs/topics/agent-adapter.md §11.3 (frozen list) + §11.5 (W2 v0.3
 * 修订) + §11.7 (决议汇总).
 */
export type AgentEvent =
  | { type: 'system'; continuationToken?: string; cwd?: string; model?: string }
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown; subagentId?: string }
  | { type: 'tool_progress'; id: string; message?: string; subagentId?: string }
  | { type: 'tool_result'; id: string; output: string; isError: boolean; subagentId?: string }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number; costUsd?: number }
  | { type: 'consent_required'; id: string; operation: unknown }
  | { type: 'done'; continuationToken?: string }
  | { type: 'error'; message: string; code?: ErrorCode; recoverable?: boolean };

export interface AgentRun {
  readonly events: AsyncIterable<AgentEvent>;
  stop(): Promise<void>;
  waitForExit(timeoutMs?: number): Promise<boolean>;
}

export interface AgentCapabilities {
  type: 'cli' | 'api';
  input: { images: boolean; attachments: boolean };
  output: {
    streaming: boolean;
    thinking: boolean;
    toolUse: boolean;
    citations: boolean;
  };
  /**
   * Window size and cost classification.
   *
   * Frozen since v0.2 per docs/product-strategy.md §1.2:
   * - `costClass` 4-tier coarse rating; do NOT introduce finer tiers or
   *   per-token pricing until flying-feishu cost-aware dispatcher exists.
   *
   * See docs/topics/agent-adapter.md §11.3.
   */
  context: { window: number; costClass: 'free' | 'cheap' | 'standard' | 'premium' };
  /**
   * Frozen since v0.2 per docs/product-strategy.md §1.2.
   * Self-reported skill ratings; do NOT add skills, refine grading scale,
   * or introduce per-skill substructure until flying-feishu dispatcher
   * really uses this for routing decisions.
   * See docs/topics/agent-adapter.md §11.3.
   */
  skills: Record<'code' | 'review' | 'plan' | 'research' | 'ops', 'A+' | 'A' | 'B' | 'C' | 'D'>;
  /**
   * Frozen since v0.2 per docs/product-strategy.md §1.2.
   * Built-in tool list + canExtend flag; do NOT add substructure (e.g.
   * per-tool danger ratings, tool categories) until a real flying-feishu
   * tool routing layer needs them.
   * See docs/topics/agent-adapter.md §11.3.
   */
  tools: { builtin: string[]; canExtend: boolean };
  session: { resumable: boolean; tokenKind: 'opaque' | 'history-ref' };
  /**
   * Continuation token rotation behavior (Phase 4 C2 sync, plan v1 F6 + 决断 7).
   *
   * - `'static'`: same token across resumes within a single agent session
   *   (e.g. some CLI agents that reuse a session id).
   * - `'rotating'`: new token on every system / done event (e.g. Claude Code
   *   stream-json mode).
   *
   * weaverbird processing logic stays uniform: A3 recoverInflightRuns replay
   * always picks the most recent token seen on system / done events from
   * events.ndjson (not the spec.json startup value). This capability field
   * is self-reported diagnostic info for adapter authors, not behavior gate.
   *
   * Capability-layer extension (self-report) is NOT a §1.2 freeze violation:
   * capability is the right layer for cross-adapter heterogeneity disclosure.
   * See docs/topics/agent-adapter.md §11.5 #27 + §11.7.
   */
  tokenRotation?: 'static' | 'rotating';
}

export interface AgentAdapter {
  readonly id: string;
  readonly displayName: string;
  isAvailable(): Promise<boolean>;
  getCapabilities(): Promise<AgentCapabilities>;
  run(req: RunRequest): AgentRun;
}
