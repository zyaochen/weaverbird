# Architecture review findings

This document records the main findings from the current documentation-and-architecture review pass.

## Review scope

The review covered:
- `README.md`
- `docs/architecture/*`
- `docs/guides/cli-debugging.md`
- `docs/reference/debug-contracts.md`
- `docs/testing/debugging.md`
- current implementation evidence in `apps/wb-cli`, `packages/core`, `packages/platform-cli`, `packages/provider-mock`, `packages/state-memory`, `packages/state-filesystem`, and the existing integration tests

## What is in good shape

### 1. Package boundaries are structurally sound

The codebase already follows a clean dependency model:
- `packages/core` is the kernel
- adapter packages depend on `core`
- `apps/wb-cli` is the composition root
- command implementations do not reach into CLI internals

This gives the repo a stable base for future platform and provider expansion.

### 2. The first vertical slice is real, not aspirational

The current CLI + mock-provider slice is fully runnable and tested. It covers:
- inbound event creation
- command parsing
- session resolution
- provider execution
- trace recording
- output delivery
- file-backed trace persistence
- file-backed provider-session reuse

That is enough to review actual runtime behavior instead of only reading design notes.

### 3. Debugging is properly treated as a system concern

Tracing and diagnostics were implemented as contracts and runtime side effects rather than ad hoc logging. This is a strong architectural choice because it keeps observability reusable across future adapters.

## Risks and gaps

### 1. Package maturity was previously under-documented

Before this pass, the repo structure suggested broader support than the runtime actually delivered. The new package matrix fixes that, but the underlying risk remains: scaffold packages can easily be mistaken for working integrations if docs drift again.

### 2. Generic filesystem state exists, but is not yet part of the active runtime slice

`packages/state-filesystem/src/fileStateStore.ts` is implemented and supports JSON-backed `get`, `set`, and `delete` operations.

The current limitation is narrower:
- the current CLI composition root still wires `InMemoryStateStore` as the active runtime `stateStore`
- durable generic state is therefore not yet exercised by the main runnable slice
- filesystem persistence remains operationally limited by the same broader caveats as the rest of the file-backed layer: no locking, no atomic-write helper, and no concurrency guarantees

That means the package boundary is no longer a stub, but durable generic state still should not be over-described as a hardened or actively validated runtime path.

### 3. Real platform/provider breadth is still unproven

The architecture is designed for multiple platforms and providers, but only the CLI platform and mock provider are currently exercised end to end. The genericity claim is structurally credible, but not yet fully validated by production-like integrations.

### 4. File-backed persistence is functional but not hardened

`FileTraceStore` and `FileSessionRepository` work for local/runtime persistence, but they do not yet provide:
- atomic writes
- locking
- migration/versioning rules
- concurrency safety guarantees

That is acceptable at the current stage, but should be treated as an operational limitation, not an invisible implementation detail.

### 5. Rendering remains intentionally thin

The renderer boundary is good, but `TextRenderer` is currently a passthrough implementation. This is fine for the CLI slice, but richer platforms will likely force this layer to become more meaningful.

## Recommendations

### Immediate

1. Keep the new architecture docs as the canonical source of truth.
2. Treat `packages.md` as mandatory reading before adding or promoting a package.
3. Keep scaffold packages explicitly labeled as scaffold until they are exercised by a real composition root or dedicated tests.

### Near-term

1. Decide whether `FileStateStore` should be wired into the CLI composition root (it is implemented but not actively composed — `apps/wb-cli` uses `InMemoryStateStore`).
2. Add at least one more test that exercises a provider error event path end to end.
3. When the next real integration is chosen, validate that it plugs into the existing contracts without changing `packages/core` structure.

### Longer-term

1. Add persistence hardening if filesystem storage becomes operationally important.
2. Add contract-level tests for debug types, not just parser behavior.
3. Add renderer/output tests once a richer platform surface lands.

## Review conclusion

Weaverbird now has a reviewable architecture packet and a coherent first runtime slice. The system is ready for the next implementation step as long as work continues to respect the documented package boundaries, keeps scaffold status explicit, and expands one narrow slice at a time rather than broadening multiple unvalidated surfaces simultaneously.
