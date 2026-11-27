# Reverse Channel Setup Guide (W3.3)

> **Audience**: product-owner / operator
> **Scope**: IPC socket、`wb-cli attach`、echo 去重文件、SLA 指标、`/health` Reverse Channel 检查
> **Status**: W3.3 current guide

如果你只想最短路径确认 reverse channel 可用，先做这 4 步：

1. 先按 [captain-setup.md](./captain-setup.md) 配好 Captain 基础配置。
2. 启动带 Captain 的 `wb-bot`，让它创建 `~/.weaverbird/captain.sock`。
3. 在 bot 侧执行 `/health`，确认 `Reverse Channel` 显示 `socket + ping + hello ack ready`。
4. 在 CLI 执行 `wb-cli attach <session_id>`，或执行 `wb-cli captain sla` 看当前 SLA 汇总。

## 1. 这条通道做什么

Reverse Channel 是 CLI 和 bot 之间的本地 IPC 控制层。当前文档覆盖的能力有：

- `wb-cli attach <session_id>` 通过 Unix domain socket 把 CLI 接到已有 Captain session
- echo / reverse-@ 路径使用同一套 IPC server
- SLA 指标写到 `~/.weaverbird/sla-metrics.ndjson`
- `/health` 做 socket、握手和 ping 自检

边界：

- 这条通道不用 TCP / UDP 端口，只用本地 Unix socket
- `attach` 是 CLI-only 命令，不是 IM 帮助面默认展示项
- 本文档不重复解释 Captain 表和映射；那部分走 [captain-setup.md](./captain-setup.md)

## 2. 前置条件

- Captain 已配置完成
- `wb-bot` 已启动，且启用了 Captain / reverse channel wiring
- `~/.weaverbird/` 可写

必需文件：

- `captain-state.ndjson` 可写
- `echo-dedup.ndjson` 可写

## 3. 最短成功路径

### 3.1 确认 IPC socket 存在

Reverse-channel IPC server 监听：

- `~/.weaverbird/captain.sock`

要求：

- mode 必须是 `0600`
- 旧的 stale socket 文件会在 server 启动时被重建

### 3.2 用 `/health` 做最小活性检查

在 bot 侧执行：

```text
/health
```

Reverse Channel 当前 live checks：

- socket exists
- socket mode is `0600`
- IPC `hello` returns a valid `ack`
- IPC `ping` returns `pong`

健康时细节应接近：

- `socket + ping + hello ack ready`

### 3.3 执行一次 attach

```bash
wb-cli attach <session_id>
```

这个命令会：

- 先发 `hello`
- 再发 `attach`
- 最后把 server 返回的 `ack` 原样打印成 JSON

如果当前 session ownership 冲突，可加：

```bash
wb-cli attach <session_id> --force
```

## 4. 端到端示例

下面这条链路是当前最小可复制流程：

```bash
ls -l ~/.weaverbird/captain.sock

wb-cli attach session-001
wb-cli captain sla
wb-cli captain sla --json
```

期望：

- `captain.sock` 存在
- `wb-cli attach session-001` 输出一行 JSON，其中有 `session_id` 和 `ack`
- `wb-cli captain sla` 输出 3 行摘要：
  - `F18 attach P95: ...ms`
  - `F19 echo P95: ...ms`
  - `F21 hit rate: ...%`

## 5. 关键路径与文件落点

### IPC socket

- `~/.weaverbird/captain.sock`

### attach / echo / reverse-@ prerequisites

- sessions table already exists in the configured Captain base
- `captain.json` mapping is present
- `captain-state.ndjson` is writable
- `echo-dedup.ndjson` is writable

### SLA metrics

指标文件：

- `~/.weaverbird/sla-metrics.ndjson`

当前汇总的指标：

- F18 attach latency (`attach_p95_ms`)
- F19 echo latency (`echo_p95_ms`)
- F21 reverse-at hit rate (`reverse_at_hit_rate`)

CLI 查看方式：

```bash
wb-cli captain sla
wb-cli captain sla --json
```

## 6. 常见错误与修复

### `socket missing`

说明：`/health` 没找到 IPC socket。

下一步：

- 确认 `wb-bot` 已启动且启用了 Captain
- 确认数据目录是同一个 `~/.weaverbird`

### `socket mode XXX != 600`

说明：socket 文件权限不符合当前健康检查要求。

下一步：

- 重启 bot 让 server 重建 socket
- 避免手工创建或覆盖该 socket 文件

### `ipc_unreachable:...`

说明：socket 存在，但 `hello` / `ping` 握手失败。

下一步：

- 先重新执行 `/health`
- 再看 `wb-bot` 日志和 reverse-channel 启动路径
- 若刚发生 bot 重启，先确认 socket 已被新进程接管

### attach 返回 `mutex_conflict`

说明：session 当前属于别的 captain。

下一步：

- 确认是否应该 handover
- 需要强制接管时用 `--force`

### attach 返回 `not_found`

说明：session id 不存在于当前可见 session store。

下一步：

- 检查 session id 是否输错
- 先确认 Captain sessions mirror 是否正常

## 7. 边界与协作关系

- Captain 基础配置：看 [captain-setup.md](./captain-setup.md)
- 多 bot 安装与启动：看 [multi-bot-setup.md](./multi-bot-setup.md)
- 这份文档不定义反向 `@wb pause|resume|cancel` 的产品策略，只说明它们依赖的本地通道与健康检查
