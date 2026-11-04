# Domain · M1.1

公开入口是 `@cardigan/domain`。本任务提供实体类型、状态词表、编号解析/格式化、端口及 `developmentCardTemplate`，对应 `docs/plans/phase-1-m1.md` M1.1。

## 编号

- `formatId(kind, sequence)` / `parseId(kind, input)` 覆盖 `C-`、`W-`、`A-`、`R-`、`D-`、`V-`、`q(n)`、`h(n)`。
- 从 1 开始，仅接受无前导零的安全整数；拒绝空白、指数/小数形式和溢出。返回 `Result<T>`，失败为 `validation_failed`，不依赖异常表达非法输入。
- `formatTimelineEntryId` / `parseTimelineEntryId` 使用 `C-n#m`。条目计数独立于 Event.seq，同一事件可以对应多个条目。
- `parseEventId` 校验规范的大写 ULID，包括 128 位上限；ULID 的生成通过 `IdAllocator.nextEventId` 注入。
- 可读编号和 EventId 使用不同的 branded string 类型，防止 CardId / WorkItemId 等互换。项目、角色、机器、附件的编号格式未在计划中规定，暂保留 string 别名。

## 数据与端口约定

- 字段沿用开发方案的 snake_case。类型是只读快照；业务校验、长度限制及状态迁移由后续任务实现。
- 持久实体 `Card`、`Review`、`Attachment` 不含派生字段；完整读取形态为 `CardView`、`ReviewView`、`AttachmentView`，供 M1.2 的计算结果使用。
- 计划未区分独立内部编号时，Decision 的 id/key、HumanAction 的 id/key、TimelineEntry 的 id/short_id 使用同一种可读编号；后续命令负责保持字段值一致。
- 可选字段用缺省表示；`runtime_ref=null` 表示尚无运行时，`Run.outcome=null` 表示尚无结果。时间戳由 Clock 返回字符串，适配器负责统一时间格式。
- `Actor` 由认证层构建，带项目及 Token 绑定的 Assignment/Role 版本/工具权限；类型本身不能证明认证已经完成。`Author` 是时间线中可序列化的作者引用。
- `kind=approve` 的 Decision 用 `target` 表示其绑定的 Delivery 或 subject。`requested_verifiers` 使用验证型 WorkItemId，不用不明确的角色字符串。
- source、引用及附件挂载目标使用带 kind 的联合类型。测试结果为 command/result；已知遗留为 description 加可选 followup_card_id；控制面证据为 kind/details（JSON）。这些是尚未具体规定的字段形状选择，不包含新行为。
- priority 暂用 number，capabilities 暂用 string 列表，severity 使用 critical/major/minor；未实现排序、能力匹配或审核规则。
- 仓储读写都显式传 project_id，防止项目内可读编号在不同项目之间碰撞。角色主键包含版本，Cursor 主键包含 Assignment 和 Card。
- `UnitOfWork.run` 约定同步回调，事务上下文包含仓储及 IdAllocator；实现方负责同一事务中的编号递增与回滚。DeliveryVerifier / AttachmentStore 是异步 IO 端口，应在事务外调用；这些端口在本 PR 中均无实现。
- EventRepository 的 card_id 缺省表示项目级事件流；跨卡聚合仍由上层逐流处理。Event 的 type/payload 保留 string/JSON，事件词汇表由 M1.3 确定。
- 验证型工作项的 blocked / waiting_decision 和 max_review_rounds 为计划中的人工操作阻塞、审核上限预留类型；默认上限和迁移规则属于 M1.2。PM 验收模板不绑定开发工作项，完成申请的审核者为 role:pm。

## 测试

`pnpm test` 先执行 domain 的 `test:types`，再运行 Vitest；不能仅运行 Vitest 就认定类型契约通过。`tsconfig.test.json` 将测试纳入 TypeScript 检查，生产构建仍排除测试。

编号测试覆盖规范形式、边界、错误类型及非法输入。公开入口的契约测试覆盖不变量 1、5、12、14 在类型上的约束，以及 D4 / 不变量 13 的模板配置；它们不替代 M1.2/M1.3 和交叉验收任务对运行时行为的验证。
