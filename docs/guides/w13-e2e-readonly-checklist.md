# W13 E2E Readonly Checklist

> **Audience**: 主设计师本人 / 后续接手者  
> **Scope**: W13 L3 最小真机残余项  
> **Status**: draft-for-use  
> **Rule**: 本文档只记录**人工**执行的真机动作；agent 不得代执行

---

## 0. 为什么还有这份 checklist

W13 已把可自动化部分前移：

- **L1**：mock transport + sanitized replay，覆盖 handler → 授权 → 叫停 → 通知 → 审计链路
- **L2**：`npm run e2e:preflight:env` 只读预检，探活 env / bot identity / 群角色接口 / shortId 解析

因此 L3 只保留 **CI 不能替代** 的真机残余项：

1. 真 bot 在线且群内可见
2. 真群角色授权判定
3. 真卡片按钮回调链路

原始累计 runbook 仍看：`tests/wb-bot/E2E.md`。本文档**不重写**原 runbook，只提供 W13 最小人工入口。

---

## 1. 死红线

- **任何真机写动作前，agent 必停报，等你指令**
- 只允许在**测试群 / 测试 bot / 测试身份**下执行
- 不得把真实 `open_id` / `chat_id` / `thread_id` / token / secret / 群截图直接进 commit
- 若需要留证据，先做脱敏摘要，再记录到 closeout
- 若验证必须升级为删消息 / kill 进程 / 改 launchctl / 真群广播，停止并单独决策，不属于本 checklist 默认范围

---

## 2. 执行前准备

先确认自动化面已绿：

```bash
npm run e2e:preflight:env
npm run build
npm run typecheck
npm test
```

执行前人工确认：

- 当前使用的是测试 bot，而非生产 bot
- 当前会话中的 agent 已明确停在“只给步骤，不代执行”状态
- 你已经准备好一个测试群，且至少有：
  - 1 个 operator 身份
  - 1 个 admin 身份（owner / group_admin / whitelist 任选其一）
  - 1 个普通成员身份

---

## 3. 最小真机 checklist

## L3-1 · bot 在线且群内可见

**目的**：确认真 bot 已连上飞书，且群里能看到卡片入口。  
**是否写动作**：是，人工发送测试消息；agent 不得代发。

### 人工步骤
1. 在测试群 `@bot /help`
2. 再发 `/list-agents`
3. 发一条普通短请求，例如“hello”或“read README title”

### 预期
- bot 有响应
- `/list-agents` 返回当前 agent 摘要
- 普通请求出现运行卡片
- 卡片 header 可见 active agent，且存在可见 shortId

### 异常对照
- **无响应**：先回看 `npm run e2e:preflight:env` 是否已在同配置下通过
- **仅 DM 可用、群里不可用**：优先排查 bot 是否在测试群内、群里是否正确 `@bot`
- **有文本无卡片**：记录 message type / 群类型 / 是否为旧卡片回退，不在本 checklist 内继续扩动作

---

## L3-2 · 群角色授权判定

**目的**：确认真群里的 admin / member 判定与 W8/W11 冻结语义一致。  
**是否写动作**：是，人工发送测试 cancel 请求；agent 不得代发。

### 人工步骤
1. 先由 operator 发一条可见 shortId 的运行卡片
2. 用 admin 身份执行一次 `/cancel <shortId>`
3. 用普通成员身份执行一次 `/cancel <shortId>`

### 预期
- admin：允许，目标运行进入已叫停 / 已结束无需再叫停 语义
- member：拒绝，文案保持无权操作 / fail-closed 语义，不得放权
- 审计与 operator 通知由系统内部产生，不要求人工直接读取底层文件

### 异常对照
- **admin 被拒**：优先怀疑测试群角色、白名单或 bot 不在同一群上下文
- **member 被放行**：立即停止后续动作，视为红线回归
- **角色查询异常**：应表现为 fail-closed，而不是默认放行

---

## L3-3 · 卡片按钮回调链路

**目的**：确认真卡片 `叫停` / `停止` 的前端入口与后端冻结语义一致。  
**是否写动作**：是，人工点击卡片；agent 不得代点。

### 人工步骤
1. 由 operator 再起一条短运行，等卡片出现
2. admin 身份点击一次 `叫停`
3. operator 身份点击一次 `停止`

### 预期
- admin `叫停`：走 W11 → W8 同链路，效果与 `/cancel <shortId>` 一致
- operator `停止`：仍走 operator/self-stop 路径，不进入 `admin_cancel` 语义
- 两条路径都不应出现“猜最近一次任务”之类隐式目标选择

### 异常对照
- **按钮无反应**：记录卡片是否为旧版本、message 是否已过期
- **operator 点击后表现成 admin cancel**：立即停止后续动作，视为冻结回归
- **admin 按钮能看见但权限不对**：允许“可见但仍被授权拒绝”，不允许越权放行

---

## 4. 建议记录格式（脱敏后）

只记录脱敏摘要，不贴真实凭证或真实标识：

```md
- date: YYYY-MM-DD
- env: test bot / test group / desktop or mobile
- L3-1: pass | fail
- L3-2: admin=pass, member=pass | fail
- L3-3: admin-button=pass, operator-stop=pass | fail
- notes: only sanitized summary, no real identifiers
```

禁止记录：

- 真实 `open_id`
- 真实 `chat_id` / `thread_id`
- app secret / token / access token
- 未脱敏飞书截图

---

## 5. 什么时候要停下

出现以下任一情况，停止人工执行并单独决策：

- 需要删消息、kill 进程、重启 launchctl、改生产群配置
- 发现按钮或 `/cancel` 有越权放行迹象
- 发现日志 / 截图 / 文档里将要落真实凭证或真实标识
- 为了“探活”而不得不触发额外真实写操作

这四类都不属于 W13 默认 L3 最小 checklist 范围。
