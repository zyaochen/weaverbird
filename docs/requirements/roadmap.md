# Requirements and roadmap

> Historical note: this document describes an older pre-W1 generic runtime roadmap and is **not** the source of truth for the current mainline plan.
> Current mainline references: [README.md](../../README.md), [docs/product-strategy.md](../product-strategy.md), [docs/topics/agent-adapter.md](../topics/agent-adapter.md), [apps/wb-cli/src/main.ts](../../apps/wb-cli/src/main.ts), [apps/wb-bot/src/main.ts](../../apps/wb-bot/src/main.ts).

## Why Weaverbird exists

Weaverbird is a reusable runtime kernel for operator-facing AI workflows across multiple surfaces and providers. Instead of re-implementing platform routing, recovery semantics, session persistence, streaming, diagnostics, and output delivery in each integration, Weaverbird centralizes those concerns behind a generic runtime core.

The reusable concerns are:
- inbound event normalization
- command parsing and routing
- surface-context binding and recovery
- conversation / entity / provider session continuity
- run lifecycle management
- provider execution
- trace and diagnostic collection
- runtime-event rendering and platform delivery

## Problem statement

Without a shared kernel, every surface would need its own copy of:
- how input is normalized
- how thread / reply / flat-mode context is restored
- how session and run state are modeled
- how provider responses are streamed and finalized
- how errors and status updates are surfaced
- how invocations are traced and governed

That duplication would make multi-surface support fragile and expensive.

## Product requirements

### Functional requirements

The runtime must:
1. accept normalized inbound events from any supported platform
2. distinguish command traffic from model-prompt traffic
3. restore execution context through first-class context binding
4. support non-conversation entities without polluting conversation session state
5. support pluggable providers through a stable adapter contract
6. support pluggable storage implementations for bindings, sessions, runs, and traces
7. support pluggable renderers for different output surfaces
8. expose built-in operational/debug commands
9. produce invocation-scoped traces and structured diagnostics
10. let platform adapters consume `RuntimeEvent` / `RenderIntent` rather than provider-private streams

### Architectural requirements

The system must:
1. keep `packages/core` platform-agnostic
2. keep apps as the only composition roots
3. prevent command implementations from reaching into runtime internals
4. keep platform adapters independent from provider adapters
5. isolate persistence concerns from rendering and transport concerns
6. keep `RuntimeRun` independent from conversation or entity session state
7. keep governance logic out of adapters
8. avoid leaking Mira/Feishu transport terms into core
9. keep migration additive and retain legacy session readability

### Engineering requirements

The project should:
1. keep documentation aligned with structural changes
2. keep package responsibilities narrow and reviewable
3. keep tests aligned with documented claims
4. keep the runnable slice usable without external services
5. expand future platform/provider support additively rather than invasively

## Non-functional requirements

### Maintainability

- clear package boundaries
- limited dependency direction
- replaceable adapters rather than hard-coded transport logic
- compatibility policy that is explicit in code and docs

### Observability

- every invocation should be traceable
- warnings and failures should become structured diagnostics
- persisted traces and runs should survive restart when enabled

### Predictability

- command behavior should be deterministic
- provider/session reuse should be explicit
- context restoration should be repository-driven
- trace retention should be bounded

### Safety

- runtime debugging should not require ad hoc logging sprawl
- incomplete packages should fail loudly with `NotImplementedError`
- interrupts should only affect run state

## Current in-scope implementation

The current runnable slice is:
- `apps/wb-cli`
- `packages/platform-cli`
- `packages/provider-mock`
- `packages/command-kit`
- `packages/state-memory`
- `packages/state-filesystem`
- `packages/renderer-text`
- `packages/core`

Additional implemented adapters exist outside the default slice:
- `packages/provider-openai-compatible`
- `packages/platform-mira` (partial)

This slice already supports:
- normalized CLI input
- slash commands
- mock provider execution
- entity-scoped sessions
- context-binding and run repositories
- in-memory and file-backed traces
- file-backed legacy session compatibility
- runtime-event-based rendering and platform output
- debug/status/session/trace inspection

## Current out-of-scope or not yet complete

The following capabilities are still incomplete:
- real end-to-end Mira platform integration
- real Mira provider execution
- production concurrency controls around file storage
- rich-text, card, or form-aware generic rendering beyond adapter-local planning
- a production-ready app slice that wires `provider-openai-compatible` by default

These boundaries should remain explicit in docs and review discussions.

## Supported package maturity at this stage

### Implemented and active

- `core`
- `platform-cli`
- `command-kit`
- `provider-mock`
- `provider-openai-compatible` at adapter level
- `state-memory`
- `state-filesystem`
- `renderer-text`
- `apps/wb-cli`

### Present but partial

- `platform-mira`

### Present as scaffolds

- `platform-aime`
- `platform-cursor`
- `platform-codex`
- `provider-mira`

## Near-term roadmap

### Phase 1 — establish the runtime kernel

Status: completed for the current second-version kernel model.

Goals that were achieved:
- replace conversation-only runtime assumptions with `SurfaceContextRef`, `ContextBinding`, `ConversationSession`, `RuntimeEntitySession`, and `RuntimeRun`
- make provider events provider-private again
- introduce public `RuntimeEvent` and `RenderIntent`
- keep apps as composition roots

### Phase 2 — harden state backends and compatibility

Status: baseline completed, hardening still pending.

Completed:
- memory backend semantics landed first
- filesystem backend mirrors the same model
- legacy session JSON remains readable while new structures are written
- bindings, runs, entity sessions, and provider sessions persist in versioned files

Still pending:
- stronger concurrency policy for filesystem storage beyond the current single-file atomic replacement baseline

Completed since initial planning:
- backend capability and limitation matrix documented in [state-backend-capabilities.md](../architecture/state-backend-capabilities.md)

### Phase 3 — architecture review and document-first consolidation

Current phase.

Goals:
- review the whole architecture after the kernel upgrade
- align system docs with the implemented canonical runtime model
- add focused documents for governance, platform contracts, state backend capability, and OpenAI-compatible integration
- produce a gap backlog before new implementation batches start

Exit criteria:
- system overview, runtime sequence, package boundaries, debugging, and roadmap docs are aligned
- missing architecture topics have dedicated documents
- follow-up work is split into explicit batches rather than ad hoc edits

### Phase 4 — platform and state contract tightening

Goals:
- tighten platform adapter structure and capability rules
- codify state backend guarantees and non-goals
- close small contract/document drift discovered during the review phase

Exit criteria:
- platform adapter expectations are documented and reflected in package structure
- state capability parity and limitations are explicit
- tests cover the clarified guarantees

### Phase 5 — governance and real integration slices

Goals:
- move from allow-all governance to more explicit policy behavior
- finish one real integration slice using the current kernel without changing the core model again

Candidate directions:
- wire `provider-openai-compatible` into a production-style app path
- finish Mira platform end-to-end on top of the current runtime contracts

## Decisions that should guide future work

1. **Do not bypass core contracts.** New platforms and providers integrate through runtime contracts exported by core.
2. **Do not move composition logic into core.** Wiring belongs in app bootstraps.
3. **Do not let provider-private streams become the public runtime protocol again.** Public downstream semantics are `RuntimeEvent` and `RenderIntent`.
4. **Do not hide incomplete slices.** Partial and scaffolded packages must stay explicit.
5. **Do not fold run state back into session state.** Runs, sessions, and bindings remain separate concerns.
6. **Do not start broad implementation batches before the corresponding architecture docs are written.** Documentation now leads the next phase of changes.

## Known gaps blocking broader rollout

- No real platform adapter is complete beyond CLI.
- Mira platform translation exists, but is not wired end-to-end in an app slice.
- Mira provider remains scaffold-only.
- File storage still lacks concurrency controls beyond single-file atomic replacement.
- Richer renderer outputs are still minimal outside adapter-local planning.
- Governance still has an allow-all baseline, but the current CLI slice already injects a concrete surface-capability policy.
- OpenAI-compatible provider lacks a dedicated production-style composition path.

## Review questions for this stage

A review at this phase should answer:
- does the package layering still match the new kernel boundaries?
- do docs clearly separate public runtime events from provider-private events?
- is context restoration described at the right abstraction level?
- do tests cover entity, run, and compatibility semantics well enough?
- are the next integration milestones explicit enough to prevent drift?

## Immediate next milestone

Before the next major implementation batch, finish the architecture-review documents and publish a gap backlog. After that, pick one bounded implementation slice and execute it without changing the canonical runtime model again.
