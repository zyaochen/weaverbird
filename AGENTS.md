# AGENTS.md — Weaverbird Mainline Rules

## Scope

Default rules for **automated agents and bots** working on the current Weaverbird mainline.

- Mainline: **W1 TypeScript npm-workspaces monorepo**
- Active slice: `apps/wb-bot` + `apps/wb-cli` + `packages/core/src/agent/*`
- Current path: 飞书消息 → `apps/wb-bot/src/feishu/event-handler.ts` → `AgentAdapter.run()` → CLI subprocess; CLI 直接调用走 `apps/wb-cli/src/main.ts`
- Product posture: opinionated personal tool (Pattern D'), not a public SDK / framework / horizontal platform
- Default goal: maintain the current W1 mainline (wb-bot Feishu multi-agent), not the broader historical architecture

## Read order

Read in this order before making changes:

1. `README.md`
2. `docs/product-strategy.md`
3. `docs/topics/agent-adapter.md`
4. Task-relevant code in `apps/wb-bot/src/`, `apps/wb-cli/src/`, `packages/core/src/agent/`, `tests/`

If sources disagree, use this precedence:

1. Current mainline code
2. `README.md`
3. `docs/product-strategy.md`
4. `docs/topics/agent-adapter.md`
5. Other docs as background or historical context only

## Default working surface

Start here by default:

- `apps/*` for composition
- `apps/wb-bot/src/main.ts` for current Feishu bot entry
- `apps/wb-cli/src/main.ts` for CLI entry
- `packages/core/src/agent/types.ts` for core contracts
- `packages/core/src/agent/{registry,cli-subprocess,claude-code}.ts` for active implementation
- `tests/` for the active test surface

Do not start from older provider / platform / runtime shapes unless the task explicitly requires them.

## Non-default areas

These are not the default mainline surface:

- `docs/architecture/*`: broader or older system shapes; not the default truth for current implementation
- `test/`: older tests outside the default `vitest` surface

Do not let these areas steer mainline changes unless the task explicitly requires them.

## Agent operating rules

- Prefer the active W1 path over historical or speculative architecture
- Keep changes local to the requested scope
- Reuse current contract names and behavior before proposing new abstraction layers
- Explicitly note when a task touches non-default areas or falls outside the default verification surface
- Do not claim wider compatibility, coverage, or architectural intent than current code and docs support

## Contract discipline

The default constraints from `docs/product-strategy.md` apply here:

- Do not treat Weaverbird as an external SDK / framework
- Do not expand abstractions just to make the design look cleaner
- Unless a concrete task and real product need require it, do not refine or expand:
  - `AgentAdapter`
  - `AgentRun`
  - `AgentEvent`
  - `AgentCapabilities`
  - `ToolDescriptor`
  - `ConsentLevel`
  - `continuationToken` semantics
- Treat frozen fields and variants in `packages/core/src/agent/types.ts` as frozen by default

If contract changes are truly required:

1. Keep the change minimal
2. Reuse existing naming and semantics first
3. Update implementation, tests, and contract docs together

## Implementation rules

- Extend the existing `CLISubprocessAgent` / `ClaudeCodeAgent` path before inventing parallel abstractions
- Keep composition in `apps/*`
- Keep shared contracts and reusable logic in `packages/core`
- Do not restore broad `platform-*` / `provider-*` / `runtime-*` package families unless explicitly required
- Do not pull the mainline back toward `_legacy/` shapes without explicit justification
- Treat `wb-cli` as a debug / reference adapter path only; do not add features in `wb-cli` that are missing from `wb-bot`, and do not grow `wb-cli` into a second mainline (see `docs/product-strategy.md` §7 B2)

## Tooling and commands

Use **npm** as the default command surface.

Canonical root commands:

- `npm run build`
- `npm run typecheck`
- `npm test`
- `npm run dev -- ...`

Do not invent `npm run lint` or `npm run format` as default verification steps.

## Verification

Default verification for code changes:

- `npm run build`
- `npm run typecheck`
- `npm test`

If CLI behavior changes, also run a relevant smoke check:

- `npm run dev -- ...`

Match checks to the change:

- CLI argv / routing / help / version / list-agents → `tests/wb-cli.argv.test.ts`
- Claude stream mapping / event translation → `tests/claude-code.mapping.test.ts`
- Claude end-to-end behavior → `tests/claude-code.e2e.test.ts`
- Contract or type-surface changes → `packages/core/src/agent/types.ts` + `npm run typecheck`

## Verification caveats

- `npm test` covers only `tests/**/*.test.ts` (含当前 `tests/wb-bot/` 主线测试面)
- 飞书 e2e 走 `tests/wb-bot/E2E.md` 手工 runbook (D1-D9), 默认 `npm test` 不覆盖
- `test/` 旧目录已 W1 close 时删除
- `_legacy/**` 仍在 vitest exclude
- Do not claim repo-wide or historical coverage based only on `npm test`
- If a change touches historical areas, state what default verification does **not** cover

## Documentation sync rules

Do not change only code when the change affects:

- Contract semantics in `packages/core/src/agent/types.ts`
- `ConsentLevel`, `continuationToken`, or `AgentEvent` shape/meaning
- Mainline entrypoints, canonical commands, or default verification surface

At minimum, check whether these also need updates:

- `README.md`
- `docs/product-strategy.md`
- `docs/topics/agent-adapter.md`
- `CLAUDE.md`
- `AGENTS.md`

Mainline entrypoints, boundaries, contract semantics, and verification rules must not drift between code and docs.
