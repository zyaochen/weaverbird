# Audit-pipe Setup Guide (W3.1-polish)

> **Audience**: 主设计师本人 / 后续接手者
> **Scope**: macOS launchctl 路径 · 单个 audit-pipe LaunchAgent · 服务所有 bot
> **Pre-req**: 已读 [`README.md`](../../README.md) 中 audit-pipe / 多 bot quickstart
> **Tier**: 单机 prosumer 部署 · 不含跨机 fleet
> **承接**: W3.1/F17 审计链路已闭环；本篇只回答“怎么把 audit-pipe 自动托管起来”
> **状态**: W3.1-polish · 2026-06-06

本文档是 step-by-step runbook。核心语义与实现细节仍以 `packages/core/src/audit-pipe/*` 和 W3.1 handoff 为准；这里只回答安装、重启、排障与卸载。

---

## 0 · 看本文档前先决断

| 问题 | 决断 |
|---|---|
| 是否已经需要审计链路 | 需要本机自动托管 audit-pipe 才继续；否则前台 `npm run audit-pipe` 足够 |
| 服务几个 bot | **1 个 audit-pipe 服务所有 bot**；不要每 bot 装 1 个 |
| 与 `wb-bot-multi` 启动顺序 | **顺序无关**；launchctl 两个服务独立，先后都可 |
| 是否需要传 `--interval <数字>` | **不需要**；当前 plist 与 runbook 默认不传 |
| 平台 | 本文档只覆盖 macOS launchctl |

---

## 1 · Prerequisites

```bash
node --version    # >= 22
npm --version     # >= 10
sw_vers           # macOS only
plutil -help >/dev/null && echo OK
launchctl print gui/$UID >/dev/null && echo OK
```

repo 侧前提：

```bash
cd /path/to/weaverbird
npm install
npm run build
npm run typecheck
npm test
```

必须确认以下文件存在：

```bash
test -f dist/packages/core/src/audit-pipe/audit-pipe-main.js && echo OK
```

host 侧前提：
- `~/.weaverbird/config.json` 已就位
- 权限是 `600`
- 其中 Bitable / Lark 凭证可用

快速检查：

```bash
stat -f '%Lp %N' ~/.weaverbird/config.json
```

---

## 2 · plist install

路径速查：

| 用途 | 路径 |
|---|---|
| plist 模板 | `scripts/com.weaverbird.audit-pipe.plist.template` |
| install script | `scripts/install-audit-pipe.sh` |
| LaunchAgent 安装目标 | `~/Library/LaunchAgents/com.weaverbird.audit-pipe.plist` |
| launchctl label | `com.weaverbird.audit-pipe` |
| stdout/stderr log | `~/.weaverbird/logs/_audit-pipe/` |

推荐直接执行安装脚本：

```bash
cd /path/to/weaverbird
scripts/install-audit-pipe.sh
```

脚本会做：
1. 创建 `~/Library/LaunchAgents`
2. 创建 `~/.weaverbird/logs/_audit-pipe`
3. 渲染 plist 占位符 (`__PROJECT_ROOT__` / `__HOME__`)
4. `plutil -lint`
5. `launchctl bootstrap gui/$UID`
6. 打印 `launchctl list | grep audit-pipe`

如需手工渲染：

```bash
sed -e "s|__PROJECT_ROOT__|$(pwd)|g" -e "s|__HOME__|$HOME|g" \
  scripts/com.weaverbird.audit-pipe.plist.template \
  > ~/Library/LaunchAgents/com.weaverbird.audit-pipe.plist
plutil -lint ~/Library/LaunchAgents/com.weaverbird.audit-pipe.plist
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.weaverbird.audit-pipe.plist
```

重启 / 升级：

```bash
cd /path/to/weaverbird
npm run build
launchctl kickstart -k gui/$UID/com.weaverbird.audit-pipe
```

---

## 3 · smoke 验证

最小 smoke：

```bash
launchctl list | grep audit-pipe
ls -la ~/.weaverbird/logs/_audit-pipe/
```

跟日志：

```bash
tail -f ~/.weaverbird/logs/_audit-pipe/audit-pipe.stdout.log
```

期望信号：
- plist 已在 `launchctl list` 中出现 `com.weaverbird.audit-pipe`
- stdout log 中出现 `client ready` / token manager ready 等启动日志
- 触发任意 bot run 后，`~/.weaverbird/audit-mirror.ndjson` 出现新行
- 若 Bitable 可达，`~/.weaverbird/wal/audit/` 最终为空

数据面验证：

```bash
ls -la ~/.weaverbird/audit-mirror.ndjson
ls -la ~/.weaverbird/wal/audit/
```

---

## 4 · 控制命令表

| 场景 | 命令 |
|---|---|
| 查看服务 | `launchctl list | grep audit-pipe` |
| 查看 stdout 日志 | `tail -f ~/.weaverbird/logs/_audit-pipe/audit-pipe.stdout.log` |
| 查看 stderr 日志 | `tail -f ~/.weaverbird/logs/_audit-pipe/audit-pipe.stderr.log` |
| 重启服务 | `launchctl kickstart -k gui/$UID/com.weaverbird.audit-pipe` |
| 停止服务 | `launchctl bootout gui/$UID ~/Library/LaunchAgents/com.weaverbird.audit-pipe.plist` |
| 检查 mirror | `wc -l ~/.weaverbird/audit-mirror.ndjson` |

---

## 5 · 与 wb-bot-multi 联动

结论先说：
- **顺序无关**：先起 `wb-bot-multi` 再起 audit-pipe，或先起 audit-pipe 再起 `wb-bot-multi`，都可以。
- **1 个 audit-pipe 服务所有 bot**：它按 `~/.weaverbird/runs/<botId>/<runId>/` 扫描，不需要 per-bot 副本。
- 若 audit-pipe 未安装或未启动，`wb-bot-multi` 仍可正常工作，只是自动审计链路不会前台托管。

推荐生产组合：

```bash
launchctl list | grep weaverbird
```

期望同时看到：
- `com.weaverbird.wb-bot-multi`
- `com.weaverbird.audit-pipe`

---

## 6 · Uninstall

```bash
launchctl bootout gui/$UID ~/Library/LaunchAgents/com.weaverbird.audit-pipe.plist 2>/dev/null || true
rm -f ~/Library/LaunchAgents/com.weaverbird.audit-pipe.plist
```

注意：
- 卸载 plist 不会删除 `~/.weaverbird/config.json`
- 卸载 plist 不会删除历史 `audit-mirror.ndjson` / `wal/audit/`
- 如要清理日志，可额外删除 `~/.weaverbird/logs/_audit-pipe/`

---

## 7 · Troubleshooting

### 场景 A · `plutil -lint` 失败
症状：
- 安装脚本退出码 1

排查：
```bash
plutil -lint ~/Library/LaunchAgents/com.weaverbird.audit-pipe.plist
```

常见原因：
- `__PROJECT_ROOT__` / `__HOME__` 未替换
- 手工编辑 plist 时 XML 结构损坏

### 场景 B · `launchctl bootstrap` 失败
症状：
- 安装脚本退出码 2

排查：
```bash
launchctl bootout gui/$UID ~/Library/LaunchAgents/com.weaverbird.audit-pipe.plist 2>/dev/null || true
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.weaverbird.audit-pipe.plist
```

常见原因：
- plist 已加载但内容变更
- node 路径不对

### 场景 C · `audit-mirror.ndjson` 无新行
症状：
- 服务已在 `launchctl list` 中，但 mirror 不增长

排查：
```bash
tail -50 ~/.weaverbird/logs/_audit-pipe/audit-pipe.stdout.log
tail -50 ~/.weaverbird/logs/_audit-pipe/audit-pipe.stderr.log
ls -la ~/.weaverbird/runs/*/*/events.ndjson
```

常见原因：
- `~/.weaverbird/config.json` 不可读 / 占位符未填
- wb-bot 当前没有新 run
- 启动时 node 路径不对

### 场景 D · WAL 积压
症状：
- `~/.weaverbird/wal/audit/` 下有 `.jsonl`

排查：
```bash
ls -la ~/.weaverbird/wal/audit/
tail -100 ~/.weaverbird/logs/_audit-pipe/audit-pipe.stderr.log
```

常见原因：
- Bitable 推送失败
- 鉴权或网络异常
- 重复 client_token 被服务端拒绝

### 场景 E · node 路径不匹配
症状：
- plist load 成功，但进程起不来

排查：
```bash
which node
plutil -p ~/Library/LaunchAgents/com.weaverbird.audit-pipe.plist | grep -A2 ProgramArguments
```

修复：
- 把模板中的 `ProgramArguments[0]` 改成你机器上的 node 绝对路径，然后重新安装。
