# APIAgent 叙事撤回说明

> 状态:已撤回(Deprecated) · 依据:PRD §6.2 / §6.3 · 生效:W3 · 归口:本 note

## 1. 撤回结论

- **APIAgent / 4-agent / dispatcher 多智能体叙事**自 W3 起**正式撤回**(PRD §6.2)。
- 实际形态:**CLI-First 单机控制面**,`cc / codex / mira-cli` 为**三个同级 CLI agent**,无 APIAgent 这一层。
- **Mira 是 Agent 之一,非 owner**(PRD §6.3)。owner 是人(飞书群里的你),Mira 与 cc/codex 平级受派。

## 2. 被取代的表述(docs/product-strategy.md)

| 位置 | 旧口径(已废) | 现口径 |
|---|---|---|
| L14 slogan | 多 APIAgent 编排 | CLI-First,把 Coding Agent 重定义为 IM 同事 |
| L129 架构 | APIAgent 分层/dispatcher | event-handler 统一入口 + Command Catalog 派发 |
| L148 分层 | APIAgent 为独立层 | cc/codex/mira-cli 三同级,无独立 agent 层 |
| L269 边界 | APIAgent 持有会话 | 会话由 captain/run-registry 持有 |
| L327 设计问 | "APIAgent 如何协调" | 不适用,已撤回 |

## 3. 参考口径

`product-strategy.md:81 / :84` 已带诚实撤回标注(W3+ spec / 0 个 APIAgent),**以该两行为准口径**,本 note 与其一致。

## 4. 保留不改(历史/接口设计史)

- `plans/w0 ~ w2.5`:历史规划,保留。
- `docs/topics/agent-adapter.md`:接口设计史,保留。

## 5. owner 本地动作

在 `docs/product-strategy.md` 顶部加一行指针:
`> APIAgent 相关叙事已于 W3 撤回,见 docs/product-strategy-APIAgent-deprecation-note.md`
(原文指针 = 就地改 = owner 本地;本 note 新建 = 重构=新建,不改原文。)

## 执行包 (owner 本地)

新建 docs/product-strategy-APIAgent-deprecation-note.md(粘上面内容)。
product-strategy.md 顶部加 1 行指针 (§5)。
提交:docs(strategy): retract APIAgent narrative, add deprecation note。tag 不加。
红线：只动这 2 个文件；不碰 plans/* 与 agent-adapter.md; 不删原文段落 (指针式)。
