# P2-V V11 成员身份与外接 Assignment

- 对应：`docs/plans/phase-2.md` §3.1 新增 V11；用户 2026-11-10 拍板（本文件件 §0）。
- 前提：P2-V V1a/V1b 员工实体已合并（员工是全局实体、Assignment 记录 `employee_id`、`authorView` 已能解析员工身份）；C-55 `cardigan pm rotate` 已能原子替换常驻 PM 并迁移未结束通知。
- 开发方案要改的章节：§4（新增 Member 实体、`Assignment.external` 字段、Author/Actor 的身份说明）、§4.5（新增不变量：恰好一个在职 owner 成员；`external` 不扩大权限）、§6.6（外接 Assignment 的投递策略）、§7.1（cardigan 项目 PM Office 的张良身份、`pm rotate` 新增参数）、§8.1/§8.2（Workbench 登录对应成员、`GET /api/me`、时间线展示）、§9.1（Token 签发给外接 Assignment、CLI Token 模式）、§10.2（外接 Assignment 不适用 Launch Profile 的启动流程）、§13.1（`cardigan member ...`、`--token-file`/`CARDIGAN_TOKEN`）、§14（安全模型新增一行：CLI 的 Token 身份模式）、§15（建议新增 D13，记录本次拍板，紧跟 D12）。**实现方不改文件顶部的版本号和变更记录**，按 AGENTS.md 由 Claude 在里程碑收尾时统一补上。

## 0. 背景（2026-11-10 拍板，必须照此实现）

现状问题：Claude（本文档的作者）在主机上用本机 CLI 操作 Cardigan 时，CLI 把它当成人类对待——`apps/cli/src/host.ts` 的 `humanActor(project_id)` 固定返回 `{ kind: "human", project_id }`，所有经本机 CLI 发起的命令（评论、指令、合并确认、拍板……）都记作 `author: "human"` / `decider: "human"`。这带来两个问题：

1. **时间线分不清是用户还是 Claude做的**：时间线、拍板记录、知会（Needs You）上，人类真实操作和 Claude 用本机 CLI 做的操作显示成同一个"人/你"，没有区分。
2. **"只有人能确认高风险"的规则被绕过**：开发方案 §14、§15 D12 规定 `spending/account/permission/data_deletion` 四类高风险 Decision 只能由 `actor.kind === "human"` 确认，Workbench 与本机 CLI 同等有效。但本机 CLI 不区分"坐在键盘前的用户"和"用本机 CLI 操作的 Claude"，两者都满足 `actor.kind === "human"`，于是 Claude 事实上可以用本机 CLI 确认本应只有用户才能确认的事项——这正是 D12 想要防住的事，却被 CLI 的身份模型留了口子。

用户拍板见 §0.1–§0.5；本计划把这两个问题拆成两条独立但配合的设计：**给真人一个看得见的身份**（成员，§2.1）和**给 Claude 一个不是人类的身份**（外接 Assignment + Token，§2.2）。两者都做到，才能同时解决"分不清"和"被绕过"。

### 0.1 用户的身份

用户在 Cardigan 里要有自己的身份：名字"邵杰"，职位"所有者"。新增"成员（Member）"实体表示人：`id`（例如 `M-1`）、名字、职位、头像（复用员工头像引用规则 `library:/upload:`）、角色（所有者 `owner`，以后可加审批人 `approver`、观察者 `observer`）、状态。Workbench 登录对应到成员（现在只有一个密码，先让唯一的登录对应到所有者成员，多人登录留到以后，本计划写清楚）；本机 CLI 默认身份是所有者成员。时间线、拍板记录、知会里显示成员名字和头像，不再显示"人/你"。老数据 `author=human` 的按所有者显示。D12 和高风险确认的"人"指成员。

### 0.2 Claude 的身份

Claude 的身份：员工"张良"（头像 `library:zhang-liang`，正在生成），担任**cardigan 项目的 PM Office**，外加"平台负责人"职责（管理 Cardigan 开发；监控 Cardigan 运行以迭代功能：写计划、部署、主机运维（直到 P2a-10 运维角色上线）、监视、阶段提炼）。它不是 Cardigan 启动的 Agent，而是用户自己的 Claude Code 会话，所以要支持"外接的 Assignment"：Cardigan 为它签发 Token，它在主机上用 CLI 和 MCP 以该 Assignment 身份操作（CLI 需要一个用 Token 而不是默认人身份的方式，例如环境变量 `CARDIGAN_TOKEN` 或 `--token-file`，Token 不进仓库、不打印到日志）；Dispatcher 不为外接 Assignment 启动终端，门铃投递改为写入它能读取的收件箱（CLI `cardigan inbox` 已有）。平台负责人职责里需要的主机操作在本计划里只列清单（见 §4），权限仍按现状（它本来就在主机账号上），不扩大 Agent 账号权限。

### 0.3 其他项目

其他项目（例如以后迁过来的另一个游戏项目（Godot 大仓库））各有自己的 PM Office，用户直接和它们沟通；张良只是 cardigan 项目的 PM Office，不是跨项目总助。

### 0.4 A-36 停用

现在 cardigan 项目的 PM Office Agent（A-36）在张良接任后停用；PM Ops（A-156）保留，不受本计划影响。

### 0.5 Claude 不能代人确认高风险

V11 之后，Claude（无论用 CLI 还是 MCP，以张良的外接 Assignment 身份）不能再以成员身份确认高风险事项——因为它的 Actor 是 `assignment`，不是 `human`，§4.5 第 15/22 条和 §9.3 的既有校验已经按这条拒绝，本计划只需要保证"外接"这个新标记不会意外放宽这些检查（见 §3.2 末尾、§4 不变量）。

## 1. 目标

1. 新增全局的"成员（Member）"实体，表示真实的人；现在只有一个在职的 `owner` 成员"邵杰"。Workbench 登录、本机 CLI 默认身份，以及老数据里的 `author=human`，统一解析并显示为这个成员的名字和头像。
2. 给 Claude 一个不是 `human` 的身份：员工"张良"持有 cardigan 项目一个新的"外接"常驻 PM Office Assignment，Cardigan 为它签发 Token；本机 CLI 支持用这个 Token 而不是默认人类身份来操作；Dispatcher 不为这个 Assignment 启动终端，门铃落进它的收件箱，由它自己用 `cardigan inbox` 和 MCP 轮询处理。
3. 停用旧的 A-36 Assignment，cardigan 项目的 PM Office 换成张良的外接 Assignment；PM Ops（A-156）不变。
4. 不扩大任何权限边界：外接 Assignment 仍然只能做它的 Token `allowed_tools` 范围内的事；高风险确认、人专属的 domain 命令（成员/员工/角色管理、`markCardDone`……）继续只认 `actor.kind === "human"`，张良拿不到。

## 2. 关键设计

### 2.1 成员实体与身份解析

- `Member`：全局实体，不含 `project_id`，结构参照 Employee 的全局表模式（§4.3 Employee 的"全局表 + 全局事件流"做法）：
  - `id`：`M-n`，全局递增、不复用。
  - `name`、`title`：显示名、职位，复用 `employeeTextError` 同一套校验（长度上限、禁控制字符），不新增一套规则。
  - `avatar`：可空的头像引用字符串，复用员工头像引用规则 `library:<人物 id>` / `upload:<sha256>`，解析和展示方式与 Employee 完全一致（同一套 `EmployeeIdentity` 组件、同一个上传接口）。
  - `role`：`owner` | `approver` | `observer`。V11 只实现 `owner`：创建 `approver`/`observer` 返回 `validation_failed`、中文提示"暂不支持，等以后版本"，仅保留枚举值，不写对应的业务逻辑（审批人、观察者的权限差异完全留到以后，不在本计划内猜测设计）。
  - `status`：`active` | `inactive`。
  - `created_at`、`updated_at`。
- **不变量：任意时刻恰好有一个 `status=active` 且 `role=owner` 的成员**。创建第二个 active owner 拒绝；停用最后一个 active owner 拒绝（必须先激活/新建另一个 owner，再停用旧的——这条路径 V11 不提供也不需要，只保证"不能把 owner 清空"这条红线，多人/多 owner 场景留到以后）。
- 成员的创建、改名、停用、恢复只接受 `actor.kind === "human"`（和 Employee 命令一样），不开放 MCP 工具，不给 PM 或任何 Agent。
- **不改 `Actor` / `Author` 类型**。`Actor.kind` 仍然只有 `"assignment" | "human" | "system"`；`Author` 仍然是 `"human" | "system" | assignment:<id>`。这是本计划刻意做的收窄：成员概念只影响**读取和展示**，不影响命令层的身份模型、不触碰 §4.5 现有的任一不变量，老测试、老事件、老不变量全部不变。
  - 原因：现在只有一个 owner 成员，"human 操作者是谁"在读取时就能唯一确定（就是那个 active owner），不需要在写入时就把 member_id 刻进事件。多成员/多人登录是 Phase 2 之后的事，到那时才需要把 `Actor` 的 human 分支也带上 `member_id`，本计划不做这一步，但下面的存储设计（session 表预留 `member_id` 列）让那一步不用再改一次表结构。
- `authorView`（`packages/domain/src/author-view.ts`）和同一套逻辑覆盖的所有"人类作者"展示位置（Decision 的 `decider/resolution.resolved_by`、HumanAction 的 `requested_by`、Attachment 的 `uploaded_by`、CLI/Workbench 里任何写死"你"/"人"的地方）全部改成：遇到 `"human"` 时查当前 active owner 成员，返回其 `name`/`avatar`/`title`；查不到（理论上不会发生，见下面的迁移设计）时才回退显示"所有者"这个固定文案，不再显示"你"或"人"。`AuthorState` 新增 `members` 字段，和现有的 `employees` 字段并列传入，不改函数签名以外的调用方式。
- Workbench 登录：
  - 现在的单密码机制不变（`cardigan web set-password`），但登录后的会话对应到"当前 active owner 成员"。`GET /api/me` 的响应增加 `member: { id, name, title, avatar }`。
  - 会话表 `sessions` 增加可空列 `member_id`：登录时写入当前 active owner 的 id；旧会话行在下次校验时按"最新一张 session 推断一次并写回"的既有模式（参照角色/常驻模式的 backfill 做法）补上，不做一次性批量迁移。这一步纯粹是为将来多人登录做准备，V11 的实际行为永远是"唯一的 owner"。
- 本机 CLI：默认（没有 Token，见 §2.2）身份仍是 `humanActor(project_id)`，不改 `Actor`；展示解析上等同"当前 active owner"。换句话说，**真人用 Workbench 或本机 CLI 操作，和 Claude 用本机 CLI 操作（在引入 §2.2 之前）曾经是分不清的两件事，现在靠 §2.2 分开——§2.1 本身只解决"怎么显示"，不解决"谁能做"**。

### 2.2 外接 Assignment 与 Token（张良）

- 新增员工"张良"，用已有的 `cardigan employee add` 创建：`name=张良`、`title=平台负责人`、`role_id=pm`、`avatar=library:zhang-liang`（头像素材正在生成，上线时若素材还没就位，先留空，不阻塞其余步骤，见 §5）。
- `Assignment` 新增可选字段 `external?: boolean`，创建后不可修改（和 `employee_id`、`standing_mode` 一样固定）。V11 只允许它出现在 `scope="standing"` 且 `standing_mode="office"` 的 Assignment 上；`scope="work_item"` 或 `standing_mode="ops"` 时拒绝设置 `external=true`（张良只担任 cardigan 项目的 PM Office，不是常驻 Ops，也不承接具体工作项）。
- **创建路径：扩展 `cardigan pm rotate`（C-55），不新开一条命令**。`pm rotate` 已经实现"原子替换常驻 PM、迁移未结束通知、作废旧 Token、要求新角色版本能接住在办事项"的完整事务；给它加两个参数：
  - `--external`：新 Assignment 写 `external=true`。
  - `--employee <E-n 或名字>`：新 Assignment 写 `employee_id`（校验规则与 `assign --employee` 一致：必须在职、`role_id` 与 pm 角色一致）。
  - 不加这两个参数时行为和现在完全一样（纯换版本，`employee_id` 继续沿用旧 Assignment 的，`external` 不写）。
  - 把 A-36（cardigan 项目现有的 PM Office Assignment）换成张良的外接 Assignment，就是一次 `cardigan pm rotate --office --external --employee <张良的 E-n>`：旧 Assignment（A-36）released，`decider=role:pm` 的拍板、`triage=pm_ops` 的待你执行按现有规则转给新 Assignment，Token 作废，新 Assignment 拿到新 Token（打印一次）。
- **Dispatcher 不为外接 Assignment 启动终端**：
  - `apps/server/src/host-start.ts` / `apps/server/src/dispatch.ts` 里任何会调用 `launchRun`/派发 Run 并尝试起一个 Herdr 会话的路径，在决定是否自动启动前先查 Assignment 的 `external`；为真时，和现有"常驻 PM 已暂停"（§6.6）一样，门铃对应的通知停在 `pending`（或按现有通知状态机走到它能走到的最后一步），不调用 `launchRun`，不创建或替换 Session。区别是：暂停是临时状态、以后会恢复；`external` 是永久性质，不进入"暂停"展示文案，要单独的展示（"外接身份，由对接的 Agent 自行拉取"一类说明），避免 Needs You/执行视图把它误标成"已暂停"。
  - `cardigan assignment start <A-n>`、`cardigan pm create --office`（给已存在的 PM Office 场景不适用，仅防御性校验）对 `external=true` 的 Assignment 直接拒绝，中文提示"这是外接 Assignment，没有可以启动的终端，用 `cardigan inbox` 查看待处理通知"。
  - 这条规则只影响"要不要起终端"，**不改变**通知路由规则本身（§6.4 的路由表不变，张良照样会被 `@提及`、拍板解决等事件路由到）；也不改变门铃/ACK 的既有协议（§6.1），只是没有一个"活的会话"去接这个门铃，通知就留在收件箱，由张良（Claude）自己按自己的节奏拉取。
- **CLI 的 Token 身份模式**：
  - 新增环境变量 `CARDIGAN_TOKEN`（直接给出 Token 明文）和全局选项 `--token-file <path>`（给出一个只含 Token 的文件路径，权限必须 0600，否则拒绝读取，和 `secrets.env` 的既有校验方式一致）。两者同时给出时拒绝（避免歧义），只给一种。
  - `apps/cli/src/host.ts` 新增 `resolveActor(io, project_id, store)`：
    - 没有 `CARDIGAN_TOKEN`/`--token-file` 时，返回现有的 `humanActor(project_id)`，**行为完全不变**（真人、以及任何还没配置 Token 的脚本）。
    - 给了 Token 时，直接复用 `packages/mcp-server/src/auth.ts` 的 `authenticate(backend, token)`——CLI 本来就直接打开同一个 SQLite 文件，不用像 MCP 那样走 HTTP，`authenticate` 本身只依赖一个实现了 `McpBackend` 的对象（`verifyToken` + 只读事务），CLI 已有的 `Store` 可以适配出这个接口，不用另写一套校验逻辑。认证失败（Token 不存在、已撤销、Assignment 非 active）时 CLI 用和 MCP 一致的中文含义报错并以非零退出码退出，不回退成人类身份（避免"Token 错了就悄悄当人类操作"这种更危险的默认值）。
    - 返回的 `assignment` Actor 自带 `allowed_tools`；CLI 命令到 MCP `toolNames` 的映射（例如 `cardigan card update` → `update_card`，`cardigan comment add` → `post_comment`，`cardigan merge recheck` → 没有对应 MCP 工具的归为"仅人类操作"一类，Token 模式下直接拒绝）要在这张卡里列成一张完整表格，逐个核对，不能抽样——遗漏一个仍然调用旧 `humanActor` 的命令，就会让它在 Token 模式下静默地把 Claude 的操作记成人类操作，正是本计划要堵住的洞。domain 命令本身（例如员工/角色/成员管理、`markCardDone`）已经要求 `actor.kind === "human"`，Token 模式下 `assignment` Actor 自然被拒绝，这部分不需要 CLI 额外过滤，只需要确认没有 CLI 命令绕过 domain 校验直接操作 store。
  - `apps/cli/src/index.ts` 里所有现在直接调用 `humanActor(project_id)` 的命令文件（`role.ts`、`merge.ts`、`employee.ts`、`template.ts`、`pm-rotate.ts`、`workflow.ts`、`content.ts`、`assignment.ts`、`worktree.ts`、`preference.ts`）改为调用 `resolveActor`。
  - `cardigan inbox`：Token 模式下自动把 `--assignment` 固定成 Token 所属的 Assignment（忽略或拒绝显式传入不同的 `--assignment`），不需要主机操作者权限就能看到"该发给我的还有什么"；没有 Token 时保留现在"列出该项目所有接收者"的主机操作员视图，不收窄现有用法。
- **不扩大权限**：`external` 只是"要不要起终端"的调度标记，不出现在任何权限判断里。新增契约测试：`external=true` 的 Assignment 的 Token，`allowed_tools` 和同样配置（standing office）但 `external=false` 的 Assignment 完全一致；对四类高风险 Decision 调 `resolve_delegated_decision`/`record_decision` 一律被拒（现有校验已覆盖 `actor.kind !== "human"`，这里只是针对"外接"这个新标记补一条明确的回归测试，防止以后有人顺手把 `external` 和权限挂钩）。

## 3. 拆分

| 卡片 | 内容 | 依赖 |
|---|---|---|
| V11a | §2.1：Member 实体（domain 全局表、命令、校验、"恰好一个在职 owner"不变量）、store 迁移、CLI `member add/list/update/deactivate/activate`；`authorView` 等读取层改为解析成员；Workbench 登录对应成员、`GET /api/me` 返回成员信息、`sessions` 表加 `member_id`（backfill-on-read） | 无 |
| V11b | §2.2 前半：Employee 张良（走现有 `employee add`，不是新功能）；`Assignment.external` 字段及其校验边界；扩展 `cardigan pm rotate --external --employee`；Dispatcher（`host-start.ts`/`dispatch.ts`）对 `external=true` 跳过起终端，改走收件箱路径；`cardigan assignment start`/`pm create` 对外接 Assignment 的拒绝提示 | 无（可与 V11a 并行） |
| V11c | §2.2 后半：CLI Token 身份模式（`CARDIGAN_TOKEN`/`--token-file`、`resolveActor`、`authenticate` 适配、CLI 命令 → tool 名映射表、逐个命令文件改造）；`cardigan inbox` 的 Token 身份模式 | V11b 合并后开工（需要外接 Assignment 和它的 Token 才能测） |

每张卡控制在几百行以内；V11c 改的文件数量多但多为"把 `humanActor(project_id)` 换成 `resolveActor(io, project_id, store)`"的机械替换，超出预期时可以把"CLI 命令 → tool 名映射表"和真正的校验逻辑放前半张卡，机械替换放后半张卡分两个 PR。

## 4. 测试

- **成员**：创建、改名、停用、恢复；第二个 active owner 被拒；停用最后一个 active owner 被拒；创建 `approver`/`observer` 被拒并给出"暂不支持"的中文说明；字段校验复用 `employeeTextError` 的既有测试用例，不重复定义一套新规则再分别测。
- **展示解析**：`authorView` 对 `author="human"` 的老数据和新数据都解析为当前 active owner 的名字/头像；Decision、HumanAction、Attachment 的人类身份展示同样改为成员名字；没有任何界面文案出现"你"/裸的"人"字样（这条适合在 Workbench 的 UI 文案测试里加一条快照/正则校验，防止回归）。
- **Workbench 登录**：`GET /api/me` 返回成员信息；`sessions.member_id` 的 backfill-on-read；没有改密码/登录行为。
- **外接 Assignment**：
  - `Assignment.external` 只能出现在 `scope=standing, standing_mode=office`；其他组合拒绝。
  - `pm rotate --external --employee` 的原子替换：通知迁移、Token 作废、`hasActivePmOps` 全程为真（office 模式本身不参与这条判断，但要确认没有破坏 ops 侧的同一套校验）、新旧 Assignment 的 `decider=role:pm`/`triage=pm_ops` 事项正确转移；不加这两个参数时行为和现有 `pm rotate` 测试完全一致（回归）。
  - Dispatcher：`external=true` 的 Assignment 收到需要投递的通知时，不调用 `launchRun`，不创建/替换 Session，通知停在既有通知状态机能到达的状态；`cardigan assignment start`/`pm create` 对它直接拒绝并给出中文提示。
  - 权限边界：`external=true` 和 `external=false` 的同配置 Assignment 的 Token `allowed_tools` 一致；对四类高风险 Decision 的代拍/`record_decision` 一律拒绝（回归测试，覆盖"外接"标记不会被将来的改动悄悄接到权限判断上）。
- **CLI Token 模式**：
  - 无 Token 时所有命令行为不变（回归，跑一遍现有 CLI 测试确认没有行为变化）。
  - 有效 Token：`resolveActor` 返回的 `assignment` Actor 与 MCP `authenticate` 对同一 Token 返回的结果一致（同一份 Assignment、同一个 `allowed_tools`）。
  - 无效/撤销/非 active Assignment 的 Token：CLI 以非零退出码报错，不回退成人类身份。
  - 列出的"CLI 命令 → tool 名"映射表里每一条都要有一条测试：该命令在 Token 的 `allowed_tools` 不含对应工具时被拒绝；人类专属命令（成员/员工/角色管理、`markCardDone`、高风险 Decision 确认）在 Token 模式下一律被拒绝，不管 Token 的 `allowed_tools` 里有什么。
  - `cardigan inbox` 在 Token 模式下自动限定到该 Assignment，忽略/拒绝不同的 `--assignment`；无 Token 时行为不变。
- 实现方只跑改动所在包的测试和 `pnpm lint`、`pnpm check:deps`；改了 `packages/domain` 时额外跑 `pnpm --filter @cardigan/domain test:types`；涉及 `apps/web` 时跑 `apps/web` 全部测试。全量和 e2e 由主机侧合并闸门负责（P2a-1 已上线）。

## 5. 上线（Claude 负责）

1. V11a 合并后，确认迁移自动创建的占位 owner 成员存在，用 `cardigan member update <该成员编号> --name 邵杰 --title 所有者` 改成真实姓名（迁移本身不写死"邵杰"这个具体姓名，只保证"恰好一个 active owner"这条不变量成立，具体姓名由上线步骤填）。
2. 创建员工"张良"：`cardigan employee add --name 张良 --title 平台负责人 --role pm`；头像素材 `library:zhang-liang` 生成完成后用 `cardigan employee update` 补上，不阻塞下一步。
3. V11b、V11c 都合并后，执行 `cardigan pm rotate --office --external --employee <张良的 E-n>`，把 cardigan 项目的 PM Office 由 A-36 换成外接 Assignment；记录新 Assignment 编号；Token 只打印这一次，立刻保存到 Claude 自己本机的安全位置（不进仓库、不进聊天记录、不进这份计划文档），配置好 `CARDIGAN_TOKEN` 或 `--token-file` 供日常 CLI 使用，同时在本次 Claude Code 会话里把 Cardigan 的 MCP server（Streamable HTTP + 该 Token）配置为一个可用的 MCP 工具源。
4. 确认旧 A-36 的进程/会话已经没有未结束 Run，再停用（released）；如果它当时正持有未完成的 Run，先等它结束或走现有的交接流程，不要在它还在工作时中途换人。
5. 更新自举常驻 PM 的巡检脚本（memory "自举项目的常驻 PM" 提到的 `watch.sh`）里判断"人类新评论"的逻辑：原来如果靠"评论来自本机 CLI"这类启发式判断是不是人类，现在张良的评论 `author` 已经是 `assignment:<张良的 Assignment>` 而不是 `human`，大概率天然修复；实际改之前先确认脚本到底依据什么字段判断，照实际情况调整，不要假设。
6. 走查验证：在时间线/Needs You 上确认张良的操作显示"张良 平台负责人"而不是"你"；人为构造一个高风险 Decision，确认用张良的 Token（CLI 或 MCP）尝试确认会被拒绝，只有用真人的 Workbench 或不带 Token 的本机 CLI 才能确认。
7. 每一步验证后更新 memory 和（如果有）`HANDOFF` 里的流程说明。

## 6. 不做

- 多人登录、Workbench 账号体系、成员权限矩阵；`approver`/`observer` 角色只占枚举值，不实现任何行为差异。
- 成员/团队管理的 Workbench 界面，本计划只给 CLI。
- 跨项目的"张良"或类似总助角色；其他项目各自的 PM Office 不受本计划影响，用户继续直接和它们沟通。
- 平台负责人职责（部署、主机运维、监视、阶段提炼）的自动化或新增工具权限——本计划只在 §0.2 列职责清单，不新增 Cardigan 角色/工具白名单项；这些操作继续靠 Claude 本来就有的主机账号权限完成，和 P2a-10 的 `ops` 角色（服务于被开发项目、权限边界更窄）是两件不同的事，不要混在一起设计。
- `cardigan inbox` 之外的新交互方式；Workbench 的 Web 聊天仍留 Phase 3（开发方案 §8.1 已有结论，不在本计划改动）。
- 失联/断线接管语义（§6.6、§13.9 现有的"失联 → 宽限期 → lost → Needs You"一套）不扩展到外接 Assignment：它本来就没有 Cardigan 管理的运行时可以被判定为失联，这条留给张良自己的使用习惯，不在本计划里造一套新的监控。

## 7. 已知风险

- 迁移自动创建的占位 owner 成员如果命名含糊，在 Claude 执行 §5 第 1 步改名之前，时间线会短暂显示占位名字；上线窗口要把改名和换 PM Office 一次性做完，不要分开太久。
- V11c 改动的 CLI 命令文件多达 9 个以上，遗漏一个仍调用 `humanActor` 的命令会让该命令在 Token 模式下把张良的操作悄悄记成人类操作——这正是本计划要堵的洞，审核时必须逐个核对 §2.2 的"CLI 命令 → tool 名"映射表，不能抽样。
- Dispatcher 跳过起终端如果直接复用"已暂停"的既有状态和文案，可能让 Needs You/执行视图把外接 Assignment 显示成"已暂停"，和真正暂停的常驻 PM 混淆；需要单独的展示文案，实现时留意。
- 张良的 Claude Code 会话不是 Dispatcher 启动的，不受 Cardigan 的运行时监控；它失联或断线没有现成的"失联接管"语义（§6 已声明不做），短期内靠 Claude 自己的使用习惯保证不漏门铃，不是系统保障。
- 旧 A-36 如果在换人时仍持有未完成的 Run，强行停用可能和合并闸门排队等机制产生时序交互；上线步骤已要求先确认收尾（§5 第 4 步），但实现时如果发现这条路径没有现成的"安全停用常驻 PM"检查，需要补一条，不要假设 `pm rotate` 的现有校验已经完全覆盖。
- 头像素材"张良"在写计划时仍在生成，E-n 创建时可能暂时没有 `avatar`；不阻塞上线，但要记得后续补上，否则团队页（V6，留到以后）会少一张脸。
