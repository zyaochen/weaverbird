# Debug contract reference

> Historical note: this document describes an older pre-W1 debug contract layer and is **not** the source of truth for the current mainline contracts.
> Current mainline references: [README.md](../../README.md), [docs/product-strategy.md](../product-strategy.md), [docs/topics/agent-adapter.md](../topics/agent-adapter.md), [packages/core/src/agent/types.ts](../../packages/core/src/agent/types.ts), [apps/wb-cli/src/main.ts](../../apps/wb-cli/src/main.ts).

This document describes the contract surface for debugging and tracing in Weaverbird. Diagnostic event shapes such as `DiagnosticEvent`, `TraceRecord`, `InvocationTrace`, `TraceSummary`, and `DebugSnapshot` are defined in `packages/core/src/events/types.ts`. Runtime wiring contracts such as `TraceStore`, `RuntimeDiagnostics`, and `RuntimeDebugOptions` are defined in `packages/core/src/contracts/runtime.ts`.

## DiagnosticEvent

Represents one structured runtime-level observation.

Fields:

- `invocationId: string` — the invocation this event belongs to
- `timestamp: string` — when the event was emitted
- `severity: DiagnosticSeverity` — `"debug" | "info" | "warn" | "error"`
- `category: string` — stable event category such as `"provider"`, `"command"`, `"runtime"`
- `message: string` — short human-readable summary
- `conversationKey?: string` — normalized conversation key
- `contextKey?: string` — surface context key
- `entityKey?: string` — runtime entity key
- `runId?: string` — associated run id
- `providerId?: string` — provider involved
- `model?: string` — model involved
- `data?: Record<string, unknown>` — optional structured details

Usage:

- real-time diagnostics
- CLI status/debug output
- operator inspection

## TraceRecord

Represents one stored step inside an invocation trace.

Fields:

- `timestamp: string`
- `stage: string`
- `severity: DiagnosticSeverity`
- `message: string`
- `data?: Record<string, unknown>`

`TraceRecord` is optimized for reconstruction of a single invocation lifecycle.

## InvocationTrace

Represents the full trace for one invocation.

Fields:

- `invocationId: string`
- `startedAt: string`
- `completedAt?: string`
- `status: "running" | "completed" | "failed" | "interrupted"`
- `conversationKey?: string`
- `contextKey?: string`
- `entityKey?: string`
- `runId?: string`
- `providerId?: string`
- `model?: string`
- `records: TraceRecord[]`

Usage:

- `/trace show <invocationId>`
- persistence to file-backed storage
- bug reports and repro analysis

## TraceSummary

Lightweight projection of an `InvocationTrace` for listing.

Fields:

- `invocationId: string`
- `startedAt: string`
- `completedAt?: string`
- `status: "running" | "completed" | "failed" | "interrupted"`
- `conversationKey?: string`
- `contextKey?: string`
- `entityKey?: string`
- `runId?: string`
- `providerId?: string`
- `model?: string`
- `recordCount: number`
- `lastMessage?: string`

## TraceStore

Storage contract for invocation traces (defined in `contracts/runtime.ts`).

Responsibilities:

- `append(invocationId, record, metadata?)` — append a record to an invocation
- `getInvocation(invocationId)` — retrieve one invocation by id
- `listRecent(limit?)` — list recent invocations as `TraceSummary[]`
- `listRecentErrors(limit?)` — list recent failed invocations
- `setInvocationStatus(invocationId, status, completedAt?)` — finalize an invocation

Non-responsibilities:

- rendering traces
- command formatting
- platform-specific transport logic

## RuntimeDebugOptions

Controls debug behavior at runtime.

Current fields:

- `enabled`: global debug switch for the current runtime
- `traceEnabled`: configuration-level intent for trace recording; in the current `wb-cli` composition this is always enabled and is not exposed as an independent runtime toggle
- `persistTraces`: composition-level intent for durable trace persistence; in the current `wb-cli` path the actual behavior comes from wiring a file-backed or in-memory `TraceStore`
- `maxRecentInvocations`: retention bound for recent invocations in memory or file-backed cleanup
- `maxRecordsPerInvocation`: trace growth guard for each invocation
- `redactSensitiveData`: configuration field for future redaction behavior; the current runtime does not yet apply redaction during trace recording

## DebugSnapshot

A lightweight aggregated read model used by `/status` and related commands.

Fields:

- `platform: string`
- `provider: string`
- `model: string`
- `debugEnabled: boolean`
- `traceStore: "none" | "memory" | "file"`
- `traceCount: number`
- `recentErrorCount: number`
- `conversationKey?: string`
- `contextKey?: string`
- `entityKey?: string`
- `runId?: string`
- `providerSession?: string`

## Persistence guidance

### Ephemeral data

Good candidates for in-memory only:

- live counters
- transient prompt metadata
- non-essential provider raw payloads

### Persistent data

Good candidates for file-backed storage:

- invocation id
- timestamps
- stable trace stages
- completion/failure status
- redacted structured details

## Compatibility rule

These contracts belong to `packages/core` and must stay platform-agnostic.

That means:

- no CLI-only formatting fields
- no provider-specific transport assumptions
- no references to terminal APIs or file paths

Platform-specific rendering and storage wiring should happen outside the contract layer.
