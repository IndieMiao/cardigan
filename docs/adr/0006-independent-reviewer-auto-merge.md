# ADR 0006：独立复核角色（二郎神）与三类卡的合并代确认

- 状态：提议，关键细节已获用户确认（2026-11-13：按建议，见文末"已确认的细节"）。本 ADR 只记录设计，不改代码；对应实现计划见 `docs/plans/p2a-14-independent-reviewer.md`（草稿，同批产出）。
- 依据：`docs/development-plan.md` §4.3（Decision category，L473）、§4.4（verify WorkItem 状态机 L576–598，合并确认迁移 L532–554）、§4.5 不变量 15/16（L709/712，审核隔离）、20/21（L718/719，合并闸门与批次）、23（L726，PM 代确认合并的前置条件）、27/28（L733/734）、§7.4（新需求与拍板，L1017–1049，尤其第 2/5/7/8 条）、§10.1（Role 字段，mcp_servers L1452）、§10.4（初始角色与模型，L1539 起）、§14 安全模型汇总（L2018–2070）、§15 D11/D12（L2107/2108）。
- 代码依据：`packages/domain/src/preferences.ts`（`decisionCategories`/`highRiskCategories`，L4–19）、`packages/domain/src/commands/delegation.ts`（`mergeNeedsHuman` L56、`mergeRequiresHuman` L83、`delegationAllowed` L105、`grantDecisionCategory` L244）、`packages/domain/src/commands/pre-merge-checks.ts`（`applyPreMergeCheck` L150，权限判断 L156–193，`effectivePreMergeChecks` 的版本失效机制 L69–96）、`packages/domain/src/entities.ts`（`Card.sensitive` L139、`PreMergeCheck` L156）、`packages/domain/src/commands/pm.ts`（`createWorkItem` L323、`assign` L560）、`packages/domain/src/commands/employee-assignment.ts`（`checkEmployeeSeparation` L102、`employeeConflicts` L80）、`packages/roles/src/role-pack.ts`（`DEFAULT_ROLE_KINDS` L322、`defaultRoleDefinition` L396、`DEFAULT_ROLE_LAUNCH` L351）、`packages/roles/src/assignment.ts`（`compileAssignmentLaunch` 的三种 Harness 分支 L219–291，`codexConfig` L463）、`packages/domain/src/avatar-library.ts`（`erlang-shen` L9，已存在）、`~/.config/cardigan/launch.yaml`（`claude-opus` 启动配置，已存在）、`apps/web/test-support/chromium.mjs`（现有无 Playwright 依赖的 CDP 截图脚手架）、`packages/store/migrations/0020_run_capacity_limits.sql`（按机器的并发 Run 上限）。
- 卡片：无（本 ADR 为 P2a-14 的立项依据，尚未开卡；卡片编号由实现阶段补）。

## 背景（用户 2026-11-13 原话与决定）

当前流程：安全/权限/敏感类卡进入待合并后，PM Office 张良（Claude，外接）在系统外派子 Agent 做"独立复核"，把结论写进卡片评论，并把 C-160 的合并前核对项（`pre_merge_checks`）设为 passed/failed（当前只有 PM Office 或 human 能设，见 `pre-merge-checks.ts:164,193`）；然后人在对话里听到张良说"可以点了"才去 Workbench 点合并确认（[[human-merge-wait-for-go]]，用户 2026-11-12 选 A）。

用户原话（2026-11-13）：独立复核"做成 Cardigan 里的角色和员工，仍然用 Claude；复核没问题就自动进入合并"。用户的选择是**1a、2b、员工名二郎神**：

- **角色**：新角色 `independent_reviewer`，是卡片上**必需的验证型工作项（verify）**；复核绑定交付 SHA，交付变化要重新复核；复核结论用合并前核对项记录，**由该角色自己设 passed/failed，PM 不能代改**；复核员不能和实现者、审核者是同一个员工；有阻塞问题就退回；结论留痕时间线。
- **员工**：二郎神（人物库 `library:erlang-shen`，已存在于 `avatar-library.ts:9`），模型用 **Opus**（启动配置 `claude-opus`，已存在于 `launch.yaml`，`ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-5-5`）。实现方（coder）用 Codex/DeepSeek，复核方用 Claude，模型异构，与 `design_director` 和 `ui_ux_designer` 的交叉检查（§10.4）同一精神。
- **何时派**：卡片涉及**安全、权限、数值规则**（以及数据迁移/并发等高风险代码路径，可由 PM Ops 判断）时，由 PM Ops 或模板规则加上该工作项。
- **自动合并范围（1a）**：**安全、权限、数值规则**三类，在独立复核 passed 且合并检查 passed、其它验证项都通过后，合并确认由 PM Ops 代确认，不再交人、不再等"可以点了"。**花钱、对外发布、删除数据、需求范围变化、人标"敏感"的卡，仍交人确认。**
- 截图核对暂不纳入独立复核（Agent 环境没有浏览器）——**本 ADR 写作期间，用户追加同意**把浏览器能力和界面卡的截图核对一并纳入二郎神的职责（见"决定 6"），但先灰度上线。
- C-91（P2a-3，验证方可写构建目录）上线后，复核员能在可写构建目录里跑测试（例如把测试单独连跑多次查偶发问题）。
- 张良保留抽查权，人可随时把卡标"敏感"收回（走既有 C-65 机制，`entities.ts:139`，Agent 不能设置或取消）。

## 决定

### 1. 新角色 `independent_reviewer`

- `kind=verify`，`worktree=readonly`（C-91 上线后该项目可配 `build_dir` 可写构建目录，复用 P2a-3 既有机制，不是新的 worktree 模式）。
- 工具清单参照现有 verify 角色的公共集合（`whoami`/`get_card`/`get_updates`/`ack_events`/`post_comment`/`heartbeat`/`finish_run`/`report_blocker`/`request_human_action`/`request_decision`/`upload_attachment`/`read_attachment`/`submit_review`/`withdraw_review`，见 `role-pack.ts` 的 `defaultRoleDefinition` L396），**不**给 `update_card`、`create_work_item`、`assign` 等 PM 工具，也不给任何 `host_ops_*` 工具——复核员只下结论，不改派工、不改范围。
- Core Prompt 职责要点：只审当前版本（`target_sha` 必须等于被审交付的 `subject`）；聚焦安全/权限/数值规则（鉴权绕过、权限提升、输入校验缺失、数值边界、并发/迁移风险），不是通用代码审查（不复查 `code_review` 已经覆盖的风格、命名、简单 bug）；有阻塞问题必须退回，不能"建议但通过"；不能是 `development`/`code_review` 的同一员工（见决定 2）。**分工边界（用户 2026-11-13：按建议）**：先按上面这条粗边界执行（独立复核只管安全/权限/数值规则相关的问题，其余交给 `code_review`），不在本 ADR 穷举更细的判定规则；上线后用首批真实复核案例校准 Core Prompt 的措辞和具体判断标准，校准结论写进计划卡⑦的角色规则更新，不回头改本 ADR。
- **审核轮次上限固定为 2**（用户 2026-11-13 确认；**2026-11-14 改为项目偏好，默认普通 5、独立复核 3**，PM 不传 `max_review_rounds`，按偏好取值，只有人能改偏好，见 C-253）：`independent_reviewer` 验证型工作项连续 2 轮未通过（`reject`/`conditional`）时，按 §4.4 现有 `review_limit_exceeded` 规则直接进入 `waiting_decision`，升级给人，不再反复退回——这是比默认 `DEFAULT_MAX_REVIEW_ROUNDS` 更严格的收紧。实现上，PM（或模板装配逻辑）调用 `create_work_item` 创建该角色的验证项时必须传 `max_review_rounds=2`；建议 `createWorkItem`（`pm.ts:323`）对 `role_id="independent_reviewer"` 增加一条硬校验：显式传入的 `max_review_rounds` 大于 2 时拒绝，省略时默认取 2（而不是全局 `DEFAULT_MAX_REVIEW_ROUNDS`），避免 PM 手滑传成更宽松的值。
- 不是模板默认工作项——按决定 4 的方式动态加入，不扩大 §8.7 看板第一版范围，也不改 `developmentCardTemplate`（`templates.ts`）本身。

### 2. 三方隔离：复核员不能与实现者、审核者同员工

现有 §4.5 不变量 15/16（`development-plan.md:709,712`）只保证"验证方 ≠ 其目标产出项的作者"这一条两两隔离，由 `employee-assignment.ts:80` 的 `employeeConflicts` 实现：验证项的 `target()`（L63）只解析到**一个**目标（产出项，或完成申请对应的主产出项），所以今天如果 `independent_reviewer` 的 `target_work_item_id` 指向开发工作项，`assign` 已经会挡住"复核员＝开发者"；但**不会**挡住"复核员＝已经做过 `code_review` 的那个审核者"，因为 `code_review` 和 `independent_reviewer` 是两个平行的验证项，彼此不是对方的"目标"。

**改动**：扩展 `employeeConflicts`，当 `item.role_id === "independent_reviewer"` 时，`counterparts` 除了目标产出项外，再并入"同一产出项上其它已指派的 verify 工作项"的 Assignment 集合（即把同卡 `code_review` 这类平行验证项也算进隔离范围）；反向——`code_review` 先指派后再指派 `independent_reviewer` 的情形——同样要查。这是**新的、仅对 `independent_reviewer` 生效**的三方隔离，不改变 15/16 对其它角色的现有语义（`reviewer`/`tester`/`design_director` 互相之间仍不隔离，按现状）。

### 3. 合并前核对项的归属（C-160 扩展）

现状 `applyPreMergeCheck`（`pre-merge-checks.ts:150`）用自由文本 `label` 做键，设为 `passed`/`failed` 只允许 `office`（PM Office）或 `human`（L193）。要让 `independent_reviewer` 自己设置、PM 不能代改，需要给核对项加一个"所有权"概念。

**推荐设计**：不单独扩展 `pre_merge_checks` 的权限模型，而是把 `independent_reviewer` 的 `submit_review` 结论当作唯一权威来源，`pre_merge_checks` 只做**只读投影**：

1. `independent_reviewer` 像任何验证角色一样调用 `submit_review`：这天然满足"复核结论用验证型工作项记录"的要求，也天然获得现有机制：第 15/16/14 条审核隔离、`target_redelivered` 使旧结论失效（交付变化自动要求重新复核，`development-plan.md:584`）、`isReviewStale`/`deriveReviewMatrix` 判定有效性，全部复用,不新增一套平行状态机。
2. `submit_review` 命令在**同一事务**里，若提交方是 `independent_reviewer` 角色，额外 upsert 一条 `pre_merge_checks` 条目（固定 label，建议常量 `INDEPENDENT_REVIEW_CHECK_LABEL = "独立复核"`）：`verdict=passed`（无 must_fix）时写 `passed`，否则写 `failed`，`updated_by` 记该 Assignment。这一步只是把结论**镜像**到人已经在看的"合并前核对"清单里，不是第二个独立开关。
3. `applyPreMergeCheck` 的直接调用（PM Office／human 手工改 `pre_merge_checks`）对**这一个固定 label** 拒绝写入 `passed`/`failed`（只允许 `pending`，用于人工强制打回，见下）；其它 label 不受影响，PM Office/human 原有能力不变。

这样"谁设的 pending 由谁设 passed/failed"变成"谁有权 `submit_review` 就是谁"，不需要给 `PreMergeCheck` 加新字段、也不需要在 `pre-merge-checks.ts` 里区分"谁创建的"——所有权规则直接从固定 label 读出。

**备选（不推荐，供实现者参考）**：给 `PreMergeCheck` 加 `owner_role_id?: RoleId`，首次写入时按 actor 角色打标，之后passed/failed 只接受同角色或 human。缺点：这是一套与 Review 矩阵并行、容易漂移的第二状态源（例如交付变化后两者的"过期"逻辑要分别维护，`effectivePreMergeChecks` 的 `checked_versions` 机制和 `isReviewStale` 机制本质上做同一件事）；只在"复核不走 `submit_review`"（例如只做截图核对、不产出结构化 Review）时才需要——界面卡的截图核对（决定 6）恰好是这种情况，届时复用该备选方案的"固定 label＋角色所有权"写法，但仍建议能走 `submit_review` 的（代码/配置类复核）优先走推荐设计。

**人工打回**：`human_required_reason` 升级、或人把卡标"敏感"后，若已有 `passed` 的独立复核结论，`pre_merge_checks` 该条目**不自动失效**（复核本身仍然成立），但决定 4 的合并代确认授权会因为 `mergeNeedsHuman` 命中而不生效——即复核结论继续可信，只是"谁来点"变了。人也可以直接把该 work item 标记需要重新复核（走 `withdraw_review`，由复核员本人撤回，或由 PM 走既有 `request_changes` 退回修改路径，不新增"人代撤复核员"的入口，呼应 P2a-11 的"只有本人能撤回"设计）。

### 4. 自动合并范围：`risk_tags` 与不变量 23 的改写

**关键澄清（本 ADR 新增的概念，用户原话未展开；边界已于 2026-11-13 确认，见文末"已确认的细节"第 2 条）**：D12 四类高风险（`spending`/`account`/`permission`/`data_deletion`，`preferences.ts:4`）里的 `permission` 是**业务拍板类别**——"要不要给某个 Agent 推送权限""谁能确认合并"这类决定本身（例如 Q-152/Q-155/Q-156，见下方"成本估算"的真实样本）；`mergeNeedsHuman`（`delegation.ts:56`）只在卡片**真的有一条该类别的 Decision**关联时才强制交人。而用户说的"权限类卡"，按上下文和 PM_OPS 角色文案（`role-pack.ts:183` 的"涉及安全的事项…一律不代拍"）指的是**代码本身涉及鉴权/访问控制逻辑**——这是今天**没有任何 domain 字段承载**的、纯 PM 判断力/Core Prompt 文案层面的分类（"安全相关改动""数值规则"同样没有字段，只在 §7.4 第 7/8 条和 PM 角色正文里以自然语言出现）。这两个"权限"不是同一回事：前者永远交人（D12 不可绕过），后者正是 1a 想自动化的对象。继续用自然语言判断，PM 的分类就无法被服务端强制，也没法做"独立复核通过才放行"的闸门。

**决定（枚举值已定，用户 2026-11-13：按建议）**：新增 `Card.risk_tags?: readonly ("security" | "permission" | "numeric_rule")[]`。**只用这三个值，不再开第四个枚举**：数据迁移、并发等 PM Ops 可判断的高风险代码路径**归入 `security`**，不单独分类。语义："这张卡的产出触及安全/权限检查代码或会改变系统数值规则/行为"，与 D12 的 Decision `category` 完全独立、互不改写。

- **谁能设置**：PM（Office/Ops，复用 `createWorkItem` 已用的 `d.pm()` 判断，`pm.ts:329`）或 human，通过 `update_card`；produce/verify 角色（包括 `coder`、`independent_reviewer` 自己）不能设置——同"安全相关改动"今天只能由 PM 的判断力决定，不能自报。
- **与 D12/`sensitive`/`scope_change` 的关系**：`risk_tags` 不是第二套高风险分类，只是前者的**子集化、可自动放行版本**。`mergeNeedsHuman`（第 56 行）现有的四条命中规则（D12 四类 Decision、`scope_change` Decision、`card.sensitive`、`human_required_reason`）**不受影响，优先级更高、不可被 `risk_tags` 覆盖**——卡片即使打了 `risk_tags`，只要命中这四条任意一条，仍然交人，和今天完全一样。**边界案例已确认（用户 2026-11-13）**：同一张卡既打了 `risk_tags=["permission"]`、又产生了一条 `category=permission` 的 D12 业务拍板（例如"要不要给某角色加这个工具"）时，**业务拍板优先，该卡的合并确认仍交人**，不因 `risk_tags` 而改变——这正是上面"不可被 `risk_tags` 覆盖"的具体结论，不是例外。
- **新的放行条件**（不变量 23 改写，见下）：**只有**当 (a) `mergeNeedsHuman` 的四条都不命中，且 (b) `card.risk_tags` 非空且 ⊆ `{security, permission, numeric_rule}`，且 (c) 该卡存在一个 `role_id=independent_reviewer` 的必需 verify 工作项，其当前 Review **非 stale 且 verdict=passed**（即 `isReviewStale` 判定有效、`target_sha` 等于当前产出交付），**且** (d) 不变量 23 原有其它条件（合并检查通过、所有未取消验证项通过、无未处理 must_fix、知会必填）全部满足时，PM Ops 才能对这张卡选 `merge`。**不满足 (c) 时，`risk_tags` 非空的卡片按原规则交人**（不会因为打了标签反而降低安全性）。

**不变量 23 新表述（建议文字，供实现者精炼）**：

> 合并确认由 PM Ops 选择 `merge` 时，domain 必须在同一事务内校验当前完成申请的合并检查已通过、所有未取消的验证项通过（不论是否必需）、无未处理的 must_fix，并要求知会正文；不满足时只能 hold、退回修改或交人。卡片涉及 D12 四类或需求范围变化（含卡片来源拍板）、偏好关闭或没有活跃 PM Ops 时，合并确认由人确认。**卡片的 `risk_tags` 非空且 ⊆ `{security, permission, numeric_rule}`、且未命中上述人工强制条件时，须额外校验卡上存在一个 `role_id=independent_reviewer` 的必需验证项，其当前 Review 非 stale 且为 passed，才能代确认合并；该验证项不存在或结论非 passed/已过期时，合并确认仍由人确认（不因打了 `risk_tags` 而降低到无条件代确认）。** 敏感卡片（含人标记的敏感卡片）和 PM 主动交人的确认只接受 human Actor…（以下不变）。

**何时打标签、何时补工作项（决定 4 的配套，呼应任务②）**：PM Ops 判断卡片涉及安全/权限/数值规则（或模板按卡片模板预置，例如所有 `requires_repo=true` 且改动范围含鉴权/中间件/迁移脚本目录的卡）时，调用 `update_card(risk_tags=[...])`；domain 侧新增一条轻量不变量："卡片 `risk_tags` 非空时，若其 `template.completion.reviewer !== human`，必须存在一个必需、未取消、`role_id=independent_reviewer` 的验证型工作项，才允许该卡的主产出工作项提交完成申请"——即打标签后若没有配套的复核工作项，卡会卡在"提交完成申请"这一步给出明确中文错误，而不是悄悄跳过复核，这比"自动创建工作项"更安全（创建会隐式决定 `max_review_rounds`、`target_work_item_id` 等，交给 PM 显式调用 `create_work_item` 更可审计）。PM Ops 的角色正文新增规则："看到安全/权限/数值规则相关的改动（鉴权、合并确认权限、SSH/凭据、Token 范围、系统数值上限等）要打 `risk_tags` 并补一个 `independent_reviewer` 验证项，不要只在 PM Ops 自己心里判断"。

### 5. 新员工二郎神

- 人物库：`library:erlang-shen`（`avatar-library.ts:9`，已存在，不需要新增素材库条目）。
- 角色：`independent_reviewer`。
- 启动配置：`claude-opus`（`launch.yaml` 已存在，`ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-5-5`，与 `design_director` 共用同一启动配置——两者模型相同、Harness 相同，职责不同，不冲突，和 `pm`/`design_director` 共用 `claude-opus` 的现状一致）。
- 创建与启动是主机侧人工操作（`cardigan employee create`、`cardigan role create --from-default independent_reviewer` 等），不在 domain 里自动发生，由张良按部署步骤执行（见计划卡 ⑤）。

### 6. 浏览器能力纳入复核范围（协调方 2026-11-13 追加，用户已同意）

界面卡的截图核对目前是"张良在系统外派子 Agent 截图"，与独立复核同样绕开了"张良不在系统内跑"的边界。用户同意：给验证类角色（`ui_ux_designer`、`design_director`、`independent_reviewer`，后续 `tester`）接入本地无头浏览器能力，让 `independent_reviewer`（二郎神，Opus 可看图）直接承担界面卡的截图核对（亮/暗/390px），结论同样写进合并前核对项；界面卡在"截图核对通过 + 独立复核通过 + 合并检查通过"时也走自动合并，但**先灰度**（见计划卡 ⑧）。

- **部署**：在目标主机上给 `agent` 账号装一份**只读共享**的无头 Chromium，按现有 `/opt/codex-0.161.0`、`/opt/pi-1.4.0` 的惯例装到 `/opt/playwright-chromium-<版本>`（root 执行 `npx playwright install chromium` 后把产物固化到该路径，`agent` 账号只读），版本须与所用 `@playwright/mcp` 内置的 playwright 版本匹配（这是人工部署步骤，写进计划卡 ⑤/⑧，不进本仓库）。
- **接入方式**：`compileAssignmentLaunch`（`assignment.ts:219`）目前每个 Assignment 只编译唯一的 Card MCP 服务器（`mcpServers`/`[mcp_servers.<name>]` 的生成逐 Harness 写死为一个条目，见 L219–291、`codexConfig` L463）；需要扩展为按角色追加第二个**本地 stdio** MCP 服务器（`@playwright/mcp --headless --isolated`，不开端口、不持久化登录状态、会话结束即退出子进程）。三种 Harness 都已有"多 MCP 服务器"的原生语法（Claude Code 的 `mcpServers` object 可以有多个键；Codex 的 `config.toml` 可以有多个 `[mcp_servers.X]` 表；Pi 的 `mcp.json` 同理），只是现在的编译函数里硬编码了"只有一个叫 `card` 的服务器"，需要新增一个可选输入（例如 `extraMcpServers`）和对应分支。浏览器可执行文件路径通过环境变量指向 `/opt/playwright-chromium-<版本>`（而不是让 `@playwright/mcp` 自己下载），保持"只读共享、不进 Agent 私有目录"。
- **工具白名单**：Playwright MCP 暴露的工具（例如 `browser_navigate`、`browser_screenshot` 等，具体名称以所选 `@playwright/mcp` 版本为准）作为 `mcp__playwright__*` 加入 `ui_ux_designer`/`design_director`/`independent_reviewer` 的 `allowed_tools`，其它角色不配置、不注入该 MCP 服务器。
- **被测页面**：验证方先在 C-91 的可写构建目录检出交付 SHA，自己起 Vite dev server（本机临时端口），再用浏览器工具访问该本机地址；视口尺寸、亮暗主题切换沿用现有 `apps/web/test-support/responsive-layout.mjs`/`employee-screenshots.mjs` 的既有约定（390px 窄屏、亮暗两套主题），但**不是直接调用**这些脚本——那套脚手架是 CI/测试时跑的 Node 脚本，用的是裸 CDP pipe、明确声明"不需要 Playwright 或新增 npm 依赖"（`chromium.mjs` 注释），与本节给 Agent 装的 `@playwright/mcp` 是两条并行路径，服务不同场景（CI 自动化截图 vs. Agent 交互式核对），**不要求、也不建议合并成一条**；只是复用其视口/主题约定，避免两处标准不一致。
- **截图留存**：截图存运行目录，用 `upload_attachment(kind=evidence)` 附到卡片（复用现有附件机制，不新增存储通道）。
- **网络边界：不设防火墙硬前提（用户 2026-11-13 确认，推翻本 ADR 早先草案里的硬前提要求）**：Agent 本来就持有 shell（Core Prompt 里的 Bash/终端能力），已经可以用 `curl` 等工具访问本机任意端口——浏览器工具本身**不增加任何新的网络能力**，专门为浏览器加一道网络隔离并不能堵住这个口子，反而会造成"看起来加了防护、实际防线在别处"的误解。真正的边界是**既有的两层鉴权**：Workbench 需要密码登录（§14 安全模型，`development-plan.md:2018` 起），Card MCP 需要 Token（§9.1）——复核员既没有 Workbench 密码也没有宿主管理员的 MCP Token，访问这两者都会被各自的鉴权拒绝，与是否装了浏览器无关。**取舍**：本 ADR 把"不得访问生产 Workbench"降级为角色规则/Core Prompt 里的一条约定（"不得导航到 127.0.0.1:7781 或任何已知 Workbench 端口；被测页面只能是自己在可写构建目录起的本地 Vite dev server"），**不**要求卡⑧上线前必须有防火墙/网络命名空间改动；这是"约定 + 既有鉴权"的组合防线，不是"约定独自兜底"。残余风险：如果复核员的 Core Prompt 没有遵守这条约定，理论上仍可能对着真实 Workbench 登录页截图（拿不到页面内容，因为没有密码），造成误导性的"核对通过"结论——这个风险和"Agent 有 shell 时本来就可能做错误操作"是同一类风险，按现有安全模型的一贯处理方式（权限最小化 + 事后可审计，不是逐个工具加网络沙箱）接受，不在本阶段单独加固。
- **灰度（标准已定，用户 2026-11-13 确认）**：浏览器能力上线后先试跑 **5 张**界面卡，张良（PM Office）**逐张抽查**截图核对结论；**这 5 张必须全部没有漏判**（即张良复判后确认每一张的截图核对结论都正确），才能把"截图核对通过即可代确认"纳入自动合并条件（用项目偏好开关控制，例如 `enable_reviewer_browser`，默认关闭）。5 张里出现任意一次漏判，开关继续保持关闭，退回去分析原因（Core Prompt 不够精确、视口/断点没覆盖到、还是复核员本身误判），修正后重新计数 5 张。灰度期间界面卡的合并确认仍按现行 C-86 规则走（PM Ops 确认，仍需人核实截图）。
- **资源**：每会话一个无头浏览器实例，受现有按机器的并发 Run 上限约束（`run_capacity_limits` 表，`0020_run_capacity_limits.sql`）与 C-168 测试限流（`test-worker-limit.ts:79`）共同限制并发——这两个机制限制的是"同时能跑多少个 Run"和"每个 Run 里测试并发数"，不是专门为浏览器设计的，但自然地也限制了"同时存在多少个无头浏览器进程"。无头 Chromium 典型 RSS 约 150–300MB／实例（`--disable-dev-shm-usage` 下，视页面复杂度浮动），需要在 `cardigan-deploy` 的主机容量规划里把"并发上限 × (~300MB + 原有 Agent 进程内存)"算进目标主机的内存预算，本 ADR 只提示，不改并发限额机制本身。
- **未来**：多机时可把本地浏览器升级为共享远程浏览器服务（需鉴权），作为备选记录，本阶段不做。

## 对 D12、Q-279、"可以点了"约定的改写

| 既有规则 | 出处 | 改动 |
|---|---|---|
| D12：四类高风险只能人确认 | `development-plan.md:2108` | **不改**。`risk_tags` 与 D12 四类是两套独立分类，`mergeNeedsHuman` 对 D12 四类的强制交人逻辑原样保留，`risk_tags` 的新代确认路径明确排除命中 D12 的卡片（见决定 4） |
| 不变量 23：PM 代确认合并的前置条件 | `development-plan.md:726` | **改写**，加入 `risk_tags` + 独立复核 passed 的新代确认分支（见决定 4 的建议文字） |
| 不变量 15/16：审核隔离 | `development-plan.md:709,712` | **扩展**，仅对 `independent_reviewer` 新增"与同卡其它验证项不同员工"的三方隔离（见决定 2），不改变对其它角色的既有语义 |
| §7.4 第 2/7/8 条："安全相关改动…交人" | `development-plan.md:1037,1042,1043` | **收窄**：安全/权限/数值规则三类"交人"的默认规则不变，但新增例外——命中 `risk_tags` 且独立复核 passed 时改为 PM 代确认；对外发布、花钱、删除数据、需求范围变化、敏感标记维持原文不变 |
| C-160 `pre_merge_checks` 的 passed/failed 权限 | `pre-merge-checks.ts:156-193` | **扩展**：固定 label"独立复核"的 passed/failed 改由 `independent_reviewer` 的 `submit_review` 投影写入，PM Office/human 直接调用对该 label 的 passed/failed 写入被拒（见决定 3） |
| `PreMergeCheck` 的文档注释"Advisory only: they never change who may confirm the merge" | `entities.ts:140-143` | **语义收窄为**："对除独立复核固定 label 外的核对项仍然成立（广告性、不改变谁能确认）；独立复核这一条 label 的状态会实际改变决定 4 所述的代确认资格"——需要在代码注释里明确写出这一例外，避免后续改动误以为所有 `pre_merge_checks` 都纯只读 |
| `human-merge-wait-for-go`（memory） | 用户 2026-11-12 选 A | **上线前不改**；上线后，命中 1a 新代确认路径的卡不再需要张良说"可以点了"（因为不再交人），但花钱/发布/删除数据/范围变化/敏感卡仍遵守原规则。张良需在 P2a-14 全部合入并实测后，更新该条 memory 和 `merge-authority` |
| Q-279（feature_detail 代拍范围） | `development-plan.md:473` | **不改**。`risk_tags`/独立复核是合并确认授权的新分支，不是 Decision `category` 的代拍授权，不影响 Q-279 的既有口径 |

## 关键设计小结（供实现计划引用）

1. `independent_reviewer` 角色：verify、readonly（+C-91 可写构建目录）、工具白名单同其它 verify 角色 + 不含 PM 工具。
2. 三方隔离：`employeeConflicts` 为 `independent_reviewer` 增加"同卡其它 verify 项"的冲突集合。
3. `pre_merge_checks` 的"独立复核"固定 label 由 `submit_review` 投影写入，PM/human 对该 label 的 passed/failed 直接调用被拒（`pending` 允许，用作人工强制打回）。
4. `Card.risk_tags`（PM/human 可写，Agent 不可写）+ 不变量 23 新增"risk_tags 子集 + 独立复核 passed ⇒ PM 可代确认"的窄口子路径，不覆盖 D12/`sensitive`/`scope_change`。
5. 缺少配套 `independent_reviewer` 工作项时，打了 `risk_tags` 的卡在完成申请阶段即被挡住（防止"打标签但没人复核"的静默漏洞）。
6. 浏览器能力：角色级追加本地 stdio Playwright MCP（`assignment.ts` 的编译函数扩展为支持多 MCP 服务器），只读共享 Chromium 二进制，截图经既有附件机制留痕；界面卡自动合并先灰度。

## 安全边界与威胁分析

| 问题 | 分析 | 结论/缓解 |
|---|---|---|
| **PM 能否绕过复核员？** | PM 不能直接把 `pre_merge_checks` 的"独立复核"条目设为 `passed`（决定 3，域层拒绝）；PM 也不能代替 `independent_reviewer` 提交 `submit_review`（不变量 15/16/14 的审核隔离 + Token 的 `role_id` 校验，复核员的 Token 不签给 PM）。PM **能**设置/撤销 `risk_tags`——这是刻意的（分类本来就该是 PM 的判断力），但 `risk_tags` 本身不授予任何合并权限，只是"打开了一个必须先过独立复核才能用的窄门"；PM 不加 `risk_tags` 也不会让原本该交人的卡（命中 D12/`sensitive`/`scope_change`）绕过人工确认，因为那四条判断在 `mergeNeedsHuman` 里优先且独立生效。 | 无需额外缓解；建议契约测试显式覆盖"PM 直接调用底层 `applyPreMergeCheck` 对独立复核 label 写 passed 被拒"。 |
| **复核员 Token 能否设别的核对项？** | `independent_reviewer` 的角色工具里没有 `update_card`，无法直接改 `pre_merge_checks`（该字段目前经 `update_card` 路径写入，`applyPreMergeCheck` 的调用方只有 PM/human；复核员只经 `submit_review` 的投影写固定 label）。即使未来给复核员开放某个核对项相关工具，也应限定为"只能写自己那条固定 label"，不应给通用的自由文本核对项写权限。 | 实现时在 `submit_review` 的投影逻辑里硬编码仅写固定 label，不暴露通用 `set_pre_merge_check` 工具给该角色。 |
| **实现者能否自己加/删复核工作项？** | `create_work_item`/`update_work_item` 不在 produce/verify 角色的默认工具白名单里（`role-pack.ts` 的 `defaultRoleDefinition`，produce/verify 共用集合不含这两个工具），`coder`、`independent_reviewer` 自己都调不了；只有 PM（Office/Ops）和 human 能创建或取消工作项。即便实现者是外部员工或恶意 Prompt 注入也拿不到这个工具（Token 白名单在服务端强制，`development-plan.md` 不变量 11）。 | 无需额外缓解；维持现状即可，建议回归测试覆盖"`coder`/`independent_reviewer` 角色调用 `create_work_item` 返回 `forbidden_tool`"。 |
| **交付变化后旧 passed 是否失效？** | 两层保证：(a) Review 层：新交付触发 `target_redelivered`，`independent_reviewer` 的验证项状态回到 `ready`，`isReviewStale` 判定旧 Review 失效（既有机制，不变量 14）；(b) `pre_merge_checks` 层：`effectivePreMergeChecks` 按 `checked_versions` 判定 `stale`（既有机制，`pre-merge-checks.ts:69-96`），只要决定 3 的投影逻辑在写入时正确记录 `checked_versions`（当前产出工作项的最新交付），两层会同步失效，不需要新的失效触发器。 | 实现时需保证 `submit_review` 投影写入 `pre_merge_checks` 时调用 `currentPreMergeVersions`（`pre-merge-checks.ts:28`）取当前版本，与普通 Review 使用同一份"当前产出交付"数据源，避免两层各自判断导致不一致。 |
| **复核员与实现者、审核者同一员工如何强制拒绝？** | 决定 2 的扩展：`assign` 指派 `independent_reviewer` 时，`employeeConflicts` 把同卡 `development`（目标产出项）和 `code_review`（平行验证项）两个方向的既有 Assignment 员工都纳入冲突集合，双向检查（先指派复核员、或先指派实现者/审核者后再指派复核员，都要挡住）。 | 域层强制，契约测试覆盖三种指派顺序（先复核后实现/审核、先实现后复核、先审核后复核）全部被拒；同时覆盖"员工停用后重新用别的员工指派不受影响"的回归。 |
| **"敏感"标记如何压过自动合并？** | `card.sensitive` 是 `mergeNeedsHuman` 的第一条命中规则（`delegation.ts:61`，优先于其它一切判断），且只有 human 能设置/取消（C-65，`entities.ts:139`）。`risk_tags` 和独立复核的 passed 结论都**不能**覆盖这一条——决定 4 的新代确认分支显式要求"`mergeNeedsHuman` 的四条都不命中"才生效，标记敏感后该分支自动失效，哪怕独立复核早已 passed。 | 建议契约测试覆盖"已 passed 独立复核的卡，标记敏感后合并确认仍强制交人"，以及"PM 已持有确认但还没合并时打敏感标记，确认作废"这条既有规则（不变量 5，§7.4 第 5 条）对本新分支同样生效。 |
| **（协调方追加，2026-11-13 结论已定）浏览器能否被用来访问生产 Workbench 或别的内网地址？** | `@playwright/mcp --headless --isolated` 本身不限制导航目标，只要 Agent 在对话里让它访问任意 URL 它就会访问。但**浏览器不是这里唯一、也不是最强的网络入口**：复核员的 Core Prompt 本来就带有 shell／终端能力，早就可以用 `curl 127.0.0.1:7781` 之类的命令访问本机任意端口——装不装浏览器，Agent 能不能"看到"本机某个端口的内容，取决于**该端口自身的鉴权**，不取决于有没有浏览器。 | **不设防火墙/网络命名空间层面的硬限制**（用户 2026-11-13 推翻本 ADR 早先草案里的硬前提要求）。真正挡住"复核员截到生产数据"的是既有两层鉴权：Workbench 要密码登录，Card MCP 要 Token，复核员的 Assignment 既没有 Workbench 密码也没有宿主管理员 Token，访问这两者都会在各自鉴权那一步被拒绝，和浏览器无关。缓解收窄为**角色规则/Core Prompt 约定**："不得导航到 127.0.0.1:7781 或其它已知 Workbench 端口，被测页面只能是自己在可写构建目录起的本地 Vite dev server"；这是"约定 + 既有鉴权"的组合防线，约定本身不是唯一防线，所以不要求额外的系统层面硬限制。残余风险（约定被忽略、复核员截到一个打不开的登录页从而得出误导性结论）按现有安全模型对"Agent 有 shell 时可能做错误操作"的一贯处理方式接受，不单独加固；不作为卡⑧上线的前提条件。 |
| **（协调方追加）浏览器资源耗尽/并发失控？** | 每 Run 一个浏览器进程，受 `run_capacity_limits`（按机器的并发 Run 上限）天然约束；但该上限是为"Agent 进程整体"设计的，没有专门为"浏览器会话数"算过内存预算，灰度期间新增的内存压力可能挤占其它正在跑的 Agent。 | 灰度阶段先在低并发场景观察实际 RSS，再把"并发上限 × 浏览器典型内存"纳入 `cardigan-deploy` 的主机容量文档；不新增 domain 级别的浏览器专用限流机制（避免过度设计，待实测后再决定是否需要）。 |

## 备选方案及未采用原因

1. **PM Office 继续在系统外做复核，只是把"可以点了"改成系统自动提醒**：不采用——用户明确要求把复核做成系统内的角色和员工，而不是优化提醒文案；系统外复核无法被服务端强制（谁设 passed/failed 无法审计到 Token），也无法参与自动合并判定。
2. **独立复核结论直接复用 D12 的 `permission` Decision 类别**：不采用——会把"业务层面的权限拍板"（永远交人）和"代码层面的权限/安全/数值规则复核"（可被独立复核放行）混为一谈，污染 D12 的既有语义和既有契约测试；见决定 4 的澄清。
3. **给 `PreMergeCheck` 加 `owner_role_id` 字段，独立出一套所有权判断，不依赖 `submit_review`**：作为备选保留（见决定 3），因为它更通用（不要求复核必须产出结构化 Review），但引入第二个需要独立维护"过期"逻辑的状态源，优先级低于推荐方案；界面卡截图核对（决定 6）因为不天然产出 `submit_review` 的代码级 Review，可能需要用到这个备选。
4. **`risk_tags` 由 Agent（例如 `coder`）自报**：不采用——产出方自报"我这改动涉及安全"既不可信也造成"自己给自己开自动合并的门"的嫌疑；必须是 PM 或 human 的判断力。
5. **浏览器能力直接合并进现有 `apps/web/test-support/` 的 CDP 脚手架，不用 `@playwright/mcp`**：不采用（遵协调方指令）——Agent 需要的是交互式、按需导航的工具，不是跑一个固定脚本；但保留两者在视口/主题约定上的一致性（决定 6）。

## 回滚方式

- 角色/员工层面：`independent_reviewer` 角色和二郎神员工可以直接停用（`deactivateRole`/员工停用），不影响已有卡片的历史 Review 和 `pre_merge_checks` 记录；已创建但未指派的 `independent_reviewer` 工作项可由 PM 取消。
- 自动合并范围：不变量 23 的新分支由 `risk_tags` 字段门控，清空某个项目所有卡片的 `risk_tags`（或整体不使用该字段）即可退回"这三类卡片永远交人"的现状，不需要回滚代码；也可以只回滚"PM 代确认"这一步（继续要求 §7.4 第 2/7/8 条交人），保留独立复核角色本身（复核仍然跑，只是合并确认照旧交人）。
- 浏览器能力：角色级 MCP 服务器注入可按角色单独关闭（不生成对应配置文件即可），不影响其它能力；灰度开关（`enable_reviewer_browser`）关闭即恢复到"界面卡仍由张良系统外派子 Agent 截图核对"的现状过渡期做法。

## 已确认的细节（2026-11-13，用户：按建议）

本 ADR 初版列出的 6 项开放问题，用户已逐项确认，不再是开放问题：

1. **`risk_tags` 枚举值**：固定为 `security`/`permission`/`numeric_rule` 三个值，不开第四个；数据迁移、并发等 PM Ops 可判断的高风险代码路径归入 `security`（见决定 4）。
2. **`risk_tags=permission` 与 D12 `permission` 类别的边界**：同卡同时出现 D12 `permission` 类业务拍板时，**业务拍板优先，仍交人**，不因 `risk_tags` 而改变（见决定 4 的"边界案例已确认"）。
3. **独立复核与 `code_review` 的分工**：先按决定 1 给出的粗边界（聚焦安全/权限/数值规则，不复查 `code_review` 已覆盖的内容）上线，不在本 ADR 穷举更细的判定规则；上线后用首批真实案例校准 Core Prompt，结论写进计划卡⑦，不回头改本 ADR。
4. **浏览器的网络边界**：**不**要求卡⑧上线前有防火墙/网络命名空间层面的硬限制——Agent 本来就有 shell，浏览器不增加新的网络能力；边界交给 Workbench 密码登录和 Card MCP Token 这两层既有鉴权，浏览器侧只在角色规则/Core Prompt 里保留"不得访问生产 Workbench"的约定（见决定 6、威胁分析表对应行）。
5. **界面卡自动合并的灰度标准**：先试跑 **5 张**界面卡，张良逐张抽查，**5 张都没有漏判**才打开自动合并开关；出现任意一次漏判则保持关闭、分析原因、修正后重新计数 5 张（见决定 6）。
6. **独立复核的审核轮次上限**：固定为 **2**（2026-11-14 改为项目偏好，默认普通 5、独立复核 3，见 C-253）——连续 2 轮未通过直接升级给人，不再反复退回（见决定 1）。

## 观测指标（概要，详细方案见实现计划 §7）

- 独立复核平均耗时（从指派到 `submit_review`）。
- 误放过率的抽查方式：张良按比例抽查已自动合并的 `risk_tags` 卡，人工复判是否真的不需要人工介入；界面卡的灰度抽查比例固定为 100%（见决定 6 的 5 张标准），正式开启自动合并后的常态抽查比例由实现计划 §7 的观察指标另定。
- Opus 复核的日成本估算：见实现计划 §7，基于近 3 天数据库统计和当前 Opus 5.5 定价（$4/$20 每百万 token，输入/输出）粗算，约 **$4–$10/天**（取决于复核任务的 token 量级和卡片数量，详见实现计划）。**计费口径**：Cardigan 里跑 Claude Agent 经第三方中转网关（用户账户额度），上面的美元数是按 Anthropic 官方第一方定价表粗算的参考量级，实际计费以中转账户的计费规则和余额为准，两者可能不完全一致，不能直接当作账单预测。
