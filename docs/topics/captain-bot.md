# TOPIC-W2.5-H · Captain Bot (default bot 升级形态)

> **版本**: v1 (W2.5 close, 2026-06-02)
> **状态**: spec (W2.5 已实施 §3.1 / §3.2 / §3.5 / §3.6 跨 bot 完整版; §3.3 / §3.4 / §3.7 推 W3+ 候选)
> **创建**: 2026-05-29 (v0.1-draft); v0.1 → v0.2 同步 W2 plan v1 W2 vs W2.5 实施范围声明 (D.H-3) + C.M-5 (`/health` quick_check) + C.M-6 (`/tasks` 空格语法 + 7 日 + negative list) + B.M-8 (`/logs` pino-pretty) + 决断 §二.1 (W2 botId='default'); v0.2 → v1 W2.5 close sync 实施状态 (W2.5-I batch, 2026-06-02)
> **承接**: [docs/product-strategy.md](../product-strategy.md) §1.1, W2.5 主线 Block H, 配合 `multi-bot-routing.md`; cross-link `plans/w2-mainline.plan.md` v1.5 §2 Block C/E/H (Block H 在 W2.5 推迟, W2 仅 退化版)
> **性质**: 设计 spec, 描述 default bot 在 multi-bot 模式下的 control plane 角色、命令固定 set、bot discovery 机制; 不描述实现代码

---

## ⚠️ 实施范围声明 (W2 vs W2.5, Phase 4 C3 sync + W2.5-I close sync, D.H-3 + 决断 §二.1)

本文档总体目标位于 **W2.5 主线** (multi-bot 真启用后), W2 阶段部分子节作为 single-bot 退化版实施. W2.5-I (2026-06-02) 加 close 时实施状态标注.

**W2 阶段 single-bot 退化版** (✅ W2 close 已实施):

- §3.1 `/status` (单 bot 自身视角, 退化版见 §5)
- §3.5 `/list-bots` (单 bot 阶段返回 "default (single-bot mode)")
- §3.6 `/health` (单 bot 自检 + SQLite `PRAGMA quick_check`, 不做跨 bot 心跳探测)
- §3.7 `/tasks` (W2 空格语法已实施; W2 阶段不接 `bot=<id>` 子参数, 详见 §3.7 修订)

**W2.5 阶段升完整版** (✅ W2.5 H.A/H.B/H.C close 已实施, 2026-06-02):

- §3.1 `/status` 跨 bot 完整版 (✅ H.B, commit `987a3d5`)
- §3.2 `/stop-all` 跨 bot 完整版 (✅ H.C, commit `948c561`, 复用 G7 stop.signal 协议)
- §3.5 `/list-bots` 跨 bot 完整版 (✅ H.A, commit `a404520`)
- §3.6 `/health` 跨 bot 心跳完整版 (✅ H.B, commit `987a3d5`)
- §4 bot discovery 机制 (✅ H.A, `apps/wb-bot/src/captain/bot-discovery.ts`)

**W2.5 阶段 defer 到 W3+ 候选** (❌ 未实施, 非主路径优化):

- §3.3 `/logs <botId>` 跨 bot 路由 (用户可 `tail -f ~/.weaverbird/logs/<botId>/wb-bot.log` 直接看)
- §3.4 `/restart <botId>` launchctl kickstart (用户可 `launchctl kickstart -k gui/$UID/com.weaverbird.wb-bot.<botId>` 直接重启)
- §3.7 `/tasks bot=<id>` 子参数 (跨 bot history filter)

**`<botId>` 语法可见性 (D.H-3 + 决断 §二.1)**:

W2 阶段所有 `<botId>` placeholder 内部恒为 `'default'`, **不暴露 user-facing 语法**. 用户 `/tasks` 命令在 W2 阶段不接受 `bot=<id>` 子参数 (即使 spec 写也忽略); W2.5 启用 multi-bot 后才暴露 `bot=<id>` 用户语法.

理由: W2 single-bot 形态用户感知里没有 "bot id" 这个概念; 暴露过早是 framework drift.

---

## 1. 本文档回答什么 / 不回答什么

### 回答

- 为什么 default bot 在 multi-bot 模式下不该 disable, 而升 Captain
- 7 个固定 control plane 命令的契约 (input / output / 边界)
- bot discovery 机制 (Captain 怎么知道有哪些 worker)
- 跨进程 IPC 复用 (stop.signal / SQLite / 文件)
- Captain 命令是固定 set, 不留扩展点 (反 framework drift)
- 单 bot 模式下 Captain 命令的退化行为 (指自身, 不跨 bot)
- W2 vs W2.5 实施范围声明 (Phase 4 C3 sync, D.H-3)

### 不回答

- 多 bot 部署 / launchctl / 飞书后台建应用 → `docs/guides/multi-bot-setup.md`
- launchctl kickstart 跨 user 限制 → 部署文档
- agent control plane (`/use` / `/agent`) → `single-bot-concurrent-agents.md` §6 (W1+W2)
- W3+ 用户 forward / pipeline UI → 见 `single-bot-concurrent-agents.md` §10

---

## 2. 设计动机

```
multi-bot 模式下 (WB_MODE=multi-bot):
  
  Option 1: default bot 完全 disable
    → 浪费已配置的 1 个飞书应用
    → 用户失去单 bot 多 agent 切换的灵活入口
    
  Option 2: default bot 仅跑 agent (与其它专用 bot 平等)
    → 没问题但没"特殊性"
    → 同一个用户场景下, default 与 claude-bot 行为差异不大
    
  Option 3 (本文档选): default bot 升 Captain (跑 agent + control plane)
    → 利用率最高
    → 给用户 1 个"统揽全局"的入口
    → 满足 SRE 凌晨 "/stop-all" 等真实需求
```

→ **default bot 升 Captain** 是 W2.5 默认行为, 用户可通过 `WB_DISABLE_CAPTAIN=true` 关掉 (但通常不需要)

---

## 3. 7 个固定 control plane 命令

### 3.0 全局 botId 校验 (Phase 4 C3 sync, plan v1 §4.4 SC-12)

所有接受 `<botId>` 参数的命令 (W2.5: §3.3 / §3.4; W2 退化版不接受用户语法) 在解析阶段强制校验:

```
botId regex: /^[a-z][a-z0-9_-]{0,31}$/

约束:
  - 必须以小写字母开头
  - 字符集: [a-z0-9_-]
  - 长度: 1-32 字符
  - 不通过 → 卡片错误文案 "bot id 必须匹配 [a-z][a-z0-9_-]{0,31} (e.g. claude, codex-prod, mira_v2)"

W2 阶段语义: 用户级 user-facing 不暴露 (`<botId>` 内部恒 'default'); W2.5 启用后才暴露用户语法.
```

理由:
- 防 path traversal (botId 用于 `runs/<botId>/`, `logs/<botId>/`, `gui/<UID>/com.weaverbird.wb-bot.<botId>` 等路径)
- 防视觉混淆 (大小写 / 中文 / emoji 在 launchctl label / 文件路径里都是雷)
- 长度上限 32 跟 launchctl label 限制兼容

### 3.1 `/status`

> **W2.5 实施状态**: ✅ 跨 bot 完整版已 W2.5 H.B 落 (`apps/wb-bot/src/captain/captain-status.ts`, commit `987a3d5`). W2 single-bot 退化路径仍保留 byte-exact (router gate 双分支).

```
用法: @<default-bot> /status

行为:
  multi-bot 模式: 跨 bot 查所有 worker 的 inflight run
  single-bot 模式: 仅查本进程 inflight (退化)

数据来源:
  1. SQLite inflight_card 表 (跨 bot 共享 WAL)
  2. 各 runs/<botId>/*/heartbeat 文件 (探测 worker 在线)
  3. 各 runs/<botId>/*/status 文件 (run 当前状态)

输出 (卡片):
  📊 Weaverbird Status (2026-05-29 10:30:00)
  ─────────────────────────────────────
  🤖 default (Captain) : 空闲 · 最后心跳 5s 前
  🤖 claude            : 跑中 5min · run r-abc · 12 tools
  🤖 codex             : 空闲 · 最后心跳 3s 前
  🤖 mira              : ⚠️ 离线 (最后心跳 10min 前)
  ─────────────────────────────────────
  
约束:
  - 同步生成 (查表 + 读文件), 不调任何 agent
  - 响应时间 < 1s
  - 不修改任何状态
```

### 3.2 `/stop-all`

> **W2.5 实施状态**: ✅ 跨 bot 完整版已 W2.5 H.C 落 (`apps/wb-bot/src/captain/captain-stop-all.ts`, commit `948c561`). 复用 G7 stop.signal 协议 (`process-supervision-bounds.md` §6). W2 single-bot 退化路径 (`ctx.stopAllSessions()`) byte-exact 保留.

```
用法: @<default-bot> /stop-all

行为:
  multi-bot 模式: 跨 bot 给所有 active run 写 stop.signal
  single-bot 模式: 给本进程所有 active session 发 stop (退化)

数据来源 + 写入:
  1. 扫所有 runs/<botId>/*/status, 找 status=running
  2. 对每个 active run, 写 runs/<botId>/<runId>/stop.signal
     (协议见 process-supervision-bounds.md §6)
  3. 不等待 worker 处理结果 (异步)

输出 (卡片):
  ✅ 已向 N 个 active run 发送 stop 信号
  ─────────────────────────────────────
  - claude / r-abc : signal sent
  - codex / r-def  : signal sent
  - mira / r-ghi   : signal sent
  ─────────────────────────────────────
  各 bot 的 graceful stop 将在 ~500ms 内完成,
  完成后各自卡片会更新为 "stopped" 状态.

约束:
  - 写文件操作, < 1s
  - 不阻塞等 agent 真正停下
  - 各 worker 的 graceful stop 由各自的 wb-runner 执行
```

### 3.3 `/logs <botId> [tail=50]` (W2.5-only, W2 阶段忽略)

> **W2.5 实施状态**: ❌ defer 到 W3+ 候选 (非主路径优化). 当前阶段用户可 `tail -f ~/.weaverbird/logs/<botId>/wb-bot.log` 直接看. spec 保留以便 W3+ 实施时 anchor.
> **W2 阶段实施 agent 必须忽略**: W2 single-bot 形态没多 bot 可路, `/logs` 命令在 W2 阶段不实现 (退化行为见 §5).

```
用法: 
  @<default-bot> /logs claude
  @<default-bot> /logs claude tail=200

行为:
  跨 bot 读 logs/<botId>/wb-bot.log 末尾 N 行, pino-pretty 格式化输出

数据来源:
  logs/<botId>/wb-bot.log (W2 Block E 已配 pino file sink, JSON line-delimited)
  
格式化 (Phase 4 C3 sync, B.M-8):
  pipe 经 pino-pretty (npm 已依赖) 转人类可读
  - 时间戳 ISO 8601 → 本地时间 HH:mm:ss
  - level 字段染色 (terminal 端) / 加 emoji (飞书卡片端)
  - 字段顺序: time, level, msg, ...rest
  - 飞书卡片端 ANSI 染色去掉 (用 pino-pretty `--colorize=false`)
  
输出 (卡片, 代码块):
  📋 logs/claude/wb-bot.log (tail 50)
  ─────────────────────────────────────
  ```
  10:25:01 INFO  received lark message thread=oc_abc
  10:25:01 INFO  registered active session scopeKey=open_xxx:chat_yyy:claude-code
  10:25:02 WARN  tool_progress emit slow (>2s) toolName=run_tests
  ...
  ```
  ─────────────────────────────────────

约束:
  - 仅读, 不修改
  - tail 默认 50, 最大 500 行 (防卡片过大)
  - 若 botId 不存在或日志为空, 返回 "未找到日志"
  - 跨 user 权限: 各 worker 自己写自己 logs/<botId>/, 同 user 下文件权限默认可读
  - botId 校验走 §3.0 (Phase 4 C3 sync)
```

### 3.4 `/restart <botId>` (W2.5-only, W2 阶段忽略)

> **W2.5 实施状态**: ❌ defer 到 W3+ 候选 (非主路径优化). 当前阶段用户可 `launchctl kickstart -k gui/$UID/com.weaverbird.wb-bot.<botId>` 直接重启. spec 保留以便 W3+ 实施时 anchor.
> **W2 阶段实施 agent 必须忽略**: W2 没 launchctl per-bot kickstart 形态, `/restart` 命令在 W2 阶段不实现.



```
用法: @<default-bot> /restart claude

行为:
  调 launchctl kickstart 重启对应 bot worker (limit: 同 user, macOS)
  
执行命令:
  launchctl kickstart -k "gui/<UID>/com.weaverbird.wb-bot.<botId>"
  
输出 (卡片):
  🔄 已请求 <botId> 重启
  ─────────────────────────────────────
  launchd 将在 ~2s 内拉起 worker.
  请稍后用 /status 确认.

约束:
  - macOS only (W2.5 范围). Linux systemd 整合留 W3.
  - 不能 restart Captain 自己 (default bot worker 不能 kickstart 自己), 返回错误提示
  - 限同 user: launchctl 跨 user 需 root, weaverbird 不做
  - 若 botId 不存在或对应 plist 未安装, 返回错误提示
```

### 3.5 `/list-bots`

> **W2.5 实施状态**: ✅ 跨 bot 完整版已 W2.5 H.A 落 (`apps/wb-bot/src/captain/list-bots.ts` + `apps/wb-bot/src/captain/bot-discovery.ts`, commit `a404520`). Bot discovery 走 `${WB_CONFIG_DIR}/.env.*` 文件扫描 + `runs/<botId>/heartbeat` 探测 (≤30s fresh). W2 single-bot 退化路径 `"default (single-bot mode)"` byte-exact 保留.

```
用法: @<default-bot> /list-bots

行为:
  扫描所有已配置 bot, 探测在线状态
  
数据来源:
  1. ${WB_CONFIG_DIR}/.env.* 文件 (列出所有已配置 bot)
  2. runs/<botId>/heartbeat (探测在线)
  3. SQLite 中各 bot_id 的近期活跃统计

输出 (卡片):
  📋 已配置 bot
  ─────────────────────────────────────
  default (Captain) · agents=[claude-code, codex] · 在线 ✓
  claude            · agent=claude-code           · 在线 ✓
  codex             · agent=codex                 · 在线 ✓
  mira              · agent=mira-cli              · 离线 ✗ (10min 前)
  ─────────────────────────────────────

约束:
  - 不修改任何状态
  - 同步生成, < 1s
```

### 3.6 `/health` (W2 single-bot 退化版 + W2.5 跨 bot 完整版)

> **W2.5 实施状态**: ✅ 4 项跨 bot 完整版已 W2.5 H.B 落 (`apps/wb-bot/src/commands/health.ts`, commit `987a3d5`). 跨 bot 心跳 stale 阈值固定 30s (declared spec deviation H.B, 与 §3.0 botId regex 一致严苛). W2 退化版 3 项 byte-exact 保留 (router gate 双分支).

```
用法: @<default-bot> /health

行为:
  W2 single-bot 退化: 自检 (1-3 项, 跳过跨 bot 项 4)
  W2.5 multi-bot:    自检 + 跨 bot 探测 (1-4 全部)
  
检查项 (固定 4 项, 不增不减; Phase 4 C3 sync, C.M-5):
  1. 本 worker WSClient 连接 (内部状态 + 最近事件时间)
  2. SQLite 可写 + 完整性测试:
     - 可写测试: BEGIN IMMEDIATE + 立即 ROLLBACK
     - 完整性测试: PRAGMA quick_check  (Phase 4 C3 sync, C.M-5)
       (轻量, 不全表扫; full PRAGMA integrity_check 留 W3 健康巡检)
       结果非 "ok" → ❌ 标 SQLite 完整性异常
  3. runs/ 目录磁盘空间 (df -h, 警告 < 1GB)
  4. (W2.5 only) 跨 bot worker 心跳 (各 runs/<botId>/heartbeat, 警告 > 双层 heartbeat 阈值, 见 process-supervision-bounds.md §3.5)

输出 (卡片, W2.5 完整版):
  🩺 Health Check
  ─────────────────────────────────────
  ✅ WSClient: 连接正常, 最近事件 3s 前
  ✅ SQLite:   可写 · quick_check ok
  ⚠️ 磁盘:    runs/ 占用 800MB (低空间)
  ❌ Worker:  mira 心跳 stale (>30s)
  ─────────────────────────────────────
  整体: ⚠️ 部分异常

输出 (卡片, W2 single-bot 退化版):
  🩺 Health Check
  ─────────────────────────────────────
  ✅ WSClient: 连接正常, 最近事件 3s 前
  ✅ SQLite:   可写 · quick_check ok
  ✅ 磁盘:    runs/ 占用 200MB
  ─────────────────────────────────────
  整体: ✅ 健康
  (single-bot 模式: 跨 bot 心跳检查跳过)

约束:
  - 不修改状态
  - 检查项固定, 不允许用户扩展 (反 framework drift)
  - W2 阶段实施 agent 必须 emit `single-bot 模式: 跨 bot 心跳检查跳过` 标记 (用户感知透明)
```

### 3.7 `/tasks [N] [<agentId>]` (空格语法, Phase 4 C3 sync, C.M-6)

> **W2.5 实施状态**: ✅ W2 空格语法 (`[N] [<agentId>]`) 已 W2 close 实施 (commit `8b61088` 等); ❌ `bot=<id>` 子参数 defer 到 W3+ 候选 (非主路径优化, 跨 bot history filter 当前用户感知不强).

```
用法 (W2 + W2.5 通用空格语法):
  @<default-bot> /tasks
  @<default-bot> /tasks 50
  @<default-bot> /tasks 50 claude-code

W2.5 only 加: bot=<id> 过滤 (本 spec 不再列在 W2 阶段语法):
  @<default-bot> /tasks 30 bot=claude

参数:
  - 第 1 位置参数 N (可选): tail 行数, 默认 20, 最大 100, 超 100 截断
  - 第 2 位置参数 <agentId> (可选): 仅返回该 agent 的 history (e.g. claude-code)
  - bot=<id> (W2.5 only, W2 阶段忽略): 仅返回该 bot 的 history

行为:
  W2 single-bot 模式: 仅查本进程任务历史 (botId='default'), `bot=<id>` 子参数被显式忽略
  W2.5 multi-bot:    跨 bot 查任务历史 (含已完成 / 失败 / 已停止)

文案 (Phase 4 C3 sync, C.M-6):
  - 卷首必须显式注明 "近 7 日" 范围 (用户预期管理: 历史不是无限的)
  - 卷尾必须列 negative list:
    "未列出: 当前 active 任务 (用 /status 查)、历史详情 (用 /logs 查)、无 spec.json 的孤儿 run 目录"

数据来源:
  扫 runs/<botId>/<runId>/ 各子目录的 spec.json + status 文件
  按 startedAt 倒序排列
  
输出 (卡片, W2 single-bot 形态):
  📋 Task History (近 7 日, tail 20)
  ─────────────────────────────────────
  ✅ 10:35 claude-code · ~/code/foo · 5min · done    (r-xyz)
  ⛔ 10:30 codex       · ~/code/bar · 2min · stopped (r-abc)
  ❌ 10:25 mira-cli    · ~/ops      · 8min · error   (r-def)  ⚠️
  ✅ 10:18 claude-code · ~/code/foo · 3min · done    (r-ghi)
  ...
  ─────────────────────────────────────
  未列出: 
  - 当前 active 任务 (用 /status 查)
  - 历史详情 (用 /logs 查; 当前仍是本 bot 视角)
  - 无 spec.json 的孤儿 run 目录

约束:
  - 仅读, 不修改
  - tail 默认 20, 最大 100 行
  - 仅查 7 日内的 run (`runs/<botId>/<runId>/spec.json` 的 startedAt)
  - W2 阶段忽略 `bot=<id>` 子参数 (D.H-3, 决断 §二.1)
  - W2.5 启用 multi-bot 后 `bot=<id>` 才生效
  - <agentId> 校验走 W1 已注册 agent registry (不在则卡片错误文案)
  - 不展示 run 详细内容 (查详情用 /logs; 当前 /logs 仍是本 bot 视角)

启发: agentara 用 `tasks` 表 query 历史. weaverbird 用 file-based 扫描 (无需新表),
保持 D' 边界轻量, 跟 agentara 重型 Drizzle ORM 路径不同, 但功能等价.
```

---

## 4. bot discovery 机制

> **W2.5 实施状态**: ✅ 文件扫描 + heartbeat 探测已 W2.5 H.A 落 (`apps/wb-bot/src/captain/bot-discovery.ts`, commit `a404520`). 复用 G.B 的 `multi/discovery.ts` `.env.*` 扫描 + 加 heartbeat 探测.

### 4.1 数据来源 (W2.5)

```
来源 1: ${WB_CONFIG_DIR}/.env.* 文件
  ls ~/.weaverbird/configs/.env.*  
  → 提取 BOT_ID 与 LARK_APP_ID, 列出所有"已配置"的 bot

来源 2: runs/<botId>/heartbeat 文件
  scan runs/ → 各 botId 子目录的 heartbeat 时间
  → 判断 worker 在线状态

合并:
  configured_bots = {set of BOT_ID from .env.*}
  online_bots = {set of botId with fresh heartbeat (< 30s)}
  offline_bots = configured_bots - online_bots
  unknown_bots = online_bots - configured_bots  (异常情况)
```

### 4.2 注册表表的设计 (留 W3)

```
W2.5 用文件扫描, 工程量小, 风险低
W3 候选: 增加 bot_registry SQLite 表统一管理

bot_registry (W3 候选):
  bot_id          TEXT PRIMARY KEY
  app_id          TEXT
  display_name    TEXT
  default_agent   TEXT
  registered_at   INTEGER
  last_seen       INTEGER

但 W2.5 不做, 文件扫描 + heartbeat 探测足够。
```

---

## 5. 单 bot 模式下的退化行为 (W2 阶段实施范围)

> **W2.5 close 后退化行为状态** (2026-06-02, W2.5-I batch sync):
> - W2 single-bot 退化路径仍保留, byte-exact 兼容性 (各命令 W2 路径 + Captain 路径双分支, 见 `apps/wb-bot/src/commands/router.ts`).
> - W2.5 启用 multi-bot (`WB_MODE=multi-bot` + `BOT_ID=default` + `WB_DISABLE_CAPTAIN` unset) 时, default bot 升 Captain, 各命令走完整版.
> - 其它 bot worker 不升 Captain (非 default BOT_ID 时, slash command 走 W2 单 bot 路径, 不跨 bot).
> - Captain gate 三条件: 见 `apps/wb-bot/src/captain/captain-gate.ts` `isCaptainEnabled(...)`.

```
WB_MODE=single (W2 阶段唯一形态) 时, 命令实施范围退化:

W2 阶段必须实施:
  /status        : 仅看本进程 inflight (= single bot 的本身)
  /list-bots     : 返回 ["default (single-bot mode)"], 标注 single-bot 退化
  /health        : 1-3 项自检, 跳过跨 bot 心跳 (§3.6)
  /tasks         : 本进程任务历史, 忽略 bot=<id> 子参数 (§3.7, D.H-3)

W2 阶段不实施 (impl agent 必须忽略):
  /stop-all      : (W2.5-only) 在 W2 阶段, typed /stop 多 active session = stop-all 别名
                   见 single-bot-concurrent-agents.md §6.4 (Phase 4 C3 sync, 决断 9)
  /logs <botId>  : (W2.5-only) W2 阶段没多 bot 可路, 不实施
  /restart <botId>: (W2.5-only) W2 阶段没 launchctl per-bot kickstart, 不实施

→ 单 bot 用户也直接受益 (4 项 W2 已经能用, 不需等 W2.5)
```

> **W2 阶段 `/logs` 实施退化版 (Batch-W2-E)**:
> - 不接 `<botId>` 参数 (W2.5 多 bot 才支持)
> - 默认本进程 log file (`logs/<botId>/wb-bot.log*` with pino-roll rotation suffix)
> - tail 默认 50, 上限 500
> - 完整版 (跨 bot, 含 `<botId>` 参数, log lineage 聚合) 留 W2.5

---

## 6. 反 framework drift 设计纪律

### 6.1 命令固定 set, 不留扩展点

```
7 个命令是 hardcode 列表 (Phase 4 C3 sync: §3.0 不算独立命令, 是全局 botId 校验段), 不允许:
  
  ✗ 用户配置 ~/.weaverbird/captain-commands/<cmd>.yaml 注册新命令
  ✗ Captain 通过 LLM 解析自然语言命令 (e.g. "停掉所有跑了 5 分钟以上的")
  ✗ 命令组合 (e.g. /stop-all && /status)
  ✗ 命令 alias / shortcut
  ✗ Captain 触发 agent 跑任务 (但用户 @ Captain 不带 /xxx 时, 仍可走默认 agent, 即 default bot 的 agent 能力)
```

### 6.2 边界声明

```
Captain 命令做的事:
  ✓ 读自己/跨 bot 的元数据 (SQLite + runs/)
  ✓ 写跨 bot 的简单信号 (stop.signal)
  ✓ 调 launchctl 重启自己注册的 service
  
Captain 命令不做的事:
  ✗ 调 agent (Captain 自身仍是 default bot, 可跑 agent, 但 /xxx 命令本身不调)
  ✗ 直接修改其它 bot 的 .env / 配置
  ✗ 远程 IPC (非本机进程通信)
  ✗ 数据分析 / 复杂统计 (e.g. "本周哪个 bot 跑最多")
  
→ Captain 是 control plane, 不是 monitoring dashboard, 不是 framework
```

---

## 7. 工作项清单 (W2.5 Block H)

```
H0  本文档 spec 化 + 命令固定 set 写入                     ~0.5 天
H1  bot discovery 实现 (扫 .env.* + 探测 heartbeat)        ~0.5 天
H2  /status 实现 (跨 bot 读 inflight_card + runs/)         ~1 天
H3  /stop-all 实现 (跨 bot 写 stop.signal)                 ~0.5 天
H4  /logs <botId> 实现 (依赖 W2 Block E pino file sink)    ~0.5 天
H5  /restart <botId> 实现 (launchctl kickstart, macOS)     ~1 天
H6  /list-bots 实现                                        ~0.5 天
H7  /health 实现 (4 项固定检查)                            ~1 天
H8  单 bot 模式退化行为测试                                ~0.5 天
H9  集成测试: 3 bot multi-bot 模式下 Captain 命令          ~1 天

合计: ~5-6 天 (audit 修订, 原估 3-5 天)
```

---

## 8. Open questions (W3+ 候选)

1. **跨 user / 跨机器 Captain** —— 当前仅 same-user same-machine. 是否需要 SSH 远端 supervision? 个人工具不需要, **不做**。

2. **Captain 命令的权限控制** —— `/restart` / `/stop-all` 高危, 是否需要二次确认? W2.5 不做 (单 user 个人工具, 自己控制). 若 W3 有多人共用同一 wb-bot 实例, 再加。

3. **systemd integration (Linux)** —— `/restart` 当前 macOS launchctl. Linux 用户加 systemctl --user 支持? W3+ 候选, 看用户分布。

4. **Captain 集成 OS push** —— 跨 bot 异常 (e.g. mira worker 离线 > 30s) 自动 push 提醒. 跟 W2 Block D N3 push 配合. 是否要做? 看实战。

5. **Web UI dashboard** —— 飞书卡片渲染 capability 有限, 是否提供 localhost:port Web UI 看更详细的 Captain 视图? W3+ 候选, 不预设。

---

## 9. 文档元数据

- **版本**: v0.2 (Phase 4 C3 sync, 2026-05-30 主设计师)
- **状态**: spec (W2.5-only mainline, W2 阶段仅 §3.1/§3.5/§3.6/§3.7 退化版)
- **创建**: 2026-05-29 (v0.1-draft); v0.2 同步 W2 plan v1 W2 vs W2.5 实施范围声明
- **修订方式**:
  - **2026-05-30 v0.2 (Phase 4 C3)**: 顶部加 W2 vs W2.5 实施范围声明 (D.H-3 + 决断 §二.1); §1 范围调整; §3.0 (新) 全局 botId 校验段 (plan v1 §4.4 SC-12); §3.3 `/logs` 加 W2.5-only 标 + pino-pretty 格式化 (B.M-8); §3.4 `/restart` 加 W2.5-only 标; §3.6 `/health` 改 quick_check (C.M-5) + W2/W2.5 退化对照; §3.7 `/tasks` 改空格语法 + 7 日文案 + negative list + W2 忽略 `bot=<id>` (C.M-6 + D.H-3); §5 退化行为重写为 W2 实施范围对照; §6.1 6 → 7 命令; §9 元数据更新.
  - 后续修订: 以独立 plan / PR 形式提交.
- **关联**:
  - 上游: `docs/product-strategy.md` §1.1; `plans/w2-mainline.plan.md` v1.5 §2 Block H + §4.4 命令 UX SC-12-15 + §4.10 单兵 cli ergonomics
  - 平行 spec: `multi-bot-routing.md` (multi-bot 形态, W2.5), `single-bot-concurrent-agents.md` v0.2 (Phase 4 C3, §6.4 typed `/stop` 多 active session = stop-all 替代 W2 阶段 `/stop-all`); `agent-adapter.md` §11.5 (Phase 4 C2)
  - 下游 spec: `process-supervision-bounds.md` v0.2 (stop.signal 协议 §3.6 + 双层 heartbeat §3.5)
  - 部署: `docs/guides/multi-bot-setup.md` (W2.5 同步产出)
  - 实现 cross-link: `apps/wb-bot/src/feishu/captain.ts` (W2.5 only, W2 阶段 4 项退化命令落点)
