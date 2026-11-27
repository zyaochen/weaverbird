# Package boundaries and maturity

This document explains what each package owns after the runtime-kernel upgrade, what it depends on, and how complete each slice is.

## Status legend

- **Implemented** — active in the current runnable slice and exercised by tests or composition
- **Partial** — meaningful behavior exists, but part of the surface is still intentionally incomplete
- **Scaffold** — package shape exists, but key behavior still throws or is placeholder-only

## Package matrix

| Package | Type | Status | Used by current runnable slice | Notes |
|---------|------|--------|-------------------------------|-------|
| `packages/core` | kernel | **Implemented** | Yes | owns runtime kernel contracts, dispatch pipeline, session/run/binding semantics |
| `packages/command-kit` | adapter | **Implemented** | Yes | built-in commands operate through `CommandContext` |
| `packages/platform-cli` | adapter | **Implemented** | Yes | CLI transport adapter for normalized runtime events |
| `packages/platform-aime` | adapter | **Scaffold** | No | package shell only |
| `packages/platform-cursor` | adapter | **Scaffold** | No | package shell only |
| `packages/platform-codex` | adapter | **Scaffold** | No | package shell only |
| `packages/platform-mira` | adapter | **Partial** | No | inbound normalization and outbound delivery planning exist; no end-to-end transport wiring |
| `packages/provider-mock` | adapter | **Implemented** | Yes | deterministic provider for tests and demos |
| `packages/provider-mira` | adapter | **Scaffold** | No | contract shell only |
| `packages/provider-openai-compatible` | adapter | **Implemented** | No | request execution and model listing work; not yet part of the default app slice |
| `packages/state-memory` | adapter | **Implemented** | Yes | conversation/entity/provider sessions, bindings, runs, trace, diagnostics in memory |
| `packages/state-filesystem` | adapter | **Implemented** | Yes | file-backed sessions, bindings, runs, traces, and generic state store |
| `packages/renderer-text` | adapter | **Implemented** | Yes | `RuntimeEvent -> RenderIntent -> text` renderers |
| `apps/wb-cli` | app | **Implemented** | Yes | current composition root |

## Dependency rules

### Global rules

1. `packages/core` is the dependency root.
2. Adapter packages may import from `packages/core` only.
3. Adapter packages must not import from each other.
4. `apps/*` are the only composition roots.
5. Cross-package exchange must happen through contracts exported by `packages/core/src/index.ts`.
6. Platform-specific transport terms must not leak into core contracts.
7. Governance and routing logic must stay out of adapters.

### Examples of allowed imports

- `packages/command-kit` → `packages/core`
- `packages/platform-cli` → `packages/core`
- `packages/platform-mira` → `packages/core`
- `packages/state-filesystem` → `packages/core`
- `apps/wb-cli` → `packages/core` plus any adapter package

### Examples of forbidden imports

- `packages/command-kit` → `packages/platform-cli`
- `packages/provider-mock` → `packages/state-filesystem`
- `packages/platform-mira` → `packages/provider-mira`
- `packages/core` → any adapter package

## Detailed package notes

## packages/core

**Role:** runtime kernel

**Owns:**
- platform, provider, command, session, rendering, runtime, entity, binding, run, event, and governance contracts
- `SurfaceContextRef`
- `RuntimeEntity` / `RuntimeEntityRegistry`
- `ContextBinding` / `ContextBindingRepository`
- `ConversationSession`, `RuntimeEntitySession`, `ProviderSession`
- `RuntimeRun` / `RunRepository`
- public `RuntimeEvent`
- public `RenderIntent`
- command parsing and command registry
- key derivation helpers
- trace and diagnostic types
- `WeaverbirdRuntime`
- default entity registry and default governance policy

**Key files:**
- `src/contracts/*.ts`
- `src/runtime/runtime.ts`
- `src/runtime/defaultEntityRegistry.ts`
- `src/runtime/defaultGovernancePolicy.ts`
- `src/commands/commandParser.ts`
- `src/commands/commandRegistry.ts`
- `src/session/sessionModels.ts`
- `src/events/types.ts`

**Allowed dependencies:** internal core modules only

**Important invariants:**
- core is platform-agnostic
- core does not expose provider-private `ProviderEvent` outside provider execution
- core does not contain Mira or Feishu transport terms
- `RuntimeRun` is separate from session state
- apps remain the only composition roots

## packages/command-kit

**Role:** built-in operational command surface

**Owns:**
- `/help`
- `/status`
- `/session`
- `/model`
- `/debug`
- `/trace`

**Allowed dependencies:** `packages/core` only

**Current state:** implemented and used by integration tests

**Important invariant:** commands operate on `CommandContext` only; they do not get direct runtime internals

## packages/platform-cli

**Role:** terminal platform adapter

**Owns:**
- readline lifecycle
- raw terminal line → `RuntimeInputEvent`
- CLI output formatting
- local `/exit` and `/quit`

**Allowed dependencies:** `packages/core` only

**Current state:** implemented and active

**Important invariant:** platform code translates between terminal I/O and runtime contracts; it does not make routing or governance decisions

## packages/platform-mira

**Role:** Mira surface adapter

**Owns:**
- inbound Mira payload → `RuntimeInputEvent`
- outbound `PlatformOutputEnvelope` / `RenderIntent` → Mira delivery plan
- Mira-local delivery modes such as `thread`, `stream`, `card`, `patch`

**Allowed dependencies:** `packages/core` only

**Current state:** partial

**What exists:**
- `SurfaceContextRef` mapping for inbound events
- output planning based on `RenderIntent`
- adapter-local preservation of Mira transport semantics

**What is missing:**
- real transport integration
- end-to-end composition root wiring
- dedicated Mira integration tests

## packages/platform-aime / platform-cursor / platform-codex

**Role:** future platform adapters

**Current state:** scaffolded

**What exists:**
- package boundaries
- capability declarations
- class shells

**What is missing:**
- inbound normalization
- outbound delivery
- tests

## packages/provider-mock

**Role:** deterministic provider for local tests and demos

**Owns:**
- provider id `mock`
- model `mock-model`
- simple async provider-private event stream

**Allowed dependencies:** `packages/core` only

**Current state:** implemented and active

## packages/provider-openai-compatible

**Role:** OpenAI-compatible provider adapter

**Owns:**
- model listing
- SSE chat completion execution
- provider-private event normalization into `ProviderEvent`

**Allowed dependencies:** `packages/core` only

**Current state:** implemented at adapter level, but not yet part of the default runnable slice

**Important invariant:** it emits provider-private events only; runtime converts those into public runtime events

## packages/provider-mira

**Role:** future Mira-backed provider adapter

**Current state:** scaffolded

## packages/state-memory

**Role:** in-memory runtime state backend

**Owns:**
- `InMemorySessionRepository`
- `InMemoryContextBindingRepository`
- `InMemoryRunRepository`
- `InMemoryStateStore`
- `InMemoryTraceStore`
- `InMemoryDiagnostics`

**Allowed dependencies:** `packages/core` only

**Current state:** implemented and test-backed

**Why it matters:** this is the semantic baseline used by runtime tests, and the filesystem backend mirrors its runtime model

## packages/state-filesystem

**Role:** filesystem-backed durable runtime state

**Owns:**
- `FileSessionRepository`
- `FileContextBindingRepository`
- `FileRunRepository`
- `FileStateStore`
- `FileTraceStore`

**Allowed dependencies:** `packages/core` only

**Current state:** implemented

**What it supports:**
- legacy `ConversationSession` reads
- new `ConversationSession` writes under `conversation-sessions/`
- new `RuntimeEntitySession` writes under `entity-sessions/`
- provider session writes under versioned paths
- `ContextBinding` persistence
- `RuntimeRun` persistence
- generic JSON-backed state store
- one-file-per-invocation traces

**Known limitations:**
- no locking or concurrency coordination
- no atomic-write abstraction beyond simple file writes
- compatibility policy is intentionally simple: read old, write new

## packages/renderer-text

**Role:** text rendering boundary

**Owns:**
- `TextRenderer`
- `MarkdownRenderer`
- `RuntimeEvent -> RenderIntent -> string` mapping

**Allowed dependencies:** `packages/core` only

**Current state:** implemented

**Important invariant:** renderers do not know transport details; they only translate public runtime events into render intents and payloads

## apps/wb-cli

**Role:** executable composition root

**Owns:**
- CLI option parsing
- environment overrides
- store selection
- runtime collaborator wiring
- platform attach/start lifecycle

**Current state:** implemented and active

**What it proves:** the upgraded kernel runs end-to-end with app-level composition of platform, providers, state, bindings, runs, renderer, and governance

## Package graduation guidance

A package should be treated as implemented only when:
- its contract surface is wired
- the intended invariants are documented
- at least the golden path is exercised by tests or a composition root
- failure modes are explicit rather than hidden

This keeps the package map honest while the system grows additively.