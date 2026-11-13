# ADR 0008：把 PM Ops 的机械规则交给系统（自动指派验证项、系统代确认合并、定时催办）

- 状态：**提议，待邵杰拍板**。本 ADR 只记录盘点和设计，不改产品代码；文中凡是新数值一律标“待定、交人”。拍板前不开发实现部分（C-225 验收标准第 1 条）。
- 卡片：C-225（W-691 开发；W-692 代码审核；W-700 独立复核；W-693 PM 验收）。`risk_tags=[permission, numeric_rule]`。
- 来源：邵杰 2026-11-14 对话：“王熙凤这种常驻的 pm 可以开分身审核么? 我发现部分瓶颈在这个角色”；张良给出四个方案，邵杰选“1. 机械规则交给系统”。卡片附带数据：王熙凤 11-13 共 312 轮 Run（平均 55 秒），指派 118 次、评论 251 条；W-665/W-667 就绪后等了 10 多分钟才派；R-3328 空挂 30 分钟期间全项目停摆。
- 范围外（卡片 out_of_scope）：不开多个 PM Ops 分身，不改“每项目一个常驻 PM Ops”；不改人确认的边界（敏感、D12 四类、角色规则、需求范围、对外发布）。
- 依据：开发方案 §4.4、§4.5（不变量 11、15、16、17、20、22、23、26、29）、§6.4、§7.1–§7.4、§14；ADR 0006（独立复核与风险标签代确认）；AGENTS.md“独立复核”一节。
- 代码依据（main `b6693d8`）：
  - 指派：`packages/domain/src/commands/pm.ts` `assign`（L608，`d.pm()` 只认 PM 或 human）；`packages/domain/src/commands/employee-assignment.ts` `selectEmployee`（不传员工时已按“在职、非外接、同角色、满足隔离、空闲优先、最久未指派优先、编号小优先”挑人）、`employeeConflicts`/`checkEmployeeSeparation`（员工隔离，含已释放的历史 Assignment，`independent_reviewer` 的三方隔离）。
  - 合并：`packages/domain/src/commands/delegation.ts` `mergeNeedsHuman`、`mergeRequiresHuman`、`riskTagAutoMergeAllowed`、`delegationAllowed`；`packages/domain/src/commands/merge-delegation.ts` `pmMergeBlockers`；`packages/domain/src/commands/auto-merge.ts` `autoMergeSchedule`/`autoConfirmMerge`（已有的 system 超时代批）；`packages/domain/src/commands/screenshot-check.ts`；`packages/domain/src/commands/pre-merge-checks.ts` `effectivePreMergeChecks`/`openPreMergeChecks`。
  - 定时：`apps/server/src/pm-merge-stall-attention.ts` 与 `packages/domain/src/pm-merge-stall-attention.ts`（C-177，`merge_confirm_stall_after_minutes`）、`apps/server/src/review-limit-attention.ts`、`packages/domain/src/commands/inactive-run.ts`（`DEFAULT_INACTIVE_CANCEL_AFTER_MS`=60 分钟）、`apps/server/src/host-ops-patrol.ts`、C-179 合并前核对提醒（`pre_merge_check_reminded`）。
  - 路由：`packages/router/src/route.ts` `routeDelivery`/`routeCompletionRequest`/`routeCompletedItem`（验证项没有负责人时给 PM Ops 定向通知）。
  - 展示：`apps/web/src/components/EmployeeIdentity.tsx`（`author="system"` 已显示齿轮“系统”）。

## 1. 背景与目标

常驻 PM Ops 每次只能跑一轮 Run。很多轮次处理的是**结果确定**的事：

- 交付提交后，被请求的验证项没有负责人，Router 给 PM Ops 发定向通知（§7.2），PM Ops 起一轮 Run 调 `assign`——而 `assign` 不传员工时，挑谁本来就由 `selectEmployee` 按固定规则算出来。
- 合并闸门通过后，PM Ops 起一轮 Run，读 `pm_queue.merge_blockers`；为空时选 `merge` 并写一句知会。阻塞条件本来就由 `pmMergeBlockers` 在服务端强制。
- 等待过久的事项，只有在 PM Ops 下一轮盘点时才会被看到；PM Ops 自己卡住时没人发现（R-3328）。

目标：把这些确定性规则搬进 server 的调度循环和 domain 命令，actor 是 `system`；PM Ops 只处理需要判断的事项。**系统规则只能比 PM Ops 现有规则更严，不能更宽**；条件不满足或判断不确定时，事项照旧交给 PM Ops（或按原规则交人），系统不猜。

## 2. 盘点：PM Ops 今天在做什么

数据口径：只读，只统计事件类型和计数，不读取或输出正文、凭据。Agent 账号无权直接读数据库文件，所以没有直接查 `events` 表，而是用 Card MCP 的只读事件接口（`get_updates` 不带 card_id 的项目事件流，同一张 `events` 表的投影）统计。时间窗为项目事件 seq 6301–8121（2026-11-13T00:21Z–16:35Z，与卡片引用的“11-13 共 312 轮”口径接近但不完全相同）。PM Ops 当天轮换 6 次，先后 7 个 Assignment：A-460、A-506、A-515、A-545、A-560、A-570、A-595（来自 `standing_pm_rotated` 事件）。

### 2.1 Run 概况（项目事件流，覆盖完整）

| 指标 | 值 |
|---|---|
| PM Ops `run_started` | 320（A-460 2、A-506 30、A-515 64、A-545 36、A-560 34、A-570 71、A-595 82） |
| 触发类型（`run_queued.kind`） | followup 291、rework 24、initial 5 |
| 结束结果（`run_finished.outcome`） | completed 316 |
| 单轮时长（started→finished，n=314） | 中位 26 秒、P90 93 秒、最长 795 秒、平均 56 秒 |
| 排队到开始（queued→started，n=317） | 中位 8 秒、P90 16 秒、最长 544 秒 |

### 2.2 卡片级动作（张良在主机上只读补跑，C-225#12）

卡片级事件只在各卡片的事件流里，开发者 Token 只能读本卡，所以这张表由张良在主机上用只读方式（`mode=ro`）执行下面的 SQL 得到。时间窗是 2026-11-13 UTC 全天，Assignment 同上，只有类型和计数。

| 事件类型 | 次数 | 涉及卡数 |
|---|---|---|
| run_started | 339 | 0 |
| run_finished | 336 | 0 |
| comment_posted | 276 | 46 |
| work_item_assigned | 127 | 40 |
| work_item_updated | 35 | 12 |
| card_updated | 30 | 24 |
| human_action_requested | 28 | 11 |
| decision_requested | 26 | 21 |
| work_item_created | 26 | 20 |
| instruction_issued | 24 | 10 |
| pre_merge_check_updated | 18 | 17 |
| card_created | 16 | 16 |
| decision_resolved | 12 | 9 |
| human_action_completed | 3 | 3 |
| merge_confirmation_snoozed | 3 | 3 |
| merge_changes_requested | 2 | 2 |
| merge_check_requeued | 2 | 2 |

读法（只写实测计数，不推算节省的时间）：
- 数据范围：2026-11-13 UTC 全天，PM Ops 的 7 个 Assignment（A-460～A-595），只有事件类型和计数；涉及卡数按 `events.card_id` 列统计。因为是全天，run_started 为 339，比第 2.1 节（00:21Z–16:35Z）的 320 多。
- 指派 127 次（40 张卡）、评论 276 条（46 张卡）最多。这张表不区分指派的是验证项还是产出项（决定 1 只接管验证项），也不区分评论的用途。
- `decision_resolved` 12 次（9 张卡），`merge_confirmation_snoozed` 3 次，`merge_changes_requested` 2 次，`merge_check_requeued` 2 次。

SQL（`events` 表结构见 `packages/store/migrations/0001_initial.sql`；actor 和时间在 `doc` JSON 里，`card_id` 是独立列，doc 里的 `$.card_id` 为空）：

```sql
SELECT type, COUNT(*) AS n, COUNT(DISTINCT card_id) AS cards
FROM events
WHERE project_id = 'cardigan'
  AND json_extract(doc, '$.actor.assignment_id') IN
      ('A-460','A-506','A-515','A-545','A-560','A-570','A-595')
  AND json_extract(doc, '$.created_at') >= '2026-11-13T00:00:00Z'
  AND json_extract(doc, '$.created_at') <  '2026-11-14T00:00:00Z'
GROUP BY type ORDER BY n DESC;
```

### 2.3 分类结论

| PM Ops 动作 | 去向 | 理由 |
|---|---|---|
| 交付后给**验证项**指派员工（代码审核、测试、独立复核、设计核对等） | **交给系统**（决定 1） | 挑人规则已在 `selectEmployee`，隔离已在 domain 强制；PM Ops 只是“按下按钮” |
| 完成申请后给 **PM 验收项**指派工作项级 `pm` Assignment | **交给系统**（决定 1） | 同上；角色固定为 `pm`，员工隔离按不变量 15/16 |
| 给**产出项**指派开发者 | **仍由 PM Ops** | 要判断依赖、冲突文件、先后顺序（例如“等 C-202 合并后再派”），不是确定性规则 |
| 验证项没有合格员工（都冲突、都外接、没有在职员工） | **仍由 PM Ops** | 需要判断换人、新建员工或交人 |
| 合并前分类确认：对当前交付核对风险标签、界面卡、数值规则是否已由人拍板、是否对外发布、是否改角色规则，并读过全部时间线 | **仍由 PM Ops**（决定 2 条件 16，新增的可审计记录） | 这些都是判断，系统无法替代 |
| 合并确认：分类确认之后，其余条件全部满足时选 `merge` 并写知会 | **交给系统**（决定 2），项目偏好开启后生效 | 条件已由 `pmMergeBlockers` 等服务端强制，再加更严的系统条件 |
| 合并确认：条件不满足时 hold / 退回 / 交人；合并检查失败判断真实问题还是偶发 | **仍由 PM Ops** | 需要判断 |
| 合并确认：敏感、D12 四类、需求范围变化、角色规则、对外发布、已交人的确认 | **交人**（不变） | 人确认边界不变 |
| 打 `risk_tags`、补 `independent_reviewer` 验证项 | **仍由 PM Ops** | 风险分类是判断（ADR 0006 决定 4） |
| 审核轮数用尽（`raise_limit`/`pause`/`escalate`） | 普通验证项满足决定 4a 条件时**交给系统**加一轮，其余**仍由 PM Ops**；独立复核的上限**仍交人**（4b 是否改变交邵杰单独拍板） | 大多需要判断；“上一轮通过、只合入基线”的情形是确定性的 |
| 代拍 general / feature_detail | **仍由 PM Ops** | 需要判断（Q-279） |
| 分拣人工操作（`triage_human_action`） | **仍由 PM Ops** | 需要判断 |
| 回应无人认领的人类评论、处理 Router 升级事件 | **仍由 PM Ops** | 需要判断 |
| 等待过久的提醒（就绪项无人指派、核对项长时间 pending；Run 失活沿用现有看门狗） | **交给系统定时器**（决定 3） | 提醒本身是确定性的；收到提醒后怎么处理仍是 PM Ops 或人的判断 |
| 新建卡、拆卡、写评论说明进展 | **仍由 PM Ops / PM Office** | 需要判断 |

## 3. 决定

### 决定 0：系统动作的通用约束

1. **actor 是 `system`**：系统动作只由 server 内部调用 domain 命令产生（与现有 `autoConfirmMerge`、`expireMergeSnoozes`、C-177 一样），不暴露成 MCP 工具，也不经 Workbench API；Agent Token 只能得到 `assignment` Actor，无法伪造 `system`（不变量 11）。**不给任何 Agent 新增工具或能力。**
2. **同一新鲜事务内重查**：每个系统动作在写入事务里重新读取当前状态、重查全部条件；任一条件不满足就不写入（拒绝不留部分效果）。调度循环里的预判只用于挑候选，不作为授权依据。
3. **留痕**：每个动作写一条事件（带 `rule` 编号和依据，例如 `rule: "C-225/auto-assign"`、命中的员工排序依据或合并条件清单），并写卡片时间线条目，`author="system"`，Workbench 显示齿轮“系统”。审计与现有事件表一致，不新开存储。
4. **开关**：每类规则各有一个项目偏好开关，**默认关闭**，只有 human 能开关（与 `pm_merge_confirmation`、`auto_merge_after_minutes` 的写入权限一致）。关闭即回到今天的行为。
5. **失败回退**：系统动作因条件不满足或异常没有执行时，按今天的路径通知 PM Ops（例如 Router 原有的“验证项需要指派”定向通知），并在事件里写明未执行的原因；不重试到成功为止，不降级。
6. **与 PM Ops 并发**：系统和 PM Ops 写同一对象时由 domain 事务串行化；后到的一方按现有规则被拒（例如 `assign` 的“一个工作项一个 Assignment”、合并确认已解决），不会重复动作。PM 角色包同步删掉已交给系统的规则（见第 6 节），避免 PM Ops 主动去抢。

### 决定 1：验证工作项自动指派

**触发条件**（满足任一，且开关 `system_auto_assign_verifiers` 开启）：

- `delivery_submitted`（产出交付）：对它 `requested_verifiers` 里每个**没有 Assignment** 的验证项；
- `delivery_submitted`（完成申请，`kind=card_completion`）：对它请求的、没有 Assignment 的 PM 验收项（模板完成审核者是 human 时不处理，与现有路由一致）；
- 调度循环兜底扫描：已有可审交付（目标产出项当前最新交付请求了该项，或当前完成申请请求了该项）、但仍无 Assignment 的验证项——用于开关刚打开、或 server 重启漏掉事件的情况。

**判定依据**（全部满足才指派，都在指派事务内重查）：

1. 工作项 `kind=verify`，状态不是 `cancelled`/`passed`，`replaced_by_work_item_id` 为空，`assignment_id` 为空，也没有指向它的 Assignment；卡片不是 `done`/`cancelled`。
2. 目标有当前可审的交付：产出项最新、未作废的交付在 `requested_verifiers` 里请求了它（完成申请同理）。这是 P2a PM Ops 规则“交付后再指派”的机械化。
3. 员工：复用 `selectEmployee(d, item)` 不带员工参数的分支——在职、非外接、员工角色等于工作项角色、目标项目登记了该角色且未停用；`employeeConflicts` 排除与目标产出项**当前或曾经**（含已释放）Assignment 同员工的人，`independent_reviewer` 再排除同卡其它验证项当前或曾经的负责人（三方隔离，双向）；然后按“没有未结束 Run 优先 → 最久未被指派优先 → 员工编号小优先”排序取第一个。排序结果写进事件，便于复核。
4. 角色版本取该角色最新的启用版本，与 PM 调 `assign` 不传 `role_version` 时一致；机器取 `local`（与现有 M1 约束一致）。
5. 指派通过与 `assign` **同一段 domain 代码**（抽出内部函数，`assign` 保留 `d.pm()` 校验，新增 system 专用入口 `autoAssignVerifier`），所以不变量 15/16/17 的校验天然生效，不另写一份。

**例外（不自动指派，交 PM Ops）**：

- 该角色没有在职员工、全是外接员工，或所有候选都违反隔离：**不降级为同一员工、不放宽隔离**，按今天的路由给 PM Ops 定向通知，附上“没有合格员工”的原因（来自 `selectEmployee` 的错误信息）。
- 产出项（`kind=produce`）一律不自动指派。
- 工作项被 PM Ops 或人显式标记“手动指派”（新增工作项字段 `manual_assign: true`，PM/human 通过 `update_work_item` 设置）——用于 PM 想先等一等的情况。**是否需要这个字段待定、交人**（见第 7 节问题 4）。

**撤回与改派**：系统建的 Assignment 与 PM 建的完全相同，PM Ops 用现有手段处理：有未结束 Run 时请主机 `cardigan assignment stop`，`release_assignment` 释放，模板验证项走 `replace_verification_work_item` 后再指派新项（C-110，不变量 15 的补充）。不新增“改绑 Assignment”的入口。

**Router 配合**：自动指派成功时，Router 原来给 PM Ops 的“验证项需要指派”定向通知不再发出，改为只写时间线；新 Assignment 照常收到门铃。自动指派失败时保留原通知。

### 决定 2：系统代确认合并

**授权来源**：系统只处理**已经委托给 PM Ops** 的合并确认（`trigger=merge_confirmation`、`decider=role:pm`、`status=open`），即今天 PM Ops 有权代确认的那一部分；系统在此基础上再加更严的条件。`decider=human` 的确认（包括已交人的、敏感卡、D12、需求范围变化、PM 偏好关闭、没有活跃 PM Ops 时转给人的）**系统一律不碰**；它们仍按现有规则由人确认或走已有的超时自动合并（不变量 20，本 ADR 不改）。开关：新项目偏好 `system_merge_confirmation`，默认关闭，只有 human 能设置；`pm_merge_confirmation` 关闭时它也不生效。

**为什么需要 PM Ops 先做一次分类确认（复核 V-741 第 1 条）**：现行规则下，PM Ops 合并前会看一遍卡片，并做几项判断：
- 看到安全、权限、数值改动时，补 `risk_tags` 和 `independent_reviewer` 验证项；
- `numeric_rule` 卡要核对新数值、新行为规则已经由人拍板（“这不授权 PM 决定新的数值或行为规则”）；
- 截图核对还没计入代确认时，界面卡要等 PM Office 写出截图核对结论；
- 读全部时间线，看有没有“先别合”之类的意见。

条件 11、12 只在已经打了标签、开了开关时才生效。如果系统只看这些条件，漏标的权限改动、未经人拍板的新数值、没核对截图的界面卡都会被系统合并。所以决定 1 加决定 2 **不能让卡片从交付一路走到系统合并、中间不经过任何人的判断**。本 ADR 用条件 16 保留这一次判断，并让它可审计、绑定交付版本。

**判定依据（全部满足才代确认；在解决事务内一次性重查）**：

| # | 条件 | 依据 / 现有代码 |
|---|---|---|
| 1 | 卡片未被人标为敏感 | `mergeNeedsHuman`（C-65） |
| 2 | 卡片及其来源拍板没有未撤回的 D12 四类（花钱、账号、权限、删除数据）拍板 | `mergeNeedsHuman` |
| 3 | 没有需求范围变化拍板（含卡片来源拍板） | `mergeNeedsHuman` |
| 4 | 确认没有 `human_required_reason`，`decider` 仍是 `role:pm`，项目仍有活跃 PM Ops 且 `pm_merge_confirmation` 开启 | `mergeRequiresHuman`、`delegationAllowed`、`hasActivePmOps` |
| 5 | 未改角色规则：当前交付相对基线的改动文件不命中“角色规则路径”清单；条件 16 的分类确认也写明“未改角色规则” | **新**：主机从 Git 服务读改动文件列表交给 domain（domain 不做 IO）；路径清单可配置，**初值待定、交人**。**清单未设置、为空或格式非法时，视为不确定，系统不代确认**（不按“不命中”放行）；读不到文件列表同样视为不确定 |
| 6 | 不是对外发布：条件 16 的分类确认写明“不是对外发布”，且改动文件不命中“发布路径”清单 | **新**：**清单未设置、为空或格式非法时，视为不确定，系统不代确认**；判定方式的其它选项见第 7 节问题 2 |
| 7 | 当前完成申请的合并检查 passed（或主机已验证 noop），确认目标就是当前完成申请 | `pmMergeBlockers` |
| 8 | 所有未取消的验证项 passed（不论是否必需）；必需产出项的最新交付 accepted | `pmMergeBlockers` |
| 9 | 当前交付和完成申请上没有未处理的 must_fix | `pmMergeBlockers` |
| 10 | 合并前核对项**全部** passed 且未过期（`openPreMergeChecks` 为空），不只是独立复核和截图核对两条 | **比 PM Ops 更严**：PM Ops 今天把其它核对项当提示 |
| 11 | 风险标签卡（以条件 16 确认时的分类为准，标签由 PM Ops 在确认前补齐）：`risk_tags` 非空且仅含 `security`/`permission`/`numeric_rule`；同卡必需、未取消、未被替换的 `independent_reviewer` 验证项 passed，审核矩阵对目标最新交付为 pass，Review 未撤回、未过期、交付编号和 SHA 匹配 | `riskTagAutoMergeAllowed`（AGENTS.md 独立复核全部条件；知会由系统生成，见下） |
| 12 | 界面卡（以条件 16 的分类为准）：项目已开启截图核对计入代确认，且“截图核对”对当前交付为 passed。**截图核对未计入代确认时，界面卡一律不由系统代确认**，仍由 PM Ops 等 PM Office 的截图结论 | `screenshotCheckBlocker`，加上本 ADR 新增的排除 |
| 13 | 卡片和工作项上没有未关闭的阻塞：未处理的 `report_blocker`、未完成且阻塞合并的人工操作（`blocks_merge` 或列了工作项）、未决的其它拍板 | **新**的聚合检查，复用现有实体状态 |
| 14 | 时间线没有未处理的意见：**从卡片创建起**，卡上每一条 human 评论都早于条件 16 的分类确认（即 PM Ops 或人在读过它之后才做了确认）；分类确认之后，没有任何 human 评论，也没有 Agent 评论（`comment`，不含 Delivery/Review/系统条目）。**不做关键词匹配**。卡上有 human 评论而没有晚于它的分类确认时，视为不确定 | **新**；“意见是否已处理”无法机械判断，所以交给条件 16 的确认人（他确认时须读全部时间线），确认之后出现的任何评论都让系统放弃（第 7 节问题 3 给出放宽选项） |
| 15 | 卡片 `merge_policy=confirm`；这条确认当前没有被暂缓（snoozed），当前完成申请的合并确认也没有被 hold 或退回过（被 hold 过的由 PM Ops 或人重新处理） | 与 `autoMergeSchedule` 相同的 hold/退回/暂缓检查 |
| 16 | **合并前分类确认**：常驻 PM（Ops 或 Office）或人，对**当前**交付（每个产出项最新交付的编号和 SHA，与核对项的 `checked_versions` 同样绑定）记录过一次分类确认，且确认里写明：(a) 风险分类已核对，`risk_tags` 与改动相符；(b) 是否界面卡；(c) 不含未经人拍板的新数值或行为规则（如有，列出人拍板的 Q-n）；(d) 不是对外发布；(e) 未改角色规则；(f) 已读全部时间线，没有未处理的暂缓或“不要合并”意见。(b) 必须明确填“是”或“否”（“是”时按条件 12 处理）；(a)、(c)–(f) 任何一项不成立或缺失，系统都不代确认。交付有新版本后旧确认自动作废 | **新**：可审计记录（事件 + 卡片字段，作者为确认人）；produce/verify 角色不能写。第一版还**排除 `numeric_rule` 卡**：这类卡系统一律不代确认，留给 PM Ops（见第 7 节问题 8） |

**执行**：条件全部满足时，系统先写 `system_merge_confirmation_scheduled` 事件，进入**撤回窗口**（时长**待定、交人**，可以是 0）；窗口内 PM Ops 或人可以用现有的 `hold`/`request_changes`/`escalate` 处理该确认，系统就放弃。窗口到期时在新事务内**重查全部条件**，仍满足才解决确认：`resolution.option=merge`、`resolved_by="system"`、`via="system_rule"`、授权依据写成 `project:<id>/system_merge_confirmation/event:<偏好审计事件>`；同时生成知会写进 Needs You 知会区，内容固定为“系统按规则代确认合并 C-n（标题），条件 1–16 全部满足，分类确认人 <A-n 或 human>，规则依据 ADR 0008”。之后走原有合并、批次检查和发布流程（不变量 20/21 不变）。合并已发布后不能撤回，只能另开回退卡。

**不满足或不确定时的回退**：任一条件不满足 → 系统不动，确认留给 PM Ops，并在 PM Ops 的通知里列出未满足的条件编号（等价于今天的 `merge_blockers`，再加系统新增条件）。条件 1–6 命中（敏感、D12、范围、角色规则、发布）时系统不仅不动，还提示 PM Ops 按现有规则交人。缺少条件 16 的分类确认时，PM Ops 收到的就是今天的合并确认通知，可以选择先补分类确认、让系统处理，也可以直接按现规则处理。系统**从不**选 `hold`、`request_changes` 或交人——这些仍是 PM Ops 的判断。

**收益说明**：PM Ops 每张卡仍要做一次分类判断，只是从“合并时必须在场”变成“交付后任何时候做一次”，合并本身不再等 PM Ops 起 Run。省下的主要是排队和 PM Ops 卡住时的停摆，而不是判断本身。

**人确认边界不变**：本决定只收窄“谁来按下 PM Ops 本来就能按的按钮”；不改 `mergeNeedsHuman`、`mergeRequiresHuman`、不变量 20/22/23/28/29，不改 D12、Q-279 和 AGENTS.md 的强制交人条件。

### 决定 3：催办改为定时器通知

沿用 C-177 的做法：在 dispatcher 维护循环里运行（不起 Run、不用 Token），从事件推算等待起点，server 重启后结果一致；同一事项、同一等待周期只提醒一次，事项处理掉或等待重新开始时清除标记。所有阈值都是项目偏好，**数值待定、交人**；未设置时该提醒**关闭**（不自定默认值）；写入时校验为正整数分钟且在允许范围内（范围上下限也待定、交人），非法值拒绝。

| 提醒 | 触发条件 | 判定依据 | 例外 | 收件人与回退 |
|---|---|---|---|---|
| ① 就绪项超时未指派 | 工作项可以开工（产出项：卡片 `todo`/`in_progress`、依赖都已成功；验证项：已有可审交付）且没有 Assignment，持续超过 `unassigned_ready_after_minutes`（**待定**） | 工作项状态、依赖、交付事件的时间 | 卡片 backlog / 暂停；工作项标了 `manual_assign`（若采纳）；自动指派刚失败且已通知 PM Ops 的同一周期不重复 | PM Ops；没有活跃 PM Ops 时进 Needs You |
| ② Run 失活 | **不新增计时器，复用现有看门狗**（见表下说明） | `apps/server/src/dispatch.ts` 维护循环：`lastRunActivity`（Run 开始、心跳、Assignment 最近一次 MCP 调用）超过 `inactivityGraceMs`（默认 15 分钟）时发 `run_inactive` 告警，按 Run 持久去重 | 外接 Assignment、非 running 的 Run（与现状一致） | 与现状一致：常驻 PM Ops 自己的 Run 告警给人（`alertAudience` 返回 `human`），不发给卡住的 PM Ops 本人；PM Office 的发给人；其它发给 PM Ops |
| ③ 核对项长时间 pending | 合并前核对项对当前交付为 pending（含过期变回 pending），且卡片已在 `awaiting_merge`，持续超过 `pre_merge_check_pending_after_minutes`（**待定**） | `effectivePreMergeChecks` | “独立复核”“截图核对”两条由验证项本身驱动，提醒发给该验证项的 Assignment（没有则按 ① 处理） | 其它核对项 → PM Ops；PM Ops 不在时进 Needs You |

是否重复提醒、重复间隔和最多次数同样**待定、交人**；在拍板前只提醒一次。

**② 为什么不新增计时器（代码审核 C-225#21 第 3 条）**：现有看门狗已经覆盖“Run 失活提醒”：`dispatch.ts` 的 `inactivityGraceMs`（默认 15 分钟）到期后发一次 `run_inactive` 告警，按 Run 去重；之后失活回收由 `InactiveRunReaper` 按主机实际生效的回收阈值执行（`packages/host/src/run-capacity-config.ts` 的 `inactive_cancel_after_minutes`，未配置时取 `max(DEFAULT_INACTIVE_CANCEL_AFTER_MS, inactivityGraceMs)`）。再加一个计时器只会重复通知，还可能出现“先回收、后提醒”的顺序错误。所以本 ADR **不新增失活提醒开关和阈值**，提醒时机、去重、收件人都以现有看门狗为准，本 ADR 不改它们。
- R-3328 空挂 30 分钟这件事，按现有逻辑 15 分钟时应该已经告警给人。问题出在告警之后没人处理，而不是没有提醒。是否要在 PM Ops 自己的 Run 失活时，把常驻 host_ops 也加入收件人（host_ops 可以用 `host_ops_restart_standing_pm` 换会话），列为第 7 节问题 9。这一项只改收件人，不新增数值。
- 如果将来要调整提醒时机，只改现有的 `inactivityGraceMs` 配置，并且必须小于主机实际生效的回收阈值（以 `run-capacity-config` 读到的值为准，不以默认 60 分钟为准）。没有配置回收阈值时取上面的默认值；配置不合法时沿用现有校验（`run-capacity-config` 直接报错），不另设回退。具体数值仍交人。

### 决定 4（候选，张良 C-225#2 提出，王熙凤 C-225#7 转达）：审核轮数用满后由系统自动加一轮

来源：11-13 晚 Q-346、Q-351（C-202）、Q-360（C-211）三次情况相同——上一轮复核通过、没有 must_fix，新交付只是合入新基线并解决冲突（另有很小的增量），复核额度用满后交人，人每次都选“加一轮”。

现状（`packages/domain/src/commands/review-limit.ts` `requestReviewLimit`）：轮数用满时生成 `trigger=review_limit`、`category=general` 的拍板，推荐项在“最近交付是冲突修复（交付带 `merge_conflict_event_id`）或上一轮无 must_fix”时为 `raise_limit`。普通验证项的这条拍板按项目授权委托给 PM Ops，PM Ops 可以 `raise_limit`；**`independent_reviewer` 的这条拍板带 `human_required_reason`，必须交人，PM 不能加轮**（ADR 0006 决定 1、不变量 28 的同类规则）。

**这条必须分成两件事讨论：**

**4a 普通验证项（代码审核、测试等）**：把 PM Ops 已有的 `raise_limit` 权限机械化，不改变人确认边界。

- 触发：生成 `review_limit` 拍板，且该拍板 `decider=role:pm`（已委托给 PM Ops）、`status=open`、没有 `resolution`，开关 `system_review_limit_raise`（默认关闭，human 设置）开启。**只处理还没人动过的拍板**：PM Ops 已选 `pause`（拍板变为 `provisional`）、已 `escalate`（decider 变为 human）、人已处理，或拍板已解决时，系统一律不碰。注意 `review-limit-resolution.ts` 允许 PM Ops 在 `provisional` 后再选 `raise_limit`，但系统不走这条路，不能覆盖 PM Ops 的暂停（代码审核 C-225#21 第 2 条）。
- 判定依据（全部满足，在解决事务内重查）：① 工作项 `role_id` 不是 `independent_reviewer`，拍板没有 `human_required_reason`；② 该验证项上一轮 Review 是 `pass` 且未被撤回，没有未处理的 must_fix；③ 新交付相对上一轮已审 SHA 的差异属于“只来自合入基线”（判定见下）；④ 卡片未被标敏感，没有 D12 四类和需求范围变化拍板（`mergeNeedsHuman` 不命中），改动不命中角色规则路径（**清单未设置、为空或格式非法时视为不确定，不加轮**；读不到改动文件列表同样不加轮）；⑤ 同一验证项由系统自动加轮的累计次数不超过上限 N（**N 待定、交人**）。
- 执行：系统在解决事务内**重查**拍板仍是 `status=open`、`decider=role:pm`、无 `resolution`，以及 ①–⑤ 全部条件，任一项变了就放弃；然后以 `system` 身份解决该拍板为 `raise_limit`，rationale 写命中的条件，审计事件带两次 SHA 和差异判定结果；之后按现有逻辑恢复审核。
- 回退：任一条件不满足，或拍板已被 PM Ops/人接手（pause、escalate、resolve）→ 不动，拍板照旧留给 PM Ops 或人；系统不重试，也不会在 PM Ops 暂停之后再加轮。

**4b 独立复核（`independent_reviewer`）**：**改变人确认边界，需要邵杰单独明确拍板**（本卡 out_of_scope 写的是“不改人确认的边界”，所以默认不做）。

- 若采纳：条件同 4a 的 ②–⑤，再加“差异判定必须是 4a 中最严格的一档（树完全等于干净合并结果）”，系统才解决这条带 `human_required_reason` 的拍板；其它情况照旧交人。
- 风险：(1) 独立复核轮数上限 2 是专门为风险标签卡设的硬刹车（ADR 0006 决定 1），自动加轮会让“连续两轮未通过就交人”在这类场景下失效；(2) 合入基线本身可能改变被复核代码的安全语义——基线里别的卡改了鉴权、权限或数值规则，复核对象的行为随之改变，而“差异只来自基线”的机械判定看不出语义变化；(3) 冲突解决是人工改动，冲突区恰恰常是两边都改过的敏感代码；(4) 加轮只是恢复复核，复核员仍要对新 SHA 重新 `submit_review`，合并前仍要独立复核 pass——所以风险是“少一次人的注意”，不是“跳过复核”。
- 推荐：**不采纳 4b**，独立复核仍按现规则交人；先上 4a，用一周数据看独立复核加轮的次数再议。

**“差异只来自合入基线 / 增量很小”的判定（数值和行为规则，待定、交人）**：判定在主机侧用 Git 计算（domain 不做 IO），结果作为命令输入。候选分档：

1. **严格**：新交付的树 = 把新基线干净合入上一轮已审 SHA 的结果（`git merge-tree` 无冲突且树哈希相等）。增量为零，可机械证明。注意：有冲突需要人工解决的情况（C-202、C-211 的实际情况）**不满足**这一档。
2. **冲突解决**：上一档有冲突；新交付相对“合并结果”的差异只落在冲突文件内。是否接受、冲突区如何界定，**待定、交人**。
3. **增量很小**：在 2 的基础上允许冲突文件之外的少量改动；“很小”用行数、文件数还是路径限制，阈值多少，**全部待定、交人**。

推荐 4a 先只用第 1 档；第 2、3 档交邵杰决定是否开放以及阈值。判定失败（Git 读取失败、基线无法确定）一律视为不满足。

## 4. 不变量与开发方案的改动（拍板后随实现提交）

- §4.5 新增一条（编号实现时顺延）：“系统规则动作（自动指派验证项、系统代确认合并、定时提醒）只由 server 内部以 `system` Actor 执行，不暴露给任何 Agent 工具；每次动作在同一新鲜事务内重查全部条件，条件不满足或不确定时不写入、交 PM Ops；系统代确认合并只处理已委托给 PM Ops 的确认，条件集合是不变量 23 的超集，并要求常驻 PM 或人对当前交付做过可审计的合并前分类确认；路径清单等配置缺失时按不确定处理，不放行。”
- 不变量 15/16/17：不改文字；自动指派复用同一代码路径，契约测试覆盖。
- 不变量 23：补一句“项目开启 `system_merge_confirmation` 时，系统可以在决定 2 的全部条件满足后代确认；系统代确认不会扩大 PM 代确认的范围”。
- §6.4 / §7.2：验证项没有负责人时，先尝试系统自动指派，失败才给 PM Ops 定向通知。
- §7.1 PM Ops 职责表、§7.4：注明哪些规则已由系统执行。
- §4.3 ProjectPreferences：新增开关（`system_auto_assign_verifiers`、`system_merge_confirmation`、`system_review_limit_raise`）和提醒阈值（全部默认关闭/未设置）。
- §4.3 Card：新增合并前分类确认记录（确认人、绑定的交付版本、(a)–(f) 各项结论），写入权限只给常驻 PM 和 human，交付变化后作废；写入时发事件留审计。
- 若采纳 4b：不变量 28 和 ADR 0006 决定 1 的“独立复核轮数用满必须交人”需要改写，单独提交。

## 5. 契约测试要点（实现阶段）

1. 自动指派：目标产出项当前作者、曾经（已释放）作者、同卡其它验证项负责人（对 `independent_reviewer`）都不会被选中；先指派复核员再指派审核者等三种顺序都被拒；没有合格员工时不指派、给 PM Ops 定向通知；外接员工、停用员工不被选中；产出项不被自动指派；已替换、已取消的验证项不被指派；与 PM `assign` 并发时只有一个生效。
2. 系统代确认：表中 16 条**逐条单独置为不满足**，系统都不触发；没有分类确认、分类确认绑定的是旧交付、分类确认任一项为“否”、分类确认之后出现 human 或 Agent 评论、早于确认之前没有确认覆盖的 human 评论、`numeric_rule` 卡、截图核对未计入代确认的界面卡、路径清单为空或非法时都不触发；`decider=human` 的确认、敏感卡、D12 四类、需求范围变化、`human_required_reason`、偏好关闭、没有活跃 PM Ops 时都不触发；撤回窗口内 PM Ops hold 后到期不再代确认；到期时条件变化（例如新交付、新人类评论）不代确认。
3. 人确认边界：`mergeNeedsHuman`/`mergeRequiresHuman` 的现有契约测试保持不变并全部通过。
4. 定时器（①、③）：阈值未设置时不提醒；非法值（0、负数、小数、超范围、非数字）被拒；同一等待周期只提醒一次。② 不新增代码，只保留现有 `run_inactive` 看门狗的测试；若采纳问题 9，补“PM Ops 自己的 Run 失活时，告警发给人和常驻 host_ops，不发给 PM Ops 本人”的测试。
5. 自动加轮（4a）：拍板已被 PM Ops `pause`（provisional）、已 `escalate`、已解决，或候选选出后、写入前 PM Ops 先 pause 时都不触发；独立复核项、带 `human_required_reason` 的拍板、上一轮非 pass、有 must_fix、差异判定不满足、超过次数上限、敏感/D12/范围变化、角色规则清单为空或非法时都不触发。
6. Actor：通过 MCP 或 Web API 都无法以 `system` 身份调用这些命令。
7. 改了 `packages/domain` 时运行 `pnpm --filter @cardigan/domain test:types`。

## 6. PM 角色包的同步修改（实现阶段）

- “指派验证型工作项前，先确认产出项已交付”（`P2A_PM_OPS_RULES` 第 1 条）改写为：“验证项由系统在交付后自动指派；系统通知你‘没有合格员工’时，再判断换人、新建员工或交人。不要主动给已有交付的验证项抢先指派。”
- 合并确认一条：补“项目开启系统代确认时，你在交付后对当前交付做一次合并前分类确认（风险标签、界面卡、数值是否已由人拍板、对外发布、角色规则、已读全部时间线），写明每一项；之后满足全部条件的确认由系统处理。你只处理没有分类确认的确认、系统列出未满足条件的确认、合并检查失败和需要交人的确认。分类确认不能在没读完时间线时做”。
- 盘点一条：保留“盘点未指派的产出项”；验证项改为“查看系统未能指派的项”。
- 审核轮数一条：补“项目开启 `system_review_limit_raise` 时，普通验证项上一轮通过、新交付只合入基线的上限拍板由系统加一轮；你仍处理其余上限拍板。你选了 pause 或 escalate 的，系统不会再加轮；想让它继续审核就自己选 raise_limit。独立复核的上限仍交人”。
- 新增：“收到系统的超时提醒时，处理事项本身，并在时间线写处理结果；不要只确认收到。”
- 以上改动在开关开启前不生效的部分，角色正文按“开启后”的口径写，并注明开关名；开关关闭时 PM Ops 仍按原规则执行。角色规则改动按 Q-279 交人确认。

## 7. 交邵杰拍板的问题

| # | 问题 | 选项 | 推荐 |
|---|---|---|---|
| 1 | 各开关的上线顺序 | A 先开自动指派和提醒，系统代确认合并观察一周后再开；B 全部一起开 | A：自动指派风险最低、收益最直接（就绪等待）；代确认先只记录“若开启会代确认”的影子事件，对比 PM Ops 实际决定后再开 |
| 2 | “对外发布”如何判定 | A 按条件 16 的分类确认加发布路径清单（清单为空即不确定）；B 只靠路径清单 | A（复核 V-741 后改为与条件 16 合并；原先“正向白名单”选项已并入条件 16） |
| 3 | 条件 14“时间线没有意见”的严格程度 | A 从卡片创建起，human 评论都要早于分类确认；分类确认后的任何 human 或 Agent 评论都视为不确定；B 同 A，但分类确认后只看 human 评论和 @PM/@人的 Agent 评论 | A 起步，观察一周后按数据决定是否放宽到 B |
| 4 | 是否新增工作项字段 `manual_assign` | A 新增（PM/human 可设，系统跳过）；B 不新增，PM 想等就先不建验证项或取消后重建 | A：成本小，避免 PM Ops 为了“暂缓”去取消工作项 |
| 5 | 普通验证项自动加一轮（决定 4a） | A 采纳，差异判定只用第 1 档；B 采纳，并开放第 2/3 档；C 不采纳 | A |
| 6 | **独立复核自动加一轮（决定 4b，改变人确认边界）** | A 不采纳，仍交人；B 采纳，仅限第 1 档 | A：风险见决定 4b |
| 7 | 新数值和清单 | 撤回窗口分钟数；①、③ 两个阈值（② 复用现有看门狗，不新增）；阈值允许范围；是否重复提醒、间隔和次数；角色规则路径清单、发布路径清单的初值（提示：角色规则清单至少应覆盖 `packages/roles/**`、`AGENTS.md`、`CLAUDE.md`，具体路径仍由人定；清单为空时系统一律不代确认、不加轮）；自动加轮次数上限 N；差异判定第 2/3 档的界定和阈值 | 不推荐具体数值（按规则交人）；建议都做成项目偏好，未设置即关闭 |
| 8 | `numeric_rule` 卡是否允许系统代确认 | A 第一版一律排除，留给 PM Ops；B 条件 16 列出人拍板的 Q-n 后允许 | A：数值是否已由人拍板、拍板内容与实现是否一致，系统无法判断 |
| 9 | PM Ops 自己的 Run 失活时，现有 `run_inactive` 告警是否加发给常驻 host_ops | A 加发（host_ops 可直接换 PM Ops 会话）；B 维持现状，只告警给人 | A：只改收件人，不新增数值 |

## 8. 备选方案及未采用原因

1. **开多个 PM Ops 分身**：卡片 out_of_scope；会破坏“每项目一个常驻 PM Ops”的不变量，且并发判断难以审计。
2. **把这些规则写进 Router（只发更精确的通知）**：仍要 PM Ops 起 Run 才能落地，解决不了排队和 PM Ops 卡住时停摆的问题。
3. **给 PM Ops 换更便宜的模型跑机械动作**：省钱但不省排队；PM Ops 卡住时仍停摆。
4. **系统代确认直接复用 `autoConfirmMerge`（超时代批）**：那条路径处理的是 `decider=human` 的确认，依据是人的超时偏好；本 ADR 的对象是委托给 PM Ops 的确认，授权来源不同，混用会模糊人确认边界。只复用其中的 hold/退回检查和 `mergePlan` 预演。

## 9. 回滚方式

各开关任一关闭即回到今天的行为：验证项恢复由 PM Ops 指派，合并确认恢复由 PM Ops 代确认，审核轮数用满恢复由 PM Ops 或人处理，提醒停止。系统已建的 Assignment、已解决的确认和已发出的提醒都保留为历史记录，不需要数据迁移回退。

## 10. 上线后的观测（卡片验收标准第 6 条）

上线一周内只记录实测值，不预估：PM Ops 每日 Run 数（按 `run_started` 统计，对照第 2.1 节 11-13 的 320 轮）、验证项“可审交付出现 → 指派”的等待时间（中位、P90、最大）、系统代确认次数与“条件不满足交回 PM Ops”的次数及条件分布、各类提醒次数、PM Ops 撤回或改派系统动作的次数。
