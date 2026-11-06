# 计划：把 PM 实战经验写进 pm 角色（第一次）

- 日期：2026-11-06
- 依据：[docs/research/pm-practice-distillation.md](../research/pm-practice-distillation.md) §5
- 范围：只改 `packages/roles` 中 pm 角色的 Core Prompt 和对应测试。不改 coder、reviewer，不改 §6.3 协议，不改 domain、MCP 和数据库。

| 任务 | 内容 | 实现 | 分支 |
|---|---|---|---|
| PL.1 | pm Core Prompt 增补 | Codex | `feat/pm-role-lessons` |

## PL.1 pm Core Prompt 增补

1. 在 `ROLE_BODIES.pm` 里，在"打断规则"一节之后、"PM Office（前台）"一节之前，加入研究文档 §5 第一个代码块的四节（核实、拆卡和派活、拍板和汇报、委派），文字照抄。
2. 在"PM Office（前台）"一节末尾加入 §5 第二个代码块的一条；在"PM Ops（后台）"一节末尾加入第三个代码块的两条。
3. 把新增的规则抽成导出的常量数组（参照 `AGENT_PROTOCOL` 的写法），Core Prompt 由数组拼出来，方便测试逐条断言。
4. 测试：
   - pm 的 Core Prompt 包含每一条新增规则，office 和 ops 两种模式都包含；
   - coder 和 reviewer 的 Core Prompt 不包含这些规则；
   - 现有的 §6.3 协议测试不变，照常通过。

验收：`pnpm build && pnpm test && pnpm lint && pnpm check:deps` 全部通过；PR 描述写明对应研究文档 §5。
