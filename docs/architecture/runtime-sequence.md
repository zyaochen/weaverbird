# Runtime sequence

> Historical note: this document describes an older pre-W1 runtime sequence and is **not** the source of truth for the current mainline.
> Current mainline references: [README.md](../../README.md), [docs/product-strategy.md](../product-strategy.md), [docs/topics/agent-adapter.md](../topics/agent-adapter.md), [apps/wb-cli/src/main.ts](../../apps/wb-cli/src/main.ts), [apps/wb-bot/src/main.ts](../../apps/wb-bot/src/main.ts).

This document traces the dispatch flow implemented in `packages/core/src/runtime/runtime.ts`. The runtime is now a surface-aware, entity-aware kernel: platforms translate inbound traffic into `RuntimeInputEvent`, the kernel resolves `SurfaceContextRef -> ContextBinding -> RuntimeEntity -> ConversationSession / RuntimeEntitySession / ProviderSession -> RuntimeRun`, and only `RuntimeEvent` / `RenderIntent` cross the renderer and platform boundary.

## 1. Bootstrap

**Code:** `apps/wb-cli/src/index.ts` → `main()`

1. `parseCliOptions(process.argv.slice(2))` extracts runtime flags and environment fallbacks.
2. The app remains the only composition root and constructs:
   - `PlatformAdapter`
   - provider map
   - command list
   - renderer
   - `SessionRepository`
   - `ContextBindingRepository`
   - `RunRepository`
   - `RuntimeEntityRegistry`
   - optional `GovernancePolicy`
3. `createRuntime(context)` instantiates `WeaverbirdRuntime` and registers all commands in its internal registry.
4. The app binds the platform to the runtime's dispatch function. In the CLI slice, `CliPlatformAdapter.attach(dispatch)` does this — note that `attach()` is a CLI-specific method, not part of the `PlatformAdapter` contract. Other platform adapters will use their own binding mechanism (e.g., webhook registration).
5. `runtime.start()` delegates to `platform.start()`.

## 2. Inbound normalization

**Code:** platform adapters such as `packages/platform-cli/src/cliPlatformAdapter.ts` and `packages/platform-mira/src/miraEventMapper.ts`

Adapters normalize transport-specific input into `RuntimeInputEvent`.

Required runtime-facing fields are:
- `platform`
- `type`
- `invocationId`
- `context: SurfaceContextRef`
- `actor`
- `message`

Compatibility alias:
- `conversation` may still be populated for migration, but core treats it as a temporary defensive fallback and normalizes inbound handling around canonical `context`

A `SurfaceContextRef` carries platform-facing routing state:
- `surface`
- `conversationId`
- `threadId?`
- `replyToMessageId?`
- `rootMessageId?`
- `mentionedUserIds?`
- `routeKey?`
- `visibility?`
- `capabilities?`
- `mode: "thread" | "flat" | "session"`

Legacy aliases such as `platform`, `spaceId`, `replyToId`, and `mentionId` remain compatibility fields only.

## 3. Dispatch entry

**Code:** `WeaverbirdRuntime.dispatch(event)`

1. Resolve canonical `contextRef` from `event.context ?? event.conversation`, with `event.context` taking precedence when both are present.
2. Normalize the event around canonical `context`; `conversation` remains a compatibility alias only when one was supplied inbound.
3. Build `DispatchState` with:
   - `invocationId`
   - `startedAt`
   - `contextKey` via `buildSurfaceContextKey(context)`
   - `conversationKey` via `buildConversationKey(context)`
   - `failed: false`
   - `interrupted: false`
4. Emit ingress traces such as:
   - `ingress.received`
   - `input.parsed`

## 4. Parse and route intent

**Code:** `parseUserInput(message)` in `packages/core/src/commands/commandParser.ts`

1. The parser only parses user input.
2. Parsed command traffic now includes:
   - `invocationMode`
   - `targetEntityHint?`
   - `contextMutationIntent?`
3. Runtime routing stays in `WeaverbirdRuntime`, where parsed command traffic is matched against `CommandRegistry`.
4. The runtime later emits a public `route_decision` event instead of relying on provider-facing semantics.

## 5. Context binding resolution

**Code:** `resolveContextBinding(event)` and binding persistence in `runtime.ts`

1. Query `contextBindingRepository.getByContext(event.context, resolvedBindingMode)`.
2. Repositories first try the exact `buildSurfaceContextKey(...)` match, then fall back according to the resolved binding mode so reply, route, thread, or flat contexts can reuse an earlier binding.
3. After governance checks and session resolution, write a canonical `ContextBinding` containing:
   - `surface`
   - `routeKey`
   - `threadId`
   - `rootMessageId`
   - `replyToMessageId`
   - `conversationSessionId`
   - `entitySessionId`
   - `bindingMode`
   - `entityRef`
4. This is the first-class restore path for thread / reply / flat-mode context. Platform-specific thread semantics remain outside core.

## 6. Runtime entity resolution

**Code:** `resolveRuntimeEntity(event, binding, parsed)` and `defaultEntityRegistry.ts`

1. Delegate to `RuntimeEntityRegistry.resolve()`.
2. The default registry resolves in this order:
   - explicit `event.entity`
   - existing `ContextBinding.entityRef`
   - fallback conversation entity `{ kind: "conversation", id: buildConversationKey(context) }`
3. Core does not use Mira or Feishu terms here; it only resolves generic runtime entities.

## 7. Session resolution

**Code:** `resolveSessions(event, entity, state)`

The runtime now resolves two runtime-visible session layers and one provider continuity layer.

### 7.1 Conversation session

1. Call `sessionRepository.getOrCreateConversation(event.context, defaults, options)`.
2. This establishes conversation continuity independent from any one entity.
3. The session stores conversation-scoped defaults such as provider and model.

### 7.2 Entity session

1. Call `sessionRepository.getOrCreateEntitySession(entity.ref, defaults, options)`.
2. `RuntimeEntitySession` is the main runtime session object.
3. Multiple entity sessions may exist under one conversation session.
4. Non-conversation entities do not pollute conversation-only session state.

### 7.3 Provider session

1. Lookup provider continuity by entity session id:
   - `sessionRepository.getProviderSession(entitySession.id, entitySession.providerId)`
2. Pass the previously persisted `providerSessionId` into `ProviderRequest` when one exists.
3. During execution, providers may emit a provider-private continuity event carrying the confirmed `providerSessionId`.
4. The runtime persists provider continuity only when that anchor is present; it does not emit provider continuity as a public `RuntimeEvent`.
5. Provider continuity remains provider-specific and entity-scoped.

## 8. Governance checks

**Code:** `contracts/governance.ts` and `runtime.ts`

The runtime performs explicit governance capability checks instead of a single binary evaluation method.

Current checks are:
- `canInvoke(...)`
- `canBindContext(...)`
- `canUseCapability(...)`
- `canInterrupt(...)`

Governance stays in core/app wiring, not in platform adapters.

## 9. Run creation and lifecycle

**Code:** `createRun(...)`, `updateRunStatus(...)`, `finalizeInvocation(...)`

1. Create `RuntimeRun` with:
   - `id`
   - `invocationId`
   - `surfaceContext`
   - `entityRef`
   - `conversationSessionId`
   - `entitySessionId`
   - `entitySessionKey`
   - `providerId`
   - `model`
   - `status: "created"`
   - `startedAt`
2. Persist through `runRepository.create(run)`.
3. Move through explicit lifecycle states:
   - `created`
   - `running`
   - `waiting_input`
   - `completed`
   - `failed`
   - `interrupted`
4. Interrupt state lives on `RuntimeRun`; it does not mutate entity or conversation session state.

## 10a. Public route and entity lifecycle events

**Code:** `createRuntimeEvent(...)` and `emitRuntimeEvent(...)`

Before command or provider execution proceeds, the runtime emits:
- `route_decision`
- `entity_started`
- `run.started`

At finalization it emits:
- `run.completed` or `run.interrupted`
- `entity_completed`

These are public runtime semantics consumed by renderers and platform adapters.

## 10b. Command execution path

**Code:** `handleCommand(...)`

1. Resolve the command from `CommandRegistry`.
2. If not found:
   - emit a command diagnostic
   - emit `RuntimeEvent(error)`
   - mark the run as failed
3. If found:
   - build `CommandContext` with `context`, `conversation` alias, `entityRef`, and `runId`
   - execute the command
   - emit `RuntimeEvent(final)` when command output should be shown
4. `setModel()` persists through `updateEntitySession()`.

## 10c. Provider execution path

**Code:** `handleProviderExecution(...)`

1. Resolve the provider adapter from `context.providers` using `entitySession.providerId`.
2. Build `ProviderRequest` with:
   - `provider`
   - `runId`
   - `entityId`
   - `surfaceContext`
   - `sessionRefs`
   - `interruptToken?`
   - compatibility fields such as `context` and `entitySession`
   - `model`
   - `prompt`
3. Iterate provider-private `ProviderEvent` values.
4. For each provider event:
   - append provider trace via `recordProviderEvent()`
   - convert it to one or more public `RuntimeEvent` values via `interpretProviderEvent()`
5. Provider events no longer act as the public runtime/platform protocol.
6. On successful completion, persist `ProviderSession` against `entitySessionId`.

## 11. Public runtime events

**Code:** `packages/core/src/contracts/events.ts`

Public kernel events now include:
- `route_decision`
- `entity_started`
- `status`
- `text_delta`
- `ui_patch`
- `final`
- `error`
- `entity_completed`
- compatibility lifecycle events such as `run.started`, `run.completed`, `run.interrupted`

These are the shared runtime semantics used by renderers and platforms.

## 12. Rendering and platform output

**Code:** `emitRuntimeEvent()` + renderers in `packages/renderer-text`

1. Runtime passes each public event to `renderer.render(runtimeEvent, { stream })`.
2. The renderer converts `RuntimeEvent -> RenderIntent` and returns rendered output.
3. Runtime wraps that into `PlatformOutputEnvelope` containing:
   - `context`
   - `runtimeEvent`
   - `renderIntent`
   - `payload`
   - `kind`
   - `stream`
4. `platform.send()` consumes that envelope.

Current text renderers map:
- `text_delta` / `output.text.delta` → `stream`
- `final` / `output.final` → `text`
- `status`, `route_decision`, `entity_started`, `entity_completed`, `run.*` → `stream`
- `error` → `card`
- `ui_patch` → `patch`

## 13. Platform adapter boundary

**Code:** `packages/platform-cli/src/cliPlatformAdapter.ts`, `packages/platform-mira/src/miraEventMapper.ts`, `packages/platform-mira/src/miraOutputAdapter.ts`

Platform adapters only perform platform translation:
- inbound raw payload → `RuntimeInputEvent` with `SurfaceContextRef`
- outbound `PlatformOutputEnvelope` / `RenderIntent` → surface-local delivery behavior

Surface-specific delivery semantics remain adapter-local:
- `thread`
- `stream`
- `card`
- `patch`

Core never consumes those surface terms as routing primitives.

## 14. Failure and interrupt handling

**Code:** `emitFailure(...)` and `isRunInterrupted(...)`

### Failure path

1. Append `dispatch.failed` trace.
2. Emit runtime diagnostic.
3. Emit `RuntimeEvent(error)`.
4. Finalize the invocation as failed.

### Interrupt path

1. Query `runRepository.get(runId)` during provider execution.
2. If the run status became `interrupted`, call `canInterrupt(...)`.
3. Append trace stage `run.interrupted`.
4. Emit `run.interrupted`.
5. Stop provider processing without mutating `RuntimeEntitySession`.

## 15. Invocation finalization

**Code:** `finalizeInvocation(...)`

1. Determine terminal status:
   - `waiting_input`
   - `interrupted`
   - `failed`
   - `completed`
2. Append `dispatch.completed` trace.
3. Update `TraceStore` status.
4. Update `RunRepository` with final run status and `completedAt`.
5. Emit terminal public events.

## Trace emission summary

Typical trace stages now include:

| Stage | Severity | When |
|-------|----------|------|
| `ingress.received` | info | Runtime input accepted |
| `input.parsed` | debug | Parse completed |
| `session.loaded` | info | Conversation/entity session resolved |
| `run.created` | info | Runtime run created |
| `router.resolved` | info/warn | Route decision prepared |
| `command.resolved` | info/warn | Command lookup result |
| `command.started` | info | Before command execution |
| `command.completed` / `command.unhandled` | info/warn | After command execution |
| `provider.selected` | info/error | Provider lookup result |
| `provider.started` | info | Before provider execution |
| `provider.event` | debug/info/warn/error | Each provider event |
| `provider.session.saved` | info | After provider session save |
| `session.updated` | info | After `/model` changes preferred model |
| `run.interrupted` | warn | Interrupt observed |
| `dispatch.completed` | info/warn | Invocation finalized |
| `dispatch.failed` | error | Unhandled exception |

## Persistence summary

State is now split by concern:

1. **Context bindings:** `ContextBindingRepository`
2. **Conversation continuity:** `SessionRepository.getOrCreateConversation()`
3. **Entity continuity:** `SessionRepository.getOrCreateEntitySession()` / `updateEntitySession()`
4. **Provider continuity:** `SessionRepository.saveProviderSession()` scoped by entity session
5. **Runs:** `RunRepository`
6. **Legacy compatibility:** filesystem storage still reads old `conversations/` and old `provider-sessions/` data, then hydrates the new model

In the file-backed case, the runtime writes new records under versioned entity/session/run paths while preserving old session readability.
