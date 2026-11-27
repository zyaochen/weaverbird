# TOPIC-W2-A · Process Supervision 边界与契约

> **版本**: v0.2 (Phase 4 C1, 2026-05-30 主设计师 sync from plan v1 + plan v1.5)
> **状态**: spec (Phase 4 sync)
> **创建**: 2026-05-29 (v0.1-draft); v0.1 → v0.2 重写 8 段 (Phase 2 synthesis §2.1 process supervision 重写区合并 5 项 H + C.H-3 二态卡片 + A.H-5 migration runner + plan v1.5 §4.7/§4.8 cross-link)
> **承接**: [docs/product-strategy.md](../product-strategy.md) §1.1, W2 主线 Block A; cross-link `plans/w2-mainline.plan.md` §2 Block A + §4.7 (CSP discipline 5 层) + §4.8 (in-memory state 边界) + §10 Risk Register
> **性质**: 设计 spec, 描述 weaverbird supervision 承诺与边界、runs/ 目录契约、文件 IPC 协议; 不描述具体 TS 实现

---

## 1. 本文档回答什么 / 不回答什么

### 回答

- weaverbird process supervision 的明确承诺范围 (wb-bot 重启可恢复)
- 不在承诺范围的失败模式 (agent CLI 自身 crash / 中间态丢失 / launchd session destroy)
- `runs/<botId>/<runId>/` 目录契约 (W2 阶段 `<botId>` 恒为 internal constant `'default'`)
- detached subprocess + 文件 IPC 协议 (envFilter / stop.signal polling 500ms / 双层 heartbeat)
- inflight_card 重绑机制 (二态卡片: 续接 vs 丢失) + migration runner 显式化
- events.ndjson schema 容错协议 (未知字段忽略, schemaVersion 跨版本兼容)
- W2 与 Claude Code dynamic workflow 长跑的接口边界

### 不回答

- agent 内部 session 状态如何持久化 (是 agent CLI 自己的事)
- multi-bot 形态下跨 bot 信号交互细节 → `multi-bot-routing.md` §6
- 卡片渲染 / visibility 细节 → 由 W2 Block B 单独承接

---

## 2. 核心承诺与边界声明

### 2.1 weaverbird 承诺 (✓)

```
✓ wb-bot 进程重启后, 仍存活的 agent CLI 子进程不被杀
✓ wb-bot 进程重启后, 能识别哪些 run 是孤立的 (detached, parent died)
✓ wb-bot 进程重启后, 能恢复 inflight_card → "服务重启" 提示卡片
✓ wb-bot 进程重启后, 能基于 runs/<botId>/<runId>/output.log 续读 agent 后续输出
✓ wb-bot 进程重启后, 能基于 continuationToken 启动新一轮多轮对话 (W1 已支持)
✓ stop.signal 文件 IPC 跨进程传播 (Captain /stop-all 跨 worker)
✓ wb-bot SIGTERM 时 graceful stop 所有 active sessions (W1 Batch-A 已实现)
```

### 2.2 weaverbird 不承诺 (✗)

```
✗ agent CLI 自身 crash 时其内部 session 状态可恢复
   → 这是 agent CLI 自己的事 (claude-code 的 conversation history 由它自管)
   
✗ Claude Code dynamic workflow 内部 1000 subagent 的并发状态可恢复
   → workflow runtime 是 claude-code 内部, weaverbird 只见 event 流
   
✗ wb-bot crash + agent CLI 同时 crash 时, mid-flight tool 中间产物不丢
   → 文件系统行为决定 (e.g. 写文件到一半 crash, weaverbird 不重做)
   
✗ macOS launchd session destroy 类事件时 detached child 仍存活 (A.H-1 边界分类)
   → 具体行为分类 (W2 plan v1 §10 Risk Register A.H-1):
     - launchctl stop / launchctl unload wb-bot 服务: 仅杀 wb-bot, detached child 活, run 续接 ✓
     - macOS sleep + wake: child 状态依赖 OS power management, 多数情况续跑 ✓
     - macOS user logout / shutdown / lock screen (long-running session destroyed): detached child 也死, run 不续接 ✗
     - 物理断电: child 死, run 不续接 ✗
   → mitigation: README D8.1 边界声明 (W2 plan v1 D2.6); W3+ 重评估 launchctl bsexec / tmux 路径 (W2 plan v1 §3 W3+ + §10)

✗ 跨多 wb-bot 实例 (multi-bot) 时, 某 bot 的 inflight run 可被另一 bot 接管
   → 各 bot 自管自己 runs/<botId>/, 不互相接管
   → cross-link plan v1.5 §4.9: 飞书端不可区分 device, host 路由走 agent registry hint (W3+ 候选)
```

---

## 3. `runs/<botId>/<runId>/` 目录契约

### 3.0 Source of truth (v0.2 新增, plan v1.5 §4.7 L2 cross-link)

**`runs/<botId>/<runId>/events.ndjson` 是 source of truth**, status / inflight_card row / heartbeat / output.log 都是 derived view:

- **重建路径**: wb-bot 重启 / SQLite binding 损坏 / status 文件丢失时, 优先以 events.ndjson 重建 (replay), 其它文件作 cross-check 用
- **append-only 不变性**: events.ndjson 永不 mutate, schema 演进通过 schemaVersion 字段 (§3.4 容错协议) — 这是 plan v1.5 §4.7 L2 (CSP discipline) 的物理实现
- **W2 阶段 `<botId>` 恒为 internal constant `'default'`** (W2.5 才真启用多 bot 子目录隔离, plan v1 D5.5 + D8.4)
- **单 owner 约定**: 一个 run 的 events.ndjson 在其生命周期内仅由该 run 的 wb-runner 写入 (per-run single-writer, plan v1.5 §4.8 原则 2)
- **events.ndjson schema 预留 `host` 字段位置** (plan v1.5 §4.9; W2 阶段 host 恒 `'local'`, W3+ agent fleet 演进无 schema break)

### 3.1 路径约定

```
${WB_DATA_DIR}/runs/<botId>/<runId>/
  spec.json       ← 创建时写入, 不变 (run 元数据)
  status          ← 当前状态 (running / done / error / stopped)
  pid             ← detached child PID (写入后不变)
  output.log      ← agent CLI stdout (append-only)
  output.err      ← agent CLI stderr (append-only, 仅 error 时写)
  events.ndjson   ← parsed AgentEvent stream (append-only)
  stop.signal     ← 可选, 存在则表示请求 graceful stop
  heartbeat       ← worker 最后写入时间戳 (10s 一次)
```

### 3.2 status 文件 atomic 写入

```
status 文件取值 (4 状态明确语义, 不引入 pending — W1 形态消息进入即 running):
  "running"  : 进程在跑 (heartbeat 实时更新)
  "done"     : 正常完成 (agent emit `done` event, exit code = 0)
  "error"    : 异常退出 (exit code ≠ 0, agent 自身 crash, supervisor 探测到)
  "stopped"  : 用户主动 abort (via /stop / /stop-all / stop.signal)

→ 区分 stopped vs error 的工程意义:
  - stopped: 用户预期内, 卡片显示 "已停止", 不报警
  - error: 异常, 卡片显示 "执行失败", SRE 视为需关注的事件 (告警/复盘场景重要)

启发: agentara `tasks` 表用 5 状态 (pending/running/completed/failed/cancelled).
weaverbird 不需要 pending (无队列), 但保留 stopped 区分用户意图.

写入方式 (原子, 防并发读到中间态):
  1. write status.tmp 
  2. rename status.tmp → status (atomic on POSIX)
  
读取方式 (无 lock 直接读, append-only / atomic write 保证一致性)
```

### 3.3 spec.json schema (v0.1)

```jsonc
{
  "runId": "r-2026052910-abc123",
  "botId": "claude",                    // multi-bot 形态下区分
  "agentId": "claude-code",
  "model": "claude-sonnet-4",
  "cwd": "/Users/me/code/foo",
  "userOpenId": "ou_xxx",
  "threadId": "oc_yyy",
  "sourceMessageId": "om_zzz",
  "replyMessageId": "om_www",
  "continuationToken": null,            // 启动时若有, 写入
  "startedAt": "2026-05-29T10:00:00Z",
  "consentLevel": "normal",
  "schemaVersion": 1
}
```

### 3.4 events.ndjson 格式 + schema 容错协议 (A.H-4, plan v1 F7)

**格式**:

```
每行 1 个 JSON, 对应 AgentEvent 一个事件 (parsed)
按时间顺序 append-only
不裁剪, 保留全部历史 (用于 wb-bot 重启时重建 StreamState)
每个 event 必含 `schemaVersion` 字段 (number)
```

**重放容错协议** (wb-bot recoverInflightRuns / replay 时, plan v1 F7):

- **未知字段忽略**: event JSON 含当前代码不识别的字段 → 不 throw, 跳过 (向前兼容)
- **schemaVersion 跨版本兼容**:
  - `event.schemaVersion <= currentSupportedVersion`: 正常 parse
  - `event.schemaVersion > currentSupportedVersion`: log warn + 跳过此 run + 标 status=error (不 crash wb-bot, 让用户看到 "schema 不兼容, 请升级 wb-bot")
- **JSON 格式损坏**: 单行 parse 失败 → log warn + 跳过本行 (不 throw, 不中断 replay)
- **W1 老格式向后兼容**: W1 events.ndjson 老格式无 `subagentId` / `tokenRotation` / `host` 字段, 重放必容错 (B.M-7)

**schema 演进路径** (subagentId / tokenRotation / host 都通过此协议平滑演进, schema 不 breaking change):

- v0.3 (W2): 加 `subagentId` (frozen exception, plan v1 §4.5) + `tool_progress` event + `done.continuationToken` 一致性 (plan v1 F6) + `host` 字段位置预留
- v0.4 (W3+ 候选): `workflowId` (B.H-2 决议推 W3+, 触发条件 = 真实多 workflow 区分) + `host` 真启用 (plan v1.5 §4.9)

cross-link: plan v1 F7 (events.ndjson schema 容错), plan v1.5 §4.7 L2 (events.ndjson source of truth), plan v1 A.H-4 / B.M-7

### 3.5 heartbeat 双层探活 (A.H-3, 决断 8 deferred calibration)

**双层 heartbeat 设计** (单层 30s 阈值在 macOS App Nap / 重负载下误判 alive 为 orphan, Phase 2 review A.H-3):

**L1 · wb-runner 进程 heartbeat** (探 supervisor 进程本身):

```
wb-runner 主循环每 5s 写入 runs/<botId>/<runId>/heartbeat 文件:
  echo "$(date -u +%s)" > heartbeat.tmp && mv heartbeat.tmp heartbeat   (atomic via tmp+rename)
```

**L2 · agent CLI emit heartbeat event** (探 agent CLI 进程):

```
agent CLI 通过 stdout 协议在长跑期间 emit `heartbeat` event 写到 events.ndjson:
  {"kind":"heartbeat","ts":<epoch_ms>, "schemaVersion":1}
emit 频率: 默认 ClaudeCodeAgent emit 内置 (与 tool_progress 共用通道, 见 agent-adapter.md §11.5 #24)
```

**判定 stale 流程** (wb-bot recoverInflightRuns, §4.4 attach decision):

```
L1 stale (heartbeat 文件最新写入 ts > stale 阈值)
  AND
L2 stale (events.ndjson 最近 heartbeat / tool_progress / 任意 event 时间 > stale 阈值)
  → 标 orphan, run 状态改 error, 卡片显示 "服务重启, 任务已中断, 请重发" (§4.4 二态)

L1 fresh (wb-runner 还活)
  OR
L2 fresh (agent CLI 还在 emit)
  → run 续接, 卡片显示 "服务重启, 任务 [runId] 仍在运行中, 请稍候" (§4.4 二态)
```

**默认阈值: deferred calibration** (决断 8, plan v1 A1.5):

- 静态默认值 **不在本 spec / plan v1 锁定**
- 实施期由 plan v1 A1.5 集成测试 3 场景实测后选定:
  - 场景 1: macOS App Nap (`caffeinate -i` 抑制 vs 正常 sleep)
  - 场景 2: 重负载 child.send 阻塞 (大量 tool_progress 同时 emit)
  - 场景 3: dynamic workflow 30 min 长跑 (中间 1-2 min 沉默期)
- 候选三档: **60s / 120s / 240s**, 实测后选定写入 W2 close note (plan v1 D2.7)
- env `WB_HEARTBEAT_STALE_MS` 可调 (调试 + 凌晨告警场景用户自调)

**用途**:

- 检测 worker 是否健康 (双层互为印证)
- 跨进程 Captain 探测 worker 在线 (W2.5)
- wb-bot 重启时, 看 L1 + L2 heartbeat 双层判定 (避免 App Nap 单层误判, A.H-3 5 项 H 合并核心)

cross-link: plan v1 A1.5 (heartbeat 校准 SOP) / D2.7 (close note 写入), 决断 8 (synthesis), plan v1.5 §4.7 L2 (events.ndjson 是 L2 heartbeat 物理载体)

---

## 4. detached subprocess 模型

### 4.1 启动 + envFilter 契约 (B.H-1, W2 单一最大安全风险)

**进程关系** (plan v1.5 §4.7 L1 OS isolation 物理实现):

```
wb-bot (parent)
  ↓ spawn (detached) + envFilter('wb-runner', process.env)
wb-runner (supervisor wrapper, 跟 wb-bot 跨进程, in-memory state 不共享)
  ↓ exec (foreground, inherit stdio + script -q -F typescript.log) + envFilter('agent-cli', wb-runner.env)
agent CLI (claude / codex / mira-cli)
```

**spawn 选项** (W1 → W2 演进):

```
W1 spawn (现状, 不 detached):
  child_process.spawn(cmd, args, { cwd, env, stdio: 'pipe' })
  parent 死 → child 也死 (SIGHUP)

W2 detached spawn (wb-bot → wb-runner):
  child_process.spawn('wb-runner', args, {
    cwd,
    env: envFilter('wb-runner', process.env),  // ← envFilter 必经
    detached: true,                            // 创建新 process group
    stdio: ['ignore', outputFd, outputFd]      // stdout/err 直接写文件
  })
  child.unref()                                // parent 不等 child 退出

  parent 死 → child 仍在自己的 process group 中跑
  child 不再写 pipe, 而是写 runs/<botId>/<runId>/output.log

W2 wb-runner exec agent CLI (内层):
  child_process.spawn(agentCli, args, {
    cwd: spec.cwd,
    env: envFilter('agent-cli', process.env),  // ← envFilter 复用 ClaudeCodeAgent 现有逻辑
    stdio: ['pipe', outputFd, errFd]
  })
```

**envFilter 契约** (W2 必修, B.H-1 W2 单一最大安全风险):

`envFilter(target: 'wb-runner' | 'agent-cli', env)` 复用 `ClaudeCodeAgent.envFilter` 现有 whitelist + 显式 deny 列表 (plan v1 HP-W2-4):

| target | allow | deny (显式 deny, 不可 inherit) |
|---|---|---|
| `wb-runner` | PATH / HOME / USER / LANG / LC_* / TZ / WB_DATA_DIR / WB_HEARTBEAT_STALE_MS / WB_PUSH_THRESHOLD_MS / ANTHROPIC_* / OPENAI_* / GOOGLE_* (vendor secrets 透传) | LARK_APP_SECRET / LARK_* / WB_CLAUDE_COMMAND / WB_CODEX_COMMAND / WB_DEFAULT_CWD / BOT_ID / WB_MODE (W2.5 内部) |
| `agent-cli` | 仅对应 vendor whitelist (claude → ANTHROPIC_*, codex → OPENAI_*, gemini → GOOGLE_*) + PATH + HOME + cwd | WB_* 全部 deny / LARK_* 全部 deny / BOT_ID deny (agent CLI 不需要 weaverbird 内部 env, 防 prompt injection 泄密) |

**测试约束** (plan v1 HP-W2-4 + A1.6):

- `tests/wb-bot/env-whitelist.test.ts` 加 ≥5 例显式 deny (HP-W2-4)
- A1.6 集成测试 ≥2 fixture: claude / codex 各自 envFilter; 验证 LARK_APP_SECRET / WB_* 不出现在 agent CLI 进程 env

**安全风险**: B.H-1 是 W2 单一最大安全风险 (impl agent 默认 happy path 会直接 inherit `process.env`, 一行不慎 LARK_APP_SECRET 进 prompt injection 域). plan v1 HP-W2-4 + A1.6 是强制必修, 不允许跳过.

cross-link: plan v1 HP-W2-4 / A1.6 / §10 risk B.H-1; plan v1.5 §4.10 (`wb-cli debug` 单兵前台模式也走同一 envFilter, 不绕过)

### 4.2 wb-bot 与 child 的通信

```
W1: pipe (双向, 实时, parent 死则断)
W2: 文件 IPC (单向 + 信号)
  
  child → wb-bot:  
    child 写 output.log + events.ndjson (append-only)
    wb-bot 通过 fs.watch + tail 读 (低延迟)
    
  wb-bot → child:
    wb-bot 写 stop.signal 触发 graceful stop
    child 不直接看 wb-bot (因为 wb-bot 可能已 restart, child 不知道新 PID)
    
    实施: child 进程内部启动一个 watcher 监听 stop.signal
    (在 detached supervisor wrapper 内做, 不污染 agent CLI 本体)
```

### 4.3 child 实际是什么

```
不是直接 spawn claude/codex CLI, 而是 spawn 1 个 supervisor wrapper:

  wb-runner <runId>
    ↓ exec
    claude --resume <token> ... (or codex / mira-cli)

wb-runner 职责:
  - 写 spec.json + status + pid + heartbeat
  - 启动真实 agent CLI 作为 child
  - 把 agent CLI stdout/err 重定向到 output.log
  - parse 输出, 转 events.ndjson
  - 监听 stop.signal, 收到后 SIGTERM agent CLI
  - agent CLI 退出后, 写 status = done/error
```

### 4.4 wb-bot 重启时的恢复路径 (二态卡片承诺, C.H-3 + A.H-3)

**入口**: wb-bot 启动后立刻执行 `recoverInflightRuns()`. 必须先执行 §3.4 events.ndjson schema 容错协议 + §3.5 双层 heartbeat 判定, 后才决定卡片二态.

**流程**:

```
recoverInflightRuns():
  1. 扫描 runs/<botId>/*/       (W2 阶段 <botId> = 'default')
  2. 对每个 run:
     a. 读 spec.json (schemaVersion 校验, §3.4 容错)
     b. 读 events.ndjson (replay 至最新 event, §3.4 容错; events.ndjson 是 source of truth, §3.0)
     c. 读 status / heartbeat (L1 + L2 双层, §3.5)
     d. 应用 3 类判定 (见下表)
     e. 处理完即更新 inflight_card row 或 DELETE
```

**3 类判定 + 二态卡片** (C.H-3 二态承诺, plan v1 D2.1):

| 判定 | 条件 | 行为 | 卡片文案 |
|---|---|---|---|
| **续接** (run 仍活) | status=running AND (L1 fresh OR L2 fresh) | 重新 attach (fs.watch + tail output.log + events.ndjson), 重建 StreamState (从 events.ndjson 重放) | "⚠️ 服务重启, 任务 [runId 简短] 仍在运行中, 请稍候" |
| **丢失** (run 已死) | status=running AND L1 stale AND L2 stale | 标 orphan, 写 status=error | "⚠️ 服务重启, 任务已中断, 请重发" (不显示进度卡, 不延续误导) |
| **已完成** | status ∈ {done, error, stopped} | 跳过 attach, 卡片直接 patch 为对应终态 | 跟 W1 一致 (运行结束摘要) |

**pre-W2 inflight 数据 fallback** (A.H-5 + plan v1 A4.2):

```
spec.json 不存在 OR run_id 列为 NULL (pre-W2 W1 数据):
  → fallback W1 行为: patch 服务重启卡片 + clear inflight_card row
  → 不进 attach 流程 (W1 无 run-level supervision, 没有可 attach 的 child)

run_id IS NOT NULL (W2+ 数据):
  → 走上述 3 类判定流程
```

**事故级 fallback** (A.H-5 + plan v1 A4.3):

```
migration 失败 / SQLite 损坏:
  → wb-bot 只读启动 (不 crash)
  → 飞书 admin alert: "⚠️ 数据库迁移失败, 请检查 /health"
  → recoverInflightRuns 跳过 (没有 binding 状态可 cross-check)
```

cross-link: plan v1 A3 (recoverInflightRuns 二态判定) / D2.1 (二态卡片 done criterion) / D8.2 (卡片文案) / A4.2-A4.3 (fallback); A.H-3 (双层 heartbeat) / C.H-3 (二态承诺); plan v1.5 §4.7 L2 (events.ndjson 是 source of truth, 重建路径优先 ndjson 不优先 SQLite) + §4.8 原则 1 (SQLite writer 唯一 = wb-bot, recoverInflightRuns 在 wb-bot 启动序列内 serial)

---

## 5. inflight_card 表 (W1 已有, W2 扩展)

### 5.1 schema (W1 现状)

```sql
CREATE TABLE inflight_card (
  user_open_id     TEXT,
  thread_id        TEXT,
  source_message_id TEXT,
  reply_message_id  TEXT,
  updated_at       INTEGER,
  PRIMARY KEY (user_open_id, thread_id)
);
```

### 5.2 W2 扩展 + migration runner (A.H-5 显式化)

**schema diff**:

```sql
ALTER TABLE inflight_card ADD COLUMN run_id TEXT;   -- 关联到 runs/<botId>/<runId>/
ALTER TABLE inflight_card ADD COLUMN agent_id TEXT;
-- W2.5 再加 bot_id (见 multi-bot-routing.md §5.1)
```

**migration runner 协议** (plan v1 A4.1):

```
位置: apps/wb-bot/src/binding/migrations/001-add-run-id-agent-id.ts
版本管理: SQLite PRAGMA user_version 跟踪 schema 版本
  - W1 默认 0
  - W2 升 1 (本 migration)
  - W2.5 升 2 (加 bot_id 列)

启动序列 (BindingStore constructor 内, db.pragma('journal_mode = WAL') 之后):
  1. 读 PRAGMA user_version
  2. 跟代码内 currentSchemaVersion 对比
  3. 若 user_version < currentSchemaVersion:
     - 顺序执行 migrations/00X-*.ts (按版本号)
     - 每个 migration 内单独 BEGIN / COMMIT (失败回滚)
  4. 写 PRAGMA user_version = currentSchemaVersion

迁移失败处理 (A4.3):
  - migration runner 抛错 → wb-bot 只读启动 (不 crash)
  - 飞书 admin thread alert: "⚠️ 数据库迁移失败, 请检查 /health"
  - /health 命令显示 migration status + last error
  - 不允许部分 migration 完成 (transaction 保证 all-or-nothing)
```

**pre-W2 inflight 数据 fallback** (plan v1 A4.2):

```
A3 recoverInflightRuns 处理 inflight_card row 时:
  - run_id IS NULL (pre-W2 W1 数据) → 走 §4.4 W1 fallback 路径 (clear row + 服务重启卡片)
  - run_id IS NOT NULL (W2+ 数据) → 走 §4.4 attach 流程 3 类判定

保证: W1 → W2 升级期间存量 inflight 卡片不丢, 用户感知是 "升级期间一次性 reset 提示", 而非 "任务永久卡死"
```

cross-link: plan v1 A4.1 / A4.2 / A4.3, A.H-5 (migration runner 显式化), plan v1.5 §4.8 原则 1 (SQLite writer 唯一 = wb-bot, migration 在 wb-bot 启动序列内 serial, 跟 wb-runner 不并发)

### 5.3 重绑流程

```
wb-bot 启动后:
  1. SELECT * FROM inflight_card
  2. 对每行: 
     a. 检查对应 runs/<botId>/<runId>/status
     b. 若 status=running + heartbeat 新: attach, 续接
     c. 若 status=running + heartbeat stale: 标 error, 卡片显示 "可能丢失"
     d. 若 status=done/error/stopped: 卡片 patch 为对应终态
     e. 处理完即 DELETE FROM inflight_card WHERE ...
```

---

## 6. stop.signal 文件 IPC 协议

### 6.1 写入约定

```
任意进程 (Captain / 同进程 STOP 按钮) 写 runs/<botId>/<runId>/stop.signal:
  {
    "issuedBy": "captain" | "self-button" | "shutdown",
    "issuedAt": "2026-05-29T10:30:00Z",
    "reason": string                   // 可选, 日志用
  }

约定:
  - 内容是 JSON 但读取方不要求 parse (空文件也算 signal)
  - 同一文件可被覆盖 (后来的覆盖前者, atomic via rename)
  - 写者写完即返回, 不等 ack
```

### 6.2 读取与响应 (A.H-2 决议: polling = 500ms 主路径)

**polling 主路径** (跟 stop SLA 一致, 砍 v0.1 5s polling):

```
wb-runner supervisor 内启动 polling loop:
  setInterval(500):                                  // ← 主路径 polling 500ms (A.H-2)
    if (existsSync(stopSignalPath) && !handlingStop) {
      handlingStop = true
      1. 读 stop.signal 内容 (尽力 parse, 失败也无所谓)
      2. 向真实 agent CLI 发 SIGTERM
      3. 等 stopGraceMs (默认 500ms)
      4. 仍存活: SIGKILL
      5. 等 agent CLI 退出, 写 status = stopped
      6. 删 stop.signal 文件 (清理)
      handlingStop = false
    }
```

**stop SLA**: P50 < 500ms, P99 < 1.5s (含 SIGTERM grace + SIGKILL fallback). 决断 A.H-2: polling 主路径取代 v0.1 5s 太慢, 跟 plan v1 D2.3 一致.

### 6.3 fs.watch 仅 best-effort optimisation (A.H-2)

**fs.watch 不是主路径** (NFS / 容器 / macOS 某些 VFS 下不稳, 决断 A.H-2):

```
fs.watch 仅用于"早于 polling 触发"的 best-effort 优化:
  fs.watch(runDir, (event, filename) => {
    if (filename === 'stop.signal' && existsSync(stopSignalPath) && !handlingStop) {
       handlingStop = true
       触发跟 polling 同样的 SIGTERM 流程 (含 idempotent guard, 防 polling + watch 双触发)
       handlingStop = false
    }
  })

如果 fs.watch fail (NFS 不支持) 或不触发, polling 兜底保证 SLA.
```

**idempotent guard** (防 polling + watch 双触发同一个 stop.signal):

```
handlingStop 状态 flag (本进程内 in-memory, plan v1.5 §4.8 边界内合法):
  - 进入 SIGTERM 流程时设 true
  - 退出时设 false
  - 状态为 true 时新触发被忽略
```

**CSP discipline 注释**: stop.signal 是 fire-and-forget message (写者写完即返回, 不期待 ack), 跟 plan v1.5 §4.7 反模式 "sync request-reply through channel" 一致 — 不退化为 RPC.

cross-link: plan v1 D2.3 (stop SLA 500ms), A.H-2 决议; plan v1.5 §4.7 反模式 1 (fire-and-forget); plan v1 §10 risk A.H-2

### 6.4 stale signal 自清

```
worker 启动时检查自己 runs/<botId>/ 下的 stop.signal:
  - 若 stop.signal 存在但对应 status=done/error/stopped: 删除 (stale)
  - 若 stop.signal 存在 + status=running + 双层 heartbeat fresh (§3.5 判定): 当作有效 signal 处理
  - 若 stop.signal 存在 + status=running + 双层 heartbeat stale: 走 §4.4 orphan 路径 (signal 失效, run 已死)
```

heartbeat 阈值 deferred calibration, 见 §3.5 (60/120/240 三档候选, A1.5 集成测试期实测后选定).

---

## 7. wb-bot 与 dynamic workflow 长跑的接口

### 7.1 长跑场景

```
用户在飞书 @bot "workflow: ..."
→ wb-bot spawn wb-runner --runId r-xxx claude --workflow ...
→ wb-runner spawn claude CLI
→ claude 跑 dynamic workflow (后台 isolated runtime)
   - 内部 1000 subagent, 16 并发
   - 总时长 30 min - 3 hour
→ output.log 持续追加
→ events.ndjson 持续追加 (含 subagent_id, tool_progress 等 v0.3 events)
→ wb-bot 端 CardPipeline 实时 patch 卡片
```

### 7.2 wb-bot 重启 (workflow 跑中)

```
wb-bot 1 (老进程) SIGKILL
  ↓ (wb-runner detached, 仍活)
claude CLI 继续跑 dynamic workflow

wb-bot 2 (新进程) 启动
  ↓ recoverInflightRuns()
  ↓ 找到 runs/<botId>/r-xxx, status=running, heartbeat 新
  ↓ 重新 attach: fs.watch + tail output.log/events.ndjson
  ↓ 重建 StreamState (从 events.ndjson 重放)
  ↓ 更新 inflight_card 卡片: "服务已重启, 继续接管"
  ↓ 继续 patch 卡片直到 status=done

效果: 用户看到卡片短暂"加载中", 然后继续更新, 不感知重启
```

### 7.3 长跑的不承诺

```
✗ claude CLI 内部 1000 subagent 状态持久化 — 是 claude-code 责任
✗ 重启时 subagent 已生成内容是否完整 — 取决于 claude-code 是否 flush
✗ workflow 最终输出的 atomicity — 取决于 claude-code 写完整 done event
```

---

## 8. 工作项清单 (W2 Block A)

> **以 `plans/w2-mainline.plan.md` §2 Block A 为准** (12-13 天, 含 A0-A9 + A1.5 heartbeat 校准 + A1.6 envFilter 集成测试 + A4.1/A4.2/A4.3 migration runner 系列). 本节 v0.1 估算 (~9-10 天) 是 Phase 2 review 前的旧值, 保留作历史背景, 不作为实施依据.

v0.1 旧清单 (历史背景):

```
A0  本文档 spec 化 + 边界声明                          ~0.5 天
A1  wb-runner supervisor 工具实现                       ~3 天
    A1.1 spec.json/status/pid/heartbeat 写入
    A1.2 stdout/err 重定向到 output.log
    A1.3 events.ndjson append-only 输出
    A1.4 stop.signal watcher + 5s polling 兜底
    A1.5 SIGTERM → grace → SIGKILL 流程
A2  wb-bot 集成: spawn 改 detached + wb-runner          ~1 天
A3  wb-bot 重启时 recoverInflightRuns 流程              ~1.5 天
    A3.1 扫 runs/<botId>/*/
    A3.2 attach 仍活的 run (fs.watch + tail)
    A3.3 标 orphan / 已完成的 run
    A3.4 重绑 inflight_card 卡片
A4  inflight_card 加 run_id + agent_id 列               ~0.5 天
A5  集成测试: wb-bot kill -9, 重启验证 run 续接          ~1 天
A6  集成测试: stop.signal 跨进程触发 graceful stop      ~0.5 天
A7  集成测试: dynamic workflow 30+ min 长跑 + 重启      ~1 天

合计: ~9-10 天
```

v0.2 (Phase 4 C1) 修订: 上述清单的具体子项语义已被 spec §3-§6 重写覆盖 (A1.4 polling 5s → polling 500ms 主路径 + fs.watch best-effort, 见 §6.2/§6.3; A1 heartbeat 升双层 L1+L2, 见 §3.5; A4 加 migration runner, 见 §5.2). 工作项 + 时间估以 plan v1 §2 Block A 为单一来源.

---

## 9. 不做的事 (避免漂移)

```
✗ subprocess 守护框架 (类似 PM2 / forever / Kubernetes pod)
  → 不需要, launchd 已经做了 KeepAlive 自动重启
  
✗ 内嵌 cgroup / namespace 隔离
  → OS 级隔离够用, 不引入容器化
  
✗ runs/ 目录跨机器同步 (e.g. 多机分布式)
  → personal tool, 单机即可
  
✗ events.ndjson 实时 streaming 到外部 sink (Kafka / Pulsar)
  → 不上 observability platform
  
✗ run 历史归档机制 (定期清理 runs/)
  → W2 不做, W3+ 看磁盘压力再加 (可能加 7 日自动清理)
```

---

## 10. Open questions (W3+ 候选)

1. **run 历史保留期** —— 当前 events.ndjson 持续写入, 长期占磁盘. W3 加 retention 策略 (default 7 day, daily rotate or compress)。

2. **跨设备 run 状态同步 / agent fleet across hosts** —— 用户在 mac + 工作机两台 wb-bot, 是否能让 mac 看到工作机的 run 状态? plan v1.5 §4.9 已锁: 飞书端不可区分 device, 不做 device-aware 路由层; 多端 → 不同 host agent 走 prompt 内 agent hint + agent registry config 的 `host` / `transport` 字段 (W3+ 候选, plan v1.5 §3 W3+). events.ndjson schema 预留 `host` 字段位置 (§3.0), W3+ fleet 演进无 schema break.

3. **subprocess 资源 cap** —— claude/codex CLI 跑 dynamic workflow 时 CPU / memory 不受限. 是否要 nice / ulimit? W3 看实战。

4. **崩溃 detection 与 user 通知** —— 当前 wb-bot 重启时检测 stale heartbeat, 显示"可能丢失". 是否要更主动 (SC-13 主动 ping 用户已经死了的 run)? 待 W2 Block B 配合考虑。

---

## 11. 文档元数据

- **版本**: v0.2 (Phase 4 C1)
- **状态**: spec (Phase 4 sync)
- **创建**: 2026-05-29 (v0.1-draft)
- **修订**:
  - **2026-05-30 v0.2 (Phase 4 C1, 主设计师)**: 重写 8 段, 来源 W2 plan v1 + plan v1.5 + Phase 2 review. 5 项 H 合并 spec 重写区 = A.H-1 (launchd 行为分类) + A.H-2 (stop polling 500ms) + A.H-3 (双层 heartbeat + 决断 8 deferred) + A.H-4 (ndjson schema 容错) + B.H-1 (envFilter 契约), 加 C.H-3 二态卡片承诺 + A.H-5 migration runner 显式化. 对应段落: §1 头部 / §1.1 范围 / §2.2 launchd 边界分类 / §3.0 source of truth / §3.4 ndjson schema 容错 / §3.5 双层 heartbeat / §4.1 envFilter 契约 / §4.4 二态卡片 / §5.2 migration runner / §6.2 polling=500ms + §6.3 fs.watch best-effort.
  - 后续修订: 以独立 plan / PR 提交.
- **关联**:
  - 上游: `docs/product-strategy.md` §1.1; `plans/w2-mainline.plan.md` §2 Block A + §4.1-4.10 + §10 Risk Register
  - **W2 plan v1.5 cross-link** (本 spec 是 v1.5 战略原则的物理实现):
    - §4.6 strength-following: 本 spec 不重复 Claude Code 内部 session 持久化 (§7.3 长跑不承诺), 只管 weaverbird-side process supervision
    - §4.7 CSP discipline 5 层: 本 spec §3.0 + §3.4 是 L2 (events.ndjson source of truth) 物理实现; §4.1 + §6 是 L1 (OS process isolation) + 反模式 1 (fire-and-forget) 物理实现
    - §4.8 in-memory state 进程边界: 本 spec §5.2 (SQLite writer 唯一 = wb-bot, migration 启动序列内 serial) + §3.0 (events.ndjson per-run owner) + §6.2 idempotent guard (本进程内 in-memory 合法)
    - §4.9 host 路由: 本 spec §3.0 + §3.4 events.ndjson schema 预留 host 字段位置 (W2 阶段恒 'local')
    - §4.10 单兵 cli ergonomics: 本 spec §4.1 envFilter 在 `wb-cli debug` 单兵前台模式也走, 不绕过
  - 平行: `single-bot-concurrent-agents.md` (Block C scope key + 多卡片 UX), `multi-bot-routing.md` (W2.5), `agent-adapter.md` §11.5 (AgentEvent v0.3 schema)
  - 下游: `captain-bot.md` (Captain 复用 stop.signal 协议, W2.5)
