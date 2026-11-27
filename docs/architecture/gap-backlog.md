# Architecture gap backlog

## Purpose

This document turns the current post-kernel architecture review into an explicit backlog.

It exists to answer three questions:
1. which architectural gaps are still open
2. which gaps are documentation-only versus implementation work
3. what order future implementation batches should follow without reopening the canonical runtime model

This backlog is intentionally bounded by the current second-version kernel.

It is **not** a license to redesign:
- `SurfaceContextRef`
- `ContextBinding`
- `ConversationSession`
- `RuntimeEntitySession`
- `ProviderSession`
- `RuntimeRun`
- `RuntimeEvent`
- `RenderIntent`
- `GovernancePolicy`

Those contracts are now the baseline to build on.

## Current architecture status

### Stable enough to build on

The following are considered stable for the next phase:
- apps as the only composition roots
- provider-private `ProviderEvent` versus public `RuntimeEvent`
- renderer boundary through `RenderIntent`
- entity-scoped runtime/session model
- run lifecycle separate from session state
- binding-driven context restoration
- memory-first semantics mirrored by filesystem persistence

### Still incomplete

The following still need tightening or completion:
- platform adapter minimum structure is documented but not yet enforced across all packages
- filesystem durability and concurrency guarantees are still minimal
- governance still has an allow-all baseline, but `apps/wb-cli` now injects a concrete surface-capability policy
- OpenAI-compatible provider is implemented at adapter level but not yet a full real-app slice
- Mira remains transport-partial rather than end-to-end integrated
- richer output capability behavior is still mostly adapter-local and lightly tested

## Prioritization rules

Use these rules when choosing the next batch:

1. prefer work that strengthens an existing boundary over work that changes the model
2. prefer one bounded end-to-end slice over broad partial upgrades everywhere
3. memory semantics remain the reference model; filesystem follows additively
4. apps keep policy and provider/platform selection responsibility
5. no batch should reintroduce provider or platform leakage into `packages/core`

## Gap inventory

### G1. Platform adapter contract tightening

**Status:** documented, partially implemented

**Why it matters:**
Platform packages are the easiest place for routing, governance, and transport assumptions to leak back into the kernel. The contract is now documented, but scaffolds and partial adapters still need to converge structurally.

**Current evidence:**
- `docs/architecture/platform-adapter-contract.md`
- `packages/platform-cli/src/cliPlatformAdapter.ts`
- `packages/platform-mira/src/miraEventMapper.ts`
- `packages/platform-mira/src/miraOutputAdapter.ts`

**What remains:**
- make future `platform-*` packages converge on the documented minimum structure
- add tests that explicitly cover inbound normalization and outbound output planning
- verify capability advertising matches real transport support
- keep adapter-local delivery terms from leaking into core contracts

**Non-goals:**
- no new platform-wide runtime abstractions
- no governance or provider routing added to adapters

### G2. State backend hardening

**Status:** semantically implemented, operationally under-specified

**Why it matters:**
The state model is now correct at the contract level, but filesystem persistence still has weak guarantees around atomicity, crash behavior, and concurrency. That is acceptable for the current local slice, but it is not yet a hardened durability story.

**Current evidence:**
- `docs/architecture/state-backend-capabilities.md`
- `packages/state-memory/src/inMemorySessionRepository.ts`
- `packages/state-memory/src/inMemoryRunStore.ts`
- `packages/state-filesystem/src/fileSessionRepository.ts`
- `packages/state-filesystem/src/fileRunStore.ts`
- `packages/state-filesystem/src/fileTraceStore.ts`

**What remains:**
- document exact durability guarantees in code and tests
- decide whether local concurrency coordination should expand beyond single-file atomic replacement with last-writer-wins semantics
- expand mixed old/new compatibility coverage
- clarify durable diagnostics behavior versus current in-memory diagnostics default

**Non-goals:**
- no database migration
- no runtime awareness of storage version branches
- no folding run state back into sessions

### G3. Governance from allow-all baseline to real policy

**Status:** first real CLI policy wired, broader policy maturity still low

**Why it matters:**
The runtime now has the right governance checkpoints, but real deployments still need explicit deny behavior, capability restrictions, and operator-visible outcomes.

**Current evidence:**
- `docs/architecture/governance.md`
- `packages/core/src/contracts/governance.ts`
- `packages/core/src/runtime/defaultGovernancePolicy.ts`
- `packages/core/src/runtime/runtime.ts`

**What remains:**
- expand beyond the current surface-capability policy into richer non-trivial policy rules
- keep app-level policy wiring and operator behavior on deny documented as the real slices evolve
- confirm denial remains visible through diagnostics and runtime output as additional rules land
- decide where actor-aware or role-aware policy is actually needed before broadening the contract surface

**Non-goals:**
- no adapter-owned policy
- no governance-driven rerouting hidden from runtime
- no direct mutation of persistence from policy code

### G4. Real OpenAI-compatible integration slice

**Status:** supported in `wb-cli`, still non-default

**Why it matters:**
This is the most practical candidate for the first non-mock provider slice on top of the new kernel. The adapter already works, so the remaining work is composition, operator workflow, and end-to-end validation.

**Current evidence:**
- `docs/architecture/provider-openai-compatible.md`
- `packages/provider-openai-compatible/src/provider.ts`
- `packages/provider-openai-compatible/src/streamNormalizer.ts`
- `apps/wb-cli/src/index.ts`

**What remains:**
- keep the `wb-cli` composition path explicit and stable as the slice evolves
- expand operator docs beyond the startup/config baseline into broader failure handling
- maintain app-level tests for provider selection and missing configuration as regression coverage
- validate that the adapter remains provider-private at the event boundary as richer features are added

**Non-goals:**
- no OpenAI-specific logic moved into core
- no public runtime events emitted directly from the adapter
- no attachment/tool-call expansion before the app slice is stable

### G5. Mira end-to-end slice completion

**Status:** partial adapter path only

**Why it matters:**
Mira is the main proof point for whether the platform boundary really scales past CLI. It already demonstrates the intended adapter direction, but it is not yet a full runnable vertical slice.

**Current evidence:**
- `packages/platform-mira/src/miraEventMapper.ts`
- `packages/platform-mira/src/miraOutputAdapter.ts`
- `packages/platform-mira/src/miraPlatformAdapter.ts`
- `docs/architecture/platform-adapter-contract.md`

**What remains:**
- finish the app-level wiring needed for an end-to-end surface path
- verify output capability planning under real platform constraints
- add tests for normalization, output planning, and runtime integration
- keep Mira-specific terms adapter-local

**Non-goals:**
- no Mira vocabulary in core contracts
- no platform-specific recovery rules encoded in runtime

### G6. Debugging and observability hardening

**Status:** architecture aligned, some guarantees still weak

**Why it matters:**
The trace/debugging model is now aligned with context/entity/run semantics, but redaction, durable diagnostics strategy, and richer operator workflows are still incomplete.

**Current evidence:**
- `docs/architecture/debugging.md`
- `packages/core/src/runtime/runtime.ts`
- `packages/core/src/events/types.ts`
- `packages/state-memory/src/inMemoryTraceStore.ts`
- `packages/state-filesystem/src/fileTraceStore.ts`

**What remains:**
- implement or explicitly defer sensitive-data redaction
- clarify durable diagnostics expectations
- expand tests for newer trace fields and review-stage drift
- keep debug commands aligned with the canonical runtime model

**Non-goals:**
- no adapter-local debug side channels
- no direct terminal formatting inside core

### G7. Reverse-@ admin-path decision

**Status:** implemented in W8

**W7-design note:**
- W7-design froze the operator/admin model as a design-only package, verified that main session cards still lack a stable human-visible short identifier, and confirmed that `stop.signal` is already a reusable general stop path. Those two prerequisites were then consumed by W8.

**W8 implementation note:**
- W8 landed the admin cancel path with the approved additive model: operator remains canonical, admin is governance-only, visible short identifiers are now present on the main session card, and cancel execution reuses the existing `stop.signal` path. Remaining follow-up items stay in backlog, but the admin-path implementation itself is no longer deferred.

**Why it matters:**
W3.3 package docs originally described reverse-@ as trust-circle same-rights, while the implemented IM entry path now enforces operator-only control and W5 C6 explicitly keeps that narrower behavior as the canonical state. If a true admin path is ever needed, it must be opened as a separate, owner-approved backlog item instead of being inferred from old wording drift.

**Current evidence:**
- `specs/w3.3-wb-cli-console/SPEC.md`
- `specs/w3.3-wb-cli-console/GAP_REPORT.md`
- `specs/w3.4-run-observability/FROZEN_CONTRACTS.md`
- `apps/wb-bot/src/feishu/reverse-at-im-handler.ts`
- `tests/feishu/reverse-at-im-handler.test.ts`
- `specs/w5-scope/RETRO.md`

**What remains:**
- decide whether an admin-path capability is needed at all
- if yes, define a distinct permission model instead of overloading operator-only semantics
- define audit expectations and denial/success visibility before any implementation batch opens
- keep the current operator-only path unchanged until such a batch is explicitly approved
- W9-health revalidated the post-W8 `997` mainline and made no further behavior change; `cwd-guard:61` stays observation-only after two green focused reruns, while `LL-1` / `LL-2` remain deferred because their original concrete implementation target is still not recoverable from repo evidence
- W10-research evaluated `passport role` as a possible authority source and closed `NO-GO`: current evidence positions Passport role as organization/member/resource RBAC, not a drop-in replacement for the W8 chat-governance source chain; any future revisit requires a separate design/governance milestone and a new identity bridge from requester identity into Passport member/identity scope
- W11-feature closed the deferred `card cancel button` experience enhancement by adding a GUI entry that reuses the frozen W8 `/cancel <shortId>` path rather than widening the authority model. Remaining manual follow-up stays limited to real IM / real group-role / button end-to-end verification.

**Non-goals:**
- no silent widening of reverse-@ permissions
- no reuse of old W3.3 wording as implied approval to implement admin routing
- no code change under C6; this backlog entry is documentation-only

### G8. `/cwd-add` alias semantics versus allowlist wording drift

**Status:** deferred implementation follow-up

**Why it matters:**
The current operator guidance says raw `/cwd <abs-path>` rejections can be resolved by using `/cwd-add` to "allow a prefix", but the implemented command pair does not actually persist a reusable path-prefix allowlist. `/cwd-add` stores a named alias, and `/cwd` only reuses the relaxed validation path when the operator later passes that alias name rather than the raw path. This is not a security bug, but it is a UX/documentation mismatch that creates avoidable operator confusion in the mainline control surface.

**Current evidence:**
- `apps/wb-bot/src/commands/router.ts`
- `apps/wb-bot/src/security/cwd-guard.ts`
- `tests/wb-bot/command-router.test.ts`

**Chosen direction:**
- `/cwd-add <name> <abs-path>` remains the explicit operator action that grants trust to a path prefix
- after a successful `/cwd-add`, raw `/cwd /abs/path/...` under that saved prefix should be accepted, not only `/cwd <alias>`
- alias-based usage remains supported; the new raw-path reuse is additive rather than a replacement

**What remains:**
- implement a user-scoped allow-prefix set (or equivalent reuse of saved alias paths) so raw `/cwd /abs/path/...` can reuse previously approved prefixes after explicit `/cwd-add`
- keep the denylist-first behavior unchanged while clarifying the post-`/cwd-add` happy path in help/error wording
- add focused tests for the chosen contract so `/cwd-add` guidance, `/cwd` validation, and help text do not drift again

**Non-goals:**
- no widening of the protected denylist
- no implicit trust of arbitrary raw paths without an explicit operator action
- no contract expansion beyond the current W1 wb-bot command surface unless a real product need appears

## Recommended implementation batches

### Batch 1 — contract drift cleanup

**Goal:** close small mismatches between the clarified docs, tests, and package behavior without changing the model.

**Scope:**
- naming or wording drift in runtime/debug output
- small contract/document mismatches discovered during the review
- missing focused tests where behavior is already documented

**Primary gaps addressed:**
- G1
- G6
- small parts of G2

**Verification:**
- `npm run typecheck`
- `npm test`
- targeted assertions for the clarified behavior

### Batch 2 — platform adapter tightening

**Goal:** make the documented platform-adapter contract consistently visible in implemented and partial packages.

**Scope:**
- adapter package structure convergence
- explicit inbound normalization tests
- explicit outbound planning tests
- capability-advertising validation

**Primary gaps addressed:**
- G1
- parts of G5

**Verification:**
- `npm run typecheck`
- `npm test`
- package-level adapter tests for CLI and Mira paths

### Batch 3 — state backend hardening

**Goal:** turn the current correct semantics into an explicit durability/compatibility policy with tests.

**Scope:**
- durability and non-durability guarantees
- atomic-write decision
- concurrency scope decision
- expanded old/new compatibility cases

**Primary gaps addressed:**
- G2
- parts of G6

**Verification:**
- `npm run typecheck`
- `npm test`
- targeted filesystem compatibility and persistence tests

### Batch 4 — governance rollout

**Goal:** move from allow-all scaffolding to one real policy implementation without changing the kernel shape.

**Scope:**
- one concrete governance policy
- allow/deny tests for all four checkpoints
- app-level wiring and operator-visible deny behavior

**Primary gaps addressed:**
- G3

**Verification:**
- `npm run typecheck`
- `npm test`
- targeted governance-path integration coverage

### Batch 5 — real integration slice hardening

**Goal:** keep one bounded non-mock end-to-end slice continuously validated on the existing kernel.

**Current supported slice:** OpenAI-compatible provider path in `apps/wb-cli`.

**Why this first:**
It was lower-risk than full Mira completion because the provider adapter was already implemented and the current CLI app could compose it with limited app-level changes.

**Scope:**
- explicit OpenAI-compatible composition path in `apps/wb-cli`
- env/config/operator workflow
- app-level integration and failure tests

**Primary gaps addressed:**
- G4

**Verification:**
- `npm run typecheck`
- `npm test`
- end-to-end provider-selection/configuration coverage

### Batch 6 — Mira end-to-end completion

**Goal:** complete one non-CLI surface without changing the platform contract again.

**Scope:**
- finalize app wiring
- validate capability-aware output behavior
- add end-to-end surface tests

**Primary gaps addressed:**
- G5

**Verification:**
- `npm run typecheck`
- `npm test`
- platform-specific integration coverage

## ADR guidance

At the current stage, most open work is still implementation backlog rather than unresolved architecture choice.

That means:
- this backlog should be the main planning artifact for now
- ADRs should only be added when a real long-lived trade-off must be frozen

Likely ADR-worthy triggers would be:
- choosing a durable filesystem atomic-write strategy
- deciding whether local concurrency coordination is in scope
- freezing a long-term multi-app composition strategy beyond `apps/wb-cli`

Until one of those decisions is actually made, creating placeholder ADRs would add ceremony without preserving a real decision.

## Exit criteria for the document-first phase

The current document-first phase is complete when:
1. overview and topic architecture docs all exist and agree on naming
2. this backlog is the explicit source of follow-up batches
3. future implementation starts from one selected batch rather than ad hoc edits
4. no follow-up batch requires changing the canonical runtime model again

Current batch note:
- W5 C5 runtime data root convergence is intentionally limited to path groups 1/2/3; config-class path group 4 (`WB_CONFIG_DIR`, captain config roots, CLI home state) remains explicitly out of scope for that batch.

## Related documents

- [system-overview.md](system-overview.md)
- [runtime-sequence.md](runtime-sequence.md)
- [packages.md](packages.md)
- [debugging.md](debugging.md)
- [governance.md](governance.md)
- [platform-adapter-contract.md](platform-adapter-contract.md)
- [state-backend-capabilities.md](state-backend-capabilities.md)
- [provider-openai-compatible.md](provider-openai-compatible.md)
- [../requirements/roadmap.md](../requirements/roadmap.md)
