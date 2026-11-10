# Phase 2 计划：自举、虚拟员工、多机

- 版本：v1 草案（2026-11-09），待用户确认后开工
- 对应：开发方案 §13.2 多机拓扑、§15 D5/D11/D12、§16 Phase 2；`docs/research/pm-practice-distillation.md` §4（缺口 C1–C7）；用 Cardigan 开发 Cardigan 的试行记录（研究资料目录 `dogfood/trial-1.md`，发现 1–13）
- 前提：Phase 1（M1–M5）和 Phase 1.5（Workbench UI/UX）已完成，开发方案 v0.10.0；试行卡 C-2～C-6 已合并（next_owners、`card update`、SQLite 警告、`cardigan` 安装脚本、合并"退回修改"）。

## 0. 已经拍板的事项（2026-11-09 用户确认）

| 事项 | 决定 |
|---|---|
| 顺序 | P2a 自举做顺 → **P2-V 虚拟员工 + 看板强化** → P2b 多机 → P2c 拍板和授权 → P2d PM 能力。虚拟员工是面向普通用户、一人公司、小团队的核心卖点，也是上线后推广的重点，所以排在多机前面 |
| 主机 | GS66 |
| 合并 | 合并前自动构建和全量测试，作为合并的前置条件，结果显示在合并确认卡片上；合并后自动推 GitHub（仓库级 deploy key）。在本机跑，不需要额外资源 |
| 已完成的卡片 | 不能取消。有问题或要修改就建新卡（例如回滚卡） |
| 任务计划 | `docs/plans/` 由 Claude 写；Agent 不新建任务计划，设计改动只更新开发方案正文 |
| 卡片父子层级 | 进 Phase 2 |
| 合并拍板 | 已有"合并 / 暂缓 / 退回修改"（C-6） |
| 虚拟员工 | 员工有名字、头像、职位，能单独配模型（Agent CLI + 网关 + 模型，例如 DeepSeek、Kimi、Opus、GPT）；Workbench 里管理网关和接入点 |
| 头像 | 不用现成头像库。独立工具 `cardigan-avatar-studio` 用 sensenjoy 网关的 gpt-image-2 生成四大名著人物的全身图和头像，扁平 Q 版风格；只用文字风格规范，不把外部图片作为输入 |
| 费用和预算 | Phase 2 不做，用户在网关后台监控；额度监控放到 Phase 3 |
| 外部访问 Workbench | 开放，必须 HTTPS，由 Claude 实施和配置：Workbench 仍只监听回环地址，经 Tailscale Serve（`https://gs66-ubuntu.taildf0ff5.ts.net:8443`，只有 tailnet 内设备能访问）转发；Workbench 接受显式配置的外部来源（卡片 C-8） |
| S22 | 进 Phase 2：允许 PM 在工作项开工前设置"拍板之前不许开工"（见 P2c） |
| 头像人物 | 宗教神佛人物不做；第一期四大名著共 59 人 |
| 角色和卡片模板 | 管理员（暂时就是用户）在 Workbench 上定义角色和卡片模板，两者一起做（2026-11-09）。非开发类任务（评审、调研、素材产出等）也要能在 Cardigan 里追踪 |
| 产品形态 | 人只提需求，只做少量审核和拍板。Phase 3 让 PM 等角色按任务实际情况创建、修改卡片流程，不再全部由人定义（开发方案 §1.4） |

## 1. 工作方式

- **用 Cardigan 开发 Cardigan**：范围清楚、改动集中的任务（大多数 P2a、部分 P2-V）建成 `cardigan` 项目的卡片，由 Agent 开发、审核、验收；Claude 派验证方、在主机侧跑全量检查、确认合并、推 GitHub。P2a-1 做完后改由系统自动检查和推送。
- **Codex、Pi 走原流程**：跨包、需要设计取舍或要改运行时的大任务（员工实体、多机运行时、Git 远程化等），按 AGENTS.md 开 PR，Claude 审核合并。
- 两条路径同时用时，**同一时间只有一条往 main 合并**，避免中心仓库和 GitHub 分叉；P2a-1 之后由系统按顺序处理。
- 每张卡或每个 PR 都写清要跑的测试范围；涉及 Web 的必须跑 `apps/web` 全部测试（全站样式约束）。

## 2. P2a 自举做顺（约 1 周）

| 任务 | 内容 | 负责 | 验收要点 |
|---|---|---|---|
| P2a-1 合并闸门（细化计划：[p2a-1-merge-gate.md](p2a-1-merge-gate.md)） | 卡片进入待合并后、真正合并前，主机在隔离账号的干净 worktree 里对"合并结果"跑构建、全量测试、lint、依赖检查和 e2e；全部通过才合并，失败则卡片停在待合并并显示失败摘要。多张卡排队依次检查。合并成功后自动推 GitHub（仓库级 deploy key，私钥放数据目录 0600，只快进、不 force；被拒就停下并进 Needs You）。Needs You 的合并卡片显示检查状态（排队、运行中、通过、失败和日志链接） | Codex | 合并结果与测过的代码树一致才推送；检查失败不推进 main；检查进程不继承正式 herdr 会话的环境变量；密钥不出现在日志和界面 |
| P2a-2 测试残留 | 修复负载高时清理后又被迟到的 hc 调用拉起 holder 和 core 的竞态（试行发现 D2） | Pi | 连续跑 5 次全量测试加 e2e，没有残留进程 |
| P2a-3 验证方的构建环境 | 验证方（reviewer、tester、PM 验收）除只读 worktree 外，再得到一个可写的临时构建目录（交付 SHA 的检出，依赖走共享缓存），用完即删，能跑构建和测试 | Cardigan | 验证方能在交付版本上跑 `pnpm build`、`check:deps` 和指定测试；不能改动交付分支 |
| P2a-4 Agent 规则 | Cardigan 注入的项目规则写明：不新建 `docs/plans/` 任务计划；按卡片写明的范围跑测试；修复 Run 先合入最新 main 再交付 | Cardigan | 规则出现在三个 Harness 的启动配置里，有测试覆盖 |
| P2a-5 卡片规则 | 开发方案 §4.4：`done` 不能再转 `cancelled`；`resolution=superseded` 的卡片在看板和列表上淡化显示 | Cardigan | domain 契约测试覆盖；CLI `card update` 对已完成卡片给出中文错误 |
| P2a-7 HTTPS 外部访问 | Workbench 支持配置的外部 HTTPS 来源（C-8，已在做）；Claude 配置 Tailscale Serve 和 server 启动环境 | Cardigan + Claude | 只监听回环地址；未配置时行为不变；经 HTTPS 访问的 cookie 带 Secure；从 MacBook 用 https 地址能登录和操作 |
| P2a-6 审核者不是作者（C7） | 核实 `assign` 是否允许同一个 Assignment（或同一员工）既做产出项又做验证它的工作项；允许就补一条不变量 | Cardigan | 契约测试覆盖；开发方案 §4.5 补不变量 |
| P2a-8 CLI 评论和附件（试行发现 14） | 人在命令行给卡片发评论（`cardigan comment add <C-n> --text <内容>`）和上传附件（`cardigan attachment add <C-n> --file <路径> [--kind evidence] [--note <说明>]`），复用 Workbench 的同一段处理代码，身份是人 | Cardigan | 不登录 Workbench 也能完成；附件类型校验、大小上限与 Workbench 一致；artifact 仍必须挂拍板 |
| P2a-9 全机同时运行的 Run 上限（试行发现 35，细化见下方 §2.1） | 主机按机器配置全机同时处于 `dispatched`／`acked`／`running` 态的 Run 数上限，默认 4；超过时新 Run 留在 `queued`、不按铃，按创建时间跨项目排队；常驻 PM 的 Run 不受限但计入计数 | Codex 或 Pi | 契约测试覆盖排队顺序、PM 豁免、改配置后下一次调度生效；执行视图／看板／CLI 能看到排队位次；验证时不得人为制造 CPU 负载 |
| P2a-10 主机运维角色（试行发现 35/40/41，细化计划：[p2a-10-host-ops-role.md](p2a-10-host-ops-role.md)） | 先补确定性自动化（部署后刷新常驻会话工具清单）；再引入运维角色 `host_ops`（员工"大乔"，职位"主机运维"），处理 Run 卡在 dispatched、失控进程、偶发合并检查失败、attention 积压；不派活、不审核合并、不建卡、不定口径，高风险报人 | Cardigan（分三张卡） | 契约测试覆盖 host_ops 角色权限边界的六条不变量；`cardigan` 项目开出 host_ops Assignment 并观察一周，发现 35/40/41 不再需要 Claude 手动处理 |

### 2.1 全机同时运行的 Run 上限（P2a-9 细化）

- **背景**：试行发现 35（2026-11-10）——系统没有全局并发上限，PM Ops 和 Claude 各自派活，加上一次验收里要求的人为加负载，同一时间有 6 个 Run 在跑测试，主机（12 线程笔记本 GS66）负载 39、CPU 95°C 热降频，Workbench 变慢。
- **配置**：`CARDIGAN_CONFIG_DIR`（默认 `~/.config/cardigan`，见 §13.1）下新增一份配置文件，按机器（Machine，§4.3，现在只有 `local` 一台）设上限，省略时默认 4；不进被开发项目的仓库；和 `merge-gate.yaml` 一样不做热加载，改配置后重启 server 生效。
- **计数口径**：不新增 Run 状态，复用现有 `queued`（§4.4）。占用名额的是 Assignment 所在机器上处于 `dispatched`／`acked`／`running` 的 Run；达到上限后 Dispatcher 对新的待投递通知保持 `queued`、不调用 `dispatchRun`、不按铃，按 Run 对应触发事件的创建时间先后排队，跨项目一起排，不是哪个项目先到就一直占着。
- **豁免**：常驻 PM（PM Office、PM Ops，`scope=standing`）的 Run 不受上限限制、不会被这条规则挡在 `queued`——它们负责派活和处理拍板，被排队会饿死整条流水线；但它们占用的名额仍计入当前运行数，其他 Run 的排队判断要把它们算进去，不能当作不存在。
- **和合并闸门的关系**：P2a-1 §2.5 的合并检查已经全机串行、吃 CPU 多；**建议**检查运行时计为占用 2 个名额，具体数值实现时按实测调整，不是硬性约定。
- **domain 边界**：domain 不读配置；上限的值由主机在加载命令状态或调度（Dispatcher.tick）时作为参数传入，domain 只判断"给定上限和当前占用，这个 Assignment 能不能派发"，不新增状态机分支。
- **界面和 CLI**：指派（`assign`）不受影响，只是指派后的 Run 可能排队；Workbench 执行视图和看板卡片在 Run 排队时显示"排队中（前面还有 N 个）"；`cardigan attention` 或现有状态命令能看到排队情况。
- **测试**：契约测试覆盖排队顺序（跨项目按创建时间）、PM 豁免、上限改变后下一次调度判断立即生效。
- **Agent 规则补充**：P2a-4 注入的项目规则补一句——验证时不得人为制造 CPU 负载（空转、压测）；偶发失败只重复运行，次数不超过 20。

## 3. P2-V 虚拟员工和看板强化（约 2–3 周）

**目标**：让用户看到的是"一支有名有姓的团队"，而不是 coder、reviewer 这些能力名。角色（Role）降为内部概念，员工是用户面对的对象。

### 3.1 员工模型（开发方案 §4 新增 Employee）

- `Employee`：`id`、`name`（例如"诸葛亮"）、`title`（职位，例如"产品经理"）、`bio`、`avatar`（头像素材引用）、`role_id`（担任的角色）、`launch_profile_ref`（这个员工用的 Agent CLI + 网关 + 模型）、`status`（在职、停用）。
- 一个角色可以有多个员工，各用各的模型。指派时可以指定员工；只指定角色时，从该角色的在职员工里选一个空闲的。
- Assignment 记录 `employee_id`；时间线、交付、审核、评论、附件的作者显示员工。已有数据没有员工的，按角色显示为"未命名的 coder"一类。
- 不变量：同一张卡上，验证某个产出项的员工不能是这个产出项的员工（承接 P2a-6）。

| 任务 | 内容 | 负责 |
|---|---|---|
| V1 员工实体（细化计划：[p2v-1-employee.md](p2v-1-employee.md)） | domain 实体、状态、指派规则和不变量；store 迁移；MCP `whoami` 返回员工名和职位；CLI `employee add / list / update` | Cardigan（V1a、V1b 两张卡） |
| V2 接入点和模型 | Workbench 管理网关（地址、协议：Anthropic Messages / OpenAI Responses / OpenAI 兼容、密钥）和启动配置；密钥只存主机，界面不显示原文；为员工选"Agent CLI + 网关 + 模型"时检查组合是否兼容，并用该配置实际调一次 `whoami` 验证。`launch.yaml` 继续可用，界面上的改动写回同一份配置 | Codex |
| V3 Agent 侧身份 | 启动时把员工名、职位注入提示词；评论和交付摘要用这个身份；`@员工名` 路由到该员工当前的 Assignment | Cardigan |
| V4 头像素材 | 从 `cardigan-avatar-studio` 的导出包导入第一期人物（全身图、多尺寸头像、清单）；"招聘"时可以从素材库挑人物，也可以上传自己的图片；素材随 Workbench 打包，注明 AI 生成、自有。附件补上原文件名和一句说明（试行发现 16），附件网格显示文件名而不是 attachment-n | Pi |
| V5 员工出现在所有界面 | 时间线作者、看板卡片上的负责人头像、Needs You、附件上传者、执行视图 | Pi |
| V6 团队页 | 员工名册：每人状态（工作中、空闲、离线）、正在做的卡片、今天的产出、历史交付和审核通过率 | Pi |
| V7 执行视图可视化 | 按员工展示实时状态：在哪张卡、做了多久、最近在做什么，一键查看终端（只看模式）；取代偏技术的 Assignment 表格（原表格保留在"详细"里） | Codex |
| V8 评论加强 | 输入时按员工名自动补全 @提及、回复串、表情回应、评论里的附件直接预览 | Pi |

### 3.2 看板强化

| 任务 | 内容 | 负责 |
|---|---|---|
| K1 看板显示和筛选 | 卡片显示负责员工头像；按员工筛选；可选按员工分泳道；标签和优先级显示 | Pi |
| K2 界面上修改和取消卡片 | 卡片详情里修改标题、目标、验收标准、优先级，取消卡片（遵守 P2a-5） | Cardigan |
| K3 卡片父子层级 | domain 加 `parent_card_id`（只允许一层或有限层，待设计时定）；父卡显示子卡进度；子卡顶部显示父卡；PM 可以建子卡；看板可按父卡分组 | Codex |

### 3.3 角色和卡片模板

现状：角色只能通过配置文件登记；卡片模板只有写死的 `dev` 一种（必须有仓库，固定"开发 → 代码审核 → PM 验收"），评审、调研、素材产出这类任务没有正规流程，例如 C-9 头像评审卡的三个工作项一直挂着"待开始"，也没有正当的收尾方式。

| 任务 | 内容 | 负责 |
|---|---|---|
| V9 Workbench 角色管理（细化计划：[p2v-9-10-roles-templates.md](p2v-9-10-roles-templates.md)） | 管理员新建、编辑角色：名称、类型（产出 / 验证 / 常驻）、角色说明、能承担的工作项种类、能力标签、worktree 模式、可用工具、机器标签；默认角色可"复制后修改"。每次保存生成新版本，进行中的 Run 继续用旧版本，可看历史和回退。可用工具只能从系统白名单里选，界面不能突破系统级约束（Agent 不能推送、只有 PM Office 能记录人的拍板、验证方只读）；§6.3 协议部分由系统固定拼接，管理员只改角色说明。模型不放在角色上（见 V1、V2，放在员工上） | Cardigan（V9a、V9b 两张卡）|
| V10 Workbench 卡片模板（细化计划同上） | 管理员新建、编辑卡片模板：名称、说明、是否需要仓库、合并方式（不合并 / 确认后合并 / 自动合并）、默认工作项（标题、产出或验证、角色、是否必需、验证哪个产出项）、完成方式（完成申请经 PM 或人验收；或人直接标记完成，必须写一句结果，可附证据）。模板有版本，卡片创建时记下模板和版本，改模板不影响已有卡片。内置三个模板：`dev`（现有）、**通用任务**（不需要仓库，默认没有工作项，人标记完成）、**产出物**（产出方可以是 designer 等非开发角色，交付对象是文件或文档，验收后完成，不走合并）。建卡时（Workbench、CLI、PM 的 MCP 工具）可以选模板。domain 新增"人标记完成"命令，只对允许它的模板开放，附契约测试 | Cardigan（V10a、V10b 两张卡）|
| V11 成员身份与外接 Assignment（细化计划：[p2v-11-members-identity.md](p2v-11-members-identity.md)） | 新增全局"成员（Member）"实体表示真人（现在只有所有者"邵杰"），Workbench 登录和本机 CLI 默认身份对应到成员，时间线、拍板记录、知会显示成员名字和头像，老数据 `author=human` 按所有者显示；员工"张良"担任 cardigan 项目 PM Office，持有"外接"Assignment，Cardigan 为它签发 Token，本机 CLI 支持用 `CARDIGAN_TOKEN`／`--token-file` 以该身份操作，Dispatcher 不为外接 Assignment 起终端，门铃落入 `cardigan inbox`；停用旧的 A-36 | Cardigan（V11a、V11b、V11c 三张卡）|

V9、V10 是 Phase 3"PM 按任务创建、修改流程"的前提：先把角色和模板做成有版本、有边界的数据，之后才能让 PM 在边界内改。因此角色和模板的增删改都实现为 domain 命令，Workbench 和 CLI（`cardigan role ...`、`cardigan template ...`）共用；Phase 3 让 PM 经 CLI 或 MCP 调用同一批命令（用户 2026-11-09 要求 PM 能通过 Cardigan CLI 等方式改流程）。Agent 侧的 CLI 必须凭该 Assignment 的 Token 走与 MCP 相同的权限检查，不能使用主机上以人的身份直接读写数据库的 `cardigan`。

## 4. P2b 多机（约 2–3 周）

主机 GS66 跑控制面、数据库、中心仓库、Workbench 和常驻 PM；工作机跑 coder、tester；笔记本只当客户端。拓扑和约定见开发方案 §13.2、§13.3。

| 任务 | 内容 | 负责 |
|---|---|---|
| B1 预研落地 | 远程门铃、等待、worktree、断线表现；补测 macOS 上的 core 管理 Linux 工作机 | Claude 规划，Codex 实测 |
| B2 机器维度 | Runtime Adapter 加入机器维度，Agent 名字全局唯一 | Codex |
| B3 机器登记 | 机器登记、健康检查、能力标签（例如 `android-device`）、手动或按标签选机器 | Pi |
| B4 Git 远程化 | 工作机上的基础 clone、远程拉取交付、推送基线、远程清理 | Codex |
| B5 附件上传 | 工作机经 HTTP 上传附件 | Pi |
| B6 工作机初始化 | 安装器扩展：`agent` 用户、按项目声明的工具链（Node、pnpm 等，含可写缓存，承接自举时的手工安装经验）、Agent CLI、接入点配置按需注入 | Codex |
| B7 故障处理 | 失联 `unknown` → 宽限期 → `lost` → Needs You 人工接管；从主机最后拉取的 SHA 在另一台机器继续；旧机器恢复后清理旧 worktree | Codex |
| B8 安全收口 | SSH 只能主机连工作机；分支权限；Token 作用域；**项目之间的文件隔离**（同一个 agent 账号下各项目不能互读） | Codex |

验收（开发方案 §16）：coder 在工作机 A、tester 在带能力标签的工作机 B、PM 在主机；拔掉 A 的网线后进入 Needs You；接管后在机器 C 继续；A 恢复后旧 worktree 被清理。

## 5. P2c 拍板和授权（约 1 周）

| 任务 | 内容 | 负责 |
|---|---|---|
| C-D11 常驻授权代拍板（C-37，提前） | 复用 C-36：流程 general、功能细节 feature_detail 默认由 PM Ops 先审；scope_change 默认交人，可在拍板时或设置页授权。代拍写理由、delegated、proxy_authority；无可处理的后台／授权关闭时交人。合并确认排除，C-29 逻辑不变。设置页与 preference CLI 管理授权；HumanAction 先分拣；需要交人时必填白话标题、事项说明、人必须参与的原因、具体步骤、完成影响与回传要求，展示 PM 改写标记并保留原请求；权限内的纯流程操作由 PM 完成，过期合并确认由 C-47 系统作废，PM 不代拍合并；Workbench 查询拍板记录并按决策人、类别、卡片、时间筛选，无撤销。拍板解决后通知发起人落实，首提示含选项和影响，30 分钟无落实信号提醒 PM Ops | Codex |
| C-49 合并默认由 PM 推进（2026-11-10 用户拍板，取代 C-37 中“合并确认排除、PM 不代拍合并”） | 合并确认默认 decider 为 PM Ops；domain 强制合并检查通过、所有未取消的验证项全部通过、无未处理 must_fix 才能选 merge，否则只能 hold／退回修改／交人。卡片涉及 D12 四类或需求范围变化时由人确认（Workbench 或本机 CLI），PM 可写理由主动交人，交人后不适用超时自动合并。PM 代确认合并和各类代拍在 Needs You“知会”区同步，可标为已读；设置页可关闭 PM 代确认，关闭后回到人确认，C-29 超时自动合并保留为兜底。pm 角色包补充合并判断要点和知会写法 | Cardigan |
| C-D12 高风险只能由人确认（随 C-37，2026-11-10 更新） | spending/account/permission/data_deletion 四类永不授权给 PM；只接受 human 身份，Workbench 与本机 CLI 同等有效，PM Office/PM Ops/其他 Agent 不得代拍或转录。未经类别授权的需求范围变化仍要求 Workbench 确认 | Cardigan |
| C-due 拍板截止时间（C5） | `request_decision` 加 `due`；Needs You 按截止时间排序和提示 | Cardigan |
| C-remind 人工动作提醒（C4） | HumanAction 到期前提醒一次，到点没开始再提醒一次 | Cardigan |
| C-S22 拍板之前不许开工 | 允许对尚未开工（`todo`、`ready`）的工作项发起阻塞型拍板，拍板解决前不派 Run、不能开始；开发方案 §4.4、§4.5 补对应迁移和不变量 | Codex |

C-37 验证范围：`pnpm exec vitest run packages/domain packages/roles packages/router packages/mcp-server apps/cli apps/web apps/server/src/web`、domain `test:types`、`pnpm lint`、`pnpm check:deps`；不运行真实 hc、全量或 e2e。覆盖授权和撤回、四类高风险边界、勾选与拍板原子性、PM 缺席、分拣、历史筛选、发起人通知及超时提醒。旧 JSON 缺省兼容，不改写固定角色版本；部署时由人更新 PM 默认角色并新建对应常驻 Assignment 取得专用工具。

## 6. P2d PM 能力

| 任务 | 内容 |
|---|---|
| D-C1 长 Run 提醒 | Run 时长超过可配置阈值就通知 PM Ops，不打断执行者 |
| D-C2 上下文水位 | Runtime 上报上下文用量；超阈值时在交付边界换新会话 |
| D-C3 实际模型 | Run 记录 Harness 报告的实际模型，与启动配置不一致时标出（和 V2 的统计一起） |
| D-C6 节点检查 | 节点前的覆盖检查、发版后的卡片状态对账，先作为 PM Ops 的定期任务 |
| D-D5 接回原会话 | 记录 Agent CLI 的会话 ID，失联恢复时用 CLI 自带的恢复参数接回 |
| D-D10 经验提炼 | Phase 2 结束时按 §10.3 做一次 PM 经验提炼 |

## 7. 留到以后 / 不做

- Phase 3：PM 等角色按任务实际情况创建、修改卡片流程（模板和单张卡的工作项）并提议新角色，在人设定的边界内直接生效，越界进 Needs You；费用和额度监控；看板的人工建卡、批量操作、自定义字段、保存的视图；日历、甘特图按需评估。
- 遗留小项（有空时用 Cardigan 做）：附件先落盘后校验留下孤立文件；判断"Run 有没有产出"遍历全部事件的性能；Workbench JS 包拆分；Safari 和 Windows 走查；安装提示在执行视图里重复显示；清理旧测试用户 `cardigan-agent`（用户执行）。

## 8. 完成的标准

1. P2a：合并闸门上线后，连续 5 张 Cardigan 卡片从建卡到推 GitHub 无人工介入（拍板除外），没有带回归的合并。
2. P2-V：在 Workbench 里建 3 个员工（不同模型），走完一张卡；时间线、看板、团队页、执行视图都显示员工名字和头像；用户走查通过。
3. P2b：开发方案 §16 的多机验收场景跑通。
4. P2c、P2d：各任务的契约测试和一次真实演练通过。
