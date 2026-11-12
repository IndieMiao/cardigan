# P2a-11：验证方在合并前撤回自己已通过的审核

- 状态：已排入 `docs/plans/phase-2.md` P2a 任务表（P2a-11），待拆卡实现。
- 开发方案要改的章节（本计划只做拆分，不改正文；实现 PR 合并后由 Claude 按各 PR 描述统一回填）：§4.4（verify WorkItem 新增 passed → ready 的 withdraw_pass 迁移，以及撤回对 Card、完成申请、合并确认的级联）、§4.5（不变量 14、15、16、21、23 补撤回情形的说明）、§6.4（撤回后的路由和 Needs You 提示）、§9.2（新增 `withdraw_review` 工具）、§9.3（服务端校验：只能撤回自己的审核、状态窗口、合并检查进行中拒绝）、§10.1（角色工具清单：验证方可用，PM Office、产出角色、host_ops 不可用）。
- 对应：试行发现 21（提炼稿 `dogfood/distill-trial-1.md` F2）；用户 2026-11-11 拍板：**允许**验证方在合并前撤回自己已通过的审核，撤回后该验证项回到可处理状态，并在 Needs You 提示。
- 必读：`docs/development-plan.md` §4.4（状态机，尤其 verify WorkItem、Card、Decision 三段）、§4.5 不变量 14、15、16、21、23；§6.4 路由规则；§9.2/§9.3 工具清单与服务端校验。代码调查依据：`packages/domain/src/transitions.ts`、`derived.ts`、`commands/delivery.ts`、`commands/delivery-invalidation.ts`、`commands/merge-rework.ts`、`commands/merge-delegation.ts`、`commands/delegation.ts`、`commands/auto-merge.ts`。

## 1. 目标与不做的范围

**目标**：给验证方（reviewer、designer、tester、PM 验收等由 Agent 承担的验证工作项）一个在合并真正开始之前撤回自己给出的 `pass` 的入口；撤回后该验证项回到可处理状态等待重新审核，不需要人工介入才能纠正一次误判。

**不做（V1 范围之外）**：

1. **`reviewer=human` 的完成验收不在本计划范围**。这种模式下"验证方"是人本身，验收结论记在 `completion_review` 这条 `Decision` 上，不是 `Review`/`WorkItem`；人已经有 `request_changes`、合并确认 `hold` 等现成路径达到同样效果，不需要新机制。状态机里 `decision: resolved --revoke--> revoked` 这条迁移已经定义但当前没有任何命令调用它（grep 确认）——如果以后要支持"人改口已经 resolved 的拍板"，可以复用这条迁移，但本计划不实现，只记录这个现成的口子供以后参考。
2. 不允许 PM、`host_ops`、人代替验证方撤回（见 §2.1 的理由）；代替撤回的诉求请走已有的 `request_changes`（卡在 `awaiting_merge` 之前）或 C-46/C-66 的退回修改（已确认合并之后）。
3. 不扩大审核轮次上限、不新增拍板类别、不碰合并闸门本身的检查逻辑（P2a-1）。
4. 不处理"验证方撤回后一直不回来重新审核"的超时升级；这类情况按现有"工作项处于非终态过久"的通用关注规则处理，本计划不新增专门检查。

## 2. 关键设计

### 2.1 谁能撤回

**只有当前持有该验证工作项的 Assignment 本人**（`actor.kind === "assignment"` 且其 `assignment_id` 等于该验证工作项当前的持有者）。

理由：

- 撤回的本质是"我刚才的判断要收回"，不是流程控制。允许 PM 代撤会和 §4.5 不变量 15/16（审核者独立性：验证者不能是作者、不能被同一身份跨越产出/验证）的精神冲突——等于给了 PM 一个绕过其他验证方意愿改写其判断的入口，而 PM 已经有 `request_changes`、`resolve_delegated_decision`（C-66）、合并确认 `hold` 等更重的工具可以达到"卡片先别往前走"的效果，不需要再越权改写别人的审核结论。
- 人同理：人可以直接 `record_decision` 介入合并确认（C-65），或要求退回修改，不需要冒充某个验证方的身份去撤销其判断。
- 当验证方就是 PM 自己（完成验收项）时，PM 的 Assignment 本来就是"持有该验证工作项的 Assignment"，撤回自己给出的完成验收 `pass`，自然允许——这不是"代撤别人"，是同一条规则的普通情形。

### 2.2 什么时候能撤

允许撤回需要同时满足：

1. 该验证工作项当前状态为 `passed`（§4.4 verify 状态机的终态之一，非 `cancelled`）。
2. 该 `passed` 对应的 `Review` 是当前有效的最新一条（`!isReviewStale(review, delivery)`，见 `derived.ts`），不能撤一个已经因新交付而失效的历史审核——那种情况前端应该展示"已过期"，不提供撤回入口。
3. 卡片状态不是 `done`、`cancelled`。已完成的卡片按现有规则（P2a-5）处理，不能回退，有问题建新卡。
4. **合并没有真正开始**：当前完成申请不存在状态为 `running` 的合并闸门检查（P2a-1），且没有已记录的 `merge_succeeded`/`recordMergeResult` 成功结果。`queued` 的检查允许撤回（检查还没真正跑 Git 侧的东西，而且撤回会让这次检查绑定的完成申请失效，等价于现有"完成申请被取代，排队的检查自然不再满足不变量 21"这一既有效果，不需要额外取消排队）；`running` 的检查不允许撤回，避免和正在执行的合并校验产生竞态，错误信息提示"合并检查正在运行，暂不能撤回"。

不满足以上任一条，`withdraw_review` 返回领域错误（中文提示），不留部分效果。

### 2.3 撤回后的状态变化

统一入口：新命令 `withdraw_review({work_item_id, rationale})`。内部按"撤回的是哪种验证工作项"分两种效果，但共用同一组底层函数：

**A. 普通验证项（目标是产出型 Delivery，不是 `card_completion`）**

1. 新增 verify 工作项迁移 `passed --withdraw_pass--> ready`（`transitions.ts`，和现有 `target_redelivered: passed→ready`并列，语义是"同一份交付，重新审一次"，不是 `target_withdrawn` 的"目标没了，回 todo"）。
2. 对应 `Review` 标记为已撤回（见 §2.4），不删除、不改写原记录，保留审计。
3. 若该验证工作项是某个产出工作项的"必需验证项"之一，且产出工作项当前状态因"全部必需验证通过"而是 `accepted`：新增产出(produce)工作项迁移 `accepted --verifier_withdrawn--> delivered`（和现有 `delivered --verifiers_passed--> accepted` 对称的反向迁移），把产出工作项退回 `delivered`，保持"`accepted` 意味着全部必需验证真的都通过"这条隐含约束不被打破。产出工作项的交付版本本身不变、不进 `changes_requested`、不排 `fix` Run——撤回不代表代码错了，只代表这次验证结论要收回。
4. 复用 `delivery.ts` 里 `target_redelivered` 之后对 `ready` 结果立即做轮次上限判断的既有逻辑（`reviewRound`/`review_limit_exceeded`）：撤回导致工作项回到 `ready` 时，同一命令内按现有规则检查"再审一轮是否超限"，超限则直接进入 `waiting_decision`，不给"撤回+无限次重审"留口子（见 §7 风险）。
5. 再检查该产出工作项（或其所属卡片）是否已经有一个**仍然有效**（未 `superseded`）的 `card_completion` 交付依赖刚才的判断——有则触发下面 B 的级联；没有则到此结束。

**B. 完成验收项或牵连到已提交的完成申请**

直接撤回 PM 完成验收的 `pass`，或者 A.5 发现有完成申请受牵连时，走同一套级联（新函数，建议放在 `packages/domain/src/commands/review-withdrawal.ts`，和现有 `merge-rework.ts` 的 `reopenMerge` 并列但不复用它——`reopenMerge` 会把产出工作项移到 `changes_requested` 并暗示"要返工"，这里不需要这一步）：

1. 复用 `delivery-invalidation.ts` 的 `supersedeDelivery(d, card, completion)`：把当前 `card_completion` 交付标记 `superseded`，同一事务内把所有绑定它、仍 `open` 的 `merge_confirmation` Decision 标记为 `superseded`（和 C-47 完全一样的效果，直接复用这段代码，不新写一套），写 `decision_superseded` 事件。
2. 对 `completion.requested_verifiers`（包括完成验收项自己）逐个执行既有的 `target_withdrawn` 迁移，回到 `todo`，等下一次完成申请再变 `ready`——这一步和"新产出交付使旧完成申请失效"时的处理完全一样，不是新机制。
3. 若卡片当前状态是 `awaiting_merge`：新增卡片迁移 `awaiting_merge --verification_withdrawn--> in_progress`（迁移目标沿用 `request_changes`/`merge_conflicted` 已经在用的 `in_progress`，落地后由 §4.4 既有的"`in_progress`/`review` 由工作项状态规则自动重新推导"机制纠正为真正应显示的状态，不需要专门推导"回到 review"）。记一条新事件 `verification_withdrawn`（区别于 `merge_changes_requested`，时间线文案强调"验证方撤回了审核，需要重新验证"，不是"退回修改"），**不**把产出交付标为 `changes_requested`，**不**排 `fix` Run。
4. PM 代确认计时与超时自动合并：因为绑定的 `merge_confirmation` 已经 `superseded`，`autoConfirmMerge`（`commands/auto-merge.ts`）本来就只认 `open` 且无人回答的 Decision，`superseded` 的 Decision 自然不再是候选，不需要专门清计时器；新的完成申请会生成新的 `merge_confirmation`，按现有规则重新计时（和 C-69 取消敏感标记后重新计时是同一种"新确认，新计时"模式，不是新机制）。
5. 排队/运行中的合并闸门检查：本计划在 §2.2 已经禁止在 `running` 时撤回；`queued` 的检查任其跑完——跑完后按不变量 21，它绑定的 `completion_id` 已经是旧的、已被取代的那份，`recordMergeResult`/发布前校验会因为"不同完成申请的通过记录不可复用"而拒绝用它发布，等价于自然失效，不需要额外的取消逻辑。

### 2.4 Review 的"已撤回"标记与存储迁移

`packages/store` 的实体表是文档存储（`reviews(project_id, id, doc)`，`doc` 是整条 JSON），**不需要新的 SQL 迁移**：给 `Review`（`entities.ts`）新增一个可选字段 `withdrawn?: { at: string; rationale: string }`，由撤回事件的投影逻辑写入 `doc` 即可,和现有新增字段（例如 `merge_conflict_event_id`）走的是同一条路径。`derived.ts` 的 `deriveReviewMatrix`/`isReviewStale`"取当前有效最新一条"的判断加一条 `!review.withdrawn`，衍生计算（审核矩阵、合并确认的 `pmMergeBlockers` 等"必须没有非 `pre_existing` 的 must_fix"判断）自动把撤回的 `pass` 当成不存在，不需要逐处改写判断条件（它们本来就只看"当前有效的最新 Review"）。

### 2.5 理由字段

`rationale` 必填，非空字符串校验方式与现有 `request_changes`、`resolve_delegated_decision` 的理由字段一致。写入 `review_withdrawn` 事件 payload 和时间线；B 分支额外写入 `verification_withdrawn` 事件时复用同一段理由文本，避免要求验证方写两遍。

### 2.6 事件与时间线

新增两个事件类型：

- `review_withdrawn`：`{ review_id, work_item_id, rationale }`，任何撤回都会写（A、B 分支共用）。
- `verification_withdrawn`：仅 B 分支、且卡片确实从 `awaiting_merge` 退回时才写，`{ card_id, completion_id, rationale, trigger_work_item_id }`，和已有 `merge_changes_requested` 并列但语义不同，前端时间线用不同文案区分（"验证方撤回了审核" vs "退回修改"）。

`decision_superseded`、`target_withdrawn` 对应的既有事件照常复用，不新增。

### 2.7 通知路由

- 撤回本身：在受影响卡片的时间线出现一条"验证方撤回了审核"的条目（普通 system 时间线，不是 Decision，不阻塞）。
- B 分支触发卡片退回：复用 `merge_changes_requested` 现有的通知路径——持有产出工作项的 Assignment 收到说明（措辞强调"需要重新验证，不是代码有问题"，不等同于"退回修改"）；若合并确认原来交给 PM 处理（C-49），PM Ops 应该知道这条合并确认已经失效，复用现有"`decision_superseded` 产生知会"的机制（§5.2 条目类型表，知会随解决事件派生），不新增通知类型。
- 人侧 Needs You：按用户拍板"在 Needs You 提示"——复用 `list_needs_you` 现有的卡片级 attention/通知聚合，不新增顶层分组；撤回事件本身不是 Decision，不会自动出现在"待你处理"里，但卡片因此退回 `in_progress`、或合并确认被作废这两件事会按现有规则自然反映在执行视图和 Needs You（合并确认消失、卡片回到执行态），这对用户来说就是"看得到发生了什么"。如果验收后发现"只有时间线条目，人未必注意到"，可以在实现卡里补一条"撤回事件也计入 attention 聚合"的小扩展，本计划先按复用现有聚合来写,不预先假定需要新字段。

### 2.8 MCP 工具与权限

- 新工具 `withdraw_review({work_item_id, rationale})`，命令名 `withdraw_review`。
- 白名单：和 `submit_review` 对称——任何角色版本的 `allowed_tools` 里有 `submit_review` 的，默认同时允许 `withdraw_review`（校验逻辑参照 `commands/role.ts` 现有"某些工具只能配给某类角色"的写法，这里反过来是"有 A 就默认有 B"，不是反向限定,需要在角色保存校验里新增这条推导或直接要求模板/角色显式都列出，具体选哪种写法留给实现卡决定，建议前者更不容易漏配)。不单独开放给 `host_ops`、PM Office 的通用聊天入口。
- CLI：建议补 `cardigan review withdraw <W-n> --reason "<理由>"`，复用和 Workbench/MCP 相同的领域命令。理由：张良（外接 Assignment，`docs/plans/p2v-11-members-identity.md`）等用本机 CLI 操作的 Assignment 身份也需要这条路径；CLI 不能让人冒充某个 Assignment 身份撤销其审核——按现有 Token 身份模式（§9.1），CLI 必须带该 Assignment 的 Token 才能调用，不提供"人以 human 身份代替某个 Assignment 调用"的旁路。

## 3. 对 §4.4 状态机和 §4.5 不变量的具体改动

**状态机新增迁移**（`packages/domain/src/transitions.ts`）：

- `verify`：`passed: { target_redelivered: "ready", target_withdrawn: "todo", withdraw_pass: "ready" }`。
- `produce`：`accepted: { ..., verifier_withdrawn: "delivered" }`。
- `card`：`awaiting_merge: { ..., verification_withdrawn: "in_progress" }`。

**存储**：无需新 SQL 迁移（§2.4），`Review` 实体新增可选字段 `withdrawn?: { at: string; rationale: string }`。

**不变量新增**（续编到 §4.5，当前文档末尾编号到 24 且已有两条重复的"24"，实现卡里一并按顺延方式修正，不在本计划里重新编号已有条目）：

1. 撤回已通过审核（`withdraw_review`）只接受 `actor.kind==="assignment"` 且其 `assignment_id` 等于目标验证工作项当前的持有 Assignment；PM、`host_ops`、`human`、`system` 一律拒绝。
2. 卡片状态为 `done`/`cancelled`，或当前完成申请存在 `running` 态合并闸门检查，或已记录合并成功，一律拒绝撤回。
3. 撤回导致完成申请作废时，必须在同一事务内按 C-47 既有规则把所有绑定该申请、仍 `open` 的 `merge_confirmation` 标为 `superseded`，不代填 `merge`/`hold`/`request_changes`，也不改写已 `resolved` 的历史决定（直接复用 `supersedeDelivery`，不写第二套实现）。
4. 撤回不得把受影响的产出交付标记为 `changes_requested`，也不得为产出 Assignment 排 `fix` Run——与"退回修改"的语义边界必须在代码里体现为"不调用 `reopenMerge`/不复用它的产出工作项迁移分支"，而不是只靠文档约定。
5. 撤回回到 `ready` 的验证工作项，必须复用既有轮次上限检查（和 `target_redelivered` 的路径一致），超限同样进入 `waiting_decision`，不给"反复撤回+重审"豁免轮次预算。

## 4. 和现有机制的交互与边界

- **同一张卡多个验证项**：只影响被撤回的那一个验证工作项和它牵连到的完成申请；其它验证项的 `passed` 状态不受影响（它们各自的 Review 绑定的是各自的目标，`isReviewStale` 判断互不相关）。
- **交付被替换（新版本）**：新交付触发的 `target_redelivered`/现有失效逻辑优先于"撤回"讨论——如果验证方还没来得及撤回、产出方先交了新版本，验证项已经因为 `target_redelivered` 回到 `ready`，此时撤回操作会发现"没有当前有效的 `passed` Review"而直接拒绝，不会双重处理。
- **合并冲突退回（`merge_conflicted`）/ 人退回修改（`request_changes`）/ C-46 已确认后退回**：这几条路径都已经调用 `reopenMerge`（把产出工作项移到 `changes_requested`），和本计划的 B 分支是两条并列、互不复用实现细节但共享 `supersedeDelivery` 这一底层函数的路径。时序上互斥：卡片一旦先被这些路径移出 `awaiting_merge`，当前完成申请已经 `superseded`，撤回操作会按"没有当前有效的完成申请/验证项已经不是 `passed`"而自然拒绝，不需要专门加互斥锁。
- **敏感卡（C-65）**：撤回操作不检查、不受敏感标记影响——敏感标记只约束"谁能确认合并"，不约束"验证方能不能收回自己的判断"；敏感卡片因撤回退回 `in_progress` 后，重新走到 `awaiting_merge` 时仍按现有规则生成交人的合并确认，不因为曾经撤回过而改变敏感处理路径。
- **C-66 的 PM 退回/重检**：PM 对"已确认合并但检查失败/超时"的处理（`request_changes`/`recheck`）和本计划的撤回是两种不同触发源，都可能作用于同一张卡但不会同时发生——C-66 的前提是"已确认合并"且"最新检查失败/超时"，此时如果验证项仍是 `passed`，撤回仍然可以独立发起（卡片当时还在 `awaiting_merge`，检查已失败不算"运行中"，§2.2 的闸门按"当前是否 `running`"判断，不按"历史是否失败过"限制），两条路径最终都走到"完成申请作废、卡片回 `in_progress`"，不冲突，只是归因不同（时间线文案分别显示"退回修改"或"验证方撤回了审核"）。

## 5. 拆分成几张卡

1. **卡 1：验证项自撤回原语**（不含完成申请级联）。新增 `withdraw_pass` 迁移、`Review.withdrawn` 字段与衍生计算调整、`withdraw_review` 命令（仅处理 §2.3 A 分支 1–2 步）、权限校验（§2.2、§3 不变量 1）、MCP 工具与角色白名单推导。domain 契约测试覆盖新迁移和权限不变量。约 150–250 行。
2. **卡 2：产出工作项连带回退**。新增 `verifier_withdrawn` 迁移，在卡 1 基础上补"全部必需验证不再通过时退回 `delivered`"的判断，以及撤回回到 `ready` 时的轮次上限检查复用。依赖卡 1。约 100–150 行，以契约测试为主。
3. **卡 3：完成申请与合并确认级联**（对应试行发现 21 的核心场景：PM 验收撤回）。新增 `verification_withdrawn` 卡片迁移、`review-withdrawal.ts` 的级联函数（复用 `supersedeDelivery`、`target_withdrawn` 循环）、事件 `verification_withdrawn`、§2.2 的"合并已开始"闸门判断（检查 `running` 态合并检查、`merge_succeeded`）。依赖卡 1、2。约 200–300 行，契约测试覆盖 §3 不变量 2–4、§4 列出的边界场景（冲突/退回修改互斥、敏感卡不受影响）。
4. **卡 4：通知、CLI 与界面展示**。Needs You/执行视图确认撤回后的状态能正常反映（复用现有聚合，验证不需要新字段）；CLI `cardigan review withdraw`；Workbench 卡片详情加撤回入口（只对"当前用户对应的 Assignment 持有该验证项"可见——如果 Workbench 本身是人操作，这个入口理论上不会出现给人，只会出现在 Agent 使用 CLI/MCP 的场景，这一点需要在卡里明确"Workbench 界面本计划不提供撤回按钮，因为撤回者必须是 Assignment 本人,人没有这个身份"，避免实现者误做一个人可以点的按钮）。依赖卡 1–3。约 100–200 行。

每张卡按 AGENTS.md 走独立分支和 PR；卡 3 改 `packages/domain`，按规则必须同时跑 `pnpm --filter @cardigan/domain test:types`。

## 6. 测试清单

- **卡 1**：
  - `transitions.contract.test.ts`：`passed --withdraw_pass--> ready` 合法；`ready`/`in_progress`/`failed`/`cancelled` 状态下调用 `withdraw_pass` 被拒绝（不是合法迁移源）。
  - 权限契约测试：非持有该工作项的 Assignment、PM、`host_ops`、`human`、`system` 调用均 `unauthorized`。
  - `derived.contract.test.ts`：`deriveReviewMatrix` 对标记 `withdrawn` 的 Review 不再当作"当前有效"，矩阵回退到"无通过记录"的展示。
  - 卡片/工作项已 `done`/`cancelled` 时拒绝。
- **卡 2**：
  - produce `accepted --verifier_withdrawn--> delivered` 合法迁移测试。
  - 必需验证项之一撤回后，若其它必需验证项仍 `passed`，产出工作项是否退回——按"全部必需验证通过"的判定重算，补一条"还有其它必需验证项未通过"也应该退回 `delivered` 的用例。
  - 撤回回到 `ready` 触发轮次上限：构造已用满轮次的验证项，撤回后下一轮再审应直接进入 `waiting_decision`，复用现有 `review_limit_exceeded` 的事件断言方式。
- **卡 3**（核心，覆盖不变量 2–5）：
  - 完成验收项 `passed`、卡片 `awaiting_merge`、存在 `open` 的 `merge_confirmation` 时撤回：断言完成申请 `superseded`、确认 `superseded`（事件含 `decision_superseded`）、完成验收项及其它 `requested_verifiers` 回 `todo`、卡片回 `in_progress`、产出交付**不**变为 `changes_requested`、**没有** `fix` Run 被排。
  - 合并检查为 `running` 时撤回被拒绝（`merge_in_progress` 一类错误）；`queued` 时允许，撤回后旧检查跑完不能用于发布（复用不变量 21 的既有测试模式，断言 `recordMergeResult`/发布前校验拒绝用旧 `completion_id` 的通过记录）。
  - `merge_succeeded` 之后撤回被拒绝。
  - 和 `merge_conflicted`/`request_changes`/C-46 退回已经发生之后再调用撤回：因为验证项已经不是 `passed`，拒绝，不产生第二次级联（回归测试防止重复触发）。
  - 敏感卡片撤回后重新进入 `awaiting_merge`：新确认仍然交人，不因曾经撤回而改变（回归 C-65 既有测试，追加这一条路径）。
- **卡 4**：
  - CLI 集成测试：`cardigan review withdraw` 对非本人 Assignment 的 Token 拒绝；对本人 Token 成功后时间线/Needs You 反映预期变化。
  - 全程改了 `packages/domain`（卡 1–3）务必跑 `pnpm --filter @cardigan/domain test:types`，而不是只跑 `vitest`。

## 7. 已知风险

1. **"撤回+重审"被当作绕过轮次上限或拖延的手段**：已在设计里要求撤回回到 `ready` 复用轮次上限检查（§3 不变量 5）缓解，但如果验证方在轮次预算用尽之前反复撤回，仍可能人为拉长审核时间；本计划不额外限制"同一验证工作项每张卡最多撤回几次"，先用轮次上限兜底，观察试行效果后再评估是否需要专门限流。
2. **"验证方给出 pass 后立刻撤回"和"合并检查刚好切到 `running`"之间存在一个时间窗口**：卡 3 的判断读的是"调用时刻"的检查状态，理论上存在"读的时候还是 `queued`，写入前检查变成 `running`"的竞态；需要在同一事务内按新鲜快照判断（和现有合并确认解决逻辑一样的做法），实现时要确认用的是最新读到的状态而不是调用前缓存的状态。
3. **`reviewer=human` 路径未覆盖**（§1 已说明为故意不做）：如果试行中发现人工验收也常出现"确认完了又反悔"的情况，需要单独评估是否复用状态机里现成但未使用的 `decision: resolved --revoke--> revoked` 迁移，这是本计划留下的已知口子，不是缺陷。
4. **权限白名单的"有 A 默认有 B"写法**（§2.8）如果选错方向（例如写成需要显式都列出），可能导致已有角色的 `submit_review` 持有者在升级后突然多出一个没人注意到的新工具；实现卡需要明确写清楚选哪种，并在角色保存的契约测试里断言结果。
5. **产出工作项退回 `delivered` 但交付内容没变**：如果下游还依赖"产出 `accepted` 才能解锁的依赖项"已经因此被解锁、甚至已经有新 Run 基于它展开了工作，产出退回 `delivered` 不会收回那些已经发生的下游效果（和现有 `merge_conflicted`/`request_changes` 的退回有同样的滞后性问题，不是本计划引入的新风险，但在卡 2/3 的测试里应该补一条"退回不影响已经基于旧 `accepted` 状态启动的下游 Run"的说明性用例，确认行为符合预期而不是意外).
