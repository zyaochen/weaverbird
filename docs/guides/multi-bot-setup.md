# Multi-bot Setup Guide (W2.5)

> **Audience**: 主设计师本人 (重装 / 换机 / 协作时) · 或后续接手者
> **Scope**: macOS launchctl 路径 · `wb-bot-multi` orchestrator + N worker · Captain 四大件
> **Pre-req**: 已读 [`README.md`](../../README.md) §3 多 bot 模式 quickstart 一遍
> **Tier**: 单机 prosumer 部署 · 不含跨机 fleet (W3+)
> **承接**: [`docs/topics/multi-bot-routing.md`](../topics/multi-bot-routing.md) §3 拓扑 spec · [`docs/topics/captain-bot.md`](../topics/captain-bot.md) Captain 四大件 spec
> **状态**: W2.5-J · 2026-06-02 first cut · close note §3.5 D5.2 defer 项实施

本文档是 step-by-step 部署 runbook. spec 层语义 (为什么多进程 / SQLite WAL 多 process 协议 / open_id per-app scoped 等) 见 `multi-bot-routing.md`. 这里只回答 "怎么从 0 装起来跑通".

---

## 0 · 看本文档前先决断

| 问题 | 决断 | 默认 |
|---|---|---|
| 单 bot 够不够 | 够 → 走 `README.md` §2 W1 路径, **不需要本文档** | 不够 (e.g. 想同群 `@claude` `@codex` 各走不同 agent), 才走本文档 |
| bot 数量 | 推荐 2-4 bot · `default` (Captain, 必有) + `claude` / `codex` / `mira` (按需) | 2 bot |
| 飞书 app 数量 | 与 bot 数量 1:1 · 每 bot 1 个独立飞书 app | 2 app |
| 启动方式 | launchctl (生产, 本文档默认) 或 foreground `node` (smoke / dev) | launchctl |
| Captain enable | `default` bot 自动升 Captain · `WB_DISABLE_CAPTAIN=true` 可关 | enable |

不满足以上任一条件 (e.g. 只想跑 1 bot, 或 Linux/Windows) → **本文档不适用**, 走 `README.md` §2 W1 单 bot 路径.

---

## 1 · Prerequisites

```bash
node --version    # ≥ 22.x (LTS)
npm --version     # ≥ 10.x
sw_vers           # macOS (本文档仅覆盖 macOS launchctl 路径)
launchctl print gui/$UID > /dev/null && echo OK
```

飞书侧:
- 飞书开发者账号 (https://open.feishu.cn/)
- 能创建 N 个独立企业自建应用 (per bot 1 个 app)
- 应用 scope: `im:message` `im:message:send_as_bot` `im:chat` `im:resource` (最少)

依赖前置:
```bash
cd /path/to/weaverbird
npm install         # 安装 monorepo deps (含 better-sqlite3 native)
npm run build       # 编出 dist/ (multi-bot orchestrator 跑 dist 路径)
npm test            # 默认稳定验证面
npm run test:e2e    # 如需额外跑 CLI/provider e2e
```

---

## 2 · botId naming 规则

`apps/wb-bot/src/security/bot-id-validator.ts`:

```
/^[a-z][a-z0-9_-]{0,31}$/

— 必须小写字母开头
— 仅含小写字母 / 数字 / `_` / `-`
— 长度 1-32
— 保留 suffix (不可用) — discovery 跳过: local example test development production staging
```

合法示例: `default` `claude` `codex` `mira` `claude-pro` `codex_v2` `bot1`

**特殊**: `default` 必须存在 (Captain 升级条件 · 见 `apps/wb-bot/src/captain/captain-gate.ts`). 不配 `.env.default` → Captain 路径不可用 (`/list-bots` 等命令降级).

---

## 3 · 飞书 app 创建 (per bot 1 app)

每个 bot 在飞书开发者后台 (https://open.feishu.cn/) 独立创建:

```
1. "创建企业自建应用" → app 名 / icon / 描述 (例: "weaverbird-default" / "weaverbird-claude")
2. 应用功能 → 添加机器人能力
3. 权限管理 → 启用 scope:
   - im:message              (接收 IM 消息事件)
   - im:message:send_as_bot  (机器人发消息 / 卡片)
   - im:chat                 (群信息 / 群成员)
   - im:resource             (上传图片附件, optional)
4. 事件订阅 → 事件方式 "长连接" (推荐, 本项目走 Lark.WSClient)
5. 添加事件:
   - 接收消息 (im.message.receive_v1)
   - 消息已读 (optional)
   - 卡片回调 (card.action.trigger) — STOP 按钮必需
6. 版本管理 → 创建版本 → 提交审核 → 自己 ack 发布 (内部审核)
7. 凭证与基础信息 → 抓:
   - App ID                  (LARK_APP_ID)
   - App Secret              (LARK_APP_SECRET)
   - Verification Token      (LARK_VERIFICATION_TOKEN, 可空)
   - Encrypt Key             (LARK_ENCRYPT_KEY, 可空; 若开了消息加密则必需)
```

把 4 个凭证 (App ID / Secret / Verify Token / Encrypt Key) 各 bot 抓齐, 下一节用.

---

## 4 · 本地 `.env.<botId>` 配置

`apps/wb-bot/src/multi/discovery.ts` 扫 `WB_CONFIG_DIR` (默认 `~/.weaverbird/configs/`) 下所有 `.env.<botId>` 文件. 每文件代表 1 个 worker.

### 4.1 目录结构

```bash
mkdir -p ~/.weaverbird/configs
mkdir -p ~/.weaverbird/logs/_orchestrator
chmod 700 ~/.weaverbird     # 0700 是 boot integrity 要求
```

### 4.2 模板 (.env.<botId>)

```bash
cat > ~/.weaverbird/configs/.env.default <<'EOF'
# 必填 · LARK app credentials (per 飞书后台抓)
BOT_ID=default
LARK_APP_ID=cli_xxxxxxxxxxxxxxxxx
LARK_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
LARK_ENCRYPT_KEY=
LARK_VERIFICATION_TOKEN=

# Optional · agent 白名单 (default 推荐全开做 Captain)
AGENT_ALLOWED=claude-code,codex

# Optional · agent CLI 命令 / 默认 cwd
WB_CLAUDE_COMMAND=claude
WB_CODEX_COMMAND=codex
WB_CLAUDE_CONSENT_LEVEL=auto
# WB_DEFAULT_CWD=/Users/you/work

# Optional · log
LOG_LEVEL=info
EOF
chmod 600 ~/.weaverbird/configs/.env.default
```

第二个 bot:

```bash
cat > ~/.weaverbird/configs/.env.claude <<'EOF'
BOT_ID=claude
LARK_APP_ID=cli_yyyyyyyyyyyyyyyyy
LARK_APP_SECRET=yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy
LARK_ENCRYPT_KEY=
LARK_VERIFICATION_TOKEN=

# 此 bot 只暴露 claude-code
AGENT_ALLOWED=claude-code
WB_CLAUDE_COMMAND=claude
WB_CLAUDE_CONSENT_LEVEL=auto
LOG_LEVEL=info
EOF
chmod 600 ~/.weaverbird/configs/.env.claude
```

### 4.3 BOT_ID ↔ 文件名 必须 match

`apps/wb-bot/src/config/bot-env.ts` 严校:

```
.env.claude  → 文件内 BOT_ID=claude  ✅
.env.claude  → 文件内 BOT_ID=foo     ❌ throws "BOT_ID mismatch"
.env.bar     → 文件内 BOT_ID=claude  ❌ throws "BOT_ID mismatch"
```

discovery 跳过保留 suffix (避免误吞 `.env.local` 等开发文件):

```
.env.local        ← 跳过 (reserved)
.env.example      ← 跳过 (reserved)
.env.test         ← 跳过 (reserved)
.env.development  ← 跳过 (reserved)
.env.production   ← 跳过 (reserved)
.env.staging      ← 跳过 (reserved)
```

### 4.4 共享 vs 独占字段

| 字段 | per-bot 独立 (必) | 共享建议 |
|---|---|---|
| `BOT_ID` | ✅ 独立 (= filename) | — |
| `LARK_APP_ID` / `_SECRET` / `_ENCRYPT_KEY` / `_VERIFICATION_TOKEN` | ✅ 独立 (per bot 1 个飞书 app) | — |
| `AGENT_ALLOWED` | 独立 (按 bot 角色) | 全 bot 同 `claude-code,codex` ok |
| `WB_CLAUDE_COMMAND` / `WB_CODEX_COMMAND` | 通常共享 (claude/codex CLI 路径相同) | 同值 |
| `WB_DEFAULT_CWD` | 通常共享 | 同值 |
| `LOG_LEVEL` | 通常共享 | `info` |

---

## 5 · Build + smoke 单 worker (无 launchctl)

正式 install launchctl 前, 先验证 single worker 能跑通. 选 1 个 bot (推荐 `default`):

```bash
cd /path/to/weaverbird
npm run build     # 必须先 build, multi-bot orchestrator 跑 dist/

# Foreground smoke (用 .env.default · 等价 launchctl 加载)
WB_CONFIG_DIR=$HOME/.weaverbird/configs \
WB_DATA_DIR=$HOME/.weaverbird \
WB_MODE=multi-bot \
  node dist/apps/wb-bot/src/main.js --bot default
```

### 5.1 期望 6 boot signal (1-3 秒内全见)

```
1. "created directory with mode 0700"             ← integrity (~/.weaverbird/data + runs + logs)
2. "logger multi-stream ready (stdout + ...)"     ← pino-roll file sink ready
3. "database migrations completed" toVersion=2    ← migration 002 完成
4. "TaskIndex initialized + scheduled"            ← runs/<botId>/ scan
5. "bot self-heartbeat started"                   ← 10s interval heartbeat
6. "starting wb-bot"                              ← WSClient 起来
```

之后 ack 飞书 group `@default 你好` 应收到回复. Ctrl+C 退 (优雅: stop heartbeat → close WSClient → flush log → exit 0).

### 5.2 验文件落点

```bash
ls -la ~/.weaverbird/                           # 0700
ls ~/.weaverbird/data/                          # wb-bot.db + wb-bot.db-wal + wb-bot.db-shm
ls ~/.weaverbird/runs/default/                  # heartbeat 文件
ls ~/.weaverbird/logs/default/                  # wb-bot.1.log (pino-roll)

# 验 migration 002 跑过 (用户应见 bot_id 列):
sqlite3 ~/.weaverbird/data/wb-bot.db "PRAGMA user_version;"   # → 2
sqlite3 ~/.weaverbird/data/wb-bot.db ".schema thread_binding" # 含 bot_id TEXT
```

smoke 通过 → 进 §6 install launchctl orchestrator.

---

## 6 · launchctl orchestrator install (生产路径)

`wb-bot-multi` orchestrator 进程 = 1 个 launchctl plist 起来后, 自动 spawn N 个 wb-bot worker (1 per `.env.<botId>`), 共 1 个 KeepAlive supervisor (G.B `Supervisor` 类).

### 6.1 Render plist 模板

repo 自带模板 `scripts/com.weaverbird.wb-bot-multi.plist.template` (内含 `__PROJECT_ROOT__` 和 `__HOME__` 占位符):

```bash
cd /path/to/weaverbird

sed -e "s|__PROJECT_ROOT__|$(pwd)|g" -e "s|__HOME__|$HOME|g" \
  scripts/com.weaverbird.wb-bot-multi.plist.template \
  > ~/Library/LaunchAgents/com.weaverbird.wb-bot-multi.plist

# 验 plist 合法
plutil -lint ~/Library/LaunchAgents/com.weaverbird.wb-bot-multi.plist
# → ~/Library/LaunchAgents/com.weaverbird.wb-bot-multi.plist: OK
```

模板内含默认 env:
- `WB_CONFIG_DIR=~/.weaverbird/configs`
- `WB_DATA_DIR=~/.weaverbird`
- `NODE_ENV=production`
- `PATH=/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin`
- `StandardOutPath` / `StandardErrorPath` 落在 `~/.weaverbird/logs/_orchestrator/`

需要改 env (e.g. `WB_DISABLE_CAPTAIN`) → 编 render 出的 plist `<dict>` 块.

### 6.2 Bootstrap (启动)

```bash
mkdir -p ~/.weaverbird/logs/_orchestrator

launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.weaverbird.wb-bot-multi.plist

# 验起来
launchctl list | grep wb-bot-multi
# → PID  STATUS  com.weaverbird.wb-bot-multi
```

### 6.3 验 N worker spawn

```bash
# orchestrator pid
ORCH_PID=$(launchctl list | awk '$3=="com.weaverbird.wb-bot-multi"{print $1}')
echo "orchestrator pid=$ORCH_PID"

# worker pid (orchestrator 的 child)
pgrep -P $ORCH_PID -f 'wb-bot/src/main.js'
# → 应等于配的 bot 数量 (e.g. 2 个 .env.<botId> → 2 child)

# 看 orchestrator 日志
tail -20 ~/.weaverbird/logs/_orchestrator/wb-bot-multi.stdout.log
# → "starting multi-bot orchestrator" botIds=["default","claude"]
# → 各 worker 起来后会 print 6 boot signal

# 看各 worker 日志
tail -20 ~/.weaverbird/logs/default/wb-bot.1.log
tail -20 ~/.weaverbird/logs/claude/wb-bot.1.log
```

### 6.4 飞书侧 smoke

各 bot 拉同一群里:
```
你 @default-bot 你好
→ default-bot worker 处理, 回复

你 @claude-bot 用 claude-code 写个 hello
→ claude-bot worker 处理, 起 agent run
```

### 6.5 控制命令

| 操作 | 命令 |
|---|---|
| 停 orchestrator (全 worker 一起) | `launchctl bootout gui/$UID/com.weaverbird.wb-bot-multi.plist` |
| 重启 (开发迭代) | `launchctl kickstart -k gui/$UID/com.weaverbird.wb-bot-multi.plist` |
| 仅查状态 | `launchctl print gui/$UID/com.weaverbird.wb-bot-multi` |
| 跟 orchestrator log | `tail -f ~/.weaverbird/logs/_orchestrator/wb-bot-multi.stdout.log` |
| 跟 worker log | `tail -f ~/.weaverbird/logs/<botId>/wb-bot.1.log` |

---

## 7 · Captain 四大件 smoke

`default` bot 进 multi-bot 模式后自动升 Captain (`apps/wb-bot/src/captain/captain-gate.ts`). 在群里 (有 `default-bot` 在) 测 4 大件:

| 命令 | 期望 | 详细 spec |
|---|---|---|
| `/list-bots` | 卡片显示 `default (Captain)` + 其它 bot · 在线 ✓ / 离线 ✗ + heartbeat age | `apps/wb-bot/src/captain/list-bots.ts` |
| `/status` | 跨 bot 汇总 active runs (每 bot 1 行 + 各自 inflight 任务) | `apps/wb-bot/src/captain/captain-status.ts` |
| `/health` | 4 项 cross-bot check: WAL · runs/ · logs/ · heartbeat freshness | `apps/wb-bot/src/commands/health.ts` |
| `/stop-all` | 列 active runs → 各写 `runs/<botId>/<runId>/stop.signal` → worker 端 graceful stop | `apps/wb-bot/src/captain/captain-stop-all.ts` |

详细字段渲染 + 字符级期望见 [`tests/wb-bot/E2E.md`](../../tests/wb-bot/E2E.md) D12 (Captain 四大件 visual, 4 testcase).

### 7.1 关闭 Captain (退化 W2 byte-exact)

```bash
# 编 plist 加 env var, 或 launchctl setenv
launchctl setenv WB_DISABLE_CAPTAIN true
launchctl kickstart -k gui/$UID/com.weaverbird.wb-bot-multi.plist

# 验: /list-bots /status /health /stop-all 全部走 W2 single-bot 路径
# (期望 byte-exact 同 W1/W2 single-bot 输出, 见 E2E.md D13)
```

`WB_DISABLE_CAPTAIN` 设为 `true` 或 `1` 都关. 其它值视为 enable.

---

## 8 · Troubleshooting

### 8.1 `SQLITE_BUSY` / `SQLITE_LOCKED` at startup

**症状**: 多 bot 并发 boot 时, 某 worker log 出 `SQLITE_BUSY` 后 exit.

**原因**: 早期 (W2.5 G.D batch) `PRAGMA journal_mode=WAL` 不 honor busy_timeout · 真并发首次 boot 触发竞争.

**已修**: W2.5 G.D.1 batch · `apps/wb-bot/src/binding/store.ts` `ensureWalMode()` retry-loop + `Atomics.wait` sleepSync. 验证:

```bash
sqlite3 ~/.weaverbird/data/wb-bot.db "PRAGMA journal_mode;"
# → wal

# log 内 grep ensureWalMode retry (W2.5 G.D.1 后)
grep ensureWalMode ~/.weaverbird/logs/*/wb-bot.1.log
```

如还出 BUSY → 验 `~/.weaverbird/data/wb-bot.db-wal` 是否 stale; rm 后重启 (orchestrator 会重建).

### 8.2 `bot identity fetch failed for botId=<id>`

**症状**: worker 启动后 R2 阶段 exit, log 显示 `bot identity fetch failed for botId=claude`.

**原因**: `LARK_APP_ID` / `LARK_APP_SECRET` 错, 或 bot 未在飞书后台发布上线.

**check**:
```bash
# 验 creds 能换 access_token (curl 直测)
curl -s -X POST 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal' \
  -H 'Content-Type: application/json' \
  -d "{\"app_id\":\"$LARK_APP_ID\",\"app_secret\":\"$LARK_APP_SECRET\"}" | jq
# → 期望 {"code":0,"msg":"ok","tenant_access_token":"t-..."}

# 验 bot info
curl -s 'https://open.feishu.cn/open-apis/bot/v3/info' \
  -H "Authorization: Bearer $TENANT_TOKEN" | jq
# → 期望 {"code":0, "bot":{"open_id":"ou_...", "app_name":"weaverbird-claude", ...}}
```

如 `code !== 0` → app 未上线 / scope 缺 / creds 错. 回 §3 检查.

### 8.3 `.env.<botId>` 加载失败 — `BOT_ID mismatch`

**症状**: orchestrator log 显示 `skipping invalid bot env file` reason 含 `BOT_ID mismatch: file ".env.claude" contains BOT_ID="foo"`.

**原因**: file naming 和文件内 `BOT_ID=` 必须 byte-exact 等. 见 §4.3.

**fix**: 改文件名 (`mv .env.claude .env.foo`) 或改文件内 `BOT_ID=claude`. 然后 `launchctl kickstart -k ...` 重启 orchestrator.

### 8.4 `.env.<botId>` 全被跳过 — discovery 0 bots

**症状**: orchestrator log `no valid bot configs discovered` 后 exit code 1.

**check**:
```bash
ls ~/.weaverbird/configs/
# → 应有至少 1 个 .env.<botId> (非保留 suffix)

# 名字 case 敏感, 必须 lowercase 字母开头
# 反例: .env.Default (大写 D) 不识别
```

记得 `WB_CONFIG_DIR` env (orchestrator plist 内) 指向正确目录. 默认 `~/.weaverbird/configs/`.

### 8.5 launchctl bootstrap 失败 — `Bootstrap failed: 5: Input/output error`

**症状**: `launchctl bootstrap` 命令出 exit code 5.

**原因**: 同 label 的 plist 已 loaded · 或 plist syntax 错.

**fix**:
```bash
# 先 bootout 清理
launchctl bootout gui/$UID/com.weaverbird.wb-bot-multi.plist 2>/dev/null
sleep 2

# plutil 验 syntax
plutil -lint ~/Library/LaunchAgents/com.weaverbird.wb-bot-multi.plist

# 重新 bootstrap
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.weaverbird.wb-bot-multi.plist
```

### 8.6 bot 不响应群里 `@bot` mention

**症状**: 群里 `@claude-bot 你好`, 1 分钟无回复, worker log 无新事件.

**check**:
```bash
# 1. WSClient 连通? log 应有 "WSClient connected"
grep -i 'wsclient\|connected\|disconnect' ~/.weaverbird/logs/claude/wb-bot.1.log | tail -5

# 2. bot identity 缓存了? log 应有 "bot identity cached" open_id=ou_xxx
grep 'bot identity\|open_id' ~/.weaverbird/logs/claude/wb-bot.1.log | tail -5

# 3. mention 过滤命中? log 应有 "ignoring message (no self mention)" 或 "handling message"
grep 'mention\|ignoring\|handling' ~/.weaverbird/logs/claude/wb-bot.1.log | tail -10
```

若 #1 无 connected → 网络问题 / app 未上线 (回 §8.2).
若 #2 无 cached → bot info query 失败 (回 §8.2).
若 #3 全 "ignoring" → mentions list 不含 bot 自身 open_id · 检查群里 `@` 的是不是这个 bot · 或在飞书后台 "应用功能 → 机器人 → 群组中能使用机器人" 已开.

### 8.7 Captain `/list-bots` heartbeat stale

**症状**: `/list-bots` 卡片显示某 bot "离线 ✗ (5min 前)" 但其实 worker 在跑.

**原因**: `runs/<botId>/heartbeat` 文件未更新 (worker heartbeat timer 停了 / write fail).

**check**:
```bash
# 各 bot 的 heartbeat 文件应每 10s 更新
ls -la ~/.weaverbird/runs/*/heartbeat
stat -f "%m %N" ~/.weaverbird/runs/*/heartbeat | awk '{print strftime("%H:%M:%S", $1), $2}'

# heartbeat 文件内是 epoch sec
cat ~/.weaverbird/runs/claude/heartbeat
date +%s    # diff < 10s 表示 fresh
```

若 heartbeat 文件 stale → 该 worker 进程 / heartbeat timer 故障. `kickstart -k` 重启 orchestrator (Supervisor 会 spawn 新 worker).

### 8.8 migration 002 跑失败 → wb-bot 进 read-only

**症状**: log 出 `database migration failed` 后 `wb-bot starting in read-only mode`. Admin alert 已发.

**原因**: 通常是 db 文件被人手动改 schema, 或 disk full.

**fix**:
```bash
# 看 user_version 当前是几
sqlite3 ~/.weaverbird/data/wb-bot.db "PRAGMA user_version;"

# 若是从 W1 旧 db (version=0 或 1) 升上来, 但 migration 002 失败 →
# 1. 备份当前 db
cp ~/.weaverbird/data/wb-bot.db ~/.weaverbird/data/wb-bot.db.bak.$(date +%s)

# 2. 看具体 migration 错误 (log)
grep 'migration' ~/.weaverbird/logs/default/wb-bot.1.log | tail -10

# 3. 极端: rm db (会丢绑定历史)
launchctl bootout gui/$UID/com.weaverbird.wb-bot-multi.plist
rm ~/.weaverbird/data/wb-bot.db ~/.weaverbird/data/wb-bot.db-wal ~/.weaverbird/data/wb-bot.db-shm
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.weaverbird.wb-bot-multi.plist
# → 新 db, migration 001 + 002 自动跑
```

### 8.9 `claude-w` / `codex-w` wrapper interactive selector hang (带 model selector 的 wrapper)

**症状**:
- 飞书里 `@bot` 后回了卡片, 但卡片**永远冻在 "🟢 running · 00:00 · -"**, `model: -` / `cwd: -`, 永不流式更新
- wb-bot 主进程日志最后一条是 `spawned wb-runner session`, 之后无 event 输出
- `~/.weaverbird/runs/<botId>/<runId>/output.log` / `events.ndjson` 都是空文件
- `~/.weaverbird/runs/<botId>/<runId>/status` 是 `running` 但 `output.err` 也无报错
- 直接 terminal 跑 `claude-w --version` 会弹出 interactive selector:
  ```
  Select a model (↑↓ navigate, Enter confirm):
  > gpt-5.4
    gpt-5.3-codex
  ```

**原因**:
`claude-w` / `codex-w` wrapper 在 args 内没识别到 model flag 时, 会启动 interactive `select_model` 流程等 user 按 ↑↓ + Enter 选默认 model. 但 wb-runner 用 `stdio: ['ignore', file, file]` + `detached: true` spawn wrapper, **没 TTY 没 stdin**:
- `claude-w` 阻塞在 readline → child 永远 hang → 主进程 `for await` `events.ndjson` 自然没数据
- `codex-w` 走 codex CLI 的 `select_model` 函数, 该函数直接 `open(/dev/tty)`, 在 no-TTY 子进程下立刻报 `unable to pick selection: could not open a new TTY` → child exit code 1 → 卡片 error

**fix** — `.env.<botId>` (或单 bot 模式的 `apps/wb-bot/.env`) 内传 model flag 跳过交互. **⚠️ 注意 claude-w 跟 codex-w wrapper API 不是同一套, 不要照搬**:

```bash
# 之前 (会 hang / 撞 TTY)
WB_CLAUDE_COMMAND=claude-w
WB_CODEX_COMMAND=codex-w

# ❌ 错的 (codex-w 不认 --model, 仍走 select_model → no-TTY 报错)
WB_CODEX_COMMAND=codex-w --model gpt-5.3-codex

# ✅ fix
#   claude-w: 检测 `--model xxx` / `-m xxx` / `--model=xxx` / `-mxxx` (跟 claude CLI 透传一致)
#   codex-w:  只认 codex 上层 `-c key=value` config override, 即 `-c model=xxx` / `-cmodel=xxx`
WB_CLAUDE_COMMAND=claude-w --model gpt-5.4
WB_CODEX_COMMAND=codex-w -c model=gpt-5.3-codex
```

wrapper API 差异的源码证据 (wrapper 安装在 `$HOME/.local/bin/`):
- `claude-w`: `case "$arg" in --model|-m|--model=*|-m*) has_model_flag=1; break ;; esac`
- `codex-w`: 只检测 `-c model=*` / `-cmodel=*` / 上一 arg 是 `-c` 而当前是 `model=*`

`apps/wb-bot/src/feishu/event-handler.ts` 按 `/\s+/` split `WB_CLAUDE_COMMAND`, 第一段当 binary, 其余作 prepend args 传给 spawn. 同时 wb-bot 会自动从 prepend args 内解析出 `--model <value>`, **propagate 到 child env 作 `ANTHROPIC_MODEL`** (post-W2.5 hotfix). 背景: claude-code `--print --output-format stream-json` mode 不 honor CLI `--model` flag 必须 env, 而 `claude-w` 在 has_model_flag=1 path 下不 export 该 env. wb-bot 补这一步, 让用户**单一 source of truth**: `WB_CLAUDE_COMMAND` 写一次 `--model X` 即可, **不需要**再在 `.env` 单独设 `ANTHROPIC_MODEL=X`. 父进程已显式 set `ANTHROPIC_MODEL` 时优先尊重父进程 (override pattern).

实现: `extractModelFromArgs` (event-handler 模块 export) 支持 `--model X` / `--model=X` / `-m X` / `-mX` 4 种 form. 测试见 `tests/wb-bot/build-agent-args.test.ts`.

**清理 stale run** (interactive hang 留下来的 `status=running` 目录, 不清会触发下次启动的 `run lost after restart, stop.signal written`):

```bash
# 杀掉所有 hang 的 wrapper / claude 子进程
pkill -f claude-w 2>/dev/null
pkill -f codex-w 2>/dev/null

# 清 status=running 但实际死掉的 run dir (per bot)
RUNS=~/.weaverbird/runs/<botId>
find "$RUNS" -mindepth 1 -maxdepth 1 -type d -name '????????-????-*' -exec bash -c '
  d="$1"
  status=$(cat "$d/status" 2>/dev/null)
  if [ "$status" = "running" ]; then
    echo "removing stale running run: $(basename "$d")"
    rm -rf "$d"
  fi
' _ {} \;
```

然后 `npm run wb-bot:dev` 重启 (或 launchctl bootout / bootstrap).

**说明**:
- 不能用原生 `claude` (`WB_CLAUDE_COMMAND=claude`) 替代 wrapper — wrapper 还做 模型网关的 auth 注入 (`ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_CUSTOM_HEADERS`), 直接 claude 会走公网 Anthropic API 走 401
- 验证 wrapper 是否真支持 `--model` flag: `head -50 $(which claude-w)`, 看有没有类似 `--model|-m|--model=*|-m*) has_model_flag=1` 的分支 (实测 2026-06-03 含此 branch)
- 其它 wrapper (自建 / 第三方) 若有类似 interactive 行为, 同理处理: prompt 在 spawn-from-bot 路径下都会卡死, 都需要 `.env` 内显式传 model / 关交互的 flag

### 8.10 claude-code workspace trust prompt hang ("Quick safety check: Is this a project you trust?")

**症状** (8.9 之后的下一层 prompt):
- 即使 `WB_CLAUDE_COMMAND=claude-w --model <name>` 已生效, 卡片仍冻在 `🟢 running · 00:00 · -`
- terminal 手动跑 `claude-w --model <name>` (在 wb-bot cwd) 弹出:
  ```
  Accessing workspace:
   /path/to/cwd
  Quick safety check: Is this a project you created or one you trust? ...
  ❯ 1. Yes, I trust this folder
    2. No, exit
  ```

**原因**: claude-code 1.x 起对首次进入的 cwd 弹 workspace-trust prompt (independent of `--permission-mode`). wb-runner spawn 无 TTY → prompt 永远 hang. wb-bot 支持 per-message `/cwd <path>` 切目录, 每个新 cwd 都会触发一次, **不 scalable**.

**fix** — 已在 `buildAgentArgs` (commit `<post-W2.5 hotfix>`) 永久解决:

`apps/wb-bot/src/feishu/event-handler.ts` 的 `buildAgentArgs` 函数会自动给 claude-code 附加 `--dangerously-skip-permissions` (例外: `consentLevel === 'plan-only'`). 该 flag 屏蔽 claude 自身**所有** startup-phase prompt (含 workspace trust + tool consent UI). consent gating 完全归 wb-bot 自身的 `ConsentLevel` contract (per `AgentAdapter`) 管, 不依赖 claude UI.

**rationale**:
- wb-bot 永远 backend 进程 + 永远无 TTY 子进程, 任何 startup prompt 都 hang → `--dangerously-skip-permissions` 是 unavoidable
- 不引入新安全 risk: tool consent 仍由 `ConsentLevel` 控 (`bypassPermissions` / `acceptEdits` / `default` 等), 这本来就是 `AgentAdapter` contract 的价值
- `plan-only` 例外: 该模式 claude 仅产 plan 不执行任何工具, trust 风险 = 0, 保留原 `--permission-mode plan` 即足够

**验证 src 状态**: `grep -n dangerously-skip-permissions apps/wb-bot/src/feishu/event-handler.ts`, 应当看到 buildAgentArgs 内 `args.push('--dangerously-skip-permissions')` 分支.

**注**: 如果跑老版 wb-bot (post-W2.5 hotfix 之前), 必须升级到 main HEAD, 或者作为临时 workaround:
```bash
# 手动 trust 常用 cwd (1-time, 但每个新 cwd 都得来一次, 不 scalable)
cd /Users/<you>           # 或具体 work dir
claude-w --model gpt-5.4  # 出 trust prompt 按 1, 然后 Ctrl+C
```

---

## 9 · Uninstall / 撤销

### 9.1 仅停 (保留 config / db / log)

```bash
launchctl bootout gui/$UID/com.weaverbird.wb-bot-multi.plist
```

### 9.2 完全卸载

```bash
# 1. 停 orchestrator
launchctl bootout gui/$UID/com.weaverbird.wb-bot-multi.plist

# 2. 删 plist
rm ~/Library/LaunchAgents/com.weaverbird.wb-bot-multi.plist

# 3. (可选) 删数据 (会丢绑定历史)
rm -rf ~/.weaverbird/data
rm -rf ~/.weaverbird/runs
rm -rf ~/.weaverbird/logs

# 4. (可选) 删 config
rm -rf ~/.weaverbird/configs

# 5. (可选) 删整个 weaverbird 数据目录
rm -rf ~/.weaverbird
```

### 9.3 飞书侧

各 bot app 在 https://open.feishu.cn/ → 应用功能 → 下线 / 或留着待用. 凭证不公开 share.

---

## 10 · 第二台机 / 重装部署

### 10.1 全新 macOS (clone + 装)

```bash
# 0. 环境 (Node 22 + npm 10)
brew install node

# 1. clone repo
cd ~/work
git clone <weaverbird-repo>
cd weaverbird

# 2. install + build
npm install
npm run build
npm test    # 470/470 PASS

# 3. configs 目录 (新建 0700)
mkdir -p ~/.weaverbird/configs
chmod 700 ~/.weaverbird

# 4. 复制 .env.<botId> 模板 (或从安全位置 e.g. 1Password 拉)
#    每个 .env 都 chmod 600
cp /path/to/safe/storage/.env.default ~/.weaverbird/configs/
cp /path/to/safe/storage/.env.claude ~/.weaverbird/configs/
chmod 600 ~/.weaverbird/configs/.env.*

# 5. smoke single worker (§5)
WB_CONFIG_DIR=$HOME/.weaverbird/configs \
WB_DATA_DIR=$HOME/.weaverbird \
WB_MODE=multi-bot \
  node dist/apps/wb-bot/src/main.js --bot default
# 见 6 boot signal → Ctrl+C

# 6. install launchctl (§6.1-6.3)
sed -e "s|__PROJECT_ROOT__|$(pwd)|g" -e "s|__HOME__|$HOME|g" \
  scripts/com.weaverbird.wb-bot-multi.plist.template \
  > ~/Library/LaunchAgents/com.weaverbird.wb-bot-multi.plist
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.weaverbird.wb-bot-multi.plist
launchctl list | grep wb-bot-multi
```

### 10.2 飞书 app 复用?

**不要复用同一组 LARK_APP_ID / SECRET 给两台机** (会撞 WSClient session, 行为不可预测).

正确做法: 第二台机要么用另一组 bot apps (e.g. `default-laptop` `claude-laptop`), 要么只在 1 台机跑生产, 另一台只跑 dev (`.env.local` discovery 跳过).

---

## 11 · 相关文档

| 文档 | 关系 |
|---|---|
| [`README.md`](../../README.md) §3 | quickstart 概览 (本文档是 deep-dive) |
| [`docs/topics/multi-bot-routing.md`](../topics/multi-bot-routing.md) | spec 层 (为什么多进程 / SQLite WAL 协议 / open_id) |
| [`docs/topics/captain-bot.md`](../topics/captain-bot.md) | Captain 四大件 spec |
| [`tests/wb-bot/E2E.md`](../../tests/wb-bot/E2E.md) D10-D15 | manual gate 23 testcase (D11 真长跑 / D12 Captain visual / D13 W2 byte-exact / D14 真并发 / D15 手机端) |
| [`plans/w2.5-mainline-close-note.md`](../../plans/w2.5-mainline-close-note.md) | W2.5 close note (含 G0 defer rationale) |
| [`plans/w2.5-retrospective.md`](../../plans/w2.5-retrospective.md) | W2.5 10 batch lessons learned |

---

## 12 · 文档元数据

- **版本**: v1 (W2.5-J 首发, 2026-06-02)
- **状态**: lock (W2.5 close note §3.5 D5.2 defer 项实施 · lead designer T2 doc-only self-impl per W2.5 retrospective §6.4)
- **覆盖**: macOS launchctl + `wb-bot-multi` orchestrator + Captain 四大件 + 8 trouble + uninstall + 第二台机
- **不覆盖**: Linux systemd / Windows Service / Docker / 跨机 fleet (推 W3+)
- **维护契约**: src layout / plist template / Captain command 名 / migration 路径 任一变更 → 同 batch 内 patch 本文档
