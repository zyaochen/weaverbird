# W1 wb-bot E2E runbook

- D1: 在飞书 DM 发 `hello`，看到 `Claude Code · 处理中...` → 完成。
- D2: 发 `/list-agents`，卡片显示 claude-code + codex，并带 streaming / thinking / resumable 等能力摘要。
- D3: `/use codex` 后再发 `list files`，header 显示 `Codex · 处理中...`。
- D4: `/now` 显示 agent / cwd / 上下文有无，不暴露 token。
- D5: run 中 kill 进程并重启，旧卡片显示 `⚠️ 服务重启, 请重发`。
  - 建议用一个明显长跑的请求触发（例如让 agent `sleep 20 && pwd`），确认卡片仍在 `处理中...` 时 kill 进程。
  - **注意**: claude-code 默认 consent level (normal) 可能询问确认而不是直接执行 shell 命令; 建议测试时临时设 `--consent-level relaxed` 或在 `.env` 配置, 或换用 `cat README.md` 等非破坏命令触发长跑。
  - 重启后观察原卡片是否被补丁成 `⚠️ 服务重启, 请重发`；若没有，记录启动日志与旧卡片 message id，作为 gap 单独收口。
- D6: 带 `LARK_APP_SECRET` 与 `ANTHROPIC_API_KEY` 启动，验证子进程 env 只保留 agent key。
  - Claude 路径可发 `env | grep -E 'LARK_APP_SECRET|ANTHROPIC_API_KEY|OPENAI_API_KEY'`，预期只看到 `ANTHROPIC_API_KEY`，不应看到 `LARK_APP_SECRET` / `OPENAI_API_KEY`。
  - Codex 路径同理，预期只看到 `OPENAI_API_KEY`，不应看到 `LARK_APP_SECRET` / `ANTHROPIC_API_KEY`。
- D7: `/cwd /etc` 被拒；软链到敏感目录也被拒。
  - 直接验证：`/cwd /etc`，预期返回 `❌ 路径不允许: /etc. denied (protected): /etc`。
  - 软链验证：先在本机创建一个指向敏感目录的软链，再执行 `/cwd <symlink>`，预期同样被拒，且不会落库为当前 cwd。
- D8: 检查 `deploy/`、`apps/wb-bot/.env.example`、README。
- D9: 普通消息卡片 header 显示 active agent；点 STOP 看到三态。
- D10: approval-gate codex 运行时配置链路（`--ignore-user-config` + `-c` 注入）真机自洽。
  - 前提: `WB_CODEX_COMMAND` 指向可用 codex, `CODEX_HOME`（或默认 `~/.codex`）下有可用的 model_providers + auth 凭证; wb-bot 走飞书 runner 路径 (approval-gate 自动启用, 见 `event-handler.ts` prepareApprovalHookFiles)。
  - 前置文件检查: `~/.weaverbird/<dataDir>/approval-gate/codex-home/config.toml` 存在但运行时**不生效** (codex 带 `--ignore-user-config`); 真实 hooks/model/model_providers 来自 `-c` argv。
  - 用 `/agent codex` 触发一个无副作用的 prompt (如 `echo hello`), 确认:
    - codex 正常起跳 (`thread.started`), 不报 flag/TOML 解析错误 → `-c` 配置被接受。
    - codex `--dangerously-bypass-hook-trust` 启动告警被 `isIgnorableItemError` 吞掉, 卡片不显示假错误。
    - approval-gate wrapper hook 真实执行 (查看 `approval-gate/hooks/approval-gate-hook.sh` 被调用, 可在 `approval-gate/` 目录看审批请求落地)。
  - 自动化回归: `npm run test:e2e -- tests/codex.e2e.test.ts` 的 "boots a real codex exec with approval-gate runtime args" 用例覆盖配置解析正确性 (无可用 codex 时自动 skip)。

---

## W2 Batch-A manual acceptance (process supervision + 二态卡片 + heartbeat)

> Anchor: `plans/w2-mainline.plan.md` §7 D2.* done criteria · `plans/w2-batch-a-handoff-notes.md` Step 6.

CI 覆盖 vs manual gate 区分 (每条只列 `manual gate` 时的步骤; CI ✅ 表示 `npm test` 已覆盖, 不需要手测):

| Done | 类型 | 说明 |
|---|---|---|
| D2.1 kill-9 重启续接 + 二态卡片 | CI ✅ | `tests/wb-bot/recover-end-to-end.test.ts` + `process-supervision.kill9.test.ts` 覆盖; 主设计师可选 1 次飞书手测确认卡片文案 |
| **D2.2 30 min 长跑 + launchctl 重启** | **manual gate** | 见下方步骤 |
| D2.3 stop.signal cross-process ≤500ms | CI ✅ | `stop-signal.test.ts` |
| D2.4 任务历史索引 (LRU 700 / 7 日 / lazy) | CI ✅ | `task-index.test.ts` |
| D2.5 boot-loader 收窄 (chmod 0700 + 目录可写) | CI ✅ | `boot-integrity.test.ts` |
| D2.6 README launchd 边界声明 | docs ✅ | `README.md` Process Supervision Boundary 段 (lock-screen / logout / shutdown 三类) |
| D2.7 heartbeat App Nap fixture + 默认 240s | CI ✅ | `heartbeat-calibration.test.ts` + `heartbeat-calibration.app-nap.test.ts`; **可选**手测: 主设计师笔记本合盖 ≥10 min 唤醒, 确认任务未误判 'lost' |
| D2.8 wb-runner envFilter (FilteredEnv + spawn e2e) | CI ✅ | `wb-runner-envfilter.test.ts` + `wb-runner.envfilter.spawn.test.ts` |

### W2-D2.2 · dynamic workflow 30+ min 长跑 + launchctl 重启续接 (manual gate)

**前提**:
- wb-bot 经 launchctl 部署 (用户自配 plist, 仓库目前未带 wb-bot 模板, W2.5 Block G8 才产出) 或 `npm run wb-bot:dev` 直接跑 (foreground)
- `~/.weaverbird/runs/default/` 存在, `WB_DATA_DIR` 指向同一目录
- `WB_HEARTBEAT_STALE_MS` 用默认 240000 (240s), 不要 override

> **常见误用**: `npm run dev -- bot` ≠ 启动 wb-bot. `npm run dev` 走 wb-cli (`apps/wb-cli/src/main.ts`), 把 "bot" 当 prompt 传给 default agent. 启动 wb-bot host 必须用 `npm run wb-bot:dev` (绑 `apps/wb-bot/src/main.ts`).

**步骤**:
1. 在飞书 DM (或允许 wb-bot 的 thread) 触发一个已知 30+ min 的 dynamic workflow 任务. 推荐方式 (任选一):
   - Claude Code: `审查 packages/core 全部代码 + 分别给每个文件出 review 报告, 用 dynamic workflow 拆 subagent`
   - 或: `跑一遍 npm run build && npm test, 失败了分析根因后修复, 直到全过` (实际可能 < 30 min, 视项目状态)
2. 等任务运行 **≥ 5 min**, 观察:
   - 卡片 header 显示 `<emoji> <agent> · 处理中...` 流式更新
   - `~/.weaverbird/runs/default/<runId>/events.ndjson` 在 append (`tail -f`)
   - `~/.weaverbird/runs/default/<runId>/heartbeat` 文件 mtime 每 ~5s 更新
3. `launchctl stop com.weaverbird.wb-bot` (若装了 plist) 或 `kill $(pgrep -f 'apps/wb-bot/src/main.ts')` — wb-bot 进程退出, wb-runner detached child 不退 (因为 `detached: true + child.unref()`)
4. 立即重启 `launchctl start com.weaverbird.wb-bot` (若装了 plist) 或 `npm run wb-bot:dev &` (background) / 另一个终端 `npm run wb-bot:dev` (foreground)
5. **≤ 30s 内**观察飞书原卡片应自动 patch 为:
   - **resumed 路径** (heartbeat L1 / L2 fresh): `⏳ 服务重启, 任务 [<runId 前 8 位>] 仍在运行中, 请稍候` + STOP 按钮保留
   - 若错误显示 `⚠️ 服务重启, 任务已中断, 请重发` (lost 路径) → 失败, 说明 detached child 没续上或 heartbeat 阈值不够
6. 等原任务跑完 (总时长 ≥ 30 min), 卡片应继续 streaming (events.ndjson tail 接通到 reattached stream)
7. 最终: ✅ done 卡片 + 时长 ≥ 30 min 显示

**验收标准**:
- 卡片在重启 ≤ 30s 内进入 resumed 路径 (非 lost)
- 任务跑完后卡片 done 状态显示, events.ndjson 完整 (无 gap, 续接前后 event seq 连续)
- wb-bot 重启前后 wb-runner 子进程 PID 不变 (`ps -ef | grep wb-runner` 同一进程)
- `~/.weaverbird/runs/default/<runId>/status` 最终为 `done`

**失败 fallback**:
- 若卡片错走 lost 路径 → 检查 `heartbeat` 文件 mtime 是否 stale > 240s, 若是说明任务真的卡了或 heartbeat 写入失败 (查 wb-runner output.log)
- 若 wb-runner 进程被 launchctl 一起 kill → 检查 wb-bot spawn 时的 `detached: true` + `child.unref()` 是否生效 (grep `packages/core/src/runner/wb-runner.ts`)
- 若 events.ndjson 续接后 event seq 不连续 → 检查 `event-replay.ts` continuationToken 是否取到最近 system/done event

**完成后**: 把实测数据 (任务时长 / 重启耗时 / 卡片切换耗时 / 是否走 resumed 路径) 写回 `plans/w2-batch-a-handoff-notes.md` Step 6.2 段, 把 D2.2 状态从 ⏳ 改 ✅.

---

## W3.1-polish · audit-pipe supervision manual smoke

> 目标: 验证 audit-pipe launchctl supervision 安装、重启、日志与 mirror/WAL 行为。

### P1 · install + bootstrap

```bash
cd /path/to/weaverbird
npm run build
scripts/install-audit-pipe.sh
launchctl list | grep audit-pipe
```

**验收**:
- ✅ `com.weaverbird.audit-pipe` 出现在 `launchctl list`
- ✅ 无 sudo / root 参与安装

### P2 · log + mirror smoke

```bash
tail -f ~/.weaverbird/logs/_audit-pipe/audit-pipe.stdout.log
ls -la ~/.weaverbird/audit-mirror.ndjson
ls -la ~/.weaverbird/wal/audit/
```

**验收**:
- ✅ stdout log 出现 `client ready`
- ✅ 触发任意 bot run 后 `audit-mirror.ndjson` 有新行
- ✅ Bitable 正常时 `wal/audit/` 最终为空

### P3 · upgrade / restart

```bash
cd /path/to/weaverbird
npm run build
launchctl kickstart -k gui/$UID/com.weaverbird.audit-pipe
launchctl list | grep audit-pipe
```

**验收**:
- ✅ kickstart 后服务仍在 `launchctl list`
- ✅ 日志继续追加, audit-pipe 可继续处理新 run

### P4 · uninstall / rollback

```bash
launchctl bootout gui/$UID ~/Library/LaunchAgents/com.weaverbird.audit-pipe.plist 2>/dev/null || true
rm -f ~/Library/LaunchAgents/com.weaverbird.audit-pipe.plist
```

**验收**:
- ✅ plist 已移除
- ✅ wb-bot / wb-bot-multi 行为不受影响

---

## W2.5 multi-bot + Captain manual acceptance (D10-D15)

> Anchor: `plans/w2.5-mainline.plan.md` v0.3 §7 D1/D2 done criteria · `plans/w2.5-mainline-close-note.md` §6 manual residual

CI 覆盖 vs manual gate 区分:

| Done | 类型 | 说明 |
|---|---|---|
| D1.1 mention filter 2 bot 同群 routing | CI ✅ | `event-handler-bot-id.test.ts` + `event-handler-mention-filter.test.ts` |
| **D1.2 kill -9 worker isolation** | **manual gate (D10)** | 见下方 D10 (agent-side supervisor lifecycle smoke 已覆盖 11/11 PASS, 真 launchctl 仍 manual) |
| D1.3 schema migration 002 | CI ✅ | `migration-002.test.ts` |
| D1.4 SQLite WAL 真并发 multi-worker | CI ✅ + agent smoke | `wal-pressure.test.ts` + `/tmp/smoke-w25-6-3-stress-8bot.mjs` 8-bot 0 BUSY |
| D1.5 bot identity 自检 graceful fail | CI ✅ | `bot-identity.test.ts` |
| **D1.6 真 install 2 bot + 30+ min 长跑** | **manual gate (D11)** | 见下方 D11 |
| D2.1 `/status` 跨 bot | CI ✅ | `captain-status.test.ts` |
| D2.2 `/stop-all` 跨 bot | CI ✅ | `captain-stop-all.test.ts` |
| D2.5 `/list-bots` 跨 bot | CI ✅ | `captain-list-bots.test.ts` |
| D2.6 `/health` 4 项跨 bot | CI ✅ | `captain-health.test.ts` |
| D2.8 botId regex | CI ✅ | `bot-id-validator.test.ts` |
| **D2.x Captain 四大件 visual** | **manual gate (D12)** | 见下方 D12 |
| **W2 退化版 byte-exact 兼容** | **manual gate (D13)** | 见下方 D13 |
| **3 bot 真并发 launchctl boot** | **manual gate (D14)** | 见下方 D14 (agent-side 已 8-bot fake-creds stress 6/6 PASS) |
| 桌面 + 手机端 visual cross-check | **manual gate (D15)** | 见下方 D15 |

### W2.5-D10 · kill -9 worker isolation visual (manual gate)

**前提**:
- 至少 2 bot 真 install 通过 `scripts/com.weaverbird.wb-bot-multi.plist.template` 路径 (W2.5-J / W3+ 部署文档 G0 起草前可手动 render plist)
- `~/.weaverbird/configs/.env.default` + `~/.weaverbird/configs/.env.<other>` 真 creds
- `launchctl bootstrap gui/$UID/com.weaverbird.wb-bot-multi.plist` 已起动 orchestrator
- 1 个 worker 跑了 ≥1 min 长任务 (用真飞书发消息触发)

**步骤**:
1. `launchctl list | grep weaverbird` 确认 orchestrator 在跑
2. `pgrep -P $(pgrep -f wb-bot-multi) -f wb-bot` 看 N workers
3. `kill -9 $(pgrep -P $ORCH_PID -f 'bot codex')` (kill codex worker)
4. **≤ 15s 内** 期望:
   - default + claude worker 仍响应 (飞书消息能收到)
   - launchd 自动重启 codex worker (`pgrep -P $ORCH_PID -f 'bot codex'` 再次看到新 PID)
   - default 卡片不退化 / claude 卡片不退化

**验收**:
- ✅ kill -9 后其它 worker 不退
- ✅ launchd / supervisor 在 30s 内 restart codex
- ✅ codex 重启后状态恢复 (用 `/status` 跨 bot 卡片确认)

**agent-side 已覆盖部分**: `/tmp/smoke-w25-6-1-supervisor.mjs` 11/11 PASS (supervisor lifecycle + SIGKILL + graceful shutdown, fake creds path). 真 launchctl 仍 manual.

### W2.5-D11 · 真 install 2 bot 30+ min 长跑 (5 testcase)

**前提**: 同 D10 + 真飞书 creds 配 2 bot (`~/.weaverbird/configs/.env.default` + `~/.weaverbird/configs/.env.claude`)

#### D11.1 · 双 bot worker PID 独立

**步骤**:
```bash
ORCH_PID=$(launchctl list | awk '$3=="com.weaverbird.wb-bot-multi"{print $1}')
echo "Orchestrator PID: $ORCH_PID"
pgrep -P $ORCH_PID -af 'main.js --bot' | sort
```

**期望** (2 行, PID 不同):
```
<pid_default> node ...dist/apps/wb-bot/src/main.js --bot default
<pid_claude>  node ...dist/apps/wb-bot/src/main.js --bot claude
```

**验收**: 2 个不同 PID, 父进程都是 `$ORCH_PID`. **fail hint**: 若只看到 1 个, 检查 `~/.weaverbird/logs/_orchestrator/wb-bot-multi.stderr.log` 是否有 `bot identity fetch failed`.

#### D11.2 · 双 bot events.ndjson 不交叉

**步骤**:
```bash
# 飞书 DM `@default-bot 跑 npm test 看结果`
# 飞书 DM `@claude-bot 给我 README.md 摘要`
# 各等卡片出现, 然后:
DEFAULT_RUN=$(ls -t ~/.weaverbird/runs/default | head -1)
CLAUDE_RUN=$(ls -t ~/.weaverbird/runs/claude | head -1)
wc -l ~/.weaverbird/runs/default/$DEFAULT_RUN/events.ndjson
wc -l ~/.weaverbird/runs/claude/$CLAUDE_RUN/events.ndjson
# cross-reference grep 应各 0:
grep -c "$CLAUDE_RUN" ~/.weaverbird/runs/default/$DEFAULT_RUN/events.ndjson
grep -c "$DEFAULT_RUN" ~/.weaverbird/runs/claude/$CLAUDE_RUN/events.ndjson
```

**验收**: 2 个 events.ndjson 各 ≥ 5 行, cross-reference grep 各 0 次.

#### D11.3 · heartbeat 各自每 ~5s 更新

**步骤**:
```bash
for i in 1 2 3 4; do
  echo "--- $i ---"
  stat -f '%Sm' ~/.weaverbird/runs/default/heartbeat 2>/dev/null
  stat -f '%Sm' ~/.weaverbird/runs/claude/heartbeat 2>/dev/null
  sleep 6
done
```

**期望**: 各 bot heartbeat mtime 每次 ~5-6s 内变. 4 轮里 mtime 至少变 3 次/bot.

**验收**: 双 bot heartbeat 都 fresh. **fail hint**: 若某 bot mtime 不变, `pgrep -P $ORCH_PID -f $botId` check 该 worker 是否还活.

#### D11.4 · launchctl 重启续接 resumed 路径

**步骤** (中途, ≥ 5 min 后, 任务仍在跑时):
```bash
launchctl bootout gui/$UID/com.weaverbird.wb-bot-multi.plist
sleep 2
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.weaverbird.wb-bot-multi.plist
# 等 ≤ 30s, 观察飞书 2 个卡片
```

**期望** (2 个卡片各自 header 内文字):
```
⏳ 服务重启, 任务 [<runId 前 8 位>] 仍在运行中, 请稍候
```
(不应是 `⚠️ 服务重启, 任务已中断, 请重发`)

**验收**: 2 个原卡片 ≤ 30s 内进入 resumed 路径. **fail hint**: 若走 lost 路径, 检查 `~/.weaverbird/runs/<botId>/<runId>/heartbeat` 是否 stale > 240s (W2 D2.7 默认阈值).

#### D11.5 · 2 任务最终 done · status=done · events 完整

**步骤** (等 30+ min 直到 2 任务都 done):
```bash
cat ~/.weaverbird/runs/default/$DEFAULT_RUN/status   # 应输出 done
cat ~/.weaverbird/runs/claude/$CLAUDE_RUN/status     # 应输出 done
tail -3 ~/.weaverbird/runs/default/$DEFAULT_RUN/events.ndjson | jq -r '.type'
tail -3 ~/.weaverbird/runs/claude/$CLAUDE_RUN/events.ndjson | jq -r '.type'
```

**期望**: 末尾 `type` 含 `agent.done` / `system.done` 类. 2 卡片都显示 done state (绿色对勾 + 时长 ≥ 30 min).

**验收**: 2 任务 status=done, events.ndjson 末尾有 done event, 卡片 done state.

### W2.5-D12 · Captain 四大件 visual (4 testcase)

**前提**: 同 D11.

#### D12.1 · `/list-bots` 卡片字段

**步骤**: 飞书 `@default-bot /list-bots`

**期望卡片** (按 `apps/wb-bot/src/captain/list-bots.ts` 实际渲染):
```
📋 已配置 bot
─────────────────────────────────────
default (Captain) · agents=[claude-code, codex] · 在线 ✓
claude            · agents=[claude-code]        · 在线 ✓
─────────────────────────────────────
```

**验收**:
- ✅ 第 1 行表头 `📋 已配置 bot` (无前导空格)
- ✅ default 在第 1 位且后缀 ` (Captain)`
- ✅ 其它 bot 按 `botId.localeCompare()` 字母序
- ✅ 各 bot 行格式 `<botId padded> · agents=[<list>] · <在线/离线>` (` · ` 分隔, 不是 `: `)
- ✅ 全卡片裹 ``` (monospace)
- ✅ `─` 分隔线长度 37 字符

**fail hint**: 若 default 不带 (Captain), 检查 `isCaptainEnabled()` 入参 (`WB_MODE` `BOT_ID` `WB_DISABLE_CAPTAIN`).

#### D12.2 · `/status` 卡片 inflight + 空闲

**前置**: D11.1-D11.3 通过, default 跑中, claude 空闲

**步骤**: 飞书 `@default-bot /status`

**期望卡片** (`apps/wb-bot/src/captain/captain-status.ts` 渲染):
```
📊 Weaverbird Status (YYYY-MM-DD HH:MM:SS)
─────────────────────────────────────
🤖 default (Captain)    : 跑中 Xmin · run <runId 前 12 位>
🤖 claude               : 空闲 · 最后心跳 Xs 前
─────────────────────────────────────
```

**验收**:
- ✅ header 含 ISO 时间 (` ` 分隔 date/time, 截 19 字符)
- ✅ `🤖 ` 前缀 + `padEnd(20)` (botId + ` (Captain)` 拼一起算长度)
- ✅ 跑中行末尾 `run <12-char hex>` (`runId.slice(0, 12)`)
- ✅ 空闲行末尾 `最后心跳 <formatted age> 前`
- ✅ formatAge 规则: `<60s → Ns`, `<3600s → Nmin`, `>=3600s → Nh`

#### D12.3 · `/health` 4 项 cross-bot check

**步骤**: 飞书 `@default-bot /health`

**期望卡片** (`apps/wb-bot/src/commands/health.ts` Captain mode):
```
🩺 Health Check (Captain mode)
─────────────────────────────────────
✅ WSClient: 连接正常, 最近事件 Xs 前
✅ SQLite: 可写 · quick_check ok
✅ 磁盘: runs/ 可用 X.XGB
✅ Worker 心跳: 全部 N 个 bot 心跳新鲜 (< 30s)
─────────────────────────────────────
整体: ✅ 健康
```

**验收**:
- ✅ header 含 ` (Captain mode)` 后缀
- ✅ 4 项 check (3 项 single-bot + 第 4 项 Worker 心跳)
- ✅ 第 4 项 emoji 按状态: 全 fresh→✅, 部分 stale→⚠️, 全 stale→❌
- ✅ 30s threshold 硬编码 (`CROSS_BOT_HB_STALE_MS = 30_000`)
- ✅ 末尾整体行带 emoji

**fail variant** (制造 stale 验证): `pkill -STOP <claude_worker_pid>` 暂停一个 worker > 30s, 再 `/health` 期望第 4 项 `⚠️ Worker 心跳: 1/2 bot stale: claude (Xs 前)`, 再 `pkill -CONT <pid>` 恢复.

#### D12.4 · `/stop-all` 卡片 + stop.signal 文件 + ≤500ms graceful

**前置**: 触发一个 active run (`@default-bot 慢任务 sleep 60`), 等卡片显示处理中

**步骤**:
```bash
# 飞书 @default-bot /stop-all  (并同时记录时间)
date +%s%3N > /tmp/stopall.t0
# 触发命令
date +%s%3N > /tmp/stopall.t1
ls -l ~/.weaverbird/runs/default/<runId>/stop.signal
cat ~/.weaverbird/runs/default/<runId>/stop.signal
# 等 ≤500ms 后:
cat ~/.weaverbird/runs/default/<runId>/status
```

**期望卡片**:
```
✅ 已向 1 个 active run 发送 stop 信号
─────────────────────────────────────
- default / <runId 前 12 位> : signal sent
─────────────────────────────────────
signal 仅触发 graceful stop, 实际收敛是异步:
各 bot 的 wb-runner 读到 stop.signal 后会跑完手头的 tool,
完成后各自卡片更新为 "stopped". 用 /status 跟踪收敛进度.
```

**期望文件**:
- `stop.signal` 内容: 13-digit Unix ms timestamp (e.g. `1717293945123`)
- ≤500ms (stop.signal poll interval) 后 `status` 文件可能仍为 `running` (如果当前在 tool 中); 等 tool 完成才会切 `stopped`
- 任务卡片随 status 文件变化更新

**验收**:
- ✅ `stop.signal` 文件存在, 内容是 `String(Date.now())`, 13 digits
- ✅ 当前不在 tool 中: 任务在 ≤500ms (poll interval) 内 status=stopped
- ✅ 当前在 tool 中: 任务在该 tool 完成后 status=stopped (异步, 不保证 500ms)
- ✅ active run 卡片最终切到 stopped state

**variant** (active run = 0): 飞书 `/stop-all` 期望返回 `✅ 当前没有 active run` (单行, **不裹 ```**, 区别于有 run 路径).

### W2.5-D13 · W2 退化版 byte-exact 兼容 (5 testcase)

#### D13.1 · 切回 single-bot 模式

**步骤**:
```bash
launchctl bootout gui/$UID/com.weaverbird.wb-bot-multi.plist
cd ~/aiops/code/weaverbird
unset WB_MODE
unset BOT_ID
WB_DISABLE_CAPTAIN=true npm run wb-bot:dev &
sleep 3
pgrep -fl 'apps/wb-bot/src/main.ts'
```

**期望**: 1 个 wb-bot process, log 含 `boot signal: ready`, 无 `Captain enabled` log.

**验收**: `pgrep -c -f 'wb-bot' == 1`, captain gate 未启用.

#### D13.2 · `/list-bots` W2 byte-exact

**步骤**: 飞书 `@default-bot /list-bots`

**期望卡片** (W2 single-bot mode, 走 `router.ts !captainEnabled` 分支):
```
default (single-bot mode)
```
(单行 plain text, **不裹 ```**, **不出现 (Captain)**)

**验收**: 输出 byte-exact 跟 W2 close note 时一致.

#### D13.3 · `/status` W2 byte-exact

**期望**: 走 W2 `ctx.activeSessions()` 路径. 输出原 W2 卡片 (无 Captain mode 后缀, 无跨 bot 行).

**验收**: 跟 W2 D9 visual 时输出 byte-exact 一致.

#### D13.4 · `/health` W2 byte-exact (3 项 + single-bot suffix)

**期望卡片**:
```
🩺 Health Check (single-bot mode)
─────────────────────────────────────
✅ WSClient: 连接正常, 最近事件 Xs 前
✅ SQLite: 可写 · quick_check ok
✅ 磁盘: runs/ 可用 X.XGB
─────────────────────────────────────
整体: ✅ 健康
(single-bot 模式: 跨 bot 心跳检查跳过)
```

**验收**:
- ✅ header 后缀 ` (single-bot mode)` (不是 ` (Captain mode)`)
- ✅ 只 3 项 check (无第 4 项 Worker 心跳)
- ✅ 末尾多一行 `(single-bot 模式: 跨 bot 心跳检查跳过)`

#### D13.5 · `/stop-all` W2 byte-exact

**前置**: 触发一个 active run

**步骤**: 飞书 `@default-bot /stop-all`

**期望卡片** (走 `router.ts !captainEnabled` 分支, W2 ctx.stopAllSessions() 路径):
```
✅ 已向 N 个 active run 发送 stop 信号
─────────────────────────────────────
- <agentId> / <runId 前 12 位> : signal sent
```
(无 ``` 包裹, 无尾部 graceful tip)

**验收**: 跟 W2 close note 一致. **关键差异 vs D12.4**: 字段是 `<agentId>` 不是 `<botId>`, 无 ``` 包裹, 无尾部 graceful tip.

### W2.5-D14 · 3 bot 真并发 launchctl boot (4 testcase)

**前提**: 配 3 bot (`.env.default` + `.env.claude` + `.env.codex`)

#### D14.1 · cold start 0 SQLITE_BUSY (日志 grep)

**步骤**:
```bash
launchctl bootout gui/$UID/com.weaverbird.wb-bot-multi.plist 2>/dev/null
rm -f ~/.weaverbird/logs/*/wb-bot.log
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.weaverbird.wb-bot-multi.plist
sleep 30
for botId in default claude codex; do
  echo "--- $botId ---"
  grep -c 'SQLITE_BUSY\|SQLITE_LOCKED\|database is locked' ~/.weaverbird/logs/$botId/wb-bot.log 2>/dev/null || echo 0
done
```

**期望**: 3 个 bot 各 grep count = 0.

**验收**: 0 SQLITE_BUSY / 0 SQLITE_LOCKED. **fail hint**: G.D.1 `ensureWalMode` 没生效 — 检查 `dist/apps/wb-bot/src/binding/store.js` grep `ensureWalMode`.

#### D14.2 · ensureWalMode retry-loop 真路径痕迹

**步骤**:
```bash
for botId in default claude codex; do
  grep -E 'journal_mode|migration|ensureWalMode|boot signal' ~/.weaverbird/logs/$botId/wb-bot.log | head -5
done
```

**期望**: 3 bot 各有 boot signal `ready` log. 不应出现 `ensureWalMode failed` / 反复 retry warning.

**验收**: 3 bot 都 ready.

#### D14.3 · 3 worker 全 ready signal

**步骤**:
```bash
ORCH_PID=$(launchctl list | awk '$3=="com.weaverbird.wb-bot-multi"{print $1}')
pgrep -P $ORCH_PID -c -f 'main.js --bot'  # 期望 3
ps -o pid,etime,command -p $(pgrep -P $ORCH_PID -f 'main.js --bot')
```

**期望**: 3 worker 全在跑, etime 相近 (各 ≥ 30s).

**验收**: 3 个独立 worker process, etime 相近.

#### D14.4 · `/list-bots` 显 3 bot online

**步骤**: 飞书 `@default-bot /list-bots`

**期望卡片**:
```
📋 已配置 bot
─────────────────────────────────────
default (Captain) · agents=[...] · 在线 ✓
claude            · agents=[...] · 在线 ✓
codex             · agents=[...] · 在线 ✓
─────────────────────────────────────
```

**验收**: 3 行全 `在线 ✓`. **fail hint**: 若有 `离线 ✗`, 检查 `~/.weaverbird/runs/<botId>/heartbeat` 是否存在 + mtime fresh.

**agent-side 已覆盖**: `/tmp/smoke-w25-6-3-stress-8bot.mjs` 8 bot fake-creds 真并发 0 BUSY (6/6 PASS).

### W2.5-D15 · 桌面 + 手机端 visual cross-check (5 testcase)

**前提**: D12 完成 (Captain 四大件桌面已 visual).

#### D15.1 · 手机端 `/list-bots` 不溢出

**步骤**: 在飞书 **手机** 客户端打开同样的群/DM, 发 `/list-bots`

**验收**:
- ✅ 卡片完整显示 (不被截断)
- ✅ ` · ` 分隔符不换行 (在窄屏单行)
- ✅ `─` 分隔线渲染 (不破碎)
- ✅ `📋` emoji 不丢

**fail hint**: 若 `─` 渲染异常或换行错位, padEnd width 可能跟手机端 monospace 字体不匹配 — 记录 client 版本 + 截图, 起 visual fix follow-up batch.

#### D15.2 · 手机端 `/status` 不溢出

**期望**: `🤖 ` + `padEnd(20)` botId 在手机端 fixed-width 字体正确对齐.

**验收**:
- ✅ `🤖` 不变 character-width
- ✅ `:` 各行垂直对齐
- ✅ 时间戳 header 完整 (`YYYY-MM-DD HH:MM:SS`)

#### D15.3 · 手机端 `/health` 不溢出

**验收**:
- ✅ 4 项 check 状态 emoji (`✅` `⚠️` `❌`) 全部渲染
- ✅ 整体行 + emoji 在底部 footer
- ✅ ` (Captain mode)` 后缀完整

#### D15.4 · emoji 渲染 cross-check

**步骤**: 桌面 + 手机各发一次, 对比 4 命令 emoji:
- `📋` `📊` `🩺` `🤖` `✅` `⚠️` `❌` `✗` `✓` `─` `·`

**验收**: 桌面 / 手机两端 emoji 渲染一致, 无 mojibake / 占位符.

#### D15.5 · monospace 块 (```) fixed-width

**步骤**: 手机端发 `/list-bots`, 比对 botId 列垂直对齐:
- `default (Captain)` 后的 ` · agents=[...]` 起点位置
- `claude           ` 后的 ` · agents=[...]` 起点位置

**验收**: 两行的 ` · ` 起点在同一垂直线 (说明 padEnd width 在手机端 fixed-width 字体生效).

**fail hint**: 若垂直错位, 飞书手机端 monospace 字体可能用 proportional metric — visual fix batch 起需要换组件 (或弃 padEnd 改 plain text).

### W2.5 D11-D15 testcase summary

| 段 | testcase 数 | 时间预算 | blocker hint |
|---|---|---|---|
| D11 | 5 | 35+ min (含 30 min 长跑) | D11.4 lost 路径走错 → 检查 heartbeat 阈值 |
| D12 | 4 | 10 min | D12.4 stop.signal 文件未生成 → 检查 H.C captain-stop-all.ts 实现 |
| D13 | 5 | 10 min | D13.x byte-exact 不匹配 → 检查 router.ts `!captainEnabled` 分支 |
| D14 | 4 | 5 min | D14.1 SQLITE_BUSY 出现 → 检查 dist/ build 是否含 G.D.1 fix |
| D15 | 5 | 5 min | 手机端溢出 → visual fix follow-up batch |
| **合计** | **23** | **~65 min** | — |

完成全 23 testcase 后即可走 `plans/w2.5-mainline-close-note.md` 状态 `PRE-FINAL → FINAL` + final tag 仪式.

---

## W2.5 close manual residual 完成 check

完成 D10-D15 全部 manual gate 后:
1. 在 `plans/w2.5-mainline-close-note.md` §6 各项标 ✅ + 写实测数据
2. 把 §6 状态从 PRE-FINAL 改 FINAL
3. final commit + `git tag w2.5-mainline-close` + `git push --tags`

**agent-side 已覆盖部分** (自动化无需 manual, 列出避免主设计师重复):
- D10 supervisor lifecycle (`/tmp/smoke-w25-6-1-supervisor.mjs` 11/11 PASS)
- D14 真并发 boot (`/tmp/smoke-w25-6-3-stress-8bot.mjs` 8 bot fake-creds 0 BUSY)
- D1.4 SQLite WAL multi-worker (G.D.1 已 lock)

---

## 飞书交互对标 manual acceptance (D16-D29)

> 分支 `feat/feishu-ux-parity`。`npm test` 覆盖了解析、合并、渲染、CardKit 降级链、按钮回调、保活计数等逻辑；下面这些依赖真实飞书客户端渲染或真实平台行为，只能手工验。前提：应用已按 `apps/wb-bot/README.md` 的可选权限表开通对应权限 / 事件。

| # | 场景 | 步骤 | 预期 |
|---|---|---|---|
| D16 | 图片输入 | DM 发一张截图 + 「这是什么报错」 | 卡片无「附件未下载」告警；codex 能描述图片内容（claude 会用 Read 打开本地路径） |
| D17 | 文件 / post / 合并转发 | 分别发一个 `.log` 文件、一条带格式的富文本、一组合并转发 | agent 输入里能看到文件本地路径、富文本正文、合并转发的各条内容 |
| D18 | 引用回复 | 长按 bot 之前的一条回复 →「回复」并提问 | agent 输入以 `> 引用消息:` 开头；在话题里普通发言**不**出现引用前缀 |
| D19 | Typing 回执 | 发一条需要跑 10s+ 的请求 | 原消息上立刻出现「敲键盘」表情，run 结束后消失 |
| D20 | 连发合并与排队 | 0.5s 内连发两条；再在运行中追发一条 | 前两条合并成一次 run；追发的那条收到「已排队」提示卡，运行卡显示 `📥 已排队 1 条`，结束后自动接着跑；撤回排队中的那条则提示卡变「消息已撤回」 |
| D21 | 打字机效果 | PC 与手机各看一次长回答 | 正文逐字出现，不整块闪烁；header 不随耗时变化；结束后按钮变成「继续 / 重试 / 新会话」 |
| D22 | 30+ 工具折叠 | 让 agent 读 30 个文件 | 进行中只显示「已调用 N 个工具」+ 最近 3 个；结束后工具收在默认折叠的面板里，失败的工具面板红框 |
| D23 | 长输出续卡 | 让 agent 输出 60KB+（含长代码块） | 主卡提示「共 N 张卡」，后续「续 k/N」卡顺序到达，代码块在每张卡里都闭合 |
| D24 | 流式超 10 分钟 | 跑一个 12 分钟以上、持续有输出的任务 | 10 分钟后仍在更新（日志有 `cardkit streaming closed, re-enabling`），结束卡正常 |
| D25 | 重启恢复 CardKit 卡 | 运行中 kill 进程再启动 | 旧运行卡被改成重启提示（不报 sequence 错误） |
| D26 | 回退开关 | `WB_CARD_STREAMING=0` 启动后跑一次 | 卡片按 800ms 整卡刷新，功能不缺 |
| D27 | 话题群 | 在话题群新建话题 @bot；在普通群话题里 @bot | 回复都在话题内，不出现在群主时间线 |
| D28 | 产物回传 | 让 agent 在 cwd 生成 `chart.png` 和 `report.md` | 结束卡列出两个文件；非发起人点「发送」被拒；发起人点后图片以图片消息、md 以文件消息出现在话题里 |
| D29 | 云文档评论 | 在 docx 选中一段文字评论「@bot 这段对吗」；再对整篇评论 @bot | 评论上出现 Typing 表情，答案以纯文本回在线程里（无 `**` / `#`）；整篇评论另起一条评论回复；bot 自己的回复不会再触发 |

**保活**（可选）：笔记本合盖 5 分钟再打开，`/health` 的 WSClient 一行在 1 分钟内回到 `connected`；日志可见 `keepalive detected wake-up`，若 SDK 卡住则有 `feishu ws stuck, rebuilding client`。
