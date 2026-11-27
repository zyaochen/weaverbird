# CLI debugging guide

> Historical note: this document describes an older pre-W1 CLI debug/runtime slice and is **not** the source of truth for the current mainline.
> Current mainline references: [README.md](../../README.md), [docs/product-strategy.md](../product-strategy.md), [docs/topics/agent-adapter.md](../topics/agent-adapter.md), [apps/wb-cli/src/main.ts](../../apps/wb-cli/src/main.ts), [apps/wb-bot/src/main.ts](../../apps/wb-bot/src/main.ts).

## Purpose

`wb-cli` is the first operator-facing surface in Weaverbird. It should be useful for:

- validating runtime behavior
- understanding session and provider binding
- inspecting invocation traces
- reproducing bugs before adding more platforms

This guide describes the available debug workflows.

## Run modes

### Normal mode

```bash
npm run dev
```

Use this when you only care about standard interaction behavior.

### Debug mode

Available debug-oriented entrypoints:

```bash
npm run dev -- --debug
npm run dev -- --debug --trace
WB_DEBUG=1 npm run dev
```

Persistent trace and session options:

```bash
npm run dev -- --debug --trace --trace-dir .weaverbird/traces
npm run dev -- --trace --trace-retention 250 --trace-records 400
npm run dev -- --trace --session-dir .weaverbird/sessions
WB_TRACE_DIR=.weaverbird/traces WB_TRACE_RETENTION=250 WB_TRACE_MAX_RECORDS=400 npm run dev -- --trace
WB_SESSION_DIR=.weaverbird/sessions npm run dev -- --trace
```

## Core workflows

### Inspect runtime status

```text
/status
```

Shows:

- platform id
- provider id
- model
- debug enabled/disabled
- trace store type (`memory` or `file` in the current `wb-cli` composition)
- recent invocation and error counts
- current conversation key
- current context key
- current entity key
- current run id
- current provider session id, or `none` when no binding has been persisted yet

### Inspect session binding

```text
/session
```

Shows:

- conversation key
- provider id
- model
- provider session summary in the form `<providerId>:<providerSessionId>` or `none`

`/session-status` is an alias for the same command.

### Toggle debug mode

```text
/debug
/debug on
/debug off
```

Shows current debug state, or enables/disables the runtime debug flag for the running CLI process.

In the current `wb-cli` slice, this flag affects runtime status and trace metadata, but it does not switch the renderer into a separate verbose output mode and it does not disable trace collection.

### Inspect recent traces

```text
/trace recent
/trace last
/trace show <invocationId>
/trace errors
```

- `/trace recent` — lists recent invocation ids with status, provider, model, run/context/entity keys, record count, and last message; in the current implementation this can include the `/trace recent` command invocation itself
- `/trace last` — shows the last invocation in detail with a compact header for provider, run, conversation/context/entity keys, latest error code, recoverable flag, and provider session continuity
- `/trace show <id>` — inspects a specific invocation by id with the same compact header
- `/trace errors` — lists recent failed invocations with the same summary shape as `/trace recent`

## Example workflows

### Why did my input not route?

1. run `/status`
2. run `/trace last`
3. inspect whether the runtime recorded:
   - input received
   - input parsed as command vs message
   - provider selected or missing

### Why is the provider session missing?

1. run `/session`
2. send one normal prompt
3. run `/trace last`
4. confirm whether provider execution completed and provider session save happened

### Why did I get an empty response?

1. run `/trace last`
2. inspect provider status and final events
3. compare the runtime trace with the user-visible output
4. if persistence is enabled, keep the invocation trace for later comparison

### How do I review one openai-compatible run?

1. start `wb-cli` with `--provider openai-compatible` and the required env vars
2. send one normal prompt
3. run `/status` to confirm provider/model plus current run, context, entity, and provider-session state
4. run `/trace last` to inspect the compact header before the raw provider records
5. if the run failed or timed out, run `/trace errors` and then `/trace show <invocationId>` to inspect `code=` and `recoverable=` directly

### Why is an unknown command failing?

1. issue the command
2. run `/trace last`
3. confirm whether parsing produced a slash command
4. confirm whether registry resolution failed

## Output model

The CLI supports channel-aware output through `PlatformOutputEnvelope.kind` and `formatCliOutput()`.

Current command outputs are plain text payloads produced by the command implementations themselves. For example:

```text
platform=cli provider=mock model=mock-model debug=off trace-store=memory trace-count=1 recent-errors=0 conversation=cli:test:session context=cli:test:root-thread:root-message:root-reply:no-mentions:default-route:private:session entity=conversation:default:cli:test:session run=run-status-1 provider-session=none
```

```text
recent traces:
id=trace-1 status=completed provider=mock model=mock-model run=run-trace-1 context=cli:test:root-thread:root-message:root-reply:no-mentions:default-route:private:session entity=conversation:default:cli:test:session records=8 last=dispatch completed
```

```text
trace provider-1
status=completed
provider=mock
model=mock-model
run=run-provider-1
conversation=cli:test:session
context=cli:test:root-thread:root-message:root-reply:no-mentions:default-route:private:session
entity=conversation:default:cli:test:session
code=none
recoverable=unknown
provider-session=mock-run-provider-1
...
```

`formatCliOutput()` may prefix non-assistant output kinds, but command behavior should be understood in terms of these plain-text payloads rather than a guaranteed bracketed format such as `[status]` or `[trace]`.

## Persistence expectations

When trace persistence is enabled:

- traces should survive CLI restarts
- traces should be queryable by invocation id
- storage should remain bounded by retention settings
- one JSON file should be written per invocation under the configured trace directory
- provider sessions and conversation preferences should survive restarts when file-backed sessions are enabled

By default, enabling file-backed traces also enables a sibling session directory. You can override that location with `--session-dir` or `WB_SESSION_DIR`.

Recommended workflow:

1. start the CLI with `--trace --trace-dir .weaverbird/traces`
2. optionally pin session storage with `--session-dir .weaverbird/sessions`
3. optionally tune retention with `--trace-retention <count>`
4. optionally cap per-invocation growth with `--trace-records <count>`
5. reproduce the issue
6. restart the CLI and run `/session` to confirm the provider binding was reused
7. inspect `/trace recent` or open the corresponding JSON file directly

## Troubleshooting

### No traces available

Possible causes:

- no invocations have completed yet
- you restarted the process and only in-memory traces were configured

### `/session` shows no provider session

Possible causes:

- only commands were run
- provider execution failed before session save
- persistence is in-memory only and the process restarted

### Debug output is too noisy

Use:

- `/debug off`
- start without `--debug`
- rely on `/trace recent`, `/trace errors`, and persisted trace files instead of expecting a separate verbose renderer mode
