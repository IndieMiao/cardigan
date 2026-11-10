# P2-V V9、V10：Workbench 定义角色和卡片模板

- 对应：`docs/plans/phase-2.md` §3.3 V9、V10；用户 2026-11-09 拍板"角色和卡片模板都在 Workbench 定义，两者一起做"，Phase 3 让 PM 在边界内经 CLI 或 MCP 改流程（开发方案 §1.4、§16）。
- 前提：V1（员工，全局）已合并；模型配置在员工上，不在角色上。
- 开发方案要改的章节：§4（Role、CardTemplate 实体，Card 的 `repo` 可选、`template_version`）、§4.4（卡片的"人标记完成"迁移）、§4.5（新不变量）、§8（Workbench 设置页）、§10（角色说明的拼接）、§13.1（CLI）、§14（角色权限边界）。

## 1. 目标

1. 管理员（暂时就是人）能在 Workbench 和 CLI 上新建、复制、修改、停用角色和卡片模板。每次修改生成新版本，可以查看历史，也可以回退。
2. 内置三个卡片模板：`dev`（现有）、`general`（通用任务）、`artifact`（产出物）。评审、调研、素材产出这类非开发任务有了正规流程，也有收尾方式。
3. 所有增删改都是 domain 命令。Phase 3 只需要把同一批命令开放给 PM，不用再重写。
4. 老数据和老用法不变。

## 2. 关键设计

### 2.1 角色（V9）

- **仍按项目存储**（沿用现有 `roles` 表和版本号）。员工是全局的，担任的是角色编号，指派时要求目标项目登记了该角色（V1b 已实现）。设置页提供"从默认角色包复制"和"从其他项目复制"。
- **角色说明和系统部分分开**：新增字段 `instructions`（管理员可改的角色说明）。启动编译时由系统拼接：`instructions` + 共用协作规则（`SHARED_BOUNDARIES`）+ §6.3 协议（`AGENT_PROTOCOL`）。管理员改不到协议部分，系统更新协议后所有角色自动跟上。老角色只有 `core_prompt`，没有 `instructions`，继续原样使用；在 Workbench 里第一次编辑时，提示"将转换为新格式"，并按默认角色包的结构拆出 `instructions`。拆不出来就整段作为 `instructions`，同时警告可能和系统部分重复。
- **可编辑字段**：显示名、类型（产出 / 验证 / 常驻）、`instructions`、能承担的工作项种类（`capabilities`）、能力标签（`abilities`）、worktree 模式、可用工具、机器标签。
- **权限边界**（domain 校验，界面只是展示）：
  - 可用工具只能从系统白名单里选，白名单按角色类型给出：产出型不能有 `submit_review`；验证型不能有 `submit_delivery`；常驻型以现有 `pm` 角色的工具集为上限。具体表在实现时整理成常量，写进开发方案 §14；
  - `record_decision` 只能给 `pm` 角色，并且仍由 `standing_mode=office` 在签发 Token 时控制（现有规则不变）；
  - 验证型角色的 worktree 只能是 `readonly` 或 `none`；
  - 不能新增推送、Git 凭据之类的能力（系统里本来就没有这类工具，校验要确保白名单之外的名字一律拒绝）。
- **版本**：每次保存生成新版本，已有 Assignment 固定指派时的 role_version，之后它的 Run 都用这个版本；只有新指派才用新版本（现有机制）。回退等于用旧版本的内容生成一个新版本。停用的角色不能再被新指派，已有 Assignment 不受影响。
- 默认角色包（`packages/roles`）仍是代码里的常量，作为"复制"的来源和新项目的初始角色。

### 2.2 卡片模板（V10）

- **按项目存储，有版本**：新表 `card_templates (project_id, template_id, version, doc)`。迁移时为每个现有项目写入三个内置模板的 v1。内置模板可以复制后修改，原内置模板本身不能改（改动要先复制成新模板编号）。
- **字段**：
  - `id`（小写字母、数字、短横线）、`title`、`description`；
  - `requires_repo`：为 false 时卡片可以没有仓库；
  - `merge`：`none` / `confirm` / `auto`。`none` 表示交付不是 Git 提交，验收通过直接完成；
  - `require_acceptance_criteria`；
  - `work_items[]`：沿用现有 `TemplateWorkItem` 结构（key、标题、产出或验证、角色、是否必需、验证哪个产出项）；
  - `primary_work_item_key`：可以为空，通用任务没有工作项时为空；
  - `completion`：`{ mode: "review", reviewer: Decider }` 或 `{ mode: "human_mark_done" }`。
- **内置模板**：

| 模板 | 仓库 | 合并 | 默认工作项 | 完成方式 |
|---|---|---|---|---|
| `dev` 开发卡 | 需要 | confirm | 开发、代码审核、PM 验收（现状） | PM 审完成申请 |
| `general` 通用任务 | 不需要 | none | 无 | 人标记完成 |
| `artifact` 产出物 | 不需要 | none | 产出（默认 designer，可改）、PM 验收 | PM 审完成申请；交付对象是文件（`artifact_sha256`）或文档（`doc_version`） |

- **模板校验**（domain）：工作项 key 唯一；验证项的目标必须是同模板里的产出项；`primary_work_item_key` 必须是产出项；`completion.mode = review` 时必须有主产出项；`merge ≠ none` 时 `requires_repo` 必须为 true；引用的角色在项目里必须已登记且未停用，产出项的角色要能承担产出、验证项的角色要能承担验证。
- **建卡**：`createCard` 增加 `template_id`（缺省 `dev`），卡片记录 `template` 和 `template_version`，按该版本生成工作项。改模板不影响已有卡片。`requires_repo=false` 时 `repo` 和 `base_branch` 可以为空。Card 的 `repo` 改为可选，所有读 `card.repo` 的地方都要处理为空的情况（worktree、合并、读取视图）。
- **人标记完成**（新命令 `markCardDone`，只有人能调用）：只对 `completion.mode = human_mark_done` 的卡片开放；必须填写一句结果，可以引用证据附件；卡片里所有必需工作项都已完成（`accepted` 或 `passed`）时才允许，没有工作项时直接允许；卡片进入 `done`、`resolution=done`，写事件和时间线。这是 §4.4"done 不由规则自动触发"的一个由人显式发起的例外，开发方案里要写明。
- **非 Git 交付**：`artifact` 模板的产出交付使用已有的 `artifact_sha256` / `doc_version` 交付类型；完成申请审核通过后走已有的 `merge_not_required` 路径进入 `done`。实现时核对这条路径对没有仓库的卡片完整可用（worktree 模式为 `none` 的角色不建 worktree）。

### 2.3 界面和 CLI

- Workbench 新增"项目设置"页，下设"角色"和"卡片模板"两栏：列表（名称、类型或用途、版本、状态）、详情（当前版本内容、历史版本、和上一版的差异）、新建、复制、编辑、停用、回退。表单按 §2.1、§2.2 的校验即时提示，提交后以服务端校验为准，错误显示中文。
- 写接口复用 C-16 的幂等键机制。
- 卡片详情显示所用模板和版本；`human_mark_done` 的卡片显示"标记完成"按钮（填写结果、可选附件）。
- CLI：`cardigan role list|show|copy|update|deactivate|activate|rollback`（保留现有 `role add/update --file`，改走同一批 domain 命令）；`cardigan template list|show|add|copy|update|deactivate|activate|rollback`（`add/update` 接受 YAML 文件）；`cardigan card create --template <id>`（`--repo` 按模板要求可省略）；`cardigan card done <C-n> --result <文字> [--file <证据>]...`。
- MCP：`create_card` 增加 `template_id` 参数；本阶段不给 Agent 开放角色和模板的增删改工具（Phase 3）。

### 2.4 权限

- 本阶段角色和模板的增删改、`markCardDone` 都只有人能调用；domain 命令的 actor 校验为 human。
- 为 Phase 3 预留：命令内部把"是否允许"写成一个独立的判断函数，以后可以按"人设定的边界"放行 PM。

## 3. 拆分（四张卡，按顺序）

| 卡片 | 内容 | 依赖 |
|---|---|---|
| V10a | 模板实体、存储迁移和内置三模板；Card `repo` 可选、`template_version`；`createCard` 按模板建卡；`markCardDone`；非 Git 交付走通；CLI `template ...`、`card create --template`、`card done`；MCP `create_card` 的 `template_id` | — |
| V9a | 角色的 domain 命令和权限边界；`instructions` 字段与启动拼接；老角色兼容；CLI `role ...` | — |
| V10b | Workbench 卡片模板管理页；卡片详情显示模板、标记完成按钮 | V10a |
| V9b | Workbench 角色管理页 | V9a |

V10a 和 V9a 可以并行（分别改 card 和 role，冲突面小）；两张 b 卡在各自 a 卡合并后开工。

## 4. 测试

- domain 契约测试：模板校验的每条规则；按模板建卡生成的工作项；`repo` 为空时的建卡和后续流程；`markCardDone` 的放行和拒绝（模板不允许、必需项未完成、非人调用）；角色权限边界的每条规则；版本递增和回退；停用后不能再被指派或用来建卡。
- 存储迁移：老库升级后每个项目都有三个内置模板，老卡片的 `template` 仍是 `dev`，老角色可读、可启动。
- 启动编译：新格式角色拼接后包含协作规则和协议，且只出现一次；老角色输出和改动前逐字一致。
- 端到端（验收测试，用假 Agent）：用 `general` 模板建卡 → 人标记完成；用 `artifact` 模板建卡 → 产出文件交付 → PM 验收 → 完成，全程不需要仓库。
- 改了 `packages/domain` 必须运行 `pnpm --filter @cardigan/domain test:types`。

## 5. 不做

- PM 或其他 Agent 修改角色、模板（Phase 3）。
- 模板市场、跨项目共享模板的同步更新（只做一次性复制）。
- 卡片父子层级（K3）。
- 在 Workbench 上建卡（Phase 3，见 `phase-2.md` §7）。

## 6. C-9 的收尾

V10a 合并后，C-9（头像评审卡）按新流程收尾：建一张 `general` 模板的卡记录头像素材的定稿，人标记完成；C-9 取消并标记为被它取代。
