# Test strategy

> Historical note: this document describes an older pre-W1 runtime/debug test slice and is **not** the source of truth for the current mainline test surface.
> Current mainline references: [README.md](../../README.md), [docs/product-strategy.md](../product-strategy.md), [docs/topics/agent-adapter.md](../topics/agent-adapter.md), [apps/wb-cli/src/main.ts](../../apps/wb-cli/src/main.ts), [apps/wb-bot/src/main.ts](../../apps/wb-bot/src/main.ts).

> This document covers the test strategy for Weaverbird's runtime, debugging, and persistence features. For architecture context, see [docs/architecture/system-overview.md](../architecture/system-overview.md).

## Goals

1. Keep contracts stable through regression tests
2. Make runtime instrumentation safe to refactor
3. Keep CLI debug output readable and deterministic
4. Make persistence behavior predictable

## Test layers

### Contract tests

**Focus:** low-level contract and parser behavior.

**Existing tests:**

- `test/contracts/commandParser.test.ts` — validates that `/command arg` is parsed as a command and plain text is parsed as a non-command.
- `test/contracts/openaiCompatibleStreamNormalizer.test.ts` — validates SSE stream normalization: non-object input, error payloads, empty choices, message content fallback, and finish_reason detection.
- `test/contracts/debugContracts.test.ts` — validates that `DebugSnapshot`, `InvocationTrace`, `TraceSummary`, and `DiagnosticEvent` accept the enriched run/context/entity/provider diagnostics metadata used by the operator debugging flow.

### Runtime integration tests

**Focus:** end-to-end dispatch through the runtime with in-memory stores.

**Existing tests:**

- `test/integration/runtime.test.ts` — validates:
  - built-in command dispatch (`/status` returns platform info)
  - plain text routing to the mock provider
  - trace recording for both command and provider paths
  - unknown command error handling and trace error listing

### Command tests

**Focus:** debug and operational commands against a wired runtime.

**Existing tests:**

- `test/integration/debugCommands.test.ts` — validates:
  - `/status` includes `trace-store=memory`, `debug=off`, and current run/context/entity identifiers
  - `/trace recent` lists invocations after provider activity with run/context/entity metadata
  - `/trace last` prepends a compact operator header before raw records
  - provider failure semantics surface through `/trace show` with `code=` and `recoverable=`
  - `/debug on` toggles debug state and is reflected in subsequent `/status`

### Provider tests

**Focus:** provider adapter behavior and configuration.

**Existing tests:**

- `test/integration/openaiCompatibleProvider.test.ts` — validates:
  - model listing via injected fetch
  - streaming text delta events from SSE
  - error response handling (non-2xx, invalid JSON, streamed errors, implicit stream end)
  - multi-line SSE event parsing

- `test/integration/cliConfig.test.ts` — validates:
  - provider ID parsing from CLI flags
  - CLI option parsing and defaults
  - credential validation
  - CLI flag override behavior
  - full config construction

### Persistence tests

**Focus:** file-backed trace store and session repository.

**Existing tests:**

- `test/integration/traceStore.test.ts` — validates:
  - one JSON file per invocation is written to the trace directory
  - persisted traces are surfaced through `/trace show` commands
  - file-backed provider sessions survive across runtime instances

- `test/integration/fileSessionRepository.test.ts` — validates:
  - conversation and provider session data is written to JSON files
  - session data survives across `FileSessionRepository` instances

### Not yet covered

- dedicated contract-shape tests for diagnostic/debug types do not exist yet
- `test/integration/debugRuntime.test.ts` — dedicated debug-mode runtime tests (not yet created; current runtime tests cover the same paths)
- `test/integration/cliDebugRendering.test.ts` — renderer output formatting tests (not yet created)

## Required scenarios

All scenarios below are currently covered by existing tests.

### Happy path

- Normal prompt routed to mock provider — `runtime.test.ts: "routes plain text to the provider"`
- Trace records created in expected order — `runtime.test.ts: "records command and provider traces"`
- Final output appears correctly — `runtime.test.ts: "routes plain text to the provider"` checks for `"Mock response for: hello"`

### Error path

- Unknown command emits error output — `runtime.test.ts: "marks unknown commands as errors"`
- Error appears in trace error list — same test checks `/trace errors` output

### Command path

- Built-in command execution traced — `runtime.test.ts: "records command and provider traces"`
- Debug toggle reflected in status — `debugCommands.test.ts: "toggles debug mode"`

### Persistence path

- Persisted trace files are written and can be inspected later through `/trace show` — `traceStore.test.ts: "writes one json file per invocation"` and `traceStore.test.ts: "surfaces persisted traces through trace commands"`
- File-backed provider sessions survive across runtime instances — `traceStore.test.ts: "reuses file-backed provider sessions across runtime instances"`
- Session data survives across repository instances — `fileSessionRepository.test.ts: "reuses persisted session data across repository instances"`

## Manual verification checklist

After meaningful changes:

1. `npm run typecheck`
2. `npm test`
3. Run CLI in normal mode: `npm run dev`
4. Run CLI in debug mode: `npm run dev -- --debug --trace`
5. Verify commands: `/status`, `/session`, `/debug`, `/trace recent`
6. Send a normal prompt and inspect `/trace last`
7. Trigger an error path (e.g., `/unknown`) and inspect `/trace errors`
8. If testing a real provider path, confirm `/trace last` or `/trace show <id>` exposes provider failure or timeout semantics through `code=` and `recoverable=`

## Documentation alignment rule

Every new feature should be reflected in:

- `README.md` if it changes the top-level workflow
- `docs/architecture/` if it changes system design or package boundaries
- `docs/guides/cli-debugging.md` if it changes operator usage
- `docs/reference/debug-contracts.md` if it changes contract schemas
- Tests covering the new behavior
