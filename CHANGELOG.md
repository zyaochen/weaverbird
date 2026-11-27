## M11-D · F18 session revision 乐观锁 + attach revision_mismatch 出口 (2026-08-04)
- `SessionRecord.revision: integer(default 0)` additive 入 `packages/core/src/captain/contracts.ts`;reader 遇到缺字段视为 0，既不动存量行。
- `packages/core/src/captain/session-store.ts` 增 `upsertWithRevision(record, expectedRevision)`:字段检查 → remote `revision === expectedRevision` 才写,写入字段升 +1;mismatch 抛 `CaptainError(E_REVISION_MISMATCH)`;初次建立也走同一路径受 expectedRevision+1。
- `CAPTAIN_ERROR_CODES.E_REVISION_MISMATCH = 'captain.session.revision_mismatch'` 登记规范错误码。
- `CaptainService.CreateSessionInput` 允许显式传初始 `revision`，默认 0，老调用零变化。
- 跨设备 attach 新增 `handleAttachRequestWithRevision` 在 `packages/core/src/reverse-channel/attach-handler.ts`;它复用现有 mutex 规则，但当接到 `CaptainError(E_REVISION_MISMATCH)` 时返回 `AttachResult.outcome='revision_mismatch'`,携带 `expected_revision` / `actual_revision` / `suggestion='run reconcile or use --force'`。
- `specs/w3.3-wb-cli-console/contracts.ts` 同步添加 `revision_mismatch` variant；`tests/reverse-channel/contracts.test.ts` 的"runtime vs SPEC"反差验证保绿。
- 新增 audit helper `attachRevisionMismatchAuditResource(sessionId, expected, actual)`，把当年的"from captain"字段写成 `rev_<expected>_to_<actual>`,保证验证可追。
- 测试:`tests/captain/session-store.test.ts` 新增 3 用例（空 remote CAS 创写 / revision match 写入 / revision mismatch 拒写),`tests/reverse-channel/e2e-bidirectional.test.ts` / `tests/reverse-channel/handoff.test.ts` 校准以匹配新增的 store / schema 签名。
- D3 (home-group FSM 五态) 决策：不动 `AgentEvent` 协议。awaiting-approval 推卡已由 M11-A F22 + home-group sendCard 完成，由 `/wb` 前缀 slash 补充。
- Final close verification：`npm run typecheck`、`npm run build`、`npm test` → `Test Files 207/207`, `Tests 1172/1172`, `failed = 0`。

## M11-C · W3.5 Doc Sink / Calendar Hook / group-sync 接线 (2026-08-04)
- **Doc Sink 接 run finalizer**:`packages/core/src/run-observability/finalizer.ts` 在卡片 finalize 完成后调 `ensureRunDoc`，把 `produced_doc_urls` / `doc_sink_attempted_at` / `doc_sink_last_reason` 写回 `ObservabilityStoreEntry`；新增 `skipDocSink` 选项避免测试 / 热路径重复拉 OpenAPI。
- **Contracts 解冻**：`ObservabilityStoreEntry` 增三个 additive 字段（`produced_doc_urls`, `doc_sink_attempted_at`, `doc_sink_last_reason`），frozen 旧字段原值不变。同步 PRD §6.1 Doc Sink 接线测试要求。
- **Calendar Hook 超期回流 IM**:`packages/core/src/calendar-hook/scheduler.ts` 加 `onOverdueEscalated` 回调；`apps/wb-bot/src/feishu/transport.ts` 在 startCalendarScheduler 时把它绑到 `EventHandler.notifyCalendarOverdue`，通过 home group 发"未按时结束" 卡。
- **EventHandler.notifyCalendarOverdue**：从 session_id 拆 threadId → home group；失败仅记日志，不阻塞 sweep。
- **group-sync IM slash**: `COMMAND_CATALOG` 新增 `sync` 条目；`apps/wb-bot/src/commands/router.ts` 接 `/wb sync run`;新增 `apps/wb-bot/src/commands/wb-sync.ts` 走 `syncGroupCommand`(default mock transport) + `loadGroupSyncConfig` 守卫。
- 测试：新增 `tests/run-observability/T12-finalize-doc-sink.test.ts`(3 用例：skipDocSink bypass / not_terminal 记录 / config missing → last_reason=error)、`tests/calendar-hook/overdue-notify-im.test.ts`(4 用例：overdue → onOverdueEscalated 仅一次 / 未挂钩静默 / home-group 路由 / sendCard 失败重抛)、`tests/wb-bot/wb-sync.test.ts`(4 用例：禁用 / 未启用 / run 成功 / 未识别 sub-cmd)。
- Final close verification：`npm run typecheck`、`npm test` → `Test Files 207/207`, `Tests 1169/1169`, `failed = 0`。

## M11-A · F22 审批反向 @ 完整链路 (2026-08-04)
- 卡片渲染 `renderApprovalRequestCard` 增 `<at user_id=... />` 提及段落，把所有 `allowedApproverOpenIds` 都拉到卡片首行；卡上三按钮为「批准 / 拒绝 / 转派」。
- 新增 `renderApprovalCountdownText(request, nowMs)` 剩余秒数文案；`sweepApprovalRequests` 每次扫描都 patch `PENDING_APPROVAL` 卡的倒计时，到点改推「已超时，默认拒绝」。
- 新增 `renderApprovalResolvedCard` 把已批准 / 已拒绝 / 已三者写为终态卡，超时和拒绝都 patch 回 `carrierMessageId`，让审批人始终能看到最终态。
- 新增 `apps/wb-bot/src/approval-gate/notifier.ts`：卡片驱动的 ApprovalNotifier，`notifyApprovers` 默认 requestId 幂等去重，供未来追加 DM / 私聊通道复用。
- `sweepApprovalRequests` dispatch 阶段调 notifier 再一次向 home group 发卡片；miss 不阻塞主链路。
- `ApprovalRequestStore.transfer(requestId, newApprovers, nowIso)`：存档新的 `PENDING_DISPATCH` 记录，重置 requestId/createdAt/deadlineAt/允许列表，同时清空 resolution 字段；同一 requestId 不再残留。
- 卡片 action `approval_gate_transfer`：resolve 旧 request 为 DENIED（reason=`transferred by <opener>`）+ transfer 到新 `allowedApproverOpenIds`（发起人自动排除）+ audit + notify。没有可用其余审批人时回 toast 拒绝。
- 测试：新增 `tests/approval-gate/f22-notify-and-transfer.test.ts`（7 用例：render @ 提及 / 三按钮 / 倒计时 / 已决卡 / notifier 幂等 / notifier 错误传播）；`tests/wb-bot/approval-store.test.ts` 新增 transfer 双用例（重置窗口/字段、缺 request 报错）。
- Final close verification：`npm run typecheck`、`npm test` → `Test Files 204/204`, `Tests 1158/1158`, `failed = 0`。

## M11-B · CLI 平价 + captain.toml 修复 (2026-08-04)
- 新增 `wb-cli resume --inherit <run_id>`：从 Run Registry 拉取历史 run 并打印继承上下文（cwd/scope/agent/project/home_group_id/entry_form），不污染 IM / 卡片。
- 新增 `wb-cli list [--all-captains]`：跨 Captain 聚合读 Run Registry 最新 50 行，输出紧凑表，stderr 标 `view=all-captains`。
- `wb-cli history` 新增 `--all-captains` 标志：状态语义同 `wb-cli list`，与 IM `/wb history` 行为对齐。
- 修复 F20 `captain.toml` throw：`packages/core/src/captain/toml-loader.ts` 引入最小手写 TOML subset（仅 `version` + `[[mapping]]` 数组 + 字符串字段），缺 `captain.json` 时回落到 `captain.toml`；保留 rejection path（不识别的 key 即报 `E_TOML_INVALID`）。
- wb-cli `--help` 改由 Command Catalog 驱动（cli_visible 列表 + bespoke usage 段），`/help` 与 `wb-cli --help` 预览均来自同一 source。
- 测试：`tests/captain/toml-loader.test.ts` 增 4 用例；新增 `tests/wb-cli/cli-parity.test.ts` 8 用例覆盖 resume/list/history 入口。
- 文档：更新 `docs/guides/captain-setup.md` 说明 `captain.toml` 被接受、优先级与 `captain.json` 的关系。
- Final close verification: `npm run typecheck`, `npm test` → `Test Files 203/203`, `Tests 1149/1149`, `failed = 0`。

## W13-e2e-harness · readonly preflight + sanitized replay + manual residual checklist (2026-06-25)
- Added `npm run e2e:preflight:env` as a strictly readonly preflight that checks env completeness, bot identity readability, group-role API readability, and shortId parseability without send/delete/kill behavior.
- Added W13 L1 harness coverage with a sanitized replay fixture and guard tests that assert the test path never falls through to unexpected real egress write calls.
- Added a new minimal true-device checklist guide at `docs/guides/w13-e2e-readonly-checklist.md`; it keeps live actions manual-only, references the original runbook instead of rewriting it, and forbids unsanitized identifiers or secrets in evidence.
- Targeted verification: `tests/wb-bot/e2e-preflight.test.ts`, `tests/wb-bot/w13-l1-harness.test.ts`, `tests/wb-bot/w13-e2e-checklist-doc.test.ts`, plus `npm run build` and `npm run typecheck` green.

## W12-docs · README usability refresh (2026-06-24)
- Rewrote the root README around a first-run-first structure: 30-second overview, 5-step quick start, first-run verification, command/permission matrix, Mermaid diagrams, troubleshooting, and FAQ.
- Refreshed `.env.example` into a placeholder-only, safe-default operator template that explains which variables matter for first success and which remain advanced.
- Kept README strictly inside landed behavior: W11 card `叫停` is documented as shipped, `passport role` remains `NO-GO`, `takeover` remains out of scope, and real IM / card-button end-to-end verification remains manual-only.
- Final close verification: `npm run build`, `npm run typecheck`, `npm test`, `npm run lint:codes` → `Test Files 163/163`, `Tests 1000/1000`, `failed = 0`, `lint:codes 54/108`.

## W11-feature · admin cancel card entry (2026-06-24)
- Added an admin-facing `叫停` button on the running session card while preserving the existing operator `停止` button and the visible short-id target surface.
- Routed the new card callback into the existing W8 `/cancel <shortId>` backend chain instead of creating a second governance path, including W8 authorization, fail-closed behavior, stop execution, operator notify, and `admin_cancel` audit reuse.
- Preserved the frozen operator rule: operator clicks still short-circuit to the operator stop path and do not enter `admin_cancel` audit.
- Final close verification: `npm run build`, `npm run typecheck`, `npm test`, `npm run lint:codes` → `Test Files 163/163`, `Tests 1000/1000`, `failed = 0`, `lint:codes 54/108`.

## W10-research · passport role authority-source research (2026-06-24)
- Revalidated the post-W9 mainline with full V3 green and explicit `Test Files failed = 0` / `Tests failed = 0`, keeping the research baseline fixed at `997`.
- Researched `passport role` as a possible authority source against the current W8 model (`Feishu owner / group_admin / whitelist`) and recorded a three-source relationship matrix plus evidence grading.
- Concluded `NO-GO` for W10: Passport role is organization/member/resource RBAC rather than the current chat-governance authority domain, would require a new identity bridge, and would reopen the frozen W7/W8 auth/audit contract.
- Final close verification: `npm run build`, `npm run typecheck`, `npm test`, `npm run lint:codes` → `Test Files 163/163`, `Tests 997/997`, `failed = 0`, `lint:codes 54/108`.

## W9-health · health + carry-forward triage (2026-06-24)
- Revalidated the post-W8 mainline with full V3 green and explicit `Test Files failed = 0` / `Tests failed = 0`, keeping the live execution anchor fixed at `997`.
- Rechecked `cwd-guard:61` with two focused reruns of `tests/wb-bot/cwd-guard.test.ts` plus related cwd entry regressions; no stable reproduction was observed, so the item remains observation-only.
- Reviewed `LL-1` / `LL-2` as carry-forward labels and kept both deferred because the current repo still does not recover a concrete, low-risk implementation target.
- Final close verification: `npm run build`, `npm run typecheck`, `npm test`, `npm run lint:codes` → `Test Files 163/163`, `Tests 997/997`, `failed = 0`, `lint:codes 54/108`.

## W8 · reverse-@ admin path implementation (2026-06-24)
- Added visible short session identifiers to the primary running card so `/cancel <identifier>` can target a unique live session without guesswork.
- Added additive admin authorization (`operator -> admin -> deny`) with fail-closed group-role lookup and empty-admin-set backward compatibility.
- Added explicit `/cancel` execution over the shared `stop.signal` path, including target-not-found listing and concurrent double-cancel short-circuit behavior.
- Added admin receipt, operator notification, and `admin_cancel` audit emission while keeping `actor_role` and `result` inside the frozen W7-design schema.
- Final close verification: `npm run build`, `npm run typecheck`, `npm test`, `npm run lint:codes` → `Test Files 163/163`, `Tests 997/997`, `failed = 0`, `lint:codes 54/108`.

## W7-design · reverse-@ admin path (2026-06-23)
- Landed the final design package for a limited reverse-@ admin path as a docs-only milestone (`specs/w7-design/`).
- Verified the two implementation prerequisites instead of entering code: main session cards are not yet identifier-ready, while `stop.signal` is already a reusable general stop path.
- Preserved baseline `989` with zero runtime/test changes and closed the design milestone with full V3 green plus explicit `Test Files failed = 0` / `Tests failed = 0`.

## W6 · health + classification + C3 decision (2026-06-23)
- Revalidated post-W5 baseline `989` with full V3 green and explicit `Test Files failed = 0` / `Tests failed = 0`.
- Classified the W6 carry-forward backlog without conflict: `reverse-@ admin path` stayed governance/P1, `cwd-guard:61` stayed an observation item, and `LL-1` / `LL-2` stayed deferred experience labels.
- Recorded `reverse-@ admin path` as a formal `NO-GO` for this milestone: the current operator-only IM gate remains canonical, and a true admin path requires a separate design milestone because the repo provides no existing admin identity source or group-admin helper.
- Final close verification: `npm run build`, `npm run typecheck`, `npm test`, `npm run lint:codes` → `Test Files 163/163`, `Tests 989/989`, `failed = 0`, `lint:codes 54/108`.

## W5 · C4-C6 + closeout (2026-06-22)
- Closed W3.3 handoff-only deferred notes as docs-only: reverse-@ remains operator-only and admin path remains deferred.
- Unified runtime-root path construction through `packages/core/src/paths.ts` without changing `WB_DATA_DIR`, runtime layouts, or legacy config fallback semantics.
- Added fail-open stale-run self-heal in wb-bot: stale run -> best-effort stop + `ENDED(reason='cancelled')` + admin alert, with no automatic rerun.
- Final close verification: `npm run build`, `npm run typecheck`, `npm test`, `npm run lint:codes` → `Test Files 163/163`, `Tests 989/989`, `failed = 0`.

## W3.3 · wb-cli console + reverse-@ closeout (2026-06-08)
- Closed out reverse-channel contracts/runtime alignment, including audit resource constants and attach flush error coverage.
- Verified `/health` Reverse Channel check as a live IPC path (`socket + hello ack + ping`) and aligned the setup guide wording.
- Completed W3.3 final validation (`npm run typecheck`, `npm run build`, `npm test`) and prepared `plans/w3.3-handoff-notes.md` for handoff/tag closeout.

## W3.2.5 · Captain authoritative foundation (2026-06-06)
- Added `packages/core/src/captain/` with contracts, CaptainService, session-store, command catalog, and cwd inference.
- Added wb-bot startup catalog validation and Captain session health check hooks.
- Added `wb-cli` captain/status command surface and captain setup documentation.

## W3.2-F15 · Run Registry (2026-06-06)
- Added `packages/core/src/run-registry/` with contracts, tailer, extractor, config, WAL, and Bitable writer.
- Added `/wb history` and `/wb resume --inherit <run_id>` command paths for querying and inheriting prior runs.
- Added `wb-cli history` for CLI-side registry lookup, including `--json` NDJSON output.
- Added `/health` Run Registry check and `docs/guides/run-registry-setup.md` setup guide.

## W3.1-F1 · /health audit-pipe 健康检查 (2026-06-06)
- 新增 `checkAuditPipe` (`apps/wb-bot/src/commands/health.ts`)。
- `/health` 新增第 5 检查项 `Audit Pipe`（单 bot 模式 4 项、Captain 模式 5 项）。
- 状态覆盖: not-installed(warn) / never-run(warn) / ok / stale(warn) / wal-backlog(warn)。
- env override: `WB_AUDIT_MIRROR_STALE_MS` (default 240s) · `WB_AUDIT_WAL_WARN_THRESHOLD` (default 100)。

## W3.1-polish — audit-pipe supervision (2026-06-06)
- Added `scripts/com.weaverbird.audit-pipe.plist.template` for launchctl supervision of audit-pipe.
- Added `scripts/install-audit-pipe.sh` for user-space install (`~/Library/LaunchAgents`, no sudo).
- Added `docs/guides/audit-pipe-setup.md` with install / restart / uninstall / troubleshooting steps.
- Plist supervision path does not pass `--interval`; `/health` audit-pipe check remains deferred as follow-up F-1.

## audit-pipe (W3.1 / F17) — 2026-06-05
- Added `packages/core/src/audit-pipe/` as a sidecar pipeline that reads `events.ndjson` and writes Bitable + local mirror.
- Added standalone `npm run audit-pipe -- --once|--interval <ms>` entrypoint; default behavior remains opt-in via `~/.weaverbird/config.json`.
- Acceptance coverage includes F1/F2/F3/F4 in `tests/audit-pipe/T8/e2e-acceptance.test.ts`.
