# P2-V V12：设计流程与模板选择

- 对应：`docs/plans/phase-2.md` §3.3（角色和卡片模板）的延伸；用户 2026-11-11 拍板（本文件 §0）。
- 前提：P2-V V9a/V9b（角色管理）、V10a/V10b（卡片模板管理）已合并；V11a/V11b/V11c（成员与外接身份）已合并。C-87（只读附件下载工具，正在做）作为部分依赖，见 §3 拆卡表。
- 开发方案要改的章节：§4.3（Decision 新增 `draft?`、Role/CardTemplate 不变）、§4.4（人批准草案后系统创建，属于"人显式操作的例外"的又一实例）、§4.5（新增不变量）、§9.2（新增只读工具 `list_templates`/`list_roles`、`request_decision` 新增 `draft`、新增 `generate_image`）、§10.1（角色清单新增 `ui_ux_designer`、`design_director`）、§13.1（CLI 对应项，若新增）、§14/§14.1（出图服务密钥、草案审批权限边界）。

## 0. 背景与拍板记录（2026-11-11，必须照此设计）

用户要求：界面和交互类修改引入两个新角色——**UI/UX 设计师**（界面设计、交互设计，可写代码或用任何可用工具提供设计稿、交互原型）和**设计总监**（review 设计稿）；设计总监通过后交人拍板，拍板卡带设计稿截图和设计说明。另外要让 PM 能判断用哪个模板、复用已有模板，或为新类型工作创建模板，目的是以后 sensen-godot 游戏项目迁移进来，适配更多工作类型（场景美术、动画、特效等）。

三条拍板：

1. **PM 提议、人批准**：PM 可以自由列出、选用、复用已有模板；需要新模板或新角色时 PM 只能起草，通过 permission 类 Decision（`decider=human`）提交，人在 Workbench 批准后由系统创建。理由：角色决定 Agent 的工具白名单，等于定权限，按 D12/D14、§4.5 第 22 条"四类高风险不可纳入授权"，只能人确认。
2. **设计师第一版就同时接出图服务**（图像生成，按量花钱）以及无头浏览器截图、HTML/React 交互原型。花钱相关配置（网关、密钥、预算上限、用量记录）要设计清楚；密钥只存主机、不进仓库、不给 Agent 明文（参考 §14 和现有 launch profile / 网关做法）。参考 `cardigan-avatar-studio`（用 `gpt-image-2` 经网关生成头像，`out/usage.jsonl` 按次记录 `call_id/model/usage/duration_ms`）作为"出图服务的一个实例"，本计划不读取或复制其密钥。
3. **先写计划，用户看过再开卡**——本文件即这一步的产出，不创建任何卡片。

**本次对 2e 的补充指示（必须遵守）**："拍板卡显示图片"（Decision 关联附件、Needs You 显示缩略图）已单独建卡先做，口径是 `request_decision` 增加可选 `attachment_ids`，只能引用该卡片（或 `affected_cards`）上已有的附件。**本计划不重复设计这套附件模型**，§2.5 只说明设计流程如何使用它（设计师把截图和说明作为交付/附件上传，人拍板时引用），把它列为依赖。

## 1. 不做的范围

- 不实现出图预算的具体额度、不选定具体出图模型/网关账号（留给用户拍板，见 §6）。
- 不做 Workbench 角色/模板管理页以外的新 UI（沿用 V9b/V10b 已有页面，只扩展草案审批的展示）。
- 不把"拍板卡带附件"重新设计一遍（见 §0 第三段），只引用依赖。
- 不做 sensen-godot 的实际迁移、不预先定义场景美术/动画/特效的具体角色和模板（那是迁移时 PM 按本计划的机制自己提议）。
- 不做大文件/二进制资源传输的新能力（§2.7 只列缺口）。
- 不做 Phase 3 的通用模型网关和按 Assignment 计费（`phase-2.md` 已明确"费用和预算 Phase 2 不做，额度监控放到 Phase 3"）；本计划的出图预算是**出图这一类花钱调用的专用小闸门**，不是通用计费系统，范围刻意收窄。

## 2. 关键设计

### 2.1 PM 选模板（a）

新增两个只读 MCP 工具，只给 `standing` 角色（Office 和 Ops 都用得到，建卡前都可能要看）：

- `list_templates()`：返回当前项目每个模板 id 的**最新且 active** 版本（复用 `latestCardTemplate`/`cardTemplate` 的选版逻辑，`packages/domain/src/templates.ts:116-124`），字段包括 `id/title/description/requires_repo/merge/primary_work_item_key/work_items[]`（含每项 `role_id/kind/required`）。
- `list_roles()`：返回当前项目每个角色 id 的最新且 active 版本（复用 `activeTemplateRole`，`packages/domain/src/templates.ts:150-156` 的思路），字段包括 `role_id/display_name/kind/capabilities/worktree/abilities`，不返回 `instructions`/`core_prompt` 全文（太长，PM 判断"有没有这类角色"不需要读完整说明；需要细节时可以另开只读接口，本计划不做）。

不塞进 `project_snapshot`：模板和角色变化频率低，`project_snapshot` 已经是"全量快照成本随项目历史线性增长"的高成本查询（`docs/development-plan.md` §9.2 M1.6a 段），不应该为低频数据再加字段。两个新工具加入 `STANDING_ROLE_TOOLS`（`packages/domain/src/role.ts:33-57`）。

PM 角色说明（`packages/roles/src/role-pack.ts`）新增一组"选模板"规则（并入 `PM_PLANNING_RULES` 或新增常量 `PM_TEMPLATE_RULES`，紧跟在拆卡和派活之后）：

- 建卡前先 `list_templates` 看已有模板，按卡片的工作类型（开发、通用、产出物、设计……）选最匹配的；找不到匹配类型，优先看能不能通过现有模板"复用"（例如用 `artifact` 模板但换个产出角色），而不是急着提新模板。
- 确实需要新角色或新模板时，只能起草，按 §2.2 的流程提交 Decision，不能自己创建；起草前先 `list_roles` 确认没有能力相近的角色可以直接复用。

### 2.2 PM 提议新模板/新角色，人批准（b）

**草案数据结构**：`Decision` 新增可选字段 `draft?`：

```ts
type DecisionDraft =
  | { kind: "role"; definition: RoleDefinition }      // RoleDefinition: packages/domain/src/commands/role.ts:17-22
  | { kind: "template"; definition: CardTemplateDefinition }; // packages/domain/src/templates.ts:4-23
```

JSON 文档加字段兼容，不需要新表（`decisions` 本身已是按项目的 JSON 文档存储，参照 `roles`/`card_templates` 的兼容模式）。

**提交为 Decision**：`request_decision` 的 `draft` 参数仅当 `category="permission"` 时允许携带；domain 校验：

1. 携带 `draft` 时 `category` 必须是 `"permission"`，否则 `validation_failed`（不许借道走别的类别绕过人审）。
2. 调用方 Assignment 的 `role_id` 必须是 `"pm"`（新角色/新模板草案只能由 PM 起草，其它角色不行）。
3. `draft.definition` 必须先经 `validateRole`（`packages/domain/src/commands/role.ts:45`）或 `validateCardTemplate`（`packages/domain/src/commands/templates.ts:41`）校验通过——这两个函数本来就是纯函数（不做 IO），`requestDecision` 可以直接复用做"预检"，校验失败直接拒绝创建 Decision，不把一个格式错误的草案扔给人看。
4. `category="permission"` 时 `decider` 必须是 `"human"`，这是现有规则（`packages/domain/src/commands/coordination.ts:282-284`：高风险类别不接受 `role:pm`），不需要为草案单开一条。
5. `kind` 用 `"choose"`，`options` 固定两项：`approve`（按草案创建）、`reject`（不创建，维持现状）；`context` 由 PM 写清楚新增了什么、和最接近的现有角色/模板比起来差在哪（§2.2 下面说明 Workbench 怎么强化这部分展示，不能只靠 PM 自己写）。

**批准后系统创建**：人在 Workbench 走现有拍板入口选 `approve`，底层仍是 `recordDecision`（human Actor，`docs/development-plan.md` §9.2"你在 Web 界面上的操作走 Workbench Web API……`recordDecision` 允许人记录 `decider=human` 的决策"）。`recordDecision` 新增一段：当被解决的 Decision 有 `draft` 且选中 `approve` 且 `actor.kind==="human"` 时，在**同一事务**里按 `draft.kind` 调用 `createRole`（`packages/domain/src/commands/role.ts:203`）或 `manageCardTemplate`（`packages/domain/src/commands/templates.ts`，`action:"add"`）。

- **actor 问题自然解决**：`canManageRoles`/`canManageCardTemplates` 只认 `actor.kind==="human"`（`packages/domain/src/role.ts:87-89`；`packages/domain/src/commands/templates.ts:23-26`），而"approve"这个动作本身就是 human 在 Workbench 做的，所以创建调用的 actor 天然是 human，不需要绕过或放宽这两条判断——PM 只是起草者，从未真正执行过创建命令。
- **审计**：`role_created`/`card_template_changed` 事件 payload 新增可选字段 `created_from_decision_id`，指回这条 Decision；Decision 自身的 `raised_by`（起草的 PM Assignment）和 `resolution.resolved_by`（人）已经各自留痕，不需要重复记录"谁提议"。
- `reject` 时不执行任何创建；PM 需要修改草案就另发一条新的 `request_decision`（新草案），不修改旧 Decision。人想要"部分修改"时，在 `context`/评论里写清楚要改什么，PM 重新起草，不支持在 Workbench 上直接编辑草案字段后批准（避免"人改的和显示的不一致"）。

**Workbench 展示**（扩展 `apps/web/src/views/NeedsYouPage.tsx` 的 `Decision` 组件，`context` 目前只用 `Markdown` 渲染纯文本，`apps/web/src/views/NeedsYouPage.tsx:180-184`）：`draft.kind="role"` 时，除了现有的 `question`/`context`，额外结构化展示 `allowed_tools`（完整列表，不折叠）、`worktree`、`capabilities`——这三项直接决定权限边界，必须醒目；`draft.kind="template"` 时额外展示 `work_items[]` 的角色和种类、`completion`、`merge`。这不是通用 diff 算法，只是把草案里"决定权限/流程"的字段单独列出来，不能让"人批准"变成只读了一段自然语言就点下去的橡皮图章。

### 2.3 设计角色（c）

新增两个默认角色（`packages/roles/src/role-pack.ts` 的 `ROLE_BODIES`/`DefaultRoleId`）：

| role_id | kind | 职责 | 核心工具 |
|---|---|---|---|
| `ui_ux_designer` | produce | 界面设计、交互设计；可写代码（HTML/React 原型）或用无头浏览器截图、出图服务产出设计稿 | `submit_delivery`（`kind=design`）、`upload_attachment`、`generate_image`（§2.6） |
| `design_director` | verify | review 设计稿是否达标，不是 review 代码实现 | `submit_review`，附件证据 |

`defaultRoleDefinition` 的 `kind` 推断（`packages/roles/src/role-pack.ts:243-244`，`role==="pm"?standing:role==="coder"?produce:verify`）要扩成按角色名显式映射（新增两个分支），不能再用"非 pm/coder 就是 verify"的隐式规则，否则新角色会被错误归类。

**现有 `designer` 角色怎么处理**：保留，不改名、不删除，定位仍是"验证型界面走查"（`packages/roles/src/role-pack.ts:180-193`，审代码实现后的 UI/交互是否符合预期，挂在 `dev` 模板场景）——它和 `design_director` 审的不是同一件事：`designer` 审"代码实现出来的界面对不对"，`design_director` 审"设计稿本身够不够格交给人拍板"。两者不冲突，不合并。

**顺手修一个现状不一致**：内置 `artifact` 模板默认产出角色是 `role_id="designer"`（`packages/domain/src/templates.ts:95`），但按 `defaultRoleDefinition` 的规则 `designer` 的 `kind` 是 `verify`，`verify` 角色不含 `submit_delivery`（`ROLE_TOOL_ALLOWLISTS.verify`，`packages/domain/src/role.ts:64-70`），`validateCardTemplate` 对非空 `capabilities` 的角色会拒绝它做产出项（`packages/domain/src/commands/role.ts` 的能力校验规则；`packages/domain/src/development-plan.md` §4.5 第 19 条）。这不是本计划引入的 bug，但顺手把 `artifactCardTemplate.work_items[0].role_id`（`packages/domain/src/templates.ts:95`）改成 `ui_ux_designer`，让内置模板默认可用；不影响已经手工注册过 produce 类型 `designer` 角色的老项目（模板建卡时查的是项目实际登记的角色，不要求和默认包同名同 kind）。

### 2.4 设计模板（d）

新增内置模板 `design`（`packages/domain/src/templates.ts`，排在 `artifactCardTemplate` 之后）：

| 字段 | 值 |
|---|---|
| `requires_repo` | `false`（设计稿/原型作为附件交付，不进仓库；需要交互原型代码真正入库走评审时，直接用 `dev` 模板开发子任务，不在本模板重复设计，见 §1） |
| `merge` | `none` |
| `require_acceptance_criteria` | `true` |
| `primary_work_item_key` | `design_production` |
| `work_items` | `design_production`（produce，`ui_ux_designer`，必需）→ `design_review`（verify，`design_director`，`target_work_item_key=design_production`，必需） |
| `completion` | `{mode:"review", reviewer:"human"}` |

设计卡由人审批完成（`completion.reviewer=human`），不设 PM 验收。

**流程**：设计师产出（`submit_delivery(kind=design, subject=artifact_sha256|doc_version, attachments=[截图...])`）→ 设计总监验证（`submit_review`，有 `must_fix` 即驳回，回到设计师，走现有 §4.4 返工机制，不新增状态）→ 主产出负责人（`ui_ux_designer`）提交 `kind=card_completion` 的完成申请 → **人拍板**（不是 PM）：通过即卡片完成，退回即回到设计师重做、设计总监重新验证。

**用户原话是"设计总监通过的设计稿再给我拍板……拍板卡片带截图和设计说明"，而不是"卡片先 done、之后再问是否立项"**：所以不能走 §2.2 那种"PM 另发 Decision"的模式，必须让"人拍板"本身就是卡片的完成条件——这正是现有 `completion.reviewer="human"` 机制的设计目的：

- 校验上已经支持：`validateCardTemplate` 允许 `completion.reviewer==="human"`（`packages/domain/src/commands/templates.ts:123-130`，不要求对应任何 verify 角色，和 `reviewer="role:xxx"` 走不同分支）。
- 流程上已经实现：主产出负责人提交 `card_completion` 交付后，`requestHumanCompletionReview`（`packages/domain/src/commands/human-completion.ts:9-63`）自动生成一条系统 Decision（`trigger="completion_review"`、`kind="approve"`、`decider="human"`、选项固定 `approve`/`reject`），不需要 PM 介入、不需要新的 trigger 类型。
- **退回修改走哪条现有迁移**：人选 `reject` 时，`resolveHumanCompletionReview`（同文件 `:64-133`）把卡片状态按 `completion_review_rejected` 迁移（`:126-132`）退回执行阶段，而不是进入合并/完成；设计师提交新的 `design_production` 交付后，旧的 `design_review` 按既有版本规则自动失效（§4.5 第 14 条"交付有新版本后，针对旧版本的审核结论自动失效"），**设计总监必须针对新版本重新验证**，不需要专门为设计模板写一条新规则。人选 `approve` 时走 `completionPassed`（`:125`，调用 `packages/domain/src/commands/merge.ts` 的既有完成路径），`design` 模板 `merge=none` 直接进入 `done`。

**现有机制的真实缺口**（写入 V12d 范围，不在别处隐藏）：`requestHumanCompletionReview` 生成 Decision 时只填 `context: delivery.summary`（`human-completion.ts:43`），**没有带上任何附件引用**——这正是用户要的"拍板卡带截图和设计说明"缺失的那一步。V12d 要把这条系统生成的 Decision 也接上 C-95 的附件能力：生成 `completion_review` Decision 时，从该 `card_completion` 交付（或它引用的 `design_production` 交付）的 `attachments[]` 取值，写入 Decision 的附件引用字段（字段名和存储方式以 C-95 实际落地的结构为准——若 C-95 把附件引用做成 `Decision` 实体的持久字段，这里直接赋值；若 C-95 只在 `request_decision` 这一个 MCP 入口做参数到展示的直通、`Decision` 本身不持久化该字段，则说明系统生成的 Decision 走不了这条路，需要和 C-95 的实现者对齐、必要时请其把该字段提升为 `Decision` 实体字段——**V12d 开工前必须先读 C-95 的实际实现确认这一点，不能假设**）。

### 2.5 拍板卡带附件：依赖已建的卡（e）

本计划不重复设计 Decision 附件模型（已由 C-95 实现：`request_decision` 增加可选 `attachment_ids`，只能引用该卡片或 `affected_cards` 上已有的附件；Needs You 显示缩略图、点开大图）。本计划只约定设计流程如何**使用**它：

- 设计师在 `submit_delivery` 时把截图、设计说明作为附件（`attachments[]`，`packages/mcp-server/src/commands/delivery-tools.ts:44-46`）一并提交；或用 `upload_attachment(kind=artifact, attach_to={kind:"delivery", id})` 单独补充。
- 设计总监在 `submit_review` 时同样可以附证据截图（`reviewInput.attachments`，同文件 `:70`）。
- `design_production` 负责人提交 `kind=card_completion` 的完成申请时，把设计稿截图和设计说明同样放进这次交付的 `attachments[]`（逐条对照验收标准，和 `coder` 写完成申请的方式一致）。
- 系统生成的 `completion_review` Decision（§2.4）据此带上附件引用，人在 Needs You 上直接看到缩略图和设计说明，不需要跳回卡片详情——这是本计划里**唯一**用到附件拍板能力的地方（§2.4 已删掉"PM 另发立项 Decision"的设计，不再有第二处引用）。
- V12d 依赖 C-95 已经合并（§3），因为"系统自动生成的 Decision 接上附件"这一步需要 C-95 定义好的附件引用字段已经存在，不能先写代码等它。

### 2.6 设计师工具（f）

**无头浏览器**：不作为 Cardigan MCP 工具暴露（截图本身不是业务事实，不需要服务端校验，和 `coder` 能跑任意测试命令是同一个模式——Cardigan 只规定"结果怎么交"，不规定"过程里能跑什么命令"）。落地方式：

- 工作机初始化脚本（`agent` 用户、工具链）按 §20.1/§20.4 的既有分工属于 `cardigan-deploy` 仓库，不在 `cardigan` 仓库里写安装脚本；无头浏览器（建议 Playwright + 固定版本的 Chromium，不自动更新，呼应 Launch Profile 的 `auto_update:false` 保守策略）由 Claude 按"平台负责人"职责在部署时装好。
- `ui_ux_designer` 角色的 `required_machine_tags`（`packages/domain/src/role.ts` 的 `Role.required_machine_tags`）新增一个约定标签 `headless-browser`，复用现有 `Machine.tags[]` 机制（§4.3，和 `android-device`/`gpu` 同一模式），只把设计任务派到已装好浏览器的机器。
- 设计师 Core Prompt 指导"用机器上已装好的某个截图/构建命令生成 png，再用 `upload_attachment` 或 `submit_delivery` 的 `attachments` 提交"，不新增 MCP 工具。

**出图服务接入**（图像生成，按量花钱）：

- **新增 MCP 工具** `generate_image(prompt, size?, reference_attachment_id?) -> {attachment_id, cost_estimate}`，仅 `ui_ux_designer`（以及未来其它需要出图的 produce 角色）可调用。domain 侧只做"该项目当月累计花费是否超预算"的纯函数校验；真正的 HTTP 调用和密钥使用发生在 host 层，参照现有 `DeliveryVerifier` 的端口模式（`packages/mcp-server/src/commands/delivery-tools.ts` 的 `DeliveryVerifierFor`）：domain 定义一个 `ImageGenerator` 端口接口，`host` 提供真实实现调用网关，结果经现有 `prepareAttachment`（`packages/domain/src/commands/support-tools.ts` 附件落盘路径的同一套机制）落盘后直接返回 `attachment_id`，设计师不需要自己处理图片 base64。
- **密钥不给 Agent 明文**：不复用现有 `provider.secret_env`（那套机制是把密钥作为环境变量注入 Agent CLI 子进程，Agent 的 bash 工具能读到，`~/.config/cardigan/launch.yaml` 的 `secret_env` 字段本质如此）。出图服务改为**host 侧转发**：密钥只写在主机 `launch.yaml` 新增的顶层区块（示例，字段名不含真实值）：
  ```yaml
  image_gen:
    default:
      base_url: <网关地址，写在私有部署配置里>
      model: gpt-image-2
      secret_env: IMAGE_GEN_API_KEY   # Cardigan 独立账号的密钥，值只在主机环境
  ```
  这个区块由 host 进程自己读取，**不编译进任何 Assignment 的运行目录**（和 Agent CLI 的 Provider/Profile 配置是两条不同的路径）；Agent 侧只持有它本来就有的 Cardigan MCP Token，调用 `generate_image` 由 host 代为请求网关，Agent 进程环境里不出现出图服务的密钥。这是本计划推荐的方案，权衡见 §6。
- **预算与用量记录**：新增 host/store 层的用量台账（不是 domain 实体，类似附件 GC 循环的性质）`image_gen_usage`：每次调用记录 `{assignment_id, project_id, model, tokens/usage, cost_estimate, at, call_id}`，字段设计参照 `cardigan-avatar-studio` 的 `out/usage.jsonl` 记录模式（`call_id/model/usage/duration_ms`，不涉及其密钥）。预算上限按项目存（新增 `ProjectPreferences` 字段 `image_gen_budget_usd`，只有人能设置，和 `auto_merge_after_minutes` 同一校验/审计模式，`docs/development-plan.md` §4.3"ProjectPreferences"段）。
- **超限行为**：`generate_image` 在 domain 校验时直接拒绝（`budget_exceeded`，中文提示），不留部分效果（不产生附件、不计用量）；已生成的不受影响。PM 角色说明新增一条：出图预算不足时，用 `request_decision(category=spending, decider=human)` 问人是否提高额度，不能自己决定或绕过（花钱类高风险，§4.5 第 22 条"四类高风险不可纳入授权"同样适用）。
- **与 V2 的关系**：V2（`docs/plans/phase-2.md` §3.1"V2 接入点和模型"）管的是 Agent CLI 对话用的模型网关；出图服务本质上也是"网关 + 模型"的组合，字段命名（`base_url`/协议/密钥引用）特意和 V2 即将引入的"接入点"概念对齐，便于 V2 上线后把出图网关收进同一个 Workbench 界面统一管理，不重复造轮子。V12 不等 V2，先用 `launch.yaml` 手工配置（和现有 Provider 配置一样，第一版本就是手工 YAML），预算用 CLI/偏好设置配置，Workbench UI 留给以后。

### 2.7 面向游戏项目的扩展方式（g）

场景美术、动画、特效按"新增角色 + 新增模板"覆盖，走 §2.2 的 PM 提议机制，本计划不预先定义具体角色/模板（那是 sensen-godot 迁移时的事）。核对现有交付能力，列出缺口（只列，不实现）：

- **附件大小上限 10 MiB**（`docs/development-plan.md` §9.3："解码后 ≤10MiB"）不够美术资源（贴图、模型、动画文件动辄数十到数百 MB）。
- **传输方式**：附件走标准 base64 JSON body，大文件 base64 膨胀 33% 且需要一次性整体编解码，没有分片/流式上传或外部对象存储引用。
- **`Delivery.subject`** 只有 `git_head`/`artifact_sha256`/`doc_version` 三种（`packages/domain/src/entities.ts:435` 附近），没有"资源包/多文件清单"的结构；`evidence[]` 的 diff 目前只服务 Git 代码 diff，二进制资源的"改了什么"更需要缩略图/预览而非文本 diff。
- 无头浏览器/出图服务目前只为 UI 设计师设计；3D 预览（例如引擎内截图、Blender 渲染）需要另一套工具链，不在本计划讨论。

## 3. 对 §4.4/§4.5/§9/§14 的改动与存储迁移

- **§4.4**：补一句——草案经人 `approve` 后系统创建角色/模板，是"人显式操作的例外"的又一个实例（与 `markCardDone` 同类），不是规则自动触发。
- **§4.5 新增不变量**：
  1. `request_decision` 携带 `draft` 时，`category` 必须是 `permission`，调用方 Assignment 的 `role_id` 必须是 `pm`；否则 `validation_failed`。
  2. `draft.definition` 必须先通过对应的 `validateRole`/`validateCardTemplate`，校验失败不创建 Decision。
  3. 角色/模板的创建只能发生在 `recordDecision` 对带 `draft` 的 Decision 选中 `approve`、且 `actor.kind==="human"` 时；任何其它路径不能触发这个副作用（回归：PM/Agent 直接调用 `createRole`/`manageCardTemplate` 仍一律拒绝，`canManageRoles`/`canManageCardTemplates` 不变）。
  4. `generate_image` 的预算校验和实际调用在同一事务/同一次处理内完成，超限拒绝不留部分效果（不产生附件、不写用量）。
  5. `design` 模板的审核隔离沿用 §4.5 第 15/16 条：`design_review` 不能是 `design_production` 当前或曾经的 Assignment/员工。
- **§9（MCP）**：新增只读 `list_templates()`/`list_roles()`（仅 standing/`pm`）；`request_decision` 新增可选 `draft`（仅 `category=permission` 且调用方为 `pm`）；新增 `generate_image(prompt, size?, reference_attachment_id?)`（仅 `ui_ux_designer` 等被授权的 produce 角色）。
- **§14/§14.1**：新增一行"出图服务密钥"：只写主机 `launch.yaml` 的 `image_gen` 区块，不编译进任何 Assignment 运行目录，经 host 转发，Agent 不持有明文；预算超限服务端拒绝，不依赖 Agent 自报。角色权限边界表补一行：`ui_ux_designer`（produce，新增 `generate_image`）、`design_director`（verify）。
- **存储迁移**：
  - 迁移为每个已有项目写入 `design` 模板 v1（和 V10a 同一迁移模式，`docs/plans/p2v-9-10-roles-templates.md` §2.2 的做法）。
  - `ui_ux_designer`/`design_director` 作为新的默认角色**代码常量**加入 `packages/roles/src/role-pack.ts`，不批量写入所有现有项目的 `roles` 表——按拍板 1 的精神，要不要在某项目启用新角色也是一次决定，人用 `cardigan role add --from-default`（现有机制）按项目手工引入。
  - `Decision` 加字段 `draft?`（JSON 兼容，无需迁移）。
  - 新增 host/store 层 `image_gen_usage` 表（迁移新增），`ProjectPreferences` 加字段 `image_gen_budget_usd?`（JSON 偏好表兼容，无需迁移）。

## 4. 拆卡（按建议顺序）

| 卡片 | 内容 | 依赖 |
|---|---|---|
| V12a | 新角色 `ui_ux_designer`/`design_director`（`role-pack.ts` 的 `kind` 推断改显式映射）；新内置模板 `design`；修正 `artifactCardTemplate` 默认产出角色为 `ui_ux_designer`；对应契约测试 | 无（V9a/V10a 已合并） |
| V12b | 只读工具 `list_templates`/`list_roles`；加入 `STANDING_ROLE_TOOLS`；PM 角色说明新增"选模板"规则 | 可与 V12a 并行，建议 V12a 合并后开工以便端到端联调 |
| V12c | `Decision.draft` 字段；`request_decision` 的 `draft` 校验；`recordDecision` 的"approve 时按草案创建"分支与审计字段 `created_from_decision_id`；PM 角色说明新增"提议新角色/模板走 Decision"规则；Workbench 草案展示（工具白名单/worktree/能力结构化渲染） | 可独立开工，建议排在 V12a 之后以便联调一个真实草案 |
| V12d | `design` 模板端到端跑通（产出→设计总监验证→完成申请→**人**拍板，通过完成/退回重做）；`requestHumanCompletionReview` 补上附件引用（§2.4 的缺口）；PM 角色说明新增"设计卡的拍板是人验收设计稿，不是 PM 代劳"的提醒 | V12a；**C-87**（Agent 只读附件下载工具，硬依赖）；**C-95**（`request_decision`/Decision 附件引用，硬依赖） |
| V12e | `headless-browser` machine tag；`ui_ux_designer` Core Prompt 的截图/原型工具指导（`cardigan-deploy` 侧的实际安装脚本不在本仓库） | V12a |
| V12f1 | `ImageGenerator` 端口接口 + `generate_image` MCP 工具骨架（用假实现测试预算校验和拒绝路径） | V12a |
| V12f2 | host 真实接入出图网关；`launch.yaml` 的 `image_gen` 区块；`image_gen_usage` 台账；`ProjectPreferences.image_gen_budget_usd`；PM 角色说明"预算不足发起 spending Decision" | V12f1 |

每张卡控制在几百行以内；V12b/V12c/V12e 可在 V12a 合并后并行开工；V12f 拆成两张避免"domain 接口 + host 真实网关接入"混在一张大卡里。

**C-87 是 V12d（以及 `design_director` 这个角色本身能不能工作）的硬依赖，不是可选项**：`design_director` 的全部职责就是"看设计师上传的截图/原型，判断够不够格"（§2.3），而现状没有任何工具让 Agent 读取已上传的附件内容（`design_director` 拿到的只是 `attachment_id`，没有下载/查看手段）。`generate_image`（§2.6）生成的图片虽然可以直接落盘返回 `attachment_id` 给设计师，但**设计总监审的是设计师交付的东西，不是自己生成的东西**，必须能"看见"附件才能验证，不能靠无头浏览器自己重新截一遍来代替"审查设计师交付的内容"。V12d 在 C-87 合并、`design_director` 的角色说明里明确要求"先用（C-87 提供的）附件下载工具看截图，再写审核结论"之前不能开工；`generate_image`（V12f）本身不依赖 C-87。

## 5. 测试清单

- **domain 契约测试**：
  - `design` 模板的 `validateCardTemplate` 规则（角色能力匹配、审核隔离、`requires_repo=false` 与 `merge=none` 的一致性）。
  - `ui_ux_designer`（produce）不含 `submit_review`，`design_director`（verify）不含 `submit_delivery`（`ROLE_TOOL_ALLOWLISTS` 回归）。
  - `request_decision` 的 `draft`：非 `category=permission` 携带被拒；非 `pm` 角色携带被拒；`draft.definition` 校验失败被拒。
  - `recordDecision` 的"approve 时创建"：`approve` 且 `actor.kind==="human"` 才创建；`reject` 不创建；非 human（理论上不该发生，仍要测）不创建；创建后事件带 `created_from_decision_id`；PM/Agent 直接调用 `createRole`/`manageCardTemplate` 仍被拒（回归）。
  - `generate_image`：预算充足通过、不足拒绝且不留部分效果（无附件、无用量记录）；非授权角色调用被拒。
  - `design_review` 审核隔离：不能是 `design_production` 的同一 Assignment/员工（复用 §4.5 第 15/16 条既有测试模式）。
  - `completion.reviewer="human"` 的 `design` 模板走既有 `requestHumanCompletionReview`/`resolveHumanCompletionReview`：`approve` → `completionPassed` → `done`（回归，`merge=none` 应走 `merge_not_required` 同一路径）；`reject` → `completion_review_rejected`（回归）；补充新测试覆盖"系统生成的 `completion_review` Decision 带上了完成申请交付的附件引用"（§2.4 的缺口修复）。
  - 设计师在 `reject` 之后提交新版本 `design_production` 交付，旧 `design_review` 结论自动失效（§4.5 第 14 条回归），卡片必须等设计总监对新版本重新 `submit_review` 通过，才能再次提交完成申请。
- **存储迁移测试**：`design` 模板 v1 写入每个已有项目；新增默认角色常量的 `upgradeRole` 升级路径对 `ui_ux_designer`/`design_director` 同样可用。
- **端到端（验收测试，假 Agent）**：用 `design` 模板建卡 → 设计师交付（带截图）→ 设计总监通过 → 设计师提交完成申请 → 人在 Needs You 看到带缩略图和设计说明的拍板卡 → 选"通过"→ 卡片 `done` → PM 用 `create_card(source={kind:"decision", decision_id})` 开开发卡；另跑一遍"退回修改"路径：人选 `reject` → 卡片回到执行阶段 → 设计师改稿 → 设计总监重新验证 → 再次完成申请 → 通过；`design_director` 用 C-87 的下载工具实际看到了附件内容（不是只拿到一个 id）；PM 提议一个新模板草案 → 人 `approve` → 新模板立即可用于建卡；出图预算用尽 → 调用被拒 → PM 发起 `spending` Decision → 人提额 → 恢复可用。
- 改了 `packages/domain`（含测试文件）照常跑 `pnpm --filter @cardigan/domain test:types`，根目录 `pnpm test` 会先跑这一步。

## 6. 需要用户进一步拍板的点

1. 出图预算的具体额度（月度/总量上限多少美元，或多少次调用）——本计划只设计机制，不填数字。
2. 默认用哪个出图模型/网关：直接复用 `cardigan-avatar-studio` 用的网关 + `gpt-image-2`，还是新开一个独立网关账号/额度（避免和头像生成混用额度、互相影响）？
3. 密钥注入方式：本计划推荐"host 转发"（§2.6，密钥不进 Agent 进程），但实现更重；是否接受为此多做一层 host 转发，还是先接受"环境变量注入、预算仅建议性"的简化方案？
4. 无头浏览器具体选型（建议 Playwright + Chromium）、装在哪台/哪些工作机、是否所有工作机都装——本计划只给出 machine tag 机制，具体部署清单需要在 `cardigan-deploy` 里定。
5. `ui_ux_designer` 默认用哪个 Harness/模型——现状 D3 决策没有覆盖设计类角色（"designer、tester 接入移动端项目时再定"），需要用户补一句，或接受"先用现有某个 Launch Profile，上线后再换"的临时方案。
6. `design` 模板是否需要一个"交互原型代码要入仓库评审"的变体——本计划范围内决定不做（§1），如果实际用下来不够用，需要用户确认是否值得为此再拆一张卡。


**用户 2026-11-11 拍板结果**：
1. 出图预算：每个项目每月上限 **100 美元**，超限时服务端拒绝并升级给人。
2. 出图网关：沿用现有网关和 `gpt-image-2`，但为 Cardigan **单开独立账号或密钥和额度**，与头像生成分开计量；密钥由用户开通后放到主机。
3. 密钥方式：**主机代为调用**（§2.6，`generate_image` 工具，密钥不进 Agent 进程，预算由服务端强制）。
4. 无头浏览器：Playwright + Chromium，先装在主机 Agent 环境（Claude 决定，用户未反对）。
5. 默认模型：`ui_ux_designer` 用 codex（codex-astra），`design_director` 用 Claude Opus（claude-opus），产出和审核交叉。
6. “交互原型代码入仓库评审”的模板变体：第一版不做。

## 7. 已知风险

- `artifact` 模板默认产出角色从 `designer` 改成 `ui_ux_designer`（§2.3）只影响新项目/新复制的默认建议值，不影响已经手工注册过 produce 类型 `designer` 角色的老项目；但实现时要补一条回归测试覆盖"老项目仍可用旧配置建 artifact 卡"，不能假设这条路径天然不受影响。
- `Decision.draft` 的"人批准即创建"机制如果 Workbench 展示不到位，容易变成橡皮图章——用户拍板 1 想防的正是"新角色/模板等于定权限，必须人真正看清楚才能批"，§2.2 把"结构化展示工具白名单/worktree"列为强制项，审核时要重点检查这部分实现质量，不能只检查字段有没有传对。
- 若最终采用"环境变量注入"（§6 第 3 点）而非 host 转发，出图预算将是建议性而非强制性的：Agent 理论上可以绕过 `generate_image` 工具、直接拿到的密钥去调网关，从而绕开预算校验——这是两种密钥方案的结构性差异，选择时需要接受相应的后果，不是实现缺陷。
- 游戏资产大文件的缺口（§2.7）如果不解决，sensen-godot 迁移时设计流程本身可以直接套用，但真正的 game-ready 资源文件流转可能仍需要线下或其它渠道（例如 Git LFS、云存储链接），不能完全走 Cardigan 附件机制；本计划明确不在这里解决。
- 无头浏览器和出图服务都是"Agent 在 Run 过程中调用的外部工具"，截图对不对、图生成得好不好完全靠 Agent 自觉，这和 `coder` 能跑任意 shell 命令的现状是同一类风险延伸，不是本计划新增的风险类别；但这是第一次把这个模式扩展到"花钱的外部调用"，验收时要确认预算校验真的发生在服务端（`generate_image` 工具内部），不能信任 Agent 自称"没超预算"。
