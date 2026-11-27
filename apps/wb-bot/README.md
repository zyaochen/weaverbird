# wb-bot

## Quickstart

首次需配置飞书自建应用 (约 10-15 分钟), 已有 LARK_APP_ID/SECRET 凭证者约 30 秒。

```bash
npm install
cp apps/wb-bot/.env.example apps/wb-bot/.env
npm run wb-bot:dev
```

在 `.env` 里至少填：`LARK_APP_ID`、`LARK_APP_SECRET`，并按你的运行环境选择 agent 凭证来源；如果日常使用的是包装命令，可额外设置 `WB_CLAUDE_COMMAND` / `WB_CODEX_COMMAND`（例如 `claude-w` / `codex-w`）。

## 飞书平台配置 (6 步)

1. 创建企业自建应用。
2. 启用机器人能力并设置名称/头像。
3. 在事件与回调里选择"长连接接收事件"。
4. 订阅 `im.message.receive_v1` 和 `card.action.trigger`。
5. 在权限管理里添加 `im:message`、`im:message.group_at_msg`、`im:resource`，然后发布版本。
6. 运行 `npm run wb-bot:dev` 后，在飞书 DM 发 `/list-agents` 确认卡片能显示 agent 能力摘要。

以下是可选项，缺了只影响对应功能，bot 照常工作：

| 功能 | 需要的权限 / 事件 | 缺了会怎样 |
|---|---|---|
| 运行卡流式输出（打字机效果） | 权限 `cardkit:card:write` | 自动退回整卡更新（每 800ms 刷一次），日志里有 `cardkit create failed` |
| 话题群里回复进话题 | 权限 `im:chat:readonly` | 话题群判定失败按普通群回复；已在话题里的消息不受影响 |
| `/require-mention off` 后不 @ 也响应 | 权限 `im:message.group_msg`（敏感权限，需管理员审批） | 飞书只推送 @bot 的消息，开关形同未关 |
| 撤回排队中的消息 | 事件 `im.message.recalled_v1` | 撤回的消息仍会在上一轮结束后被处理 |
| 云文档评论里 @bot | 事件 `drive.notice.comment_add_v1` + 权限 `drive:drive`，bot 需对文档有评论权限 | 收不到评论事件 |

## 与飞书的交互

- **输入**：文本、富文本（post）、图片、文件、音视频、合并转发都会解析；图片和文件下载到 `<dataDir>/media/`；codex 通过 `--image` 接收图片，claude 与其余附件以本地路径写进输入，由 agent 自己打开。引用回复会把被引用的消息作为 `> 引用消息` 放在输入前面。
- **回执**：开始处理的消息会被打上「敲键盘」表情，结束后撤掉；缺表情权限时只记日志。
- **连发合并**：同一会话 600ms 内的连发合并成一次（`/` 开头的命令不等）。运行中再发的消息排队，卡片上显示排队数，本轮结束后合并成下一轮；点「停止」会一起丢掉排队消息。
- **运行卡**：进行中显示最近的思考、最近 3 个工具调用和阶段/耗时；结束后思考与工具收进折叠面板，页脚显示 tokens 与费用（agent 上报了才有）。正文超过约 12000 字时，后面的部分以「续 k/N」卡接着发，不切断代码块。
- **结束卡按钮**：「继续」「重试」「新会话」只有发起人能点。「继续」等于发一句 `继续`，「重试」重发原消息，「新会话」清掉这张卡所属 agent 的上下文。bot 重启后旧卡的按钮会提示失效。
- **产物回传**：本轮在 cwd 里新写或改过的文件（≤20MB，最多 3 个）会列在结束卡上，点「发送」才上传，不会自动外发。
- **话题群**：话题里的消息、话题群里的消息，回复都挂在话题里。
- **云文档评论**：在 doc / docx / sheet / file 的评论里 @bot，评论线程（选中原文、之前的回复、问题）作为输入，答案以纯文本回在同一线程，整篇评论则另起一条评论。bot 不读写文档正文，agent 需要正文时自己用 lark-cli 等工具。没有停止按钮，单次最长 15 分钟。
- **连接保活**：每 15s 检查一次长连接；从睡眠醒来先等一轮；连续 3 次未连上且能访问飞书时重建连接。`/health` 显示连接状态与最近重连时间。

## 环境变量（飞书交互）

| 变量 | 默认 | 作用 |
|---|---|---|
| `WB_MESSAGE_DEBOUNCE_MS` | `600` | 连发合并的静默窗口，`0` 关闭合并 |
| `WB_MEDIA_MAX_MB` | `20` | 单个附件下载上限 |
| `WB_MEDIA_CACHE_MAX_MB` | `1024` | 附件缓存总量上限，超出按最旧淘汰 |
| `WB_CARD_STREAMING` | 开 | `0` 关闭 CardKit 流式卡，只用消息卡片整卡更新 |
| `WB_CARD_SHOW_THINKING` | 开 | `0` 不在卡片上显示思考内容 |
| `WB_DOC_COMMENTS` | 开 | `0` 不处理云文档评论事件 |

## 运行

```bash
npm run wb-bot:dev
```

如需显式指定 agent 命令：

```bash
WB_CLAUDE_COMMAND=claude-w WB_CODEX_COMMAND=codex-w npm run wb-bot:dev
```

## 命令

- `/use <agent>`
- `/list-agents`
- `/now`
- `/reset-context`
- `/stop`
- `/follow` — 当前 thread 有 active run 时，完成后额外推一条通知
- `/status` — 本 bot active run 摘要；Captain 启用时显示跨 bot 汇总
- `/stop-all` — 本 bot 所有 active run；Captain 启用时跨 bot 派发 stop
- `/logs [tail=N]` — 本 bot 最近日志
- `/health` — 本 bot 控制面健康；Captain 启用时附带其它 bot 心跳状态
- `/tasks [N] [<agentId>]` — 本 bot 任务历史
- `/queue-metrics` — 当前 session 队列指标
- `/list-bots` — single-bot 下返回退化视图；Captain 启用时列出全部 bot
- `/cwd <abs-or-alias>` — 默认允许 `~/projects`, `~/code`, `~/work`, `/tmp` 前缀; 其他目录 (含 `~/dev`, `~/Desktop` 等) 需先 `/cwd-add <prefix>` 添加
- `/cwd-add <name> <abs-path>`
- `/cwd-list`
- `/cwd-rm <name>`
- `/require-mention [on|off]` — 查看 / 修改本群是否必须 @bot 才响应；修改仅限群主、群管理员和 `WB_REVERSE_AT_ADMIN_OPEN_IDS` 白名单
- `/help`

说明：`/help` 会按模式收紧展示面。single-bot 默认不主动暴露 Captain 分组，但命令路由本身仍有 single-bot degrade 行为。

## WB_CLAUDE_COMMAND / WB_CODEX_COMMAND

`WB_CLAUDE_COMMAND` / `WB_CODEX_COMMAND` 是**本机私用** wrapper 命令名 (例: SSO 包装脚本 `claude-w`); 这是 operator-startup 阶段的本机 override, **不是 SDK 扩展点 / 不是可被外部组件组装的 wb-bot framework hook**; 留空即用系统 PATH 里的 `claude` / `codex`。

## 部署

当前提供 `deploy/launchd/com.weaverbird.wb-bot.plist` 模板。
使用前请先把其中的 `__NODE_BIN__` 和 `__WEAVERBIRD_ROOT__` 替换成你机器上的实际路径，然后再用 `launchctl` 加载。

环境文件示例位于 `apps/wb-bot/.env.example`。
