# C-3：CLI 支持人修改和取消卡片

依据：C-3 / W-7 的目标与验收标准；补充 M1.7b 的人用 CLI 入口。

## 实现范围

- 新增 `cardigan card update <C-n> [--title <标题>] [--goal <目标>] [--acceptance <标准1;标准2>] [--priority <n>] [--status backlog|todo|cancelled] [--project <p>]`。
- 至少提供一个修改字段；验收标准按分号拆分、去空白，优先级必须为有限数值。无效编号、状态、参数及空字段返回中文用法错误。
- 复用项目选择、`humanActor` 和事务内 `runCommand`，调用现有 domain `updateCard`；取消工作项和拒绝转换均沿用 domain 规则，不改变领域模型。
- 状态机核对：既有 domain 允许 `done → cancelled`，拒绝 `done → todo/backlog`；以被拒绝的转换验证已完成卡片的中文错误与回滚，不在 CLI 增设状态规则。
- 成功显示卡片编号及修改字段；domain 拒绝时显示中文原因、非零退出码，保留原数据。
- 同步顶层帮助、card 子命令用法、`packages/domain/COMMANDS.md` 和开发方案 §13.1 的 CLI 说明，不修改方案顶部版本与变更记录。

## 验证与交付

- CLI 测试覆盖文字与验收标准、优先级、规划状态、取消及已通过验证项保留、拒绝转换的事务回滚、无字段与非法参数、项目选择和帮助。
- 运行 `pnpm exec vitest run apps/cli`、`pnpm lint`、`pnpm check:deps`；不运行全量测试或 e2e。
- 在当前工作项分支本地提交，以 commit SHA 经 `submit_delivery` 交付，请求 W-8 代码审核；不开 PR、不 push。
