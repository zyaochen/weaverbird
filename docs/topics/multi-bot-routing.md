# TOPIC-W2.5-G · 多 bot 多进程路由 (Tier 2)

> **版本**: v0.1-draft
> **状态**: draft
> **创建**: 2026-05-29
> **承接**: [docs/product-strategy.md](../product-strategy.md) §1.1 Tier 化产品哲学, W2.5 主线 Block G
> **性质**: 设计 spec, 描述多 bot 多进程模型、文件 IPC 协议、SQLite WAL 共享、mention 过滤; 不描述部署操作步骤 (见 `docs/guides/multi-bot-setup.md`)

---

## 1. 本文档回答什么 / 不回答什么

### 回答

- 为什么飞书侧"1 应用 N bot"不存在 → 多应用各 1 bot 是唯一物理形态
- wb-bot 多进程模型: 每 bot 1 个 Node.js worker 进程
- 共享数据层: SQLite WAL + runs/ 文件 IPC + logs/ 隔离
- `WB_MODE=multi-bot` 启用条件与兼容性
- bot identity 自检: 每 worker 启动时 query 自己的 open_id, 用于 mention 过滤
- 跨进程 stop 信号文件 IPC 协议
- `open_id` per-app scoped 的工程含义 (跨 bot 用户身份不共享)

### 不回答

- Captain bot control plane 命令 (`/status` / `/stop-all` / `/restart`) → `captain-bot.md`
- 单 bot 内多 agent 并发 → `single-bot-concurrent-agents.md`
- AgentEvent schema → `agent-adapter.md` §13
- 部署步骤 (launchctl / plist 模板 / 飞书后台建应用) → `docs/guides/multi-bot-setup.md` (W2.5 同步产出)
- mira-cli MiraAgent adapter 形态 → mira-cli 上线后另写

---

## 2. 调研结论速览 (KKK-β 来源)

```
C1 · 飞书原生不支持 1 应用 N bot identity (1 应用 = 1 bot, 固定 name/avatar)
C2 · open_id 是 per-app scoped (同用户在不同 bot 应用下 open_id 不同)
C3 · 同 bot 内 user @ bot 不受影响 (W1 形态不动)
C4 · 1 Node.js 进程能挂多个 Lark.WSClient (但单进程 crash 全死, 不符合 SRE 凌晨场景)
C5 · 配新 bot 用户成本: 飞书后台 15-30 min (企业用户走审批可能数小时)
```

→ 选定形态: **多应用各 1 bot, 每 bot 独立进程, 共享数据层**

---

## 3. 进程模型

> **W2 阶段 botId 标注 (Phase 4 C3 sync, D.H-3 + 决断 §二.1)**: 本 spec 描述的多 bot 拓扑 (`runs/<botId>/`, `logs/<botId>/`) 是 W2.5 启用后的形态. **W2 阶段 `<botId>` 内部恒为 `'default'`, 用户不感知**, 路径形态在 W2 单 bot 模式下退化为 `runs/default/<runId>/`, `logs/default/wb-bot.log`. cross-link `single-bot-concurrent-agents.md` 卷首 W2 botId 标注 + `captain-bot.md` ⚠️ 实施范围声明.

### 3.1 拓扑

```
~/.local/share/weaverbird/ (XDG_DATA_HOME)
  data/
    wb-bot.sqlite          ← WAL mode, 多 process 共享
    wb-bot.sqlite-wal      ← WAL 文件
    wb-bot.sqlite-shm      ← shared memory
    runs/<botId>/<runId>/  ← process supervision, 按 bot 子目录隔离
    logs/<botId>/wb-bot.log ← 按 bot 子目录隔离, daily rotate
    sock/                  ← 预留 (W3+ 若需 Unix socket IPC)

      ↑          ↑          ↑          ↑
      │          │          │          │
 ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐
 │bot:    │ │bot:    │ │bot:    │ │bot:    │
 │default │ │claude  │ │codex   │ │mira    │
 │(W1 兼容)│ │        │ │        │ │        │
 └────────┘ └────────┘ └────────┘ └────────┘
```

### 3.2 单 worker 进程的职责

```
每个 wb-bot worker:
  - 自己的 .env 文件 (LARK_APP_ID/SECRET, BOT_ID, AGENT_ALLOWED, CWD allowlist)
  - 自己的 Lark.WSClient + Lark.Client + EventDispatcher
  - 自己的 AgentRegistry (基于 AGENT_ALLOWED 过滤)
  - 自己的 EventHandler + activeSessions Map
  - 自己的 BindingStore 句柄 (但底层 SQLite 共享)
  - 自己的 pino logger (file sink 写 logs/<botId>/wb-bot.log)
  - 自己的 launchd plist (独立重启策略, 互不影响)
```

### 3.3 启动方式

```
wb-bot start --bot <botId>
  → 读 .env.<botId> (或 .env 若 botId=default)
  → 设置 BOT_ID=<botId> 环境变量
  → 初始化数据层 (SQLite WAL 共享 + runs/<botId>/ + logs/<botId>/)
  → 启动 WSClient + EventHandler
```

```
launchd 自动启动 (用户 install 后):
  com.weaverbird.wb-bot.default.plist
  com.weaverbird.wb-bot.claude.plist
  com.weaverbird.wb-bot.codex.plist
  com.weaverbird.wb-bot.mira.plist
  
  每个 plist 内: ProgramArguments = [..., "--bot", "<botId>"]
```

---

## 4. WB_MODE 配置

### 4.1 两种模式

```
WB_MODE=single (W2 默认, 单 bot 形态)
  - 仅启动 1 个 worker (BOT_ID 默认 'default')
  - schema 中 bot_id 列写 'default'
  - 不识别其它 bot 的 runs/ logs/
  
WB_MODE=multi-bot (W2.5 启用)
  - 用户启动 N 个 worker (各自 .env.<botId>)
  - schema 中 bot_id 列写各自 botId
  - default worker (若运行) 升 Captain (见 captain-bot.md)
```

### 4.2 启用方式

```
Single mode (W2 默认):
  # 用户 .env 无变化, 自动单 bot
  WB_MODE 字段可不设, 默认 single
  
Multi-bot mode (W2.5):
  # 全局开关 (建议放 ~/.weaverbird/global.env 或 default .env):
  WB_MODE=multi-bot
  
  # 每 worker 自己的 .env.<botId>:
  BOT_ID=claude
  LARK_APP_ID=cli_yyy
  LARK_APP_SECRET=yyy
  AGENT_ALLOWED=claude-code            # 只暴露 claude-code 给此 worker
  
  # 等等
```

### 4.3 兼容性

```
W1 用户的 .env 完全不动, 自动以 single mode 运行
W2 用户在 single mode 享受单 bot 并发多 agent
W2.5 用户可选择启用 multi-bot, 但 single mode 仍是默认
```

---

## 5. 数据层共享

### 5.1 SQLite schema 演进 (W2.5)

```sql
-- W1 表 (现状)
CREATE TABLE thread_binding (
  user_open_id TEXT,
  thread_id    TEXT,
  agent_id     TEXT,
  cwd          TEXT,
  PRIMARY KEY (user_open_id, thread_id)
);

-- W2.5 migration: 加 bot_id 列
ALTER TABLE thread_binding ADD COLUMN bot_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE agent_continuation ADD COLUMN bot_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE inflight_card ADD COLUMN bot_id TEXT NOT NULL DEFAULT 'default';

-- 主键升级
-- thread_binding 主键: (user_open_id, thread_id, bot_id)
-- agent_continuation 主键: (user_open_id, thread_id, bot_id, agent_id)
-- inflight_card 主键: (user_open_id, thread_id, bot_id)
```

### 5.2 WAL 模式多进程安全

```
better-sqlite3 默认 journal_mode=WAL, 多进程 reader 安全
多进程 writer: WAL 锁是 OS 文件锁, 毫秒级

启动时强化:
  PRAGMA journal_mode=WAL;
  PRAGMA synchronous=NORMAL;
  PRAGMA busy_timeout=5000;        -- 5s, 防 SQLITE_BUSY
  
写操作:
  BEGIN IMMEDIATE                  -- 显式加锁, 不靠隐式
  ... INSERT/UPDATE ...
  COMMIT
```

### 5.3 跨 bot 数据隔离原则

```
每个 bot worker 写自己 bot_id 的行 (天然隔离, 冲突域为 0)
读操作可跨 bot (e.g. Captain /status 跨 bot 查询 inflight_card)

注意: 
  - open_id 是 per-app scoped, 跨 bot 不共享身份
  - 同一物理用户 (e.g. 你 SRE), 在 default-bot 下 open_id_A
    在 claude-bot 下 open_id_B, 在 codex-bot 下 open_id_C
  - thread_binding 表的 (user_open_id, ..., bot_id) 复合主键自然处理这点
  - 不做 union_id 跨 bot 用户身份合并 (W2.5 不做, 留 W3+)
```

---

## 6. runs/ 目录跨 bot 隔离

### 6.1 路径约定

```
~/.local/share/weaverbird/data/runs/<botId>/<runId>/
  spec.json          ← run 元数据 (agentId, model, prompt, started_at, ...)
  output.log         ← agent CLI stdout (append-only)
  events.ndjson      ← parsed AgentEvent stream (append-only)
  status             ← 当前状态 (running / done / error / stopped)
  stop.signal        ← 写此文件触发 graceful stop (跨进程信号)
  pid                ← detached child PID
```

详见 `process-supervision-bounds.md`. 这里仅说明 bot 维度隔离.

### 6.2 跨 bot 读 (Captain 用)

```
Captain /status 跨 bot 查询逻辑 (在 default worker 进程内):
  1. 扫描 runs/*/ 各子目录, 找各 bot 的 runs
  2. 读各 runs 的 status 文件 (不 lock, 直接读)
  3. 渲染汇总卡片

注意:
  - 各 bot worker 写自己 runs/<botId>/, 不写其它
  - default worker 只读其它 bot 的 runs/, 不写
  - 读写并发 OK (append-only + 原子 rename 写 status)
```

### 6.3 跨 bot 写 (stop-all 用)

```
Captain /stop-all 写 stop.signal 协议:
  1. 列出所有 bot worker 的 active runs (从各 runs/<botId>/ 读 status==running)
  2. 对每个 active run, 写 runs/<botId>/<runId>/stop.signal:
     {
       "issued_by": "captain",
       "issued_at": "2026-05-29T10:30:00Z",
       "reason": "/stop-all from user"
     }
  3. 各 bot worker 的 watcher (fs.watch) 看到此文件后, 触发 graceful stop
  4. worker 处理完 stop 后, 删 stop.signal 文件 (清理)

容错:
  - 若 stop.signal 已存在但 stale (超 60s), worker 启动时强制清理
  - watcher 失效兜底: worker 每 5s polling 一次本 botId 下所有 runs 的 stop.signal
```

---

## 7. bot identity 自检 + mention 过滤

### 7.1 启动时自检

```
worker 启动后立刻 query 自己的 bot info:
  GET /open-apis/bot/v3/info
  → 返回 { bot: { open_id: "ou_xxx_bot_self", ... } }
  
将 open_id_bot_self 缓存在 EventHandler 内存中
```

### 7.2 mention 过滤

```
EventHandler 收到 im.message.receive_v1 事件后:
  1. 解析 message.content 中的 mentions list (Lark 推送的)
  2. 若 mentions 包含 open_id_bot_self → 处理
  3. 若 mentions 不含 → 忽略 (避免群里 @ 别人时本 worker 也响应)

例外: 单聊 (chat_type=p2p) 不需要 @ mention, 总是处理
```

### 7.3 多 bot 在同一群里的预期行为

```
群里有 3 个 wb-bot: default-bot, claude-bot, codex-bot

用户消息 "@claude-bot 帮我看 RCA":
  → default-bot worker 收事件, mentions 不含自己 → 忽略
  → claude-bot worker 收事件, mentions 含自己 → 处理
  → codex-bot worker 收事件, mentions 不含自己 → 忽略

用户消息 "@claude-bot @codex-bot 一起看":
  → default-bot worker 忽略
  → claude-bot worker 处理 (回卡片 1)
  → codex-bot worker 处理 (回卡片 2)
```

---

## 8. 故障隔离

### 8.1 进程级隔离 (Tier 2 核心收益)

```
场景                     单进程 N WSClient 后果    多进程后果
─────────────────────────────────────────────────────────
claude agent crash       全进程死, 3 bot 全失联    仅 claude bot 失联
codex CPU 100%           其它 bot WSClient ack 超时 其它 bot 不受影响
mira OOM                 全进程死                  仅 mira bot 失联
某 bot token 过期重启     全进程重启                仅该 bot 重启
SQLite 长 transaction    阻塞所有 bot              其它 bot 等 5s busy_timeout
```

### 8.2 launchd 自动重启

```
plist 配置 KeepAlive=true, 任一 bot worker 崩溃后 launchd 自动拉起 (~2s)
重启后通过 process-supervision-bounds 协议恢复 inflight runs
```

---

## 9. 工作项清单 (W2.5 Block G) + 实施状态 (W2.5-I close sync, 2026-06-02)

| # | 工作项 | 估时 | 实施状态 | 实施 anchor |
|---|---|---|---|---|
| G0 | `docs/guides/multi-bot-setup.md` 部署文档 (step-by-step + 8 常见错误诊断) | ~1.5 天 | ✅ W2.5-J (lead designer T2 doc-only self-impl) | `docs/guides/multi-bot-setup.md` v1 (604 行, 12 章) — post-W2.5-close (2026-06-02 同 chat) |
| G1 | wb-bot 进程化: `--bot <botId>` CLI + `.env.<botId>` 加载 | ~1 天 | ✅ G.A | `apps/wb-bot/src/cli/parse-args.ts` (MR #12, commit `c350f40`) |
| G2 | schema migration 002: `bot_id` 列 + 主键升级 + 自动迁移 | ~1 天 | ✅ HP + G.A | `apps/wb-bot/src/binding/migrations/002-add-bot-id.ts` (commit `e14b87c` + `c350f40`) |
| G3 | bot identity 自检 (`bot/v3/info` query 缓存) | ~0.5 天 | ✅ G.C | `apps/wb-bot/src/feishu/bot-identity.ts` (commit `6c92922`) |
| G4 | mention 过滤 (event-handler 加 filter) | ~0.5 天 | ✅ G.C | `apps/wb-bot/src/feishu/event-handler.ts` (commit `6c92922`) |
| G5 | `runs/<botId>/` 子目录隔离 + 各 worker 写自己子目录 | ~0.5 天 | ✅ G.B | `apps/wb-bot/src/main.ts` + `apps/wb-bot/src/binding/store.ts` (MR #13, commit `35485d8`) |
| G6 | `logs/<botId>/` pino file sink 子目录隔离 | ~0.5 天 | ✅ G.B | `apps/wb-bot/src/logger.ts` (MR #13) |
| G7 | 跨进程 stop.signal 文件 IPC 协议 + watcher + polling | ~1 天 | ✅ G.B (复用 W2-A) | W2-A 已实施 `apps/wb-bot/src/feishu/event-handler.ts:590`; G.B 跨 bot 复用 |
| G8 | launchd plist 模板生成器 (`scripts/install-bot.sh`) | ~1 天 | ✅ G.B | `scripts/com.weaverbird.wb-bot.plist.tmpl` + `scripts/install-bot.sh` (MR #13) |
| G9 | SQLite WAL 多进程真并发 (≥3 bot × 高频写无 SQLITE_BUSY) | ~1 天 | ✅ G.D.1 | `apps/wb-bot/src/binding/store.ts` `ensureWalMode` retry-loop + `Atomics.wait` sleepSync (commit `42f29b4`) |
| G10 | 集成测试: kill -9 一个 worker 验证其它正常 | ~1 天 | ⏳ manual gate | 主设计师本人 launchctl visual (D1.2 + D1.6 + D4.2) |
| G11 | 集成测试: multi-bot 群里 @ 路由正确性 | ~0.5 天 | ✅ G.C | `tests/wb-bot/event-handler-mention-filter.test.ts` (commit `6c92922`) |

**实施总结** (W2.5-I 2026-06-02 · G0 post-close 2026-06-02): G1-G9 + G11 (10 项) W2.5-I 内 close, G0 W2.5-J 同 chat post-close 内 close (lead designer T2 doc-only self-impl), G10 manual gate 主设计师本人 23 testcase real-path. 合计估时 ~10-11 天 (audit 修订, 原估 1 周偏低), 实际 1 session 6 batch (HP + G.A + G.B + G.C + G.D + G.D.1) + W2.5-I + W2.5-J 内 close.

---

## 10. 不做的事 (避免漂移)

```
✗ 跨 bot 自动消息 (bot a 自动 @ bot b) — M3, 已经反复确认不做
✗ 跨 bot 用户身份合并 (union_id) — W2.5 不做, 留 W3 优化
✗ 单进程 N WSClient 形态 — 不符合 SRE 凌晨故障隔离需求
✗ 1 个飞书应用挂 N bot identity — 飞书原生不支持
✗ 跨 bot config 同步机制 — 各 bot 自己 .env, 不互相 inherit
✗ 跨 bot agent registry 共享 — 各 worker 自己 registry 隔离
✗ 自动 bot scaling (按负载启动新 bot) — 个人工具不需要
```

---

## 11. Open questions (留 W3+)

1. **union_id 引入** —— 跨 bot 用户身份合并, 用 union_id 代替 open_id 作 thread_binding 主键. 优点: Captain 跨 bot 看到统一 "你" 而非分裂 ID. 缺点: 需要 `contact:user.base:readonly` scope, 用户授权多一步. 留 W3, 看实战需求。

2. **bot worker 间的进程发现机制** —— Captain 怎么知道有哪些 worker 在线? 当前方案: 扫 .env.*  文件 + 探测 runs/<botId>/heartbeat 时间. 是否需要 dedicated 注册表 (bot_registry SQLite 表)? W2.5 用文件扫描, W3 可优化。

3. **跨 bot 卡片 STOP 互通** —— 用户在 claude-bot 卡片点 STOP, 能否同时停 codex-bot 的关联 run? 听起来便利, 但语义复杂 (谁是关联?). **不做**, 各 bot STOP 各自管。

4. **多 bot 模式下 Captain 是否一定要 default worker** —— 当前设计 default 升 Captain. 若用户禁用 default 怎么办? W3 看实战, 是否给非 default worker 也加 captain 命令支持。

---

## 12. 文档元数据

- **版本**: v1 (W2.5 close, 2026-06-02)
- **状态**: lock (W2.5 已实施 G1-G9 + G11; G0/G10 推 follow-up)
- **创建**: 2026-05-29 (v0.1-draft); v0.1-draft → v1 W2.5-I batch close sync (2026-06-02)
- **实施 batch**: HP (`e14b87c`) / G.A (`c350f40` MR #12) / G.B (`35485d8` MR #13) / G.C (`6c92922`) / G.D (`ff8b949`) / G.D.1 (`42f29b4`) — 470/470 tests passing
- **关联**:
  - 上游: `docs/product-strategy.md` §1.1
  - 平行: `single-bot-concurrent-agents.md` (Tier 1), `captain-bot.md` (Captain 命令)
  - 部署: `docs/guides/multi-bot-setup.md` (W2.5 同步产出)
  - 边界: `process-supervision-bounds.md` (跨进程文件 IPC 协议)
