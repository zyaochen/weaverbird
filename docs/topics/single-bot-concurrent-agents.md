# TOPIC-W2-C · 单 bot 内并发多 agent (Tier 1)

> **版本**: v0.2 (Phase 4 C3, 2026-05-30 主设计师 sync from plan v1 + plan v1.5)
> **状态**: spec (Phase 4 C3 sync)
> **创建**: 2026-05-29 (v0.1-draft); v0.1 → v0.2 同步 W2 plan v1 命令 UX 修订 (C.H-1 空格语法 + C.H-2 多卡片 UX + C.M-1/C.M-5/C.M-6 + 决断 9 typed `/stop` = stop-all + D.H-3 W2 botId='default' + D.M-3 displayEmoji 改 wb-bot metadata)
> **承接**: [docs/product-strategy.md](../product-strategy.md) §1.1 Tier 化产品哲学, W2 主线 Block C; cross-link `plans/w2-mainline.plan.md` §2 Block C + §4.4 scope key + §4.5 AgentEvent v0.3 schema; plan v1.5 §4.6 strength-following + §4.10 工程原则 (单兵 cli ergonomics)
> **性质**: 设计 spec, 描述 scope key 语义、并发隔离规则、卡片 identity 契约; 不描述具体 TS 实现

> **W2 阶段 botId 标注 (D.H-3 + D5.5 + D8.4)**: 本 spec 涉及的 `<botId>` 在 W2 阶段恒为 internal constant `'default'`, 不暴露 user-facing (用户语法不接受 `bot=<id>`); 多 bot 形态延伸到 W2.5 (`multi-bot-routing.md`).

---

## 1. 本文档回答什么 / 不回答什么

### 回答

- W1 现状: 单 thread 多 agent 为何串行排队
- scope key 从 `(user, thread)` 升级到 `(user, thread, agent)` 的语义影响
- `thread_binding` 表语义如何重定义 (`default agent for thread` vs `agent registry`)
- 卡片 header 如何承载 agent identity (emoji + name) — displayEmoji 走 wb-bot 内部 metadata (D.M-3)
- `/agent <id> <prompt>` 空格语法 slash 行为契约 (砍 v0.1 `/agent=` alias, C.H-1)
- typed `/stop` 在多 active session 下 = `/stop-all` 别名 (决断 9)
- 多卡片 UX 规范 (header 标准化 + SC-13 不发新 message, C.H-2)
- busy queue 如何按 `(thread, agent)` 隔离, 跨 agent 互不阻塞
- 单 bot 模式 (`WB_MODE=single`) 的默认体验

### 不回答

- 多 bot 多进程形态 → 见 `multi-bot-routing.md` (W2.5)
- 跨 agent 数据流动 (forward / pipeline) → §1.1 "用户驱动" 原则; W3+ UI 转发候选
- `AgentEvent` schema 升级 (subagentId frozen exception / tool_progress unfrozen) → `agent-adapter.md` §11.5 + §11.7 (Phase 4 C2 sync)
- Captain bot control plane 命令 → `captain-bot.md` (W2.5-only header, W2 仅实施 §3.1/§3.5/§3.6/§3.7 single-bot 退化版)
- process supervision 文件 IPC → `process-supervision-bounds.md` v0.2 (Phase 4 C1)

---

## 2. W1 现状与限制

```
W1 active session map key:
  scopeKey = `${userOpenId}:${threadId}`

含义: 1 个 thread 同时只能有 1 个 active agent run

后果:
  用户 @bot 1: claude 跑中
  用户 @bot 2 (即使是 /agent codex): 走 busy queue,
    弹 "上一条请求仍在处理" 卡片, 必须等 claude 完或 /stop
```

这是 SRE 凌晨场景的硬性限制: 同 1 个 thread 无法 claude + codex + mira 并发分头查.

---

## 3. scope key 升级

### 3.1 新 scope key

```
W2 active session map key:
  scopeKey = `${userOpenId}:${threadId}:${agentId}`

含义: 同 thread 内, 每个 agent 是独立 active session, 互不阻塞
```

### 3.2 数据结构变化

```text
EventHandler 内部状态 (修订):
  activeSessions       : Map<scopeKey: string, ActiveSession>
  activeSessionsByMessageId : Map<messageId: string, ActiveSession>  // 不变, 仍按 messageId 索引

ActiveSession (修订):
  scopeKey         : string                      // 含 agentId
  agentId          : string                      // 新增显式字段
  sourceMessageId  : string
  replyMessageId   : string
  run              : AgentRun
  pipeline         : CardPipeline
  state            : StreamState
  extraMessageIds  : string[]
```

### 3.3 并发示例

```
用户 @bot 1: "/agent claude 看 impact"
  → 创建 session, scopeKey = "open_xxx:chat_yyy:claude-code"
  → activeSessions 存入

用户 @bot 2: "/agent codex 查 RCA"  ← 此时 claude session 仍在跑
  → scopeKey = "open_xxx:chat_yyy:codex" ≠ claude 的 scopeKey
  → 不命中 busy queue
  → 直接创建新 session 并发跑

用户 @bot 3: "/agent codex 给 rollback"  ← codex session 仍在跑
  → scopeKey = "open_xxx:chat_yyy:codex" = 既有 codex session 的 scopeKey
  → 命中 busy queue, 弹 "codex 上一条仍在处理" 卡片
```

### 3.4 多卡片 UX 规范 (Phase 4 C3 sync, C.H-2 partial accept)

W2 单 thread 内多 agent 并发时, 同一时刻可能存在 ≥2 张 active 卡片. UX 必须避免视觉混乱.

**规范**:

```
SC-13 (新, plan v1 §4.4): 卡片渲染严格不发新 message, 仅 patch 现存卡片
  - 每个 active session 持有 1 个 messageId (W1 已有)
  - tool_progress / text_delta / tool_result / done 全部 PATCH 进同一卡片
  - 不允许在 thread 内追加新消息体 (原因: 飞书 thread 已经是天然时间线; 卡片是 active state, 不是事件流)

SC-14 (新, plan v1 §4.4): header 标准化
  - line 1: <emoji> <displayName> · <agentId>     (e.g. "🧠 Claude Code · claude-code")
  - line 2: <status badge> · <elapsed> · <cwd-tail>
    例: "🟢 running · 02:15 · ~/services/api"
  - emoji 来自 wb-bot 内部 metadata (apps/wb-bot/src/agent-display.ts), 不来自 adapter 字段
    (D.M-3 决议: 跟 §5.1 一致)

视觉示意 (单 thread 内 claude + codex 并发):

┌──────────────────────────────────┐
│ 🧠 Claude Code · claude-code     │
│ 🟢 running · 02:15 · ~/api       │
│ ──────────────────────────────── │
│ 看 impact 中 ...                 │
│ [STOP]                           │
└──────────────────────────────────┘
┌──────────────────────────────────┐
│ ⚡ Codex · codex                  │
│ 🟢 running · 00:45 · ~/api       │
│ ──────────────────────────────── │
│ 查 RCA 中 ...                    │
│ [STOP]                           │
└──────────────────────────────────┘
```

**为什么要写 SC-13/SC-14 进 spec**: C.H-2 review 提出 "多卡片视觉糊成一团" 风险; 这两条 SC 是 plan v1 决议的最小可接受 UX 不变量, 实施层不允许偏离.

---

## 4. `thread_binding` 表语义重定义

### 4.1 W1 语义 (有歧义)

```sql
CREATE TABLE thread_binding (
  user_open_id TEXT,
  thread_id    TEXT,
  agent_id     TEXT,        -- W1: 这个 thread 默认用哪个 agent?
                            --      也表示"最后一次用过的 agent"?
                            --      也充当"thread 允许的 agent 集合"?
  cwd          TEXT,
  PRIMARY KEY (user_open_id, thread_id)
);
```

### 4.2 W2 语义 (明确)

```
thread_binding 表 = "thread 的默认 agent 偏好 + cwd 偏好"

语义:
  (user, thread) → (default_agent_id, cwd)
  
  用户 @bot 不带 /agent 时, 选 default_agent_id
  用户 @bot 带 "/agent <id> <prompt>" 时, 显式覆盖, 不修改 binding (除非另发 /use <id>)
  
  并发的多个 agent session 不通过此表反映 (它们在 activeSessions map)
  
不再充当:
  ✗ "thread 允许的 agent 集合" (任何 registered agent 都能用)
  ✗ "最后一次用的 agent" (隐式 last-used 不再决定 default)
```

### 4.3 schema 演进

```sql
-- W2 不改 schema 表结构, 仅明确语义
-- W2.5 加 bot_id 列, 但 W2 阶段不动

-- 同时 W2 加索引提升查询效率
CREATE INDEX IF NOT EXISTS idx_thread_binding_user 
  ON thread_binding(user_open_id, thread_id);
```

---

## 5. 卡片 identity (emoji + name)

### 5.1 数据来源 (Phase 4 C3 sync, D.M-3 决议)

W2 plan v1 决议: displayEmoji **不进 core types AgentAdapter contract**, 改进 wb-bot 内部 metadata map. 跟 §1.2 抽象冻结纪律 + plan v1.5 §4.6 strength-following 一致 (不为 UI 字段扩 core contract).

```
wb-bot 内部 static metadata map:
  apps/wb-bot/src/agent-display.ts

  type AgentDisplayMeta = {
    emoji: string;              // 卡片 header 视觉区分
    supportsSubagent: boolean;  // 是否走折叠 UI (outcome A) vs 平面 UI (outcome C)
  };

  const AGENT_DISPLAY: Record<string, AgentDisplayMeta> = {
    'claude-code': { emoji: '🧠', supportsSubagent: true },
    'codex':       { emoji: '⚡', supportsSubagent: false },
    'mira-cli':    { emoji: '🔧', supportsSubagent: false },
  };

CardRenderer 渲染规则:
  meta = AGENT_DISPLAY[adapter.id] ?? { emoji: '🤖', supportsSubagent: false }
  header = `${meta.emoji} ${adapter.displayName} · ${adapter.id}`
  例: "🧠 Claude Code · claude-code"
      "⚡ Codex · codex"
      "🔧 Mira · mira-cli"
      "🤖 Custom-Agent · custom" (注册了 adapter 但未在 metadata map 内)
```

**为什么不进 core types**:
- UI metadata 是 wb-bot consumer 关心的, 不是 AgentAdapter contract 关心的 (D.M-3)
- 跟 W1 承诺 "加新 agent ≈ 200 LOC" 一致 (synthesis §2.5 / C.L-3): 加新 agent = adapter 注册 + agent-display.ts metadata 添加 ≈ 几行
- 决断 §二.2 + plan v1.5 §4.6 strength-following: agent 强 (CLI 自带 displayName) 我们让步, 不重复扩 core contract
- cross-link `agent-adapter.md` §11.5 #21 + §11.7 决议汇总

### 5.2 emoji 选择规范 (内置 agent + 字符校验)

```
内置 emoji:
  claude-code → 🧠 (大脑, 通用智能)
  codex       → ⚡ (高效, 代码强)
  mira-cli    → 🔧 (工具型)
  未注册      → 🤖 (默认机器人 fallback)

字符校验 (Phase 4 C3 sync, plan v1 §4.4 SC-12):
  - 长度: ≤ 4 UTF-16 字符 (避免飞书卡片 header 溢出)
  - 必须是单 grapheme cluster (Intl.Segmenter / String.prototype.normalize 验证)
  - 拒绝: 普通 ASCII 字母 (避免跟 displayName 视觉混淆)
  - 拒绝: 控制字符 / 方向标记 / 零宽字符
  
  实施: apps/wb-bot/src/agent-display.ts 启动时静态校验, 不通过则启动失败 + 显式
       error log "agent-display: emoji must be single grapheme cluster, ≤ 4 UTF-16 chars"

  非规范, 用户自定义 adapter 可任意指定 (走 metadata map 添加).
```

### 5.3 cwd 渲染 (W1 已有, W2 调整为 header 第二行)

```
卡片 header 形态 (W2, SC-14):
  line 1: `${emoji} ${displayName} · ${agentId}`
  line 2: `${statusBadge} · ${elapsed} · ${shortCwd}`
  
  例:
    🧠 Claude Code · claude-code
    🟢 running · 02:15 · ~/code/foo
```

### 5.4 outcome A vs outcome C UI 对照 (Phase 4 C3 sync, plan v1 §7 D6)

W2 dynamic workflow 卡片 UI 取决于 `AGENT_DISPLAY[id].supportsSubagent`:

```
outcome A (claude-code, supportsSubagent: true) — 折叠 UI

┌─────────────────────────────────────────┐
│ 🧠 Claude Code · claude-code            │
│ 🟢 running · 12:34 · ~/services/api     │
│ ─────────────────────────────────────── │
│ 主线程 (3 events)                       │
│   text: 拆解 RCA 思路 ...               │
│ 16 个 subagent (12 done, 4 running):    │
│   ▸ subagent-1 (read_file)              │
│   ▸ subagent-2 (run_tests) ← running    │
│   ▸ ... 14 more ...                     │
│ [STOP]                                  │
└─────────────────────────────────────────┘

outcome C (codex / mira-cli, supportsSubagent: false) — 平面 UI

┌─────────────────────────────────────────┐
│ ⚡ Codex · codex                         │
│ 🟢 running · 02:15 · ~/services/api     │
│ ─────────────────────────────────────── │
│ text: 查 service-foo RCA                │
│ tool_use: read_file(/var/log/api.log)   │
│ tool_result: 200 lines, ERROR at line 5 │
│ tool_use: run_tests(suite=integration)  │
│ tool_progress: 12/45 tests passed ...   │
│ [STOP]                                  │
└─────────────────────────────────────────┘
```

折叠阈值: ≥10 subagent 时折叠为 "N 个 subagent (M done)" 摘要 (cross-link `agent-adapter.md` §11.5 #22).

---

## 6. `/agent <id>` slash 命令契约 (Phase 4 C3 sync, C.H-1 空格语法)

### 6.1 行为 (空格语法, 砍 v0.1 `/agent=` alias)

W2 plan v1 决议: 砍 v0.1 `/agent=<id>` 等号 alias, 改空格语法 `/agent <id> <prompt>`. 理由 (C.H-1):

- 空格语法跟其他 slash 命令统一 (`/use <id>`, `/stop`, `/tasks <N>`)
- 等号语法 `/agent=xxx` 跟 shell `KEY=VALUE` 视觉冲突, 用户容易误以为是变量赋值
- 单兵 cli ergonomics (plan v1.5 §4.10) 要求最小语法负担

```
触发: prompt 开头匹配 ^/agent\s+([a-z][a-z0-9_-]{0,31})\s+(.*)$

行为:
  1. 提取 capture group 1 作为本次 run 的 agent_id (不变 binding)
  2. capture group 2 (剥离 /agent <id>) 作为真实 prompt
  3. 创建 session, scopeKey = `${userOpenId}:${threadId}:${agentId}` (§3.1)

例:
  "/agent codex 查 service-foo RCA"
  → agent_id = codex
  → prompt = "查 service-foo RCA"

校验:
  agent_id 不在 registered agents → 卡片错误文案 "未注册 agent: <id>; 已注册: claude-code / codex / mira-cli"
  agent_id 不通过正则 → 卡片错误文案 "agent id 必须是 [a-z][a-z0-9_-]{0,31}"
  prompt 为空 (只发 "/agent codex") → 卡片错误文案 "请在 /agent <id> 后面写要执行的指令"
```

### 6.2 与 `/use <id>` 区别 (Phase 4 C3 sync, 删 `/bind` 幻象)

W1 实际命令是 `/use <id>` (改 thread_binding.agent_id), v0.1 spec 误称 `/bind` 是幻象 (synthesis §3.2 C3): W2 plan v1 决议改正:

```
/agent <id> <prompt>     : 一次性, 不改 binding (适合并发分流)
                           e.g. "/agent codex 查 RCA"
                           
/use <id>                : 永久, 改 binding.agent_id (适合长期默认)
                           e.g. "/use claude-code"
                           
/agent <id> + /use <id>  : 跟 git checkout vs git checkout -b 类似的二元区分:
                           前者临时切换不留痕, 后者切换 + 改默认偏好
```

实施层 cross-link: `apps/wb-bot/src/feishu/event-handler.ts` 命令 router (W1 已有 `/use`, W2 加 `/agent`).

### 6.3 未指定 agent 时的 fallback (W1 已有, W2 不变)

```
1. 查 thread_binding.agent_id (用户的偏好)
2. 若 NULL: resolveDefaultAgent() (W1 已有, 选 PREFERRED_AGENT_ORDER 第一个可用的)
```

### 6.4 typed `/stop` 多 active session 行为 (Phase 4 C3 sync, 决断 9)

W2 单 thread 内可能有 ≥2 个 active session (e.g. claude + codex 并发). typed `/stop` (用户在 thread 输入文本, 非卡片按钮) 必须明确语义.

W2 plan v1 决议 (synthesis §2.7 决断 9):

```
typed /stop (无参数), 当 thread 内有:
  - 0 个 active session → 卡片 "当前没有正在运行的任务"
  - 1 个 active session → stop 该 session (W1 行为, 不变)
  - ≥2 个 active session → stop **全部**, 等价 /stop-all 别名
                            卡片汇总 "已停止 N 个任务: claude-code / codex"

typed /stop <id> (有参数, 显式指定):
  - <id> 不在 active sessions → 卡片 "<id> 未在运行"
  - <id> 在 active sessions → stop 该 session

卡片 STOP 按钮 (非 typed) → 永远只 stop 该卡片对应的单 run
                            (按钮原本就承载 messageId → run 的 1:1 映射, 无歧义)
```

理由:
- typed `/stop` 在多 active session 下, 用户意图最常是 "全停" (e.g. "凌晨乱了, 我先把所有都停了"), 让 stop-all 是默认是更安全
- 显式 `/stop <id>` 留给少数想精准停某一个的场景
- 卡片按钮 vs typed 命令物理来源不同, 不会互相误触
- decision 在 plan v1 §4.4 SC-15 落档

---

## 7. busy queue 按 `(thread, agent)` 隔离

### 7.1 检测逻辑 (修订)

```
W1: this.activeSessions.has(scopeKey)
    其中 scopeKey = user:thread

W2: this.activeSessions.has(scopeKey)
    其中 scopeKey = user:thread:agent

含义:
  同 thread, 不同 agent → 不命中 busy, 各自并发
  同 thread, 同 agent → 命中 busy, 弹 "等待或 STOP"
```

### 7.2 busy 卡片文案

```
W1: "上一条请求仍在处理, 请等待或点击 STOP"

W2 修订: 
  "<agent_name> 上一条仍在处理, 请等待或点击 STOP"
  例: "Claude Code 上一条仍在处理, 请等待或点击 STOP"

理由: 同 thread 多 agent 并发时, 用户必须能知道哪个 agent 还在跑
```

---

## 8. `WB_MODE` 配置

### 8.1 两个值

```
WB_MODE=single (默认, W2 用此模式)
  - 1 个 wb-bot 进程 = 1 个飞书应用 = 1 个 bot identity
  - 单 bot 内并发多 agent
  - schema 中 bot_id 列默认 'default'
  - Captain 命令在此模式下指自身 (无跨 bot)
  
WB_MODE=multi-bot (W2.5 启用)
  - N 个 wb-bot 进程 = N 个飞书应用 = N 个 bot identity
  - 详见 multi-bot-routing.md
  - default bot 升 Captain
```

### 8.2 W2 兼容性

```
W1 用户的 .env 不需要任何变更, 自动以 WB_MODE=single 运行
新增的 "/agent <id>" 用法对老用户也立即可用
W2 阶段 botId 内部恒为 'default', 用户不感知 bot_id 概念 (D.H-3)
```

---

## 9. 工作项清单 (W2 Block C)

```
C0  thread_binding 语义重定义 spec 写入                          ~0.5 天
C1  scope key 升级 (event-handler.ts)                            ~1 天
C2  ActiveSession 加 agentId 字段                                ~0.5 天
C3  busy queue 按 (thread, agent) 隔离                           ~0.5 天
C4  busy 卡片文案加 agent_name                                    ~0.5 天
C5  /agent <id> 空格语法 slash 命令实现 (command-router)         ~0.5 天
C6  CardRenderer 使用 wb-bot 内部 metadata (agent-display.ts)    ~0.5 天
C7  集成测试: 3 agent 同 thread 并发跑                            ~1 天
C8  集成测试: 同 agent 同 thread busy 排队                       ~0.5 天
C9  typed /stop 多 active session = stop-all (决断 9)            ~0.3 天
C10 多卡片 SC-13/SC-14 UX 不变量实施 + 测试                       ~0.5 天

合计: ~5.8-6.8 天 (Phase 4 C3 sync 后, 原 audit 修订 ~5-6 天)
```

---

## 10. 不做的事 (避免漂移)

```
✗ thread 内 agent 之间数据自动流动 (M3)
  → 用户必须显式 "/agent <id>" 切换并重发 prompt
  
✗ scope 中再加额外维度 (e.g. (user, thread, agent, model))
  → W2 仅升级到 agent, 不引入更细粒度
  → 不同 model 仍视为同一 agent (e.g. claude opus vs sonnet 都是 claude-code)
  
✗ thread_binding 表充当 "session inventory"
  → activeSessions Map 是唯一 in-flight session 真实来源
  → thread_binding 只是用户偏好
  
✗ /agent <id> 自动启动多个 agent 并发跑
  → 一次 /agent <id> 只启 1 个; 用户要 3 个 agent 并发要发 3 条消息
  
✗ 砍 v0.1 /agent=<id> 等号 alias (Phase 4 C3 sync, C.H-1)
  → 只接受空格语法 "/agent <id> <prompt>"
  → 即使容易支持双语法, 不做 — 单兵 cli ergonomics 要求最小语法负担
```

---

## 11. Open questions (留 W2.5/W3)

1. **/agent <id> 是否支持 `/agent claude,codex,mira` 并发 fan-out** —— 一条消息启 N 个 agent 并发, 同 prompt 给每个. 听起来便利, 但 prompt 智能裁剪 (不同 agent 需要的 context 不同) 是 framework drift 的入口. **不做**, 用户要并发自己发 N 条消息.

2. **busy 卡片是否加 "queue/排队" 选项** —— 当前 W1 行为是拒绝并提示等待. 用户可能希望 "排队等前一个完成自动继续". 听起来友好, 但实现要存 prompt + 长时间持久化, 风险高. **不做**, 用户自己 /stop + 重发.

3. **`/agent <id>` 是否记录到 binding 作 last-used** —— 是否方便, 但与 §4.2 "binding 只反映偏好不反映 last-used" 冲突. **不做**, 用户用 /use 显式偏好.

4. **AgentRegistry 是否需要 hot-reload** —— 加新 agent 需要重启 wb-bot. 是否支持运行时 register/unregister? W2/W2.5 不做, 重启可接受.

---

## 12. 文档元数据

- **版本**: v0.2 (Phase 4 C3 sync, 2026-05-30 主设计师)
- **状态**: spec
- **创建**: 2026-05-29 (v0.1-draft); v0.2 同步 W2 plan v1 命令 UX 修订
- **修订方式**:
  - **2026-05-30 v0.2 (Phase 4 C3)**: 头部加 W2 botId='default' 标注 (D.H-3); §1 范围调整; §3.4 (新) 多卡片 UX 规范 SC-13 + SC-14 (C.H-2 partial); §5.1 displayEmoji 改 wb-bot 内部 metadata (D.M-3); §5.2 字符校验 ≤4 + 单 grapheme cluster (plan v1 §4.4 SC-12); §5.3 cwd 渲染调整为 header 第二行; §5.4 (新) outcome A/C UI 对照 (plan v1 §7 D6); §6 改空格语法 + 砍 `=` alias (C.H-1); §6.2 删 `/bind` 幻象, 改 `/use <id>` (synthesis §3.2 C3); §6.4 (新) typed `/stop` 多 active session = stop-all (决断 9); §9 工作清单加 C9/C10; §10 加 \"砍 `=` alias\" negative; §12 元数据更新.
  - 后续修订: 以独立 plan / PR 形式提交.
- **关联**: 
  - 上游: `docs/product-strategy.md` §1.1; `plans/w2-mainline.plan.md` v1.5 §2 Block C + §4.4 多卡片 UX SC-12-15 + §4.10 单兵 cli ergonomics
  - 平行 spec: `multi-bot-routing.md` (Tier 2, W2.5), `agent-adapter.md` §11.5 + §11.7 (Phase 4 C2: subagentId frozen exception + tool_progress unfrozen + tokenRotation capability + displayEmoji 改 wb-bot metadata 决议)
  - 下游 spec: `captain-bot.md` (Captain control plane 命令; Phase 4 C3 sync 后 W2.5-only header), `process-supervision-bounds.md` v0.2 (Phase 4 C1: events.ndjson source of truth + 双层 heartbeat)
  - 实现 cross-link: `apps/wb-bot/src/feishu/event-handler.ts` (scope key 升级 + 命令 router); `apps/wb-bot/src/agent-display.ts` (新, displayEmoji + supportsSubagent metadata 落点)
