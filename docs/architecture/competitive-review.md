# Architecture review: Weaverbird vs HappyClaw vs Mirage vs lark-channel-bridge

This document cross-references the architecture and product design of three reference agent/LLM bridge systems — **HappyClaw**, **Mirage**, and **lark-channel-bridge** (feishu-claude-code-bridge) — against **Weaverbird**, identifies gaps and advantages, and provides actionable short-term and long-term improvement recommendations.

---

## Executive summary

Weaverbird's strict package layering, contract-first design, and composition-root model are architecturally superior to all three reference systems. None of them achieves Weaverbird's level of structural separation. However, all three are production-deployed with streaming, concurrency, error recovery, and platform integration capabilities that Weaverbird's current runtime lacks entirely.

lark-channel-bridge is the most instructive comparison: at 7,834 lines and 4 runtime dependencies, it delivers a fully functional Feishu-to-Claude-Code bridge — demonstrating that a well-designed system can be 10x smaller than HappyClaw (72K LOC) or Mirage (63K LOC) while achieving comparable core functionality. Its pure-functional state reducer for streaming output (`reduce(state, event) -> newState`) is the gold-standard pattern that Weaverbird should adopt for its renderer story. Its richer agent event taxonomy (10 types vs Weaverbird's 4 `ProviderEvent` types) also reveals a gap in Weaverbird's event model that needs closing before real tool-using agents can be supported.

The primary risk remains unchanged: Weaverbird's runtime kernel is exercised only by a mock provider and a CLI adapter, leaving its generality claims unvalidated by real-world stress.

---

## Part 1: Reference system strengths

### HappyClaw — strengths worth learning from

| Strength | Detail | Weaverbird relevance |
|----------|--------|---------------------|
| **File-based IPC with atomic writes** | Agent runner ↔ main process use write-tmp-then-rename for crash safety | Weaverbird's `FileTraceStore` and `FileSessionRepository` use naive `writeFile` — no atomicity |
| **StreamEvent as canonical shared type** | 22-event discriminated union in `shared/stream-event.ts`, synced via build script with CI validation | Weaverbird has `ProviderEvent` (4 types) and `RuntimeEvent` — correct direction but much thinner |
| **ProviderPool with health tracking** | Round-robin/weighted/failover strategies, consecutive error threshold, auto-recovery, per-session sticky binding | Weaverbird has `Map<ProviderId, ProviderAdapter>` — no load balancing, no health tracking, no failover |
| **GroupQueue concurrency controller** | Per-group state machines, container/host process limits, task priority, exponential backoff, graceful shutdown | Weaverbird has no concurrency control — dispatch is fire-and-forget with no queuing or backpressure |
| **Three-tier memory system** | Global CLAUDE.md + per-workspace CLAUDE.md + date-based memory files with compaction-triggered flush | Weaverbird has no memory/context persistence beyond session and trace state |
| **Per-user workspace isolation** | Every user gets independent filesystem, Claude session, and IM context | Weaverbird's session model supports multi-conversation but has no user isolation or workspace concept |
| **Streaming UX pipeline** | Text buffering (200 chars), tool call timing tracking, thinking panel, sub-agent message translation, display-level filtering | Weaverbird's `TextRenderer` is a passthrough — no streaming UX considerations |
| **Billing and usage tracking** | Subscription plans, wallets, redeem codes, per-model usage records in SQLite | Weaverbird has no usage tracking or resource governance |

### Mirage — strengths worth learning from

| Strength | Detail | Weaverbird relevance |
|----------|--------|---------------------|
| **Generator-based SSE streaming** | `async function*` yielding `StreamYield` discriminated union — composable, testable, handles backpressure naturally | Weaverbird's `ProviderAdapter.execute()` already uses `AsyncIterable<ProviderEvent>` — same pattern, good |
| **Adaptive PATCH rate limiter** | Sliding window (2 min / 60 budget), per-chat sub-budgets, exponential backoff, cooldown, refund mechanism | Weaverbird has no rate limiting for platform output delivery |
| **Two-phase rolling abort signals** | `makeRollingAbortSignal(firstChunkMs, idleMs, maxLifetimeMs)` with per-chunk reset and tool-call extension | Weaverbird's `ProviderInterruptToken` is a basic flag — no timeout phases, no adaptive idle detection |
| **Biz-error classification** | 3-tier (auth/hard/soft) error envelopes within SSE streams — soft errors preserve the stream | Weaverbird's `ProviderEvent.error` has `recoverable` flag but runtime always aborts on error |
| **Config snapshot at conversation start** | `snapshotModelId`, `snapshotDeepThink` frozen when conversation created — prevents mid-conversation drift | Weaverbird session carries mutable `preferredModel` — model changes mid-conversation are possible |
| **3-level config cascade** | Thread → chat → global with inheritance | Weaverbird has no config hierarchy — flat global defaults only |
| **Smart Dispatcher (3-layer intent matching)** | Exact match → LLM function calling → fuzzy fallback with self-describing `ActionDefinition` that auto-generates LLM tool schemas | Weaverbird has only prefix-based `/command` parsing — no natural language dispatch |
| **Action registry with LLM schema generation** | `registerAction()` with params, examples, dangerous flag → auto-builds OpenAI function calling schemas | Weaverbird's `CommandRegistry` is name/alias-based only — no parameter schemas, no LLM integration |
| **Multi-model orchestration engines** | Debate (2-4 LLMs argue), Prism (contradiction detection), Insight (parallel analysis), Veil | Weaverbird has no multi-model or multi-turn orchestration beyond single-prompt dispatch |
| **Interrupt recovery across restarts** | Records active streams to disk on shutdown, recovers partial content on startup | Weaverbird has no interrupt recovery — in-flight invocations are lost on restart |
| **119 test files with repro-regression pattern** | `test/repro/` directory with bug-specific regression tests named to trace back to incidents | Weaverbird has 8 test files (39 tests) — correct patterns but thin coverage |
| **30+ design documents** | SSE protocol docs, UX principles, postmortems, known issues, session guides | Weaverbird has 16 docs — good architecture coverage, but no UX principles, protocol docs, or operational guides |

### lark-channel-bridge — strengths worth learning from

| Strength | Detail | Weaverbird relevance |
|----------|--------|---------------------|
| **Pure-functional state reducer** | `reduce(state, event) -> newState` in `card/run-state.ts` — immutable, side-effect-free, trivially testable. Separates state computation from rendering entirely. | Weaverbird accumulates streaming text in a local variable inside `handleProviderExecution` — no formal streaming state model. This reducer pattern is the single most valuable pattern across all four projects for Weaverbird's renderer story. |
| **Rich agent event taxonomy** | `AgentEvent` is a 10-type discriminated union: `text`, `tool_use_begin`, `tool_use_end`, `tool_result`, `result`, `error`, `reasoning`, `system`, `sub_agent_message`, `citation`. | Weaverbird's `ProviderEvent` has only 4 types (`text_delta`, `status`, `final`, `error`). Tool lifecycle events, reasoning traces, and sub-agent messages cannot be represented. |
| **Per-scope debounce queue with block/unblock** | `PendingQueue` in `bot/pending-queue.ts`: 600ms debounce coalesces rapid-fire messages; queue blocks while a run is active, messages accumulate and flush as one batch after run ends. | Weaverbird has no message batching — every dispatch is independent. This is simpler and more practical than HappyClaw's GroupQueue for initial concurrency control. |
| **Agent adapter abstraction** | `AgentAdapter.start(params) -> AgentRun` with `AgentRun.events: AsyncIterable<AgentEvent>` in `agent/types.ts`. The Claude coupling is replaceable by any NDJSON-streaming CLI agent. | Maps cleanly to Weaverbird's `ProviderAdapter.execute()` but with finer-grained lifecycle (start/run separation, explicit abort). |
| **Minimal dependency philosophy** | 4 runtime dependencies for a full Feishu bridge. No web framework, no ORM, no config library. | Validates that a well-factored system does not need heavy dependencies. Weaverbird's 4 dev deps + 0 runtime deps is even leaner. |
| **AsyncLocalStorage trace propagation** | `traceId` / `chatId` / `msgId` propagated through the async call chain via `AsyncLocalStorage`. Every log entry carries context without manual threading. | Weaverbird threads `DispatchState` manually through method arguments. AsyncLocalStorage would eliminate this boilerplate. |
| **Encrypted secret management** | AES-256-GCM keystore with PBKDF2-derived key + `SecretRef` protocol (env/file/exec) for pluggable secret resolution. | Weaverbird has no secret management. Required before any real provider with API keys. |
| **Interactive card callback protocol** | `__claude_cb` marker lets Claude design interactive card UIs (buttons, forms) whose click events route back into the same agent session as synthesized messages. | Weaverbird has no mechanism for agents to create interactive UIs or receive callback events from the platform. |
| **Cloud-doc comment integration** | Not just a chat bot — also responds to @mentions in Feishu document comments, with wiki-node resolution and reply threading. | Weaverbird's `RuntimeInputEvent.type` supports `"message" | "action" | "system"` but no non-chat interaction surfaces have been exercised. |
| **Dual-output rendering** | `renderCard(state)` and `renderText(state)` both consume the same `RunState` — one state model, two output formats selectable by deployment config. | Weaverbird's `Renderer<TOutput>` is parameterized by output type, which supports this pattern, but only `TextRenderer` exists. The state-then-render separation is not yet implemented. |

---

## Part 2: Weaverbird's structural advantages

Weaverbird is not behind in all dimensions. Its architecture has genuine advantages over all three reference systems.

| Weaverbird advantage | vs HappyClaw | vs Mirage | vs lark-channel-bridge |
|---------------------|-------------|-----------|----------------------|
| **Strict monorepo package boundaries** | HappyClaw uses `shared/` with build-time copy sync — fragile | Mirage is a flat 213-file single package — no structural separation | Single package, no module boundary enforcement |
| **Contract-first kernel design** | No formal contract layer — coupling is implicit via IPC file protocol | `CommandHandlerContext` is ad-hoc callback injection — not a stable contract | `AgentAdapter` interface is clean but other module boundaries are implicit |
| **Composition-root pattern** | Main process is also the composition root and the orchestrator | Singleton services with module-level instantiation — no DI | `StartChannelDeps` is a step toward DI but composition happens in `start.ts` alongside business logic |
| **Provider-agnostic runtime** | Locked to Claude Agent SDK | Locked to Mira API shapes | `AgentAdapter` is replaceable, but session/workspace management is Claude-specific |
| **Entity/run/binding separation** | Conflates run state and session state | Conflates run state and session state | Conflates run state and session state |
| **RuntimeEvent / RenderIntent public protocol** | Leaks SDK-specific events to the main process | Leaks SSE-specific `StreamYield` through the stack | `AgentEvent` is clean but flows directly to the renderer with no intermediate protocol |
| **Adapter independence** | 6 IM channels share utility modules | Command handlers import Feishu card builders | Card rendering directly imports Feishu CardKit types |
| **Documented architectural invariants** | CLAUDE.md constraints but no invariant docs | AGENTS.md but rules are informal | No architectural invariant documentation |

**Key insight:** Weaverbird already has the architecture that all three reference systems would need if they wanted to support multiple platforms cleanly. lark-channel-bridge comes closest with its `AgentAdapter` abstraction and `RunState` separation, but its Feishu coupling in the rendering layer would prevent clean multi-platform extension. The risk is that Weaverbird's architecture remains theoretical until exercised by a real provider and a real platform.

---

## Part 3: Gap analysis

### Critical gaps (blocking production readiness)

| Gap | Impact | Reference |
|-----|--------|-----------|
| **No real provider execution** | The async-iterable streaming path is only exercised by `MockProvider`, which yields 3 events synchronously. Real SSE streaming, backpressure, timeouts, and partial failure are untested. | HappyClaw: full Claude SDK streaming with context compaction. Mirage: SSE generator with 5 stream phases. lark-channel-bridge: Claude CLI subprocess with NDJSON streaming. |
| **No concurrency control** | `dispatch()` has no queuing, no per-conversation serialization, no backpressure. Concurrent dispatches to the same conversation will race on session state. | HappyClaw: `GroupQueue` with state machines, retry, priority. Mirage: `ConversationState.processing` flag + pending message queue (max 10). lark-channel-bridge: `PendingQueue` with debounce + block/unblock. |
| **Incomplete abort/interrupt** | `ProviderInterruptToken` exists and the runtime checks `isRunInterrupted()` before and during provider iteration. What is missing: `AbortSignal` threading through `ProviderRequest`, and the ability for a new dispatch to the same conversation to trigger an interrupt on the in-flight stream. | HappyClaw: IPC `_interrupt` + `_drain` signals. Mirage: `AbortController.abort()` + Mira terminate API. |
| **No error recovery within streams** | Runtime always treats `ProviderEvent.error` as terminal — calls `return` on the iterator. Soft/recoverable errors that should allow partial content delivery are lost. | Mirage: 3-tier biz-error classification (auth/hard/soft) — soft errors yield a signal but keep the stream alive. |
| **No rate limiting for platform output** | Every `sendText` call immediately calls `platform.send()`. A fast-streaming provider could overwhelm the platform. | Mirage: `patchRateLimiter` with sliding window budgets, per-chat fairness, exponential backoff. |

### Important gaps (needed for first real integration)

| Gap | Impact | Reference |
|-----|--------|-----------|
| **No provider health tracking** | If a provider starts failing, there is no automatic failover or health recovery. | HappyClaw: `ProviderPool` with consecutive error thresholds and 5-min auto-recovery. |
| **No streaming output buffering/debouncing** | `text_delta` events are emitted incrementally to the platform via `emitRuntimeEvent()`, so the CLI user does see streaming output. What is missing: buffering/debouncing for high-frequency events, and a formal `StreamState` model for renderers to consume instead of raw event fragments. | HappyClaw: periodic IPC message events with 200-char buffering. Mirage: periodic card PATCH with text buffering. lark-channel-bridge: pure-functional `RunState` reducer with periodic card re-render. |
| **No timeout/deadline for provider execution** | A provider that hangs forever will block the conversation permanently. | Mirage: `makeRollingAbortSignal()` with first-chunk, idle, and max-lifetime phases. |
| **No config snapshot on conversation start** | `ConversationSession.preferredModel` is mutable. A `/model` command in one invocation immediately affects the next, even if a stream is in-flight. | Mirage: model/deepThink/onlineSearch frozen into `ConversationState` at conversation creation. |
| **No filesystem atomicity** | `FileTraceStore` and `FileSessionRepository` use `writeFile` directly — a crash during write corrupts state. | HappyClaw: write-tmp-then-rename pattern for all IPC and config files. |
| **No graceful shutdown** | `apps/wb-cli` has no SIGINT/SIGTERM handler. In-flight invocations are silently lost. | HappyClaw: drains active containers, waits for IPC. Mirage: records interrupted streams to disk, recovers on startup. |

### Enrichment gaps (needed for product maturity)

| Gap | Impact | Reference |
|-----|--------|-----------|
| **No natural language command dispatch** | Only slash-prefix commands are recognized. Users must memorize exact command names. | Mirage: Smart Dispatcher with 3-layer intent matching (exact → LLM → fuzzy). |
| **No multi-model orchestration** | Single-provider, single-model per conversation. No debate, collision, or parallel analysis. | Mirage: Debate (2-4 LLMs), Prism (contradiction detection), Insight (parallel analysis). |
| **No usage/billing tracking** | No token counting, no cost tracking, no usage limits. | HappyClaw: per-model usage records in SQLite with subscription plans. Mirage: per-request token/cost capture. |
| **No memory/knowledge persistence** | No cross-session memory, no wiki, no context injection from prior conversations. | HappyClaw: 3-tier memory + compaction-triggered flush. Mirage: wiki knowledge base + memory client. |
| **No rich output rendering** | `TextRenderer` is a passthrough. No card building, no table rendering, no image embedding. | HappyClaw: Feishu streaming cards with 3-level degradation. Mirage: Feishu card builder with table renderer, image elements, collapsible panels. lark-channel-bridge: CardKit 2.0 with collapsible panels, tool summaries, and dual-output (card + text) from shared `RunState`. |
| **No tool/MCP integration** | `ProviderCapabilities.toolCalls` exists as a flag but no tool execution path is implemented. | HappyClaw: 12+ MCP tools via in-process SDK server + user-configured external MCP. Mirage: MCP/Skill tool discovery + per-chat tool preferences. lark-channel-bridge: tool lifecycle events (`tool_use_begin`/`tool_result`) rendered as collapsible panels. |

---

## Part 4: Recommendations

### Short-term (next 2 milestones — validate the kernel under real stress)

#### S1. Implement provider-side streaming with incremental output delivery

**Why:** The single biggest untested claim in the architecture is that the async-iterable provider path works under real streaming conditions. Both HappyClaw and Mirage show that streaming is where all the subtle bugs live (partial content, abort races, rate limiting, error recovery).

**What to build:**
- Wire `provider-openai-compatible` into `apps/wb-cli` as a selectable provider (it already exists at adapter level)
- Add incremental output delivery: buffer `text_delta` events and periodically flush to the platform instead of accumulating until `final`
- Add a configurable flush interval (e.g., 200ms or 200 chars, inspired by HappyClaw's buffering)
- The renderer should receive `stream: true` context and the platform adapter should handle incremental writes

#### S2. Add concurrency control to the dispatch loop

**Why:** Without this, two messages to the same conversation will race on `sessionRepository` reads/writes. All three reference systems treat this as a P0 requirement.

**What to build:**
- Per-conversation dispatch serialization with a pending message queue
- The recommended starting pattern is lark-channel-bridge's `PendingQueue`: a debounce window (e.g., 600ms) that coalesces rapid-fire messages, with block/unblock semantics that hold messages while a run is active and flush them as a batch after the run ends. This is simpler than HappyClaw's full `GroupQueue` state machine or Mirage's 10-slot pending array, and sufficient for the initial integration.
- Reject with a notice when the queue exceeds a bounded depth
- New messages should be able to abort in-flight provider streams (depends on S3)

#### S3. Complete abort/interrupt with AbortSignal and cross-dispatch triggering

**Why:** The runtime already checks `isRunInterrupted()` before and during provider iteration via `ProviderInterruptToken`, but two pieces are missing: `AbortSignal` threading so providers can react to cancellation, and the ability for a new dispatch to trigger interruption of an in-flight stream on the same conversation.

**What to build:**
- Thread `AbortSignal` from `ProviderRequest` through the provider's `execute()` method (the field exists in the contract but is not populated by the runtime)
- In `handleProviderExecution`, create an `AbortController` stored on the `DispatchState`
- When a new dispatch arrives for the same conversation while one is in-flight, abort the old controller
- Add SIGINT/SIGTERM handlers to `apps/wb-cli` that abort all active invocations and finalize their traces

#### S4. Implement 3-tier error classification within streams

**Why:** The current "error = terminal" behavior loses partial content. In real SSE streams, many errors are recoverable.

**What to build:**
- Extend `ProviderEvent.error` with a `severity: "auth" | "hard" | "soft"` field (or reuse the existing `recoverable` flag with clearer semantics)
- In `handleProviderExecution`, handle soft errors by yielding partial content to the platform and continuing the iteration
- Handle auth errors by marking the provider unhealthy (feeds into S5)

#### S5. Add provider health tracking and failover

**Why:** Single-provider-no-failover is acceptable for a mock but not for production.

**What to build:**
- A `ProviderPool` wrapper around `Map<ProviderId, ProviderAdapter>` that tracks consecutive errors per provider
- Automatic failover when a provider exceeds the error threshold
- Health recovery after a cooldown period
- This belongs in `packages/core` since it is provider-agnostic orchestration

#### S6. Implement atomic file writes

**Why:** Both `FileTraceStore` and `FileSessionRepository` corrupt on crash-during-write.

**What to build:**
- A shared `atomicWriteFile(path, content)` utility: write to `${path}.tmp`, then `rename`
- Use it in all file-backed stores
- This is a one-function fix with high safety value

#### S7. Add graceful shutdown with interrupt recovery

**Why:** In-flight invocations are silently lost on restart.

**What to build:**
- SIGINT/SIGTERM handler in `apps/wb-cli` that:
  1. Aborts all active provider executions
  2. Finalizes all in-flight invocations as `"interrupted"`
  3. Records interrupted invocations to a recovery file
  4. On next startup, reads the recovery file and marks those invocations in the trace store

#### S8. Adopt a pure-functional state reducer for streaming output

**Why:** Weaverbird currently accumulates streaming text in a local `accumulated` variable inside `handleProviderExecution`. This ad-hoc approach cannot represent tool calls, reasoning traces, or phased content. All three reference systems solve this: lark-channel-bridge's `RunState` + `reduce()` is the cleanest implementation — a textbook Redux reducer with zero side effects and trivial testability.

**What to build:**
- Add a `StreamState` type in `packages/core` that captures accumulated text, active tool calls, reasoning blocks, completion status, and error state
- Add a `reduceStreamEvent(state: StreamState, event: ProviderEvent) -> StreamState` pure function
- Replace the `accumulated` variable in `handleProviderExecution` with `StreamState` reduced over the provider event stream
- Renderers receive `StreamState` instead of raw text strings, enabling them to render tool calls, reasoning, and phased content
- This pairs naturally with S1 (incremental output delivery): the renderer re-renders on each state transition

**Reference:** lark-channel-bridge `card/run-state.ts` (152 lines, pure `reduce()` function). Also: lark-channel-bridge's dual-output pattern — `renderCard(state)` and `renderText(state)` both consume the same `RunState`, producing different output formats from one state model.

#### S9. Enrich ProviderEvent taxonomy for tool and reasoning lifecycle

**Why:** Weaverbird's `ProviderEvent` has 4 types: `text_delta`, `status`, `final`, `error`. This is insufficient to represent what real agents emit. All three reference systems have richer event models: lark-channel-bridge has 10 types, HappyClaw has 22 types, Mirage has 5+ stream signal types. Without tool lifecycle events, Weaverbird cannot render tool call progress, display reasoning traces, or support agent-driven interactive UIs.

**What to build:**
- Add at minimum: `tool_use_begin` (tool name, input), `tool_use_end` (tool name), `tool_result` (output summary), `reasoning` (thinking text), `system` (session info, agent metadata)
- Keep the existing 4 types unchanged for backward compatibility
- The `StreamState` reducer (S8) should handle all new event types
- Provider adapters that don't support these events simply never emit them — no breaking change

**Reference:** lark-channel-bridge `agent/types.ts` (10-type `AgentEvent` union). HappyClaw `shared/stream-event.ts` (22-type `StreamEvent` union).

### Long-term (future milestones — product depth)

#### L1. Add natural language command dispatch (Smart Dispatcher)

**Why:** Mirage proves this is a significant UX improvement. The 3-layer pattern (exact → LLM → fuzzy) is composable and can reuse the existing `CommandRegistry`.

**What to build:**
- Extend `Command` with optional `params`, `examples`, and `dangerous` fields (inspired by Mirage's `ActionDefinition`)
- Add an LLM-powered dispatch layer that converts natural language to command invocations using the command metadata as tool schemas
- Keep it optional — slash commands remain the primary path; smart dispatch is an enhancement

#### L2. Add output rate limiting

**Why:** Required before any real Feishu/Mira platform adapter, since both APIs have strict PATCH rate limits.

**What to build:**
- A `RateLimiter` contract in `packages/core` with sliding-window semantics
- Per-conversation budgets to ensure fairness under concurrent streaming
- Platform adapters declare their rate limits as part of `PlatformCapabilities`

#### L3. Add multi-model orchestration primitives

**Why:** Both HappyClaw and Mirage derive significant product value from multi-model patterns (debate, parallel analysis). This is a differentiator, not a nice-to-have.

**What to build:**
- A `CompositeProvider` or `OrchestratorProvider` pattern that wraps multiple providers
- Basic orchestration primitives: parallel execution, sequential chain, voting/synthesis
- These compose on top of the existing `ProviderAdapter` contract

#### L4. Add memory/context persistence across sessions

**Why:** Both reference systems treat memory as essential for meaningful conversations.

**What to build:**
- Extend `StateStore` with a memory-specific API or use the generic KV store
- Add memory injection hooks in the dispatch pipeline (before provider execution)
- Support per-conversation and per-entity memory scopes

#### L5. Add rich rendering for non-CLI platforms

**Why:** The renderer seam exists but is exercised only by `TextRenderer`. Real platform adapters need card builders, table renderers, image handling, and streaming card updates.

**What to build:**
- Adopt lark-channel-bridge's state-reducer-then-render pattern as the canonical approach: renderers consume `StreamState` (from S8) and produce platform-specific output. lark-channel-bridge proves this with `renderCard(state)` and `renderText(state)` — two renderers consuming one shared state model, producing CardKit 2.0 JSON and plain markdown respectively.
- A `RenderIntent`-driven card builder for Feishu/Mira (already partially planned in `platform-mira`)
- Table detection and rendering (Mirage's `tableRenderer.ts` is a good reference)
- Long-content auto-splitting (all three reference systems implement this)
- Tool call rendering as collapsible panels (lark-channel-bridge's `tool-render.ts` is the simplest reference)

#### L6. Add usage tracking and governance

**Why:** Any multi-user deployment needs token counting and usage limits.

**What to build:**
- A `UsageRecord` type in core events
- Provider adapters emit usage data via `ProviderEvent` (add a `usage` event type)
- A `GovernancePolicy` in core that can enforce per-user or per-conversation limits
- Storage in `state-*` packages

#### L7. Add tool/MCP execution support

**Why:** Tool calls are the primary way modern LLM agents interact with external systems. Both reference systems have deep tool integration.

**What to build:**
- Extend `ProviderEvent` with `tool_call_start`, `tool_call_result` events
- Add a `ToolRegistry` contract for registering available tools
- The runtime mediates tool execution: provider requests a tool call → runtime executes it → runtime feeds the result back to the provider

#### L8. Add interactive callback protocol for agent-driven UIs

**Why:** lark-channel-bridge's `__claude_cb` protocol demonstrates a powerful pattern: the agent can emit card/form events with buttons whose click events route back into the same agent session as synthesized messages. This turns the agent from a passive responder into an interactive UI designer — it can create multi-step workflows, confirmation dialogs, and configuration forms without any bridge-side code changes.

**What to build:**
- Extend `ProviderEvent` (or `RuntimeEvent`) with a `card_action` type that carries interactive element definitions (buttons, forms)
- Platform adapters render these as platform-native interactive elements (Feishu CardKit buttons, CLI prompts, etc.)
- When the user interacts with the element, the platform adapter synthesizes a new `RuntimeInputEvent` with `type: "action"` and routes it back to the same entity/session
- The runtime feeds the action back to the provider as a follow-up prompt
- This requires S9 (richer event taxonomy) and the entity/session model to be stable

**Reference:** lark-channel-bridge `card/dispatcher.ts` (card action routing) + `bot/channel.ts` (`__claude_cb` detection and re-injection into the pending queue).

---

## Part 5: Priority ordering

| Priority | Item | Type | Effort | Impact |
|----------|------|------|--------|--------|
| **P0** | S1: Real provider streaming | Short-term | Medium | Validates the core architecture claim |
| **P0** | S2: Concurrency control | Short-term | Medium | Prevents data corruption |
| **P0** | S3: Abort/interrupt | Short-term | Medium | Required for S2 and shutdown |
| **P0** | S6: Atomic file writes | Short-term | Small | One-function fix, high safety value |
| **P0** | S8: Streaming state reducer | Short-term | Medium | Foundational for rendering, required before any rich output |
| **P1** | S9: Enrich ProviderEvent taxonomy | Short-term | Small | Required for tool display, reasoning traces, and S8 |
| **P1** | S4: Error classification in streams | Short-term | Small | Prevents partial content loss |
| **P1** | S7: Graceful shutdown + recovery | Short-term | Medium | Prevents invocation loss |
| **P1** | S5: Provider health tracking | Short-term | Medium | Required before multi-provider |
| **P2** | L2: Output rate limiting | Long-term | Medium | Required before Feishu/Mira adapters |
| **P2** | L7: Tool/MCP execution | Long-term | Large | Required for real agent workflows |
| **P2** | L1: Smart Dispatcher | Long-term | Medium | Major UX improvement |
| **P3** | L3: Multi-model orchestration | Long-term | Large | Product differentiator |
| **P3** | L4: Memory persistence | Long-term | Medium | Essential for meaningful conversations |
| **P3** | L5: Rich rendering | Long-term | Large | Required per-platform; depends on S8 |
| **P3** | L6: Usage tracking | Long-term | Medium | Required for multi-user |
| **P3** | L8: Interactive callback protocol | Long-term | Large | Agent-driven UIs; depends on S9 |

---

## Part 6: What Weaverbird should NOT copy

| Anti-pattern | Source | Why avoid |
|-------------|--------|-----------|
| God object | Mirage `message.ts` (6,454 lines) | Weaverbird's dispatch pipeline is already well-factored — keep method sizes small |
| God modules | lark-channel-bridge `commands/index.ts` (1,092 lines), `bot/channel.ts` (809 lines) | All 15 commands in one file; intake + run loop + prompt building in one file. Weaverbird already avoids this with per-command files in `command-kit/src/builtins/` |
| Singleton services | Mirage module-level singletons | Weaverbird's composition-root pattern is strictly better — maintain it |
| File-based JSON for all config | Mirage 10+ JSON files in `~/.mirage/` | Use structured storage (SQLite or the existing `StateStore`) instead of proliferating config files |
| Build-time type sync | HappyClaw `make sync-types` | Weaverbird's monorepo with direct package imports is superior — no sync needed |
| Provider-specific types in public protocol | HappyClaw and Mirage leak SSE/SDK types | Weaverbird's `RuntimeEvent`/`RenderIntent` boundary is the right answer — keep it |
| No DI / no composition roots | HappyClaw and Mirage | Weaverbird already has this — never regress |
| Platform code in command handlers | Mirage command handlers import Feishu card builders | Weaverbird's `CommandContext` abstraction prevents this — maintain the invariant |
| Zero test coverage | lark-channel-bridge has 0 test files despite pure-functional modules that are trivially testable | Weaverbird must maintain and grow test coverage — never let testable pure functions go untested |
| Untyped render output | lark-channel-bridge card templates return `object` — no type-safe CardKit builder | Weaverbird's `Renderer<TOutput>` is already parameterized; render output should remain typed |
| In-place config mutation | lark-channel-bridge mutates `controls.cfg` from command handlers | Weaverbird's session updates go through `sessionRepository.updateConversation()` — keep mutations behind repository boundaries |

---

## Part 7: Four-project comparison matrix

| Dimension | Weaverbird | HappyClaw | Mirage | lark-channel-bridge |
|-----------|-----------|-----------|--------|---------------------|
| **Codebase size** | ~3K LOC | ~72K LOC | ~63K LOC | ~7.8K LOC |
| **Runtime dependencies** | 0 | 30+ | 40+ | 4 |
| **Package structure** | Strict monorepo (13 packages) | Multi-process monorepo with shared/ | Flat single package (213 files) | Single package (28 source files) |
| **Contract-first design** | Yes — `packages/core` contracts | No formal contract layer | No — ad-hoc callback injection | Partial — `AgentAdapter` is clean, rest is implicit |
| **Composition root / DI** | Yes — `apps/wb-cli` | No — main process is monolith | No — module-level singletons | Partial — `StartChannelDeps` but mixed |
| **Provider abstraction** | `ProviderAdapter` (fully agnostic) | Claude SDK only | Mira API only | `AgentAdapter` (replaceable) |
| **Platform abstraction** | `PlatformAdapter` (fully agnostic) | 6 IM channels (Feishu-centric) | Feishu only | Feishu only |
| **Streaming model** | `AsyncIterable<ProviderEvent>` (4 types) | IPC + `StreamEvent` (22 types) | `async function*` + `StreamYield` | `AsyncIterable<AgentEvent>` (10 types) |
| **Streaming state management** | Ad-hoc local variable | Per-IPC message accumulation | SSE generator with 5 phases | Pure-functional `reduce()` reducer |
| **Concurrency control** | None | `GroupQueue` (state machines, priority, backoff) | Per-conversation flag + pending queue | `PendingQueue` (debounce + block/unblock) |
| **Abort/interrupt** | `ProviderInterruptToken` (partial — checks work, no AbortSignal threading) | IPC `_interrupt` + `_drain` | `AbortController` + Mira terminate API | `AgentRun.abort()` + process kill |
| **Error classification** | Binary `recoverable` flag | Per-event error types | 3-tier (auth/hard/soft) | Error event type (no taxonomy) |
| **Rate limiting** | None | None (IPC-internal) | Adaptive PATCH rate limiter | Card update throttle (2s interval) |
| **Secret management** | None | Encrypted config files | Environment variables | AES-256-GCM keystore + `SecretRef` |
| **Observability** | `TraceStore` + `RuntimeDiagnostics` | Pino structured logging | Custom structured logger | `AsyncLocalStorage` dual-destination logger |
| **Test coverage** | 39 tests / 8 files | Moderate (unit + integration) | 119 test files + repro-regression | 0 tests |
| **Documentation** | 16 docs (12 architecture) | CLAUDE.md + README | 30+ design docs | README only |
| **Config hierarchy** | Flat global | Per-user + global | Thread → chat → global | Per-session + global |
| **Tool/MCP support** | Flag only (unimplemented) | 12+ MCP tools | MCP/Skill discovery | Tool lifecycle events (display only) |
| **Multi-model** | Multi-provider registry, no health/failover | Provider pool with failover | 4 orchestration engines | Single agent adapter |
| **Interactive UI** | None | None | None | `__claude_cb` callback protocol |
| **Non-chat surfaces** | None | None | None | Cloud-doc comment @mention |
