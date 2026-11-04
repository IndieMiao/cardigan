# Domain · M1.1–M1.2

公开入口是 `@cardigan/domain`。提供 M1.1 的实体类型、编号、端口和开发卡模板，以及 M1.2 的状态迁移与派生计算；对应 `docs/plans/phase-1-m1.md`。

## 编号

- `formatId(kind, sequence)` / `parseId(kind, input)` 覆盖 `C-`、`W-`、`A-`、`R-`、`D-`、`V-`、`q(n)`、`h(n)`。
- 从 1 开始，仅接受无前导零的安全整数；拒绝空白、指数/小数形式和溢出。返回 `Result<T>`，失败为 `validation_failed`，不依赖异常表达非法输入。
- `formatTimelineEntryId` / `parseTimelineEntryId` 使用 `C-n#m`。条目计数独立于 Event.seq，同一事件可以对应多个条目。
- `parseEventId` 校验规范的大写 ULID，包括 128 位上限；ULID 的生成通过 `IdAllocator.nextEventId` 注入。
- 可读编号和 EventId 使用不同的 branded string 类型，防止 CardId / WorkItemId 等互换。项目、角色、机器、附件的编号格式未在计划中规定，暂保留 string 别名。

## 数据与端口约定

- 字段沿用开发方案的 snake_case。类型是只读快照；业务命令、权限及长度限制由后续任务实现。
- 持久实体 `Card`、`Review`、`Attachment` 不含派生字段；完整读取形态为 `CardView`、`ReviewView`、`AttachmentView`，供 M1.2 的计算结果使用。
- 计划未区分独立内部编号时，Decision 的 id/key、HumanAction 的 id/key、TimelineEntry 的 id/short_id 使用同一种可读编号；后续命令负责保持字段值一致。
- 可选字段用缺省表示；`runtime_ref=null` 表示尚无运行时，`Run.outcome=null` 表示尚无结果。时间戳由 Clock 返回字符串，适配器负责统一时间格式。
- `Actor` 由认证层构建，带项目及 Token 绑定的 Assignment/Role 版本/工具权限；类型本身不能证明认证已经完成。`Author` 是时间线中可序列化的作者引用。
- `kind=approve` 的 Decision 用 `target` 表示其绑定的 Delivery 或 subject。`requested_verifiers` 使用验证型 WorkItemId，不用不明确的角色字符串。
- source、引用及附件挂载目标使用带 kind 的联合类型。测试结果为 command/result；已知遗留为 description 加可选 followup_card_id；控制面证据为 kind/details（JSON）。这些是尚未具体规定的字段形状选择，不包含新行为。
- priority 暂用 number，capabilities 暂用 string 列表，severity 使用 critical/major/minor；未实现排序或能力匹配。
- 仓储读写都显式传 project_id，防止项目内可读编号在不同项目之间碰撞。角色主键包含版本，Cursor 主键包含 Assignment 和 Card。
- `UnitOfWork.run` 约定同步回调，事务上下文包含仓储及 IdAllocator；实现方负责同一事务中的编号递增与回滚。DeliveryVerifier / AttachmentStore 是异步 IO 端口，应在事务外调用；这些端口在本 PR 中均无实现。
- EventRepository 的 card_id 缺省表示项目级事件流；跨卡聚合仍由上层逐流处理。Event 的 type/payload 保留 string/JSON，事件词汇表由 M1.3 确定。
- 验证型工作项的 blocked / waiting_decision 和 max_review_rounds 表达人工操作阻塞及审核上限。PM 验收模板不绑定开发工作项，完成申请的审核者为 role:pm。

## M1.2：迁移与派生计算

- `transition(machine, from, event)` 查九张表，返回 `Result<状态>`；未列出的组合（含终态重新开始）返回 `illegal_transition`。事件名表达已校验的事实，不是 MCP 命令；调用者身份、交付版本和完成申请审核资格由 M1.3 检查。
- 产出型工作项按 §4.4 可取消；Run 在排队/派发/执行等未结束状态可取消。失联只进入 unknown，未定义的自动恢复路径不在本次添加。新交付可 supersede 已接受/驳回的交付，并将已通过/失败的验证项重新置为 ready。
- 开始审核使用 `beginReviewRound(from, round, max_review_rounds)`：round 是即将开始的正整数轮次，默认上限 3；合法 ready 状态下，第 3 轮可开始，第 4 轮进入 waiting_decision。拍板后回 ready，仍须检查新上限。创建 Decision、记录轮次和放宽权限属于 M1.3。
- `deriveReview` 返回新 issues 数组、verdict 和 blocking，不修改输入；critical 的 proof 缺失、空串或全空白都降为 major，仍以 must_fix / pre_existing 决定是否阻塞。
- `isReviewStale` 接收当前交付：交付 ID 改变（即使 SHA 相同）、subject.value 不同或已 superseded，旧结论失效。
- `deriveReviewMatrix` 接收同一项目/卡片的交付版本、工作项和审核集合，返回交付 × verify 工作项的矩阵。只取匹配交付/验证项/当前 subject 的审核，以项目内递增的 V-n 数值选最新，不依赖数组顺序；superseded 状态或 supersedes 链接使旧行失效，无结论时 verdict=null。它不自行读取或聚合不同项目的数据。
- `deriveAttachmentApproval` 按 basis 查 Decision.key：resolved → approved；open/provisional → pending；revoked/withdrawn/superseded → revoked。没有 basis 或找不到对应决定时保持 pending，不猜测为已批准。
- `deriveCardStatus` 保留 done/cancelled；尚无工作活动时保留 backlog/todo。进入活动后，至少一个必需产出项且全部 delivered/accepted、没有失败的必需验证项时为 review，否则为 in_progress；可选项不阻止进入 review。
- 可以额外传入当前完成申请：submitted 优先显示 review（允许存在已知遗留），rejected 回 in_progress。accepted 也不会自动派生 done；只有 `completion_review_passed` 迁移事件可完成卡片，M1.3 必须保证该事件来自有效的完成申请审核。普通审核通过不能替代该事件。

这些函数只计算状态/视图，不修改实体、创建事件、访问仓储或发送门铃。计划未细化的状态映射及“最新”判定约定集中记录在上面，供本次 PR 评审。

## 测试

`pnpm test` 先执行 domain 的 `test:types`，再运行 Vitest；不能仅运行 Vitest 就认定类型契约通过。`tsconfig.test.json` 将测试纳入 TypeScript 检查，生产构建仍排除测试。

编号测试覆盖规范形式、边界、错误类型及非法输入。M1.1 契约覆盖类型及模板约束；M1.2 契约覆盖每张表的合法/非法迁移、审核轮次边界、各派生规则及不变量 8、11、13、14。业务命令的验收和独立交叉验收仍由 M1.3 / M1.T1 完成。
