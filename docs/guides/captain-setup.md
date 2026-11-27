# Captain Setup Guide (W3.2.5)

> **Audience**: product-owner / operator
> **Scope**: Captain sessions 表、`captain.json` 映射、CLI 绑定、`/health` Captain Sessions 检查
> **Status**: W3.2.5 current guide

如果你只想最短路径跑通 Captain，会用到这 4 步：

1. 在 `~/.weaverbird/config.json` 里加 `captain` 配置块。
2. 在仓库根目录放 `captain.json`，或在 `~/.weaverbird/captain.json` 放本机 override。
3. 运行 `wb-cli captain` 确认能列出 `Known captains:`。
4. 运行 `wb-cli captain use <captain_id>` 绑定当前 CLI，再用 `/health` 确认 `Captain Sessions` 不再报 `captain not configured`。

## 1. 这份配置解决什么问题

Captain 这一层负责把“当前 CLI/工作目录”绑定到一个 Captain 身份，并让共享 session store、attach、反向控制和健康检查都知道该归谁管。

配置完成后，你至少能做这些事：

- 用 `wb-cli captain` 查看当前已知的 captains
- 用 `wb-cli captain use <captain_id>` 绑定当前 CLI 会话
- 让 `wb-cli attach <session_id>`、反向通道和 `Captain Sessions` 健康检查走同一份基础配置
- 在 `~/.weaverbird/captain-binding.json` 里持久化当前 Captain 绑定

边界：

- 这份文档只覆盖 Captain 的本地配置与会话镜像，不覆盖多 bot 安装本身；多 bot 安装走 [multi-bot-setup.md](./multi-bot-setup.md)
- `captain_toml_path` 这个配置名是历史 schema 字段；当前 loader 实际同时支持 `captain.json` 和 `captain.toml`，优先级 `captain.json > captain.toml`。仓库根 `captain.toml`（git-tracked，无隐私字段），本机 override `~/.weaverbird/captain.json`（真实 home_group_id / open_id）

## 2. 前置条件

- 已经有可写的 `~/.weaverbird/`
- 如果你要用远端 sessions mirror，已准备好对应 Bitable 凭证
- 如果你要配合 reverse channel / attach，用法还需要参考 [reverse-channel-setup.md](./reverse-channel-setup.md)

## 3. 最短成功路径

### 3.1 写入 `~/.weaverbird/config.json`

`~/.weaverbird/config.json` 必须包含：

```json
{
  "captain": {
    "bitable_base_id": "Uq6hb0dUaaYiDQsunHel7EisgWd",
    "sessions_table_id": "tblyqLE52hgNO7UA",
    "app_id": "cli_...",
    "app_secret": "<secret>",
    "lark_domain": "LarkSuite",
    "captain_state_path": "~/.weaverbird/captain-state.ndjson",
    "captain_toml_path": "weaverbird-v2/captain.toml"
  }
}
```

- 文件权限应为 `600`
- `app_secret` 当前按本地明文保存；不要进 git，也不要放到共享目录

### 3.2 写 `captain.json`

当前实现读取优先级是：

- 仓库根 `captain.json`（优先）
- 仓库根 `captain.toml`（fallback，repo-tracked，git_remote + cwd_prefix + captain_id；不写 home_group_id）
- 本机 override `~/.weaverbird/captain.json`（含真实 home_group_id / 私有映射）

同一个 `captain_id` 上，本机 override 会覆盖仓库根配置；仓库根的 `captain.json` 存在时优先于 `captain.toml`。

最小示例（JSON）：

```json
{
  "version": 1,
  "mapping": [
    {
      "git_remote": "github\\.com.*/weaverbird.*",
      "cwd_prefix": "/Users/me/code/weaverbird",
      "captain_id": "default"
    }
  ]
}
```

### 3.3 验证 Captain 可见

```bash
wb-cli captain
wb-cli captain use default
```

期望：

- `wb-cli captain` 打印 `Known captains:` 和至少一个 `- default`
- `wb-cli captain use default` 打印 `captain=default`

## 4. 端到端示例

下面这条链路是当前最小可验证流程：

```bash
chmod 600 ~/.weaverbird/config.json

cat > captain.json <<'EOF'
{
  "version": 1,
  "mapping": [
    {
      "git_remote": "github\\.com.*/weaverbird.*",
      "cwd_prefix": "/Users/me/code/weaverbird",
      "captain_id": "default"
    }
  ]
}
EOF

wb-cli captain
wb-cli captain use default
```

然后去 bot 侧跑一次 `/health`，你应该看到：

- `Captain Sessions` 这一行存在
- 未配置时会是 `captain not configured`
- 正常时会是 `ok (...)` 或 `N sessions in mirror`

## 5. sessions 表 14 字段

| Field | Type | Nullable | Notes |
|---|---|---:|---|
| `session_id` | text | no | uuidv7 / unique key |
| `captain_id` | text | no | owning captain |
| `created_at` | datetime | no | session start |
| `last_active_at` | datetime | no | latest activity |
| `closed_at` | datetime | yes | only for CLOSED sessions |
| `status` | select | no | idle / active / suspended / closed |
| `cwd` | text | no | absolute working dir |
| `scope` | select | no | dev / staging / prod |
| `project` | select | no | weaverbird / other |
| `home_group_id` | text | yes | IM group / thread |
| `agent` | select | no | claude-code / codex / other |
| `latest_run_id` | text | yes | latest related runs.run_id |
| `operator` | user (multiple) | no | triggering open id |
| `entry_form` | select | no | values from ENTRY_FORMS |

## 6. 常见错误与修复

### `captain not configured`

说明：`/health` 能跑到 Captain 检查，但没有读到有效 `captain` 配置。

下一步：

- 检查 `~/.weaverbird/config.json` 是否真的含 `captain` block
- 检查 `sessions_table_id`、`captain_state_path`、`captain_toml_path` 这些字段名是否完整

### `captain.json is missing in repo root and ~/.weaverbird`

说明：loader 没找到任何 JSON 映射文件。

下一步：

- 在仓库根创建 `captain.json`
- 或在 `~/.weaverbird/captain.json` 建本机 override

### `captain.toml detected but TOML parser is not available`

说明：当前实现不会读取 TOML。

下一步：

- 把 `captain.toml` 改成 `captain.json`
- 或补一份等价 JSON 文件

### `WAL backlog: N`

说明：本地写远端 sessions mirror 积压了。

下一步：

- 检查 Bitable 凭证和权限
- 看 `captain_state_path` 是否可写
- 先保证本地 state file 和 config 正常，再排远端写入问题

## 7. 边界与协作关系

- 要跑多 bot + Captain 主路径：先看 [multi-bot-setup.md](./multi-bot-setup.md)
- 要跑 `attach`、echo、反向 `@wb`：再看 [reverse-channel-setup.md](./reverse-channel-setup.md)
- 这份文档不定义 Captain 的产品语义；语义边界看 `docs/topics/captain-bot.md`
