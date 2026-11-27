# Governance architecture

## Purpose

This document defines how governance fits into Weaverbird after the second-version runtime-kernel upgrade.

Governance exists to answer four questions at runtime:
- may this invocation start?
- may this surface context be rebound?
- may this run be interrupted?
- may this output capability be used on this surface?

Governance is a kernel concern, but policy choice remains an app-level responsibility.

## Boundary

### Core owns the governance contract

`packages/core` owns the public policy contract in `packages/core/src/contracts/governance.ts`.

Current public methods are:
- `canInvoke(...)`
- `canInterrupt(...)`
- `canBindContext(...)`
- `canUseCapability(...)`

`packages/core/src/runtime/defaultGovernancePolicy.ts` provides the default allow-all implementation.

### Apps own policy selection

Apps are the only composition roots and decide which concrete `GovernancePolicy` to inject.

Current example:
- `apps/wb-cli/src/index.ts`

This keeps policy choice out of adapters and avoids hiding business rules inside package-local helpers.

### Adapters must not own governance

The following packages must not decide governance outcomes:
- `packages/platform-*`
- `packages/provider-*`
- `packages/renderer-*`
- `packages/state-*`

Adapters may expose capabilities and translate events, but they must not decide whether a request is allowed.

## Governance checks in the runtime pipeline

The runtime currently applies governance at these points in `packages/core/src/runtime/runtime.ts`.

### 1. Invocation gate

`canInvoke(...)` runs after parse, binding lookup, entity resolution, session resolution, and run creation, but before binding persistence and execution.

It receives:
- `context`
- `entity`
- `event`
- `parsedInput`

Typical future uses:
- block commands by actor or surface
- deny provider prompts on restricted surfaces
- enforce entity-specific policy

### 2. Binding gate

`canBindContext(...)` runs before the runtime writes the canonical `ContextBinding`.

It receives:
- `context`
- `event`
- previous `binding?`

Typical future uses:
- prevent rebinding shared threads
- disallow flat-mode recovery on some surfaces
- require stricter ownership checks for reply/thread mutation

### 3. Capability gate

`canUseCapability(...)` runs before runtime output is delivered to the platform.

It receives:
- `context`
- `entity`
- `capability`
- `run?`

Current capability vocabulary comes from `SurfaceCapability`:
- `thread`
- `stream`
- `card`
- `patch`
- `form`

Typical future uses:
- disable patch/card/form delivery on some surfaces
- restrict richer output for specific entities or environments
- downgrade behavior without changing core routing

### 4. Interrupt gate

`canInterrupt(...)` runs when the runtime observes an interrupted run.

It receives:
- `context`
- `entity`
- `run`

Typical future uses:
- only permit interrupts from specific actors or operators
- protect long-running jobs from unauthorized cancellation

## Data model and return shape

`GovernanceDecision` currently contains:
- `allowed: boolean`
- `reason?: string`
- `metadata?: Record<string, unknown>`

This shape is intentionally simple.

The runtime uses it in two ways:
- when denied, it emits diagnostics and public error/status output
- when allowed, execution proceeds without embedding policy-specific logic into the kernel

## Design rules

### 1. Governance must stay declarative at the contract boundary

The runtime asks questions through capability-specific methods instead of embedding policy branches.

This keeps policy evolution additive:
- new policy logic can be implemented without restructuring the kernel pipeline
- tests can target policy behavior independently from transport logic

### 2. Governance must not become a hidden routing layer

Governance may allow or deny behavior, but it should not silently replace runtime routing decisions.

Good:
- deny invocation
- deny binding mutation
- deny capability usage

Bad:
- adapters silently routing elsewhere because governance is encoded locally
- policy classes inventing new execution plans outside runtime control

### 3. Governance must not mutate runtime state directly

A policy returns a decision. It does not write:
- sessions
- bindings
- runs
- trace files
- platform output

All side effects remain inside the runtime.

### 4. Governance remains orthogonal to provider semantics

Providers expose capabilities and events. Governance decides whether runtime may use them.

`ProviderEvent` must remain provider-private even when governance grows.

## Current maturity

### Implemented

- public governance contract in core
- allow-all baseline plus a concrete surface-capability policy wired by `apps/wb-cli`
- runtime invocation/binding/capability/interrupt checks
- dedicated governance integration coverage for allow/deny behavior at all four checkpoints
- diagnostics and error output on deny, including trace evidence when capability output is suppressed

### Not yet implemented

- actor-aware policy rules
- richer non-capability policy rules beyond the current CLI slice
- policy persistence or dynamic reload
- policy-specific docs for real deployment environments

## Current CLI rollout

`apps/wb-cli/src/index.ts` now injects a real `SurfaceCapabilityGovernancePolicy` rather than relying on the allow-all baseline.

Current CLI allow-list:
- `stream`
- `card`

This means:
- ordinary streaming text/status output remains allowed
- operator-visible error cards remain allowed
- richer capability paths such as `patch` and `form` are rejected unless the app explicitly widens policy

## Recommended next implementation batch

After the current CLI rollout, the next governance work should focus on:
1. richer app-level rules beyond surface capability allow-lists
2. role- or actor-aware deny behavior where a real surface needs it
3. deployment-specific operator docs and configuration guidance
4. keeping deny behavior visible through diagnostics and trace evidence as policy grows

## Code references

- `packages/core/src/contracts/governance.ts`
- `packages/core/src/runtime/defaultGovernancePolicy.ts`
- `packages/core/src/runtime/runtime.ts`
- `apps/wb-cli/src/index.ts`

## Review checklist

When reviewing governance changes, confirm that:
- apps still choose the policy implementation
- adapters still only translate, not govern
- denied behavior is visible through diagnostics and runtime output
- policy code does not mutate persistence directly
- policy code does not reintroduce provider- or platform-specific leakage into core