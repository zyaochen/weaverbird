# Run Registry Setup Guide (W3.2 / F15)

> **Audience**: product-owner / operator
> **Scope**: Run Registry Bitable schema、`config.json`、`/wb history` / `wb-cli history`、`/wb resume --inherit`、`/health` 排障
> **Status**: W3.2/F15 current guide

如果你只想最短路径跑通 Run Registry，先做这 4 步：

可选运行面：除了查询命令，现在也可以用 `npm run run-registry` 启动 Run Registry tailer + writer；它会在 run 终态时处理 Doc Sink 并持续回写 Bitable。

1. 在 `~/.weaverbird/config.json` 里加 `run_registry` 配置块。
2. 把文件权限设成 `600`。
3. 执行一次 `wb-cli history --limit 10`，确认查询链路可用。
4. 在 bot 侧执行 `/health`，确认 `Run Registry` 不再显示 `warn (not-configured)`。

## 1. 这份配置解决什么问题

Run Registry 把 run 级元数据写到 Feishu Bitable，当前主线直接用它做三类事：

补充：Doc Sink 开启后，长文类 run 产物会优先尝试落到飞书 Doc，并把 URL 写回 `produced_doc_urls`；若 Doc 创建失败，run 主流程不阻塞，本地会保留 `doc-fallback.md`，同时 `doc_sink_failed=true`。

- 查询历史 run：`/wb history`、`wb-cli history`
- 基于已有 run 续接：`/wb resume --inherit <run_id>`
- 在 `/health` 中观察本地 WAL 是否积压

事实：当前 W3.2 会把 `cost_tokens` 写成 `null`，token accounting 仍 defer。

边界：

- `/health` 的 Run Registry 检查是 fs-only，不会主动发远端 Bitable API 探活
- 本文档只讲配置和查询入口，不展开 run-registry writer/tailer 的实现细节

## 2. 前置条件

- `~/.weaverbird/` 可写
- 已有可用的 Bitable base / table / app credentials
- 若你要从 IM 面使用，需要 bot 已启动且命令面可用

## 3. 最短成功路径

### 3.1 写入 `~/.weaverbird/config.json`

`~/.weaverbird/config.json` 必须包含：

```json
{
  "run_registry": {
    "bitable_base_id": "BAS...",
    "bitable_table_id": "tbl...",
    "app_id": "cli_...",
    "app_secret": "<secret>",
    "lark_domain": "https://open.larkoffice.com",
    "run_finalize_grace_ms": 30000,
    "doc_url_allowlist": ["*.larkoffice.com", "*.feishu.cn", "github.com"]
  }
}
```

然后执行：

```bash
chmod 600 ~/.weaverbird/config.json
```

### 3.2 跑一次 CLI 查询

```bash
wb-cli history --limit 10
```

如果你更想看结构化输出：

```bash
wb-cli history --limit 10 --json
```

### 3.3 跑一次 IM 查询或续接

在 bot 侧可以直接用：

```text
/wb history --keyword weaverbird
/wb resume --inherit <run_id>
```

## 4. 端到端示例

下面这条链路是当前最小可验证流程：

```bash
chmod 600 ~/.weaverbird/config.json

wb-cli history --status succeeded --agent codex --limit 5
wb-cli history --keyword weaverbird --json
```

在 bot 侧：

```text
/wb history --status succeeded --agent codex
/wb resume --inherit run_abc123
```

期望：

- `wb-cli history` 默认输出 tab-separated 表格
- 若还有下一页，stderr 会打印 `next_cursor=...`
- bot 侧 `/wb history` 会返回 `📚 Run History`

## 5. 常用查询参数

### CLI `wb-cli history`

支持这些参数：

- `--keyword <text>`
- `--status <status>`
- `--agent <agent>`
- `--after <iso8601>`
- `--before <iso8601>`
- `--limit <N>`
- `--cursor <cursor>`
- `--json`

### IM `/wb history`

支持这些参数：

- `--keyword <text>`
- `--operator <open_id>`
- `--project <project>`
- `--agent <agent>`
- `--entry-form <im|cli>`
- `--status <status>`
- `--after <iso8601>`
- `--before <iso8601>`
- `--limit <N>`
- `--cursor <cursor>`

## 6. Bitable schema (19 fields / 字段)

| Field | Type | Nullable | Notes |
|---|---|---:|---|
| `run_id` | text | no | unique run key |
| `created_at` | datetime | no | ISO time from `startedAt` |
| `operator` | text | no | user open id |
| `project` | text | yes | derived project label |
| `cwd` | text | no | working directory |
| `scope` | text | no | consent level |
| `agent` | single select | no | agent id |
| `cmd` | text | no | command summary |
| `status` | single select | no | pending/active/finalizing/succeeded/failed/cancelled |
| `cost_tokens` | number | yes | always `null` in W3.2 |
| `cost_minutes` | number | yes | derived runtime minutes |
| `produced_doc_urls` | multi-line text | yes | top-level produced doc urls |
| `commit_shas` | multi-line text | yes | extracted 40-char git shas |
| `doc_sink_failed` | checkbox / boolean | no | true when longform doc sink fell back locally |
| `calendar_block_id` | text | yes | current calendar block id for the run |
| `calendar_hook_failed` | checkbox / boolean | no | true when calendar open/close failed or timed out |
| `risk_level` | single select | no | default `unknown` |
| `home_group_id` | text | yes | IM thread / group id |
| `entry_form` | single select | no | `im` or `cli` |

## 7. 健康检查怎么看

`/health` 会包含 `Run Registry` 这一项。

当前可见信号：

- config missing -> `warn (not-configured)`
- config 解析失败 -> `warn (config-error: ...)`
- `wal/run-registry/` backlog >= 100 -> `warn (wal_backlog: N)`
- 正常 -> `ok (N pending)`

## 8. 常见错误与修复

### `warn (not-configured)`

说明：没读到 `run_registry` 配置块。

下一步：

- 检查 `~/.weaverbird/config.json` 顶层是否真的有 `run_registry`
- 检查字段名是否是 `bitable_base_id` / `bitable_table_id` 这组当前字段

### `warn (config-error: ...)`

说明：配置存在，但 schema 不通过。

下一步：

- 对照本页 JSON 例子逐项检查字段名
- 尤其检查 `run_finalize_grace_ms` 和 `doc_url_allowlist`

### `warn (wal_backlog: N)`

说明：本地 WAL 已积压。

下一步：

- 检查 Bitable 凭证和权限
- 查看 `~/.weaverbird/wal/run-registry/`
- 远端恢复后重跑 worker / 进程，让 backlog drain

### `(no runs)`

说明：查询链路通了，但当前没有命中结果。

下一步：

- 放宽 `--status` / `--agent` / 时间范围
- 或先去 bot/CLI 跑一条真实任务，再回查 history

## 9. 边界与协作关系

- 如果你关心 Captain session，而不是 run history，走 [captain-setup.md](./captain-setup.md)
- 如果你关心审计链路而不是 history，走 [audit-pipe-setup.md](./audit-pipe-setup.md)
- 本文档不承诺 token/cost 统计；当前 `cost_tokens` 仍是空值设计
