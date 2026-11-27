# Debugging architecture

> Historical note: this document describes an older pre-W1 generic runtime/debug architecture and is **not** the source of truth for the current mainline.
> Current mainline references: [README.md](../../README.md), [docs/product-strategy.md](../product-strategy.md), [docs/topics/agent-adapter.md](../topics/agent-adapter.md), [apps/wb-cli/src/main.ts](../../apps/wb-cli/src/main.ts), [apps/wb-bot/src/main.ts](../../apps/wb-bot/src/main.ts).

> This document covers the debugging and tracing slice of Weaverbird's architecture. For the full system design, see [system-overview.md](system-overview.md). For the step-by-step dispatch flow, see [runtime-sequence.md](runtime-sequence.md).

## Why this exists

Weaverbird supports multiple platforms and multiple providers behind a single runtime core. If debugging were implemented as ad hoc printing inside `platform-cli` or individual providers, the codebase would become hard to maintain as more surfaces are added.

Debugging is treated as a first-class architecture slice with dedicated contracts, storage, commands, runtime instrumentation, and rendering.

## Implemented capabilities

The debugging slice is fully operational for the current CLI vertical.

- **Diagnostic event contracts** — `DiagnosticEvent`, `TraceRecord`, `InvocationTrace`, `TraceSummary`, `DebugSnapshot` are defined in `packages/core/src/events/types.ts`.
- **Runtime instrumentation** — `WeaverbirdRuntime` emits structured trace records across ingress, routing, session/run resolution, command/provider execution, and finalization.
- **In-memory trace store** — `InMemoryTraceStore` in `packages/state-memory` provides bounded retention and recent/error listing.
- **File-backed trace store** — `FileTraceStore` in `packages/state-filesystem` writes one JSON file per invocation with configurable retention.
- **File-backed state repositories** — `FileSessionRepository`, `FileContextBindingRepository`, and `FileRunRepository` persist continuity state to disk.
- **Debug commands** — `/status`, `/session`, `/debug`, `/trace recent`, `/trace last`, `/trace show <id>`, `/trace errors` are implemented in `packages/command-kit`.
- **CLI option surface** — `--debug`, `--trace`, `--trace-dir`, `--session-dir`, `--trace-retention`, `--trace-records` with `WB_*` environment variable overrides.
- **Diagnostic emission** — `RuntimeDiagnostics.emit()` receives structured diagnostic events for warnings and errors, stored by `InMemoryDiagnostics` in the current slice.

## Design goals

1. Keep debugging **platform-agnostic** in `core`.
2. Keep CLI presentation concerns inside `platform-cli`.
3. Make tracing **invocation-centered** so operators can inspect one turn at a time.
4. Support both in-memory and durable file-backed persistence.
5. Make every debugging surface testable and documented.

## Ownership boundaries

### Core

`packages/core` owns:

- diagnostic event contracts (`events/types.ts`)
- trace contracts and lifecycle semantics (`contracts/runtime.ts`: `TraceStore`, `RuntimeDiagnostics`, `RuntimeDebugOptions`)
- runtime instrumentation (`runtime/runtime.ts`)
- debug snapshots exposed to commands (`DebugSnapshot`)

`packages/core` must not:

- print directly to the terminal
- depend on CLI-only formatting rules
- choose file locations for persisted traces

### Platform CLI

`packages/platform-cli` owns:

- interactive input loop
- formatting normal output vs status/debug/trace/error output (via `formatCliOutput`)
- prompt handling while output lines are emitted

`packages/platform-cli` must not:

- invent trace records on its own
- bypass runtime contracts with custom side channels

### State layer

`packages/state-memory` owns:

- in-memory `TraceStore` with bounded invocation retention and per-invocation record caps
- in-memory `RuntimeDiagnostics` with bounded event buffer
- in-memory continuity stores for bindings, sessions, and runs used by runtime tests

`packages/state-filesystem` owns:

- file-backed `TraceStore` with one JSON file per invocation and retention enforcement
- file-backed `SessionRepository`, `ContextBindingRepository`, and `RunRepository`
- additive compatibility for legacy persisted conversation/provider data

The state layer must not own rendering or command semantics.

### Command kit

`packages/command-kit` owns:

- operator-facing commands: `/status`, `/session`, `/debug`, `/trace`
- composing runtime debug snapshots and trace summaries into human-readable output

It consumes `CommandContext` from core and never reaches into CLI internals.

## Debugging model after the second-version kernel

The debugging model now follows the same canonical runtime concepts as the kernel itself.

### Invocation scope

Tracing is centered on `RuntimeInputEvent.invocationId`.

Each `InvocationTrace` can include:
- `invocationId`
- `startedAt` / `completedAt`
- `status`
- `conversationKey`
- `contextKey`
- `entityKey`
- `runId`
- `providerId`
- `model`
- ordered `records`

This means debugging is no longer only about one conversation/session pair. It is now able to explain:
- which surface context was matched
- which entity was chosen
- which run was created
- which provider/model executed
- how the invocation terminated

### Runtime phases visible to debugging

The runtime emits traces around these phases:
1. ingress accepted
2. input parsed
3. sessions resolved
4. run created
5. route resolved
6. command or provider execution
7. provider session persistence
8. finalization or failure

This aligns operator debugging with the actual kernel pipeline rather than a legacy conversation-centric mental model.

## Diagnostic lifecycle

Typical trace stages currently include:

1. `ingress.received`
2. `input.parsed`
3. `session.loaded`
4. `run.created`
5. `router.resolved`
6. `command.resolved`
7. `command.started`
8. `command.completed` / `command.unhandled`
9. `provider.selected`
10. `provider.started`
11. `provider.event`
12. `provider.session.saved`
13. `session.updated`
14. `run.interrupted`
15. `dispatch.completed`
16. `dispatch.failed`

The authoritative list lives in `packages/core/src/runtime/runtime.ts`; this document should mirror that implementation rather than invent a second list.

## Trace model

### InvocationTrace

`InvocationTrace` is the full, per-invocation trace artifact.

It is used when:
- `/trace show <id>` drills into one invocation
- persisted trace files are inspected directly
- integration tests verify end-to-end runtime behavior

### TraceSummary

`TraceSummary` is a lightweight projection used by listing commands such as `/trace recent` and `/trace errors`.

### DebugSnapshot

`DebugSnapshot` is the operator-facing runtime status view used by `/status`. It summarizes:
- platform
- provider
- model
- debug mode
- trace store type
- recent trace counts
- conversation/context/entity/run identifiers
- provider session identity

## Persistence strategy

### In-memory (default)

- `InMemoryTraceStore` with bounded `maxRecentInvocations` and `maxRecordsPerInvocation`
- recent invocation lookup and recent error filtering
- data does not survive process restarts

### File-backed (opt-in)

- `FileTraceStore` writes `<invocationId>.json` under the trace directory
- retention is count-based per invocation and enforced by deleting the oldest trace files once `maxRecentInvocations` is exceeded
- unreadable or corrupt persisted JSON is currently treated as missing data during filesystem reads/listing
- `FileSessionRepository`, `FileContextBindingRepository`, and `FileRunRepository` persist continuity state
- data survives process restarts; integration tests verify reuse across runtime instances

## Redaction and safety

- `RuntimeDebugOptions.redactSensitiveData` exists in the contract but redaction is not yet applied during trace recording. This remains a follow-up item.
- Raw provider payloads are not stored in traces; only structured metadata is recorded.
- Interrupts are tracked through `RuntimeRun`, not by mutating entity or conversation sessions.

## Current limitations

- Trace redaction is still not implemented.
- Filesystem persistence does not yet provide concurrency coordination or atomic-write guarantees.
- Debug output is primarily consumed through commands; there is no dedicated live debug event stream beyond normal runtime output.
- `InMemoryDiagnostics` is still the default diagnostics sink even when the file-backed stores are enabled.

## Future enhancements

- apply `redactSensitiveData` filtering during trace emission
- add stronger filesystem safety policy (atomic writes / locking / recovery semantics)
- export diagnostics to external sinks
- add trace filtering by severity or stage in `/trace` commands
- document and test capability-aware debugging behavior for richer platform adapters

## Implementation checkpoints

The debugging slice should continue to be reviewed against these checkpoints:

1. Are trace fields aligned with the canonical runtime model (`context`, `entity`, `run`)?
2. Are operator commands still derived from core contracts rather than adapter shortcuts?
3. Are persistence guarantees and limitations explicit?
4. Are new runtime stages reflected in trace docs and tests?
5. Are debugging docs aligned with the actual implementation in `runtime.ts` and integration tests?

## Related documents

- [system-overview.md](system-overview.md)
- [runtime-sequence.md](runtime-sequence.md)
- [packages.md](packages.md)
- [../requirements/roadmap.md](../requirements/roadmap.md)
