# Platform adapter contract

> Historical note: this document describes an older pre-W1 `platform-*` adapter contract and is **not** the source of truth for the current mainline.
> Current mainline references: [README.md](../../README.md), [docs/product-strategy.md](../product-strategy.md), [docs/topics/agent-adapter.md](../topics/agent-adapter.md), [apps/wb-cli/src/main.ts](../../apps/wb-cli/src/main.ts), [apps/wb-bot/src/main.ts](../../apps/wb-bot/src/main.ts).

## Purpose

This document defines the stable responsibilities of `platform-*` packages after the second-version runtime-kernel upgrade.

The central rule is:

> Platform adapters translate between surface-local transport semantics and kernel contracts. They do not own routing, governance, provider execution, or persistence.

## Core boundary

Platform adapters integrate with core through `PlatformAdapter`, `RuntimeInputEvent`, `PlatformOutputEnvelope`, `RuntimeEvent`, and `RenderIntent`.

Relevant code:
- `packages/core/src/contracts/platform.ts`
- `packages/core/src/contracts/events.ts`
- `packages/core/src/contracts/rendering.ts`

## Inbound contract

### Adapter input

Each platform receives its own raw transport payloads:
- CLI lines
- webhook payloads
- bot callback payloads
- IDE bridge events

### Adapter output to runtime

Adapters must normalize raw input into `RuntimeInputEvent[]`.

Required fields are:
- `platform`
- `type`
- `invocationId`
- `context: SurfaceContextRef`
- `actor`
- `message` when applicable

Compatibility alias:
- adapters may still accept or mirror `conversation` during migration, but new code should treat `context` as canonical and keep compatibility handling at the adapter/runtime entry boundary

## SurfaceContextRef responsibilities

`SurfaceContextRef` is a surface-facing runtime object, not just a key fragment.

Adapters are responsible for populating the platform-facing fields they actually know:
- `surface`
- `conversationId`
- `threadId?`
- `replyToMessageId?`
- `rootMessageId?`
- `mentionedUserIds?`
- `routeKey?`
- `visibility?`
- `capabilities?`
- `mode`

Legacy aliases may still be provided for compatibility:
- `platform`
- `spaceId`
- `replyToId`
- `mentionId`

Adapters may ingest those aliases from raw payloads, but they should normalize them into the second-version fields before handing the event to runtime. New adapter code should prefer the second-version fields.

## Outbound contract

The runtime delivers `PlatformOutputEnvelope` to the adapter.

The envelope includes:
- `platform: PlatformId`
- `context: SurfaceContextRef`
- `conversation?: ConversationRef`
- `runtimeEvent: RuntimeEvent`
- `renderIntent: RenderIntent`
- `payload: unknown`
- `kind?: PlatformOutputKind`
- `stream?: boolean`
- `invocationId?: string`

Adapters consume that envelope and choose the actual transport behavior.

## RenderIntent consumption rules

Adapters should treat `RenderIntent` as the platform-neutral presentation contract.

Current intent vocabulary:
- `text`
- `stream`
- `card`
- `form`
- `patch`

Adapters may translate those into surface-local behaviors such as:
- stdout line
- threaded message
- card update
- streamed append
- patch request

The mapping belongs in the adapter, not in core.

## Capability rules

Capabilities are expressed at two levels:

### PlatformCapabilities (adapter-level)

Declared on `PlatformAdapter.capabilities` as a static interface:
- `streaming: boolean`
- `messageUpdate: boolean`
- `richText: boolean`
- `forms: boolean`

These describe what the platform transport can support in general.

### SurfaceCapability (per-context)

Declared on `SurfaceContextRef.capabilities` as an array of `SurfaceCapability` values:
- `thread`
- `stream`
- `card`
- `patch`
- `form`

These describe what a specific surface context supports. Runtime governance checks use `SurfaceCapability` via `canUseCapability()` to gate output intents.

Adapters should only advertise capabilities that the surface can actually support.

## What adapters may do

Adapters may:
- normalize raw input
- choose transport-specific delivery primitives
- map `RenderIntent` to surface-local output plans
- preserve surface-local terminology internally
- surface platform capabilities to runtime

## What adapters must not do

Adapters must not:
- decide whether a command or prompt is allowed
- choose governance outcomes
- store sessions, bindings, or runs on their own
- consume `ProviderEvent` as if it were public runtime output
- embed provider routing logic
- invent cross-surface runtime semantics inside adapter-local code

## Mira as the model partial adapter

Relevant files:
- `packages/platform-mira/src/miraEventMapper.ts`
- `packages/platform-mira/src/miraOutputAdapter.ts`
- `packages/platform-mira/src/miraPlatformAdapter.ts`

Current Mira behavior shows the intended pattern:
- inbound raw Mira payloads normalize into `RuntimeInputEvent` with rich `SurfaceContextRef`
- outbound `RenderIntent` values are converted into a Mira-local output plan
- Mira-specific delivery terms (`thread`, `stream`, `card`, `patch`) remain adapter-local

This is the correct direction even though the transport is still partial.

## CLI as the model implemented adapter

Relevant files:
- `packages/platform-cli/src/cliPlatformAdapter.ts`
- `packages/platform-cli/src/cliRenderer.ts`

Current CLI behavior demonstrates:
- local input loop → `RuntimeInputEvent`
- adapter-local output formatting
- no governance or routing behavior embedded in the adapter

## Suggested minimum structure for future platform packages

Each `platform-*` package should converge on four concerns:
1. adapter class implementing `PlatformAdapter`
2. inbound mapper/normalizer if raw payloads are complex
3. outbound delivery planner if transport has multiple output modes
4. tests covering normalization and output planning

This keeps scaffold packages aligned and reduces future drift.

## Review checklist

When reviewing a platform adapter, confirm that:
- `RuntimeInputEvent` normalization is complete and explicit
- `SurfaceContextRef` fields are filled from real surface facts, not guessed runtime semantics
- output consumption starts from `PlatformOutputEnvelope` / `RenderIntent`
- provider-private events are never used as public output protocol
- governance and routing decisions remain in core
- surface-local terms do not leak into core contracts

## Code references

- `packages/core/src/contracts/platform.ts`
- `packages/core/src/contracts/events.ts`
- `packages/core/src/contracts/rendering.ts`
- `packages/platform-cli/src/cliPlatformAdapter.ts`
- `packages/platform-mira/src/miraEventMapper.ts`
- `packages/platform-mira/src/miraOutputAdapter.ts`
- `packages/platform-mira/src/miraPlatformAdapter.ts`
