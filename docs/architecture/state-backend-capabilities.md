# State backend capabilities

## Purpose

This document defines what Weaverbird expects from runtime state backends and how the current in-memory and filesystem implementations compare.

The state model is now split by concern:
- context binding persistence
- conversation continuity
- entity continuity
- provider continuity
- run lifecycle persistence
- trace persistence
- optional generic key-value state
- optional diagnostics sink

## Canonical contracts

State behavior is defined by these core contracts:
- `SessionRepository`
- `ContextBindingRepository`
- `RunRepository`
- `StateStore`
- `TraceStore`
- `RuntimeDiagnostics`

Relevant files:
- `packages/core/src/contracts/session.ts`
- `packages/core/src/contracts/context-binding.ts`
- `packages/core/src/contracts/run.ts`
- `packages/core/src/contracts/runtime.ts`
- `packages/core/src/events/types.ts`

## Implementations

### Memory-backed

Files:
- `packages/state-memory/src/inMemorySessionRepository.ts`
- `packages/state-memory/src/inMemoryContextBindingStore.ts`
- `packages/state-memory/src/inMemoryRunStore.ts`
- `packages/state-memory/src/inMemoryStateStore.ts`
- `packages/state-memory/src/inMemoryTraceStore.ts`
- `packages/state-memory/src/inMemoryDiagnostics.ts`

Role:
- semantic baseline for the runtime model
- fastest backend for tests and local ephemeral execution

### Filesystem-backed

Files:
- `packages/state-filesystem/src/fileSessionRepository.ts`
- `packages/state-filesystem/src/fileContextBindingStore.ts`
- `packages/state-filesystem/src/fileRunStore.ts`
- `packages/state-filesystem/src/fileStateStore.ts`
- `packages/state-filesystem/src/fileTraceStore.ts`

Role:
- durable local persistence
- additive compatibility with older persisted session files
- restart survival for CLI-oriented slices

## Capability matrix

| Capability | state-memory | state-filesystem | Notes |
|------------|--------------|------------------|-------|
| Conversation session continuity | Yes | Yes | filesystem reads legacy conversation data and writes new session shape |
| Entity session continuity | Yes | Yes | entity sessions are first-class in both backends |
| Provider session continuity | Yes | Yes | provider continuity is scoped by entity session |
| Context binding persistence | Yes | Yes | bindings are keyed by `buildSurfaceContextKey(...)` |
| Run persistence | Yes | Yes | runs are independent from session state |
| Trace persistence | Yes | Yes | memory is bounded; filesystem is durable |
| Generic key-value state | Yes | Yes | both backends implement the contract, but the current `wb-cli` runtime path still wires `InMemoryStateStore` and does not actively consume generic state |
| Diagnostics sink | Yes | Partial | current durable default still uses in-memory diagnostics |
| Legacy session compatibility | N/A | Yes | filesystem supports read-old / write-new |
| Restart survival | No | Yes | memory is process-local only |
| Concurrency coordination | No | No | no locking semantics currently |

## Semantics that both backends must preserve

### 1. Entity isolation

One conversation may contain multiple entity sessions.

Backends must not collapse:
- conversation continuity
- entity continuity
- provider continuity
- run lifecycle

into one reused record.

### 2. Run independence

`RuntimeRun` must remain separate from session state.

Interrupts and terminal run state must not be persisted by mutating:
- `ConversationSession`
- `RuntimeEntitySession`
- `ProviderSession`

### 3. Binding-driven restoration

Context restoration must flow through `ContextBindingRepository`, not through provider transcript heuristics. In the current implementation, repositories first try the full `buildSurfaceContextKey(...)` match and then fall back by binding mode so reply, route, thread, and flat contexts can reuse the previously persisted binding.

### 4. Additive compatibility

Filesystem persistence must preserve the compatibility rule:
- read old
- write new

That means legacy conversation/provider data remains readable, but new writes go to the current structure.

## Filesystem layout notes

Current filesystem persistence includes these notable areas:
- `conversation-sessions/`
- `entity-sessions/`
- `provider-sessions-v2/`
- legacy `conversations/`
- legacy `provider-sessions/`
- binding store directories backed by `FileStateStore`
- run store directories backed by `FileStateStore`
- trace directory with one JSON file per invocation

This layout is intentionally simple and favors compatibility plus inspectability over broader storage coordination. In the current implementation, single-file JSON writes use atomic replacement through a sibling temp file plus rename, and trace retention remains count-based by invocation so older trace files are deleted once `maxRecentInvocations` is exceeded.

## Current limitations

### Shared limitations

Both current backends are simple contract implementations. Neither currently provides:
- transactional semantics
- cross-record atomicity
- richer query/index interfaces

### Memory-specific limitations

- no restart survival
- no durable compatibility story by design
- bounded retention for traces/diagnostics only through in-memory caps

### Filesystem-specific limitations

- no file locking
- no compare-and-swap or cross-file transaction semantics
- no crash-recovery protocol beyond atomic single-file replacement with last-write-wins behavior
- unreadable or corrupt persisted JSON is currently treated as missing data by the filesystem adapters
- compatibility policy is implemented, but concurrency remains intentionally under-specified for local CLI use

## Compatibility policy

Filesystem persistence follows a strict compatibility posture:

1. continue to read legacy persisted conversation/provider data
2. hydrate current runtime-facing objects from that legacy data when needed
3. persist new writes using the newer session/provider structures
4. keep compatibility logic localized to filesystem adapters rather than leaking it into runtime flow

This preserves additive migration without forcing the runtime to become version-aware.

## Recommended next hardening batch

After the current hardening batch, remaining state backend work should focus on:
1. keeping exact durability/non-durability guarantees aligned in code comments, docs, and tests
2. deciding whether local concurrency coordination is in scope beyond last-writer-wins single-file replacement
3. expanding compatibility tests to include more mixed old/new persisted states
4. deciding whether durable diagnostics should remain separate from the current in-memory default

## Review checklist

When reviewing state backend changes, confirm that:
- memory remains the semantic baseline
- filesystem mirrors runtime semantics instead of inventing its own model
- run state is still independent from session state
- bindings remain the primary restore mechanism
- provider continuity stays scoped by entity session
- compatibility logic stays in filesystem adapters, not in runtime orchestration

## Code references

- `packages/state-memory/src/inMemorySessionRepository.ts`
- `packages/state-memory/src/inMemoryContextBindingStore.ts`
- `packages/state-memory/src/inMemoryRunStore.ts`
- `packages/state-memory/src/inMemoryTraceStore.ts`
- `packages/state-filesystem/src/fileSessionRepository.ts`
- `packages/state-filesystem/src/fileContextBindingStore.ts`
- `packages/state-filesystem/src/fileRunStore.ts`
- `packages/state-filesystem/src/fileStateStore.ts`
- `packages/state-filesystem/src/fileTraceStore.ts`