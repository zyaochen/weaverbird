# OpenAI-compatible provider adapter

## Purpose

This document explains the role of `packages/provider-openai-compatible` in the current architecture and how it should be integrated without changing the second-version kernel model.

The adapter already implements the provider contract and is now a supported non-default real provider profile in the runnable CLI slice.

## Package role

`packages/provider-openai-compatible` is a provider adapter package.

It owns:
- upstream model listing
- OpenAI-compatible chat completion execution
- streaming normalization into provider-private `ProviderEvent`

It does not own:
- app composition
- runtime routing
- platform delivery
- persistence
- public runtime event semantics

## Code entry points

Key files:
- `packages/provider-openai-compatible/src/provider.ts`
- `packages/provider-openai-compatible/src/streamNormalizer.ts`
- `packages/provider-openai-compatible/src/index.ts`

Current composition entry point that can wire it:
- `apps/wb-cli/src/index.ts`

## Current implemented behavior

### Capabilities

The adapter currently reports:
- `streaming: true`
- `toolCalls: false`
- `attachments: false`

### Model listing

`listModels()` calls the upstream `/models` endpoint and maps returned ids into `ModelDescriptor`.

### Execution

`execute(request)` currently:
1. emits an initial provider-private status event
2. if the runtime already passed a `providerSessionId`, re-emits it as a provider-private continuity anchor
3. sends a POST to `/chat/completions`
4. requests streaming mode
5. maps SSE chunks into provider-private events through `normalizeOpenAICompatibleStream(...)`
6. emits:
   - `text_delta`
   - `final`
   - `error`

The adapter does not invent a new upstream continuity id when none exists. In the current slice it can preserve an existing anchor, but it does not claim a true upstream session identity model yet.

### Error handling

The adapter currently covers:
- non-2xx upstream responses
- invalid stream JSON
- streamed error frames
- stream completion without explicit finish reason
- thrown transport failures normalized into stable operator-facing errors
- bounded retry for transient transport failures
- cancellation and timeout propagation through fetch and stream reading

These behaviors are exercised in `test/integration/openaiCompatibleProvider.test.ts`.

## Contract alignment

The provider integrates with the second-version kernel through `ProviderRequest` and `ProviderEvent`.

### Request shape

The runtime now passes:
- `provider`
- `runId`
- `entityId`
- `surfaceContext`
- `sessionRefs`
- `interruptToken?`
- compatibility fields such as `context` / `entitySession`
- `model`
- `prompt`

The OpenAI-compatible adapter currently only needs the minimal subset to execute the upstream request:
- `provider`
- `model`
- `prompt`

That is acceptable as long as unused fields remain additive rather than ignored hidden assumptions.

### Event boundary

The adapter emits provider-private `ProviderEvent` values only.

The runtime is responsible for converting them into public `RuntimeEvent` values.

This boundary must remain intact.

## Current composition path

`apps/wb-cli/src/index.ts` already contains the composition logic needed to choose the provider.

Current behavior:
- `parseProviderId(...)` accepts `mock` and `openai-compatible`
- omitting the provider still defaults `wb-cli` to `mock`
- explicit unsupported provider values fail fast instead of silently falling back to `mock`
- `createCliRuntimeConfig(...)` wires `OpenAICompatibleProvider` when the CLI/env profile requires it
- `WB_OPENAI_BASE_URL` and `WB_OPENAI_API_KEY` are required when the provider is selected
- blank env values are treated as missing configuration
- `WB_OPENAI_BASE_URL` must be a valid URL
- `WB_OPENAI_TIMEOUT_MS` and `WB_OPENAI_MAX_RETRIES` may optionally tune transport timeout/retry behavior
- startup fails fast with operator-facing guidance if the selected provider configuration is invalid
- `WB_MODEL` or `--model` may override the default model
- app-level config coverage in `test/integration/cliConfig.test.ts` locks CLI/env selection, precedence, and startup validation behavior

This means the adapter is already implemented and supported as a bounded real integration slice in the current CLI app, even though it remains a non-default path.

## Current slice limits

Even though the adapter now has a supported `wb-cli` integration path, important limits remain:
- the default runnable app path still centers on `provider-mock`
- startup validation is intentionally limited to provider selection and basic config sanity, not broader connectivity health checks
- failure lifecycle is still intentionally bounded, but transport errors, timeouts, transient retries, and cancellation are now normalized within the adapter
- tool calls and attachment handling are still out of scope
- this slice is operator-configured rather than a broader production-hardening story

## Operator workflow

Minimal supported workflow:

1. set `WB_OPENAI_BASE_URL` to a valid base URL
2. set `WB_OPENAI_API_KEY`
3. optionally set `WB_OPENAI_TIMEOUT_MS` and `WB_OPENAI_MAX_RETRIES` to positive integers
4. start `wb-cli` with `--provider openai-compatible` or `WB_PROVIDER=openai-compatible`
5. optionally override the model with `--model` or `WB_MODEL`

If the provider is selected with a missing, blank, or malformed startup configuration, `wb-cli` fails before runtime composition continues.

## What remains after this slice

The current slice is intentionally bounded. Future work may include:

1. richer operator docs for upstream failure handling beyond the current normalized transport semantics
2. broader real-environment validation beyond config/profile coverage
3. only after that, consideration of features such as tool calls or attachment handling

This keeps the kernel stable while letting the integration mature additively.

## Non-goals for this slice

This slice should not:
- move OpenAI-specific transport logic into core
- bypass `ProviderEvent` and emit public runtime events directly from the adapter
- couple the adapter to filesystem or platform code
- use this integration as an excuse to revise the canonical runtime model again

## Review checklist

When reviewing changes to this adapter, confirm that:
- it still depends only on `packages/core`
- it still emits provider-private events only
- upstream auth/config requirements are explicit in app composition
- app-level config tests still cover CLI/env selection and startup validation
- tests still cover model listing, streaming, and error paths
- new features do not leak transport-specific semantics into core

## Code and test references

- `packages/provider-openai-compatible/src/provider.ts`
- `packages/provider-openai-compatible/src/streamNormalizer.ts`
- `apps/wb-cli/src/index.ts`
- `test/integration/cliConfig.test.ts`
- `test/integration/openaiCompatibleProvider.test.ts`
- `test/contracts/openaiCompatibleStreamNormalizer.test.ts`