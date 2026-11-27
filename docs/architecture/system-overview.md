# System overview

> Historical note: this document describes an older pre-W1 generic runtime/platform architecture and is **not** the source of truth for the current mainline.
> Current mainline references: [README.md](../../README.md), [docs/product-strategy.md](../product-strategy.md), [docs/topics/agent-adapter.md](../topics/agent-adapter.md), [apps/wb-cli/src/main.ts](../../apps/wb-cli/src/main.ts), [apps/wb-bot/src/main.ts](../../apps/wb-bot/src/main.ts).

## Purpose

Weaverbird is a reusable agent runtime for multiple operator surfaces and multiple AI providers. Its purpose is to separate reusable orchestration concerns from platform-specific transport code and provider-specific execution code.

The system is intended to make these behaviors reusable across future integrations:
- inbound event normalization
- command parsing and execution
- context restoration and binding
- conversation / entity / provider session continuity
- run lifecycle management
- provider invocation and provider-session reuse
- trace and diagnostic emission
- runtime-event rendering and platform delivery

Without this separation, each platform integration would need its own routing story, recovery model, session layout, trace model, and provider wiring.

## Design goals

1. **One runtime core, many adapters.** `packages/core` remains the shared orchestration kernel no matter how many platforms or providers are added.
2. **Strict functional partitioning.** Platform, provider, command, renderer, and state concerns live in separate packages with explicit boundaries.
3. **Composition over conditionals.** Apps choose which adapters to assemble instead of forcing `core` to branch on platform names.
4. **Operator-debuggable by default.** The first usable slice must already support traces, status commands, and persisted state.
5. **Additive evolution.** New surfaces and providers should plug into stable contracts without forcing architectural rewrites.

## Canonical runtime model

The current kernel is organized around six runtime semantics:
- **Surface context** — platform-facing routing and delivery semantics expressed through `SurfaceContextRef`
- **Conversation continuity** — reusable continuity identity for one logical conversation
- **Entity isolation** — distinct runtime entities under one conversation through `RuntimeEntitySession`
- **Run lifecycle** — one invocation tracked independently in `RuntimeRun`
- **Runtime event** — public kernel output protocol consumed by renderers and platforms
- **Render intent** — surface-neutral presentation intent consumed by platform adapters

These semantics intentionally separate concerns that were previously mixed together in a conversation-only flow.

## Architectural model

### Layers

```text
┌────────────────────────────────────────────────────────────┐
│ apps/*                                                    │
│ composition roots: choose providers, platforms, stores    │
└───────────────┬────────────────────────────────────────────┘
                │ instantiate
┌───────────────▼────────────────────────────────────────────┐
│ packages/core                                             │
│ contracts + runtime + command parser + registry + events  │
└───────────────┬────────────────────────────────────────────┘
                │ consumed through contracts
┌───────────────▼────────────────────────────────────────────┐
│ adapter packages                                          │
│ platform-*  provider-*  command-kit  state-*  renderer-*  │
└────────────────────────────────────────────────────────────┘
```

### Dependency direction

The intended dependency rule is:
- `apps/*` may depend on all package slices
- adapter packages may depend on `packages/core`
- `packages/core` depends only on its own internal modules
- adapter packages do not depend on each other

This prevents sideways coupling such as:
- command packages calling CLI helpers directly
- provider packages depending on filesystem persistence details
- platform adapters importing provider code
- governance rules being embedded in adapters

## Current implemented system

The current runnable vertical slice is built from:
- `apps/wb-cli`
- `packages/core`
- `packages/platform-cli`
- `packages/command-kit`
- `packages/provider-mock`
- `packages/provider-openai-compatible` at adapter level
- `packages/state-memory`
- `packages/state-filesystem`
- `packages/renderer-text`

This slice proves that the architecture is not only conceptual. The following are already operational:
- command handling
- provider routing
- context binding and restoration
- entity-scoped session resolution
- run persistence
- trace recording and diagnostics
- debug inspection commands
- file-backed traces, runs, bindings, and sessions
- additive compatibility for legacy session data

## System responsibilities by slice

### apps

Apps are composition roots. They are responsible for:
- reading runtime options
- instantiating adapters
- choosing storage implementations
- wiring those implementations into `createRuntime(...)`
- binding the platform to the runtime's dispatch function (e.g., `CliPlatformAdapter.attach(dispatch)` — this is CLI-specific, not a `PlatformAdapter` contract method; other platforms use their own binding mechanism)
- starting platform lifecycle
- choosing governance policy

`apps/wb-cli/src/index.ts` is the current canonical example.

### core

`packages/core` is the system kernel. It owns:
- contract definitions
- runtime orchestration
- command parsing and resolution
- identity/key derivation
- trace and diagnostic types
- default entity and governance policies

It does not own:
- terminal I/O
- HTTP/webhook handling
- provider-specific transport details
- file path selection
- concrete storage formats
- platform-specific delivery plans

### platform adapters

Platform packages are responsible for:
- translating raw platform events into `RuntimeInputEvent`
- reporting platform capabilities
- delivering `PlatformOutputEnvelope` back to the origin surface
- keeping surface-local transport semantics adapter-local

Core only sees normalized context and public runtime/render semantics.

### provider adapters

Provider packages are responsible for:
- declaring provider capabilities
- listing supported models
- converting provider-native execution into provider-private `ProviderEvent`

The runtime converts provider-private events into public `RuntimeEvent` values.

### command implementations

`packages/command-kit` owns operator-facing commands built on `CommandContext`.

This keeps commands decoupled from:
- platform-specific APIs
- runtime internals
- storage implementation details

### state backends

State packages are responsible for:
- context binding persistence
- conversation / entity / provider session persistence
- run persistence
- trace storage
- optional diagnostics and generic key-value state

Today:
- `state-memory` is the semantic baseline used by tests
- `state-filesystem` mirrors the same model and adds additive compatibility for legacy persisted data

### renderers

Renderers turn `RuntimeEvent` into `RenderIntent` and platform-ready payloads.

The current text/markdown renderers are intentionally simple. The architectural point is the boundary, not presentation richness.

## End-to-end dispatch story

At runtime, one invocation flows like this:

1. a platform adapter emits a `RuntimeInputEvent`
2. `WeaverbirdRuntime.dispatch()` parses the input
3. the runtime resolves context binding, entity, conversation session, entity session, and run
4. the runtime chooses the command path or provider path
5. provider-private `ProviderEvent` values are translated into public `RuntimeEvent` values
6. output is rendered through the configured renderer into `RenderIntent`
7. the platform adapter sends the output back to the user
8. traces and diagnostics are recorded as side effects
9. the invocation is finalized as `completed`, `failed`, `interrupted`, or `waiting_input`

See [runtime-sequence.md](runtime-sequence.md) for the detailed execution narrative.

## Genericity and extension model

Weaverbird’s generality comes from four stable extension seams.

### 1. Platform seam

Any new platform is expected to implement `PlatformAdapter`.

That means new surfaces can vary in:
- input transport (CLI, webhook, IDE bridge, bot event)
- output transport (stdout, API call, structured message)
- capabilities (streaming, message update, rich text, forms)
- adapter-local delivery plans (`thread`, `card`, `patch`, and similar surface terms)

without changing runtime orchestration.

### 2. Provider seam

Any new provider is expected to implement `ProviderAdapter`.

That means providers can vary in:
- authentication model
- streaming protocol
- model catalog
- tool-call or attachment support

without changing the command system, state model, or platform contracts.

### 3. State seam

Persistence is abstracted by:
- `SessionRepository`
- `ContextBindingRepository`
- `RunRepository`
- `StateStore`
- `TraceStore`
- `RuntimeDiagnostics`

This allows the runtime to stay agnostic to memory vs filesystem vs future database backends.

### 4. Rendering seam

`Renderer<TOutput>` allows output shape to vary by surface without re-embedding formatting concerns into the runtime.

## Cross-cutting observability

Debugging is not treated as incidental logging. It is part of the system contract.

Current observability model:
- invocation-scoped traces via `TraceStore`
- structured diagnostics via `RuntimeDiagnostics`
- operator commands for `/status`, `/session`, `/debug`, `/trace`
- file-backed persistence for traces and sessions in the CLI slice

This makes the current slice reviewable and debuggable before more real integrations arrive.

## Current maturity boundaries

### Implemented and active

- core runtime and contracts
- CLI adapter
- command-kit built-ins
- mock provider
- OpenAI-compatible provider adapter
- in-memory stores
- file-backed sessions, bindings, runs, and traces
- text renderer
- CLI composition root

### Present but partial

- `platform-mira`
- richer generic rendering beyond simple text payloads
- filesystem hardening concerns such as concurrency coordination and atomic write policy

### Present as scaffolds

- `platform-aime`
- `platform-cursor`
- `platform-codex`
- `provider-mira`

These packages preserve the intended package map and public seams, but they are not yet functioning end-to-end integrations.

## Architecture invariants

The following rules should remain true as the system grows:
- `packages/core` must not import from adapter packages
- apps remain the only composition roots
- commands must interact through `CommandContext`
- providers must emit typed `ProviderEvent` values
- downstream public semantics are `RuntimeEvent` and `RenderIntent`
- `RuntimeRun` remains independent from conversation or entity session state
- governance stays in app/core wiring, not in adapters
- platform-specific terms must not leak into core contracts
- persistence and rendering remain replaceable by contract
- partial slices must be documented explicitly rather than implied away

## What this system overview is not

This document does not replace:
- the runtime execution narrative in `runtime-sequence.md`
- package-by-package maturity detail in `packages.md`
- observability specifics in `debugging.md`
- scope and milestone planning in `../requirements/roadmap.md`

It is the top-level orientation document for understanding how the current system is intended to fit together.
