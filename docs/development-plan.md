# Cardigan · 多 Agent 协作开发系统开发方案

- 版本：v0.10.0（2026-11-09）
  - v0.10.0：**Phase 1.5 Workbench UI/UX 完成**（#179–#201，计划见 `docs/plans/phase-1.5-ui.md`，用户两轮走查通过）。§8.1 前端：左侧导航加页面框架，统一颜色、字号变量和公共组件（时间、编号标签、状态标签、空状态、筛选栏、长内容折叠）；看板和列表合成 `#/p/<项目>/cards?view=list|board`，旧路由跳转；卡片可用 `card=<编号>` 在右侧抽屉打开；交互组件用 Radix 无样式单独包，不引带样式的组件库；随站点打包 Inter、思源黑体（Noto Sans SC）、JetBrains Mono 三套 OFL 字体，由 Workbench 自己提供，正文开启 `text-autospace`。§8.3 快照顶部加五项概览，空分区不显示，最近交付改为表格。§8.4 卡片详情：来源和相关卡片、固定区块导航和写评论入口、最近结论、附件网格和大图预览（显示上传者和真实上传时间）；时间线按天分组、左侧竖线和类型图标、评论卡片默认完整显示、交付审核拍板的状态固定在卡片右上角、只用三档字号。§8.7 看板只排一行、永不折行，放不下时在看板区域内横向滚动。Needs You 拍板卡片、列表、项目动态和执行视图的改造（#182、#183）没有改正文，设计见计划 §4.2–§4.5。
  - v0.9.1（2026-11-08）
  - v0.9.1：**M5.S 真实冒烟通过，Phase 1 完成**（#157–#178）。M2.S、M3.S、M4.S（含 sensen-godot 大仓库）、M5.S 全部通过，发现的 S1–S25 除 S22 外全部修复（S22 和项目之间的文件隔离列入 Phase 2）。§10.2 预置 Agent 的目录信任和 Claude 首次初始化，关闭 Claude 自动记忆；§12.2、§12.4 只读审核方在当前交付版本上启动和刷新；§9.2、§9.3 验证目标参数和诊断，coder 交付摘要限 160 字，新卡默认用项目登记的仓库；§6.4、§7.2 常驻 PM Run 不得自我唤醒、ACK 按流推进、经 MCP 指派的工作项由 Router 通知后启动、提交审核也算 Run 有产出、规则能确定下一步的事件不再升级给 PM Ops；§4.3、§4.4、§10.4 PM 验收只针对完成申请；§12.3、§13.1 统一数据目录默认值，未创建的仓库不备份；§12.6 回收已释放的终端和空 worktree 目录；§12.5 合并计划包含所有 Git 交付；§4.4、§6.6 手动停止的常驻 PM 保持暂停；§8.1 卡片页内定位走路由参数；§10.4 补 designer、tester Core Prompt。附录 A 第一条通过标准改为"只因产品口径和合并确认打断你"（用户拍板）。
  - v0.9.0（2026-11-06）
  - v0.9.0：**M5 完成**（#121–#156）。§8.2 Workbench 写接口（评论、指令、附件、拍板、人工动作）及 §9.2 人和常驻 PM Ops 的指令、引用解析；§8.3–§8.6 项目快照、执行视图、项目动态和可续传的 SSE 实时刷新；§14 Workbench 只监听回环地址、登录和 JSON/Origin 防护在监听器上强制执行；§4.4 没有验证项指向的产出工作项，交付即完成；§7.1、§10.4 常驻 PM 的 Token 按持久化的模式限定工具；§10.2 每个 Assignment 隔离 Claude 配置目录；§13.9 两次 Run 之间运行时丢失时自动替换 Session，失败立即升级；§11.2 运行时诊断信息。§15 新增 D10–D12（PM 规则来自各项目 PM 实战经验并定期提炼、常驻授权代拍板和高风险拍板只在 Workbench 确认留到 Phase 2），§10.3 写入定期提炼流程。附录 A 按开发卡模板和拍板规则对齐，在真实 server、hc 和 Git 上端到端运行。
  - v0.8.0（2026-11-06）
  - v0.8.0：**M4 完成**（#88–#120）。§12.1 中心仓库改为数据目录下主机独占的 bare 仓库，登记源只读、只快进同步、分叉不动；§12.2 基础 clone 改从中心取基线，agent-ssh 下首次建空仓库、之后由主机经 Agent 执行入口增量推送（不再每次打整仓 bundle），查询和传输两档超时；§12.3 交付在事务前按数据库记录的分支校验 commit 和祖先关系，提交后固定 `refs/cardigan/deliveries/<id>`（只创建不覆盖），定期备份 `agent/*`；§12.5 在 bare 仓库里用 merge-tree + commit-tree + 比较后更新合并，不检出文件，冲突不动任何 ref；§12.6 release、清理决策（保留 / 强制清理前先存补丁）、只报告不删除的对账；§4.4 卡片新增 `awaiting_merge`，合并成功才 done，合并确认按模板策略进 Needs You（用户确认）；§7.1 / §10.4 常驻 PM 的前台/后台模式持久化为 `standing_mode`，Token 范围由模式决定；§9.1 MCP 认证拒绝非 active 的 Assignment；§14 主机 Git 只在中心仓库执行，从 Agent 仓库拉取经 Agent 执行入口跑 upload-pack 并开启 fsck。
  - v0.7.0（2026-11-05）
  - v0.7.0：**M3 完成**（#61–#87、#91、#94、#101、#103、#104）。§6.4 路由规则表、§6.5 @提及、§7.2 升级、§6.7 合并门铃全部实现；通知状态机 `pending → belled → acked` 及 `delivery_failed`、`needs_attention` 写入 §4.4；Dispatcher 以 MCP 为准判断忙闲，按指数退避重发、wake 失败不静默重试、看门狗、运行时失联 unknown → lost；按流（每张卡、项目级）的事件序号和 Router 游标；PM Office / Ops 共用 pm 角色、分工和打断规则（§7.1–§7.3）；§20.1 / §20.2 新增 `packages/host`，CLI 和 Dispatcher 共用同一份启动和失败补偿流程。
  - v0.6.23（2026-11-05）
  - v0.6.23：**M2 完成**（#43–#72）。一键启动、Runtime 适配器（herdr-core 0.1.18）、worktree、启动编译和首条提示；M2.7 Agent 专用账号模式接入一键启动；start 哨兵在 dispatchRun 提交之后才写入，并使用安全写入。
  - v0.6.22（2026-11-05）
  - v0.6.22：M2.7 补充共享 Git 的账号边界：主机仅读取登记源并生成只读 bundle，共享 clone/worktree 的 Git 操作均在 agent 账号执行。
  - v0.6.21（2026-11-05）
  - v0.6.21：M2.7 实际写入共享运行目录与凭据权限；固定目录描述符防止共享目录链接覆盖主机文件；server 打开数据库前验证私有数据目录。
  - v0.6.20（2026-11-05）
  - v0.6.20：M2.7 确定 agent 专用账号、主机私有数据、cardigan-share 两账号共享组和专用 loopback SSH 入口；安装器先做只读 preflight，提供 --check，后续运行时接线分批交付；见 ADR 0002。
  - v0.6.19（2026-11-05）
  - v0.6.19：M2.5 实现本地独立 clone、worktree 创建/复用和脏文件查询，明确 detached 目标和路径冲突的拒绝边界；Assignment 编号按项目分配，worktree 路径按项目分层，project_id 入路径前校验为安全片段。
  - v0.6.18（2026-11-05）
  - v0.6.18：M2.3 第一部分接入 hc 0.1.18，明确独立 session/socket、子进程超时、事件序号、替换和释放边界；共用真实/内存契约套件单独提交。
  - v0.6.17（2026-11-05）
  - v0.6.17：M2.1 第二部分补齐 acknowledgeRun / abortDispatch，复用 activeWork 推进首次 MCP 确认，明确取消和重复调用边界。
  - v0.6.16（2026-11-05）
  - v0.6.16：M2.1 第一部分定义 Role、Runtime 端口和主机侧 queueRun / dispatchRun，明确快照、互斥和派发元数据边界。
  - v0.6.15（2026-11-05）
  - v0.6.15：M2 开工前复核 D9，维持 herdr-core 并锁定 0.1.18；多机实测更新到 §11.3；§10.4 明确 PM 验收由每张卡单独的工作项级 pm Assignment 完成（用户确认）。M2 任务计划见 `docs/plans/phase-1-m2.md`。
  - v0.6.14（2026-11-04）
  - v0.6.14：M1.6c 接入附件、Run 和项目查询；明确 base64/摘要校验、内容寻址落盘、事务失败保留文件及只读快照边界。
  - v0.6.13（2026-11-04）
  - v0.6.13：M1.6b 安全修订：MCP 只登记 Assignment，不签发或返回 Token；签发与 Assignment 校验由主机在同一事务完成。
  - v0.6.12（2026-11-04）
  - v0.6.12：M1.6b 接入协作和 PM 工具，增加 store 的事务内 Token 签发能力；MCP 凭据边界由 v0.6.13 修订。
  - v0.6.11（2026-11-04）
  - v0.6.11：报告的阻塞保存为 WorkItem.reported_blocker；PM／人确认与实际恢复分开，支持与 Decision / HumanAction 独立解除，避免相互等待。
  - v0.6.10（2026-11-04）
  - v0.6.10：M1.6a 明确 MCP 命令的一致快照、缓存优先预检、幂等事务及失败回滚边界；后续工具分依赖 PR 接入。
  - v0.6.9（2026-11-04）
  - v0.6.9：§4.4 验证型工作项补上 `in_progress → blocked / waiting_decision` 和 `blocked → in_progress`（报阻塞、发起阻塞拍板、解除阻塞；`waiting_decision` 仍回到 `ready`）；M1.T1 审核时发现规格漏写，实现早已支持。
  - v0.6.8（2026-11-04）
  - v0.6.8：M1.3 二轮审核：暂停自身工作项前复用交付/审核的启动校验；明确 delivered / accepted 的等待行为；新交付到达时检查累计审核预算，用尽则转上限拍板。
  - v0.6.7（2026-11-04）
  - v0.6.7：M1.3 审核修订：PM 受控解除普通阻塞；阻塞拍板包含请求者工作项；审核上限的暂停/放宽与恢复条件分离；四个 M1.5 只读工具由 mcp-server 单独维护。
  - v0.6.6（2026-11-04）
  - v0.6.6：M1.3 协作命令：明确敏感决策分类、Run 心跳/上限审计、阻塞后新建 queued Run、PM Office 权限来源及 Token 签发意图；不启动运行时。
  - v0.6.5（2026-11-04）
  - v0.6.5：M1.3 审核修订：最后一轮 reject / conditional 均转阻塞拍板；完成申请目标失效后验证项回到 todo；supersedes 只指向同类上一版，审核事件先于拍板请求。
  - v0.6.4（2026-11-04）
  - v0.6.4：M1.3 交付命令：完成申请前置检查排除本次完成审核工作项（用户确认），区分产出与完成申请版本，明确事务外校验/事务内归约和结构化遗留依据。
  - v0.6.3（2026-11-04）
  - v0.6.3：按 M1.2 审核意见补齐 §4.4 的新交付重开、在审版本失效、验证项取消及 unknown 重连迁移；§13.9 明确暂时失联后的恢复路径。
  - v0.6.2（2026-11-04）
  - v0.6.2：§20.4 合并规则改为常规 PR 由 Claude 合并并给出 brief；§10.4 改正 PM 角色的写法（前台、后台是同一个角色的两个 Assignment）。
  - v0.6.1（2026-11-04）
  - v0.6.1：§10.2 新增"接入点 + 启动配置"两层设计，以及供人手动启动的 `cardigan launch`。
  - v0.6（2026-11-04）
  - v0.6：Phase 0 完成。D3–D9 全部敲定（§15）；按 `docs/research/` 中各份预研报告修订 §2.1、§4.3–§4.5、§5.2、§6、§8.2、§8.4、§8.7、§9、§10、§11（重写）、§12、§13、§14、§16–§18 和附录 A、B；新增 ADR 0001（运行时基线）。
  - v0.5.1：新增 D9（运行时基线），0.3 增加 Herdr 换代评估，0.6 改为敲定 D3–D9。
  - v0.5：§16 Phase 0 新增 0.7（代码骨架）和 0.8（同类产品对比、名字检查），0.6 改为敲定 D3–D8；0.2 从"试行评论模板"改为"回溯现有看板项目"，0.1 是否试行看 0.2 的结论；新增任务级计划 `docs/plans/phase-0.md`。
  - v0.4：D2 决定技术栈：TypeScript（Node 24 LTS）+ pnpm workspace + SQLite（WAL）+ React（Vite，纯 SPA）；§20.4 明确 DeepSeek 通过 Pi 实现，并记录项目级 Pi 插件。
  - v0.3：项目定名 Cardigan；D1 决定自研看板，不依赖 Gitea 等外部看板；Git 改为"主机发起"模型（§12）；新增 §8.7 看板第一版范围和 §20 仓库规划。
  - v0.2：新增附录 C（看板工具评估）。
- 用途：后续开发的指导文档。Phase 0、Phase 1（M1–M5）和 Phase 1.5（Workbench UI/UX）已完成，决策 D1–D12 已敲定（§15），各项预研结论见 `docs/research/`。
- 来源：本目录下三份讨论记录（见附录 B）。凡是"已核实"的外部能力，均来自 2026-10-24 查阅的官方文档或源码。

---

## 0. 一页摘要

**这是什么**：一个由"人 + 核心 Agent"驱动的多岗位协作系统。你主要和 PM Agent 讨论需求、看进展、拍板；PM 负责分配任务、监控进度；产品、设计、开发、测试等岗位 Agent 负责执行。所有协作围绕"卡片 + 时间线"展开。

**架构一句话**：

> 自研控制面（唯一事实来源，含自研看板） + Herdr（Agent 运行时和人工接管层，基线为 herdr-core，见 D9） + 可插拔 Agent CLI（Claude Code / OpenCode / Pi / Codex 等）。Agent 通过 Card MCP 读写事实；Herdr 只负责"按门铃"；所有 Git 网络操作都由主机发起。

**模型一句话**：

> Card 管目标；Work Item 管岗位责任；Assignment 管持续责任（持有 Session 和 worktree）；Run 管一次执行；Timeline 管协作过程；Delivery / Review / Decision 让关键交流变得可计算。

**最重要的几条原则**：

1. 先持久化事件，再按门铃；门铃只带 ID，内容由 Agent 通过 MCP 读取。
2. 通知路由到 Assignment，不按角色广播，也不按 worktree 寻址。
3. 业务完成以 Delivery / Review 为准，不以 Herdr 的 `done` / `idle` 为准。
4. Worktree 属于 Assignment，不属于角色；Session 可替换，Assignment 不替换。
5. 只有"需要你拍板"和"重大风险"才打断你与 PM 的主对话。
6. 交付只引用 commit SHA，由主机拉取进中心仓库后才生效，不引用本地路径；从第一天起就按多机约定设计。

**路线与工作量**（1 名有经验的开发者，AI 辅助）：

| 阶段 | 内容 | 粗估 |
|---|---|---|
| Phase 0 | 预研 + 在现有实践中做零代码验证 | 1–2 周 |
| Phase 1 | 单机 MVP 闭环 | 4–8 周 |
| Phase 2 | 多机部署 | 3–5 周 |
| Phase 3 | 加固（按需） | 4–8 周以上 |

---

## 1. 背景与目标

### 1.1 使用场景

- 你和少数核心 Agent 长期讨论，PM Agent 是主要对话对象。
- PM Agent 负责任务分配和进度监控。
- 岗位 Agent 负责执行：产品、设计、开发、测试、审核等。
- 一张卡往往需要多个岗位协作，例如同时涉及产品调整、设计修改、代码和测试。
- Agent 之间需要通信，或者通过钩子从看板获得消息。

### 1.2 原始需求（六项）

1. 给 Agent 单独定义角色：core memo、能力，例如 PM Agent、设计 Agent、Coding Agent。
2. 每个 Agent 可以指定 Provider / 模型。
3. 集成看板（卡片）系统：给 Agent 指定任务，Agent 通过 MCP 读取、交付和讨论。
4. 需要你拍板的问题提交成卡片或其他持久形式，而不是只出现在对话窗口里。
5. 每个 Agent（尤其是 Coding Agent）有独立的 worktree。
6. 能管控 worktree。

### 1.3 当前实践与痛点

当前实践：

- 使用 Herdr 多窗口终端运行多个 Agent，Agent 之间用 Herdr Prompt 按门铃。
- PM Agent 名为 zhangliang，是你的主要对话 Agent。
- 卡片下的评论时间线承载交付汇报、反馈和拍板。

痛点：

| 痛点 | 根因 |
|---|---|
| 门铃不断打断你与 PM 的对话和拍板 | "人与 PM 的对话"和"机器向 PM 汇报"在同一个 Session 里 |
| 系统只能从自然语言猜"现在该谁做什么" | 评论同时承担讨论、分配、交付、审核、拍板、推进 |
| 拍板被时间线淹没，被阻塞的 Agent 不知道何时恢复 | 决定不是结构化对象 |
| PM 变成人工消息路由器 | 缺少确定性的事件路由 |
| 漏处理、重复处理 | 没有事件序号、处理游标和业务 ACK |

### 1.4 设计目标

- **可操作**：每个状态旁边都有可执行的动作，而不是只显示 working / idle / done。
- **容易理解**：主界面只暴露 4 个概念（任务、评论、交付、待拍板）；Assignment、Run、Session 放在执行视图里。
- **可恢复**：任何 Agent、Herdr 或机器重启后，任务都能从控制面恢复。
- **执行层可替换**：今天用 Herdr + CLI，明天可以加直连 SDK 适配器，而不重写业务系统。

### 1.5 第一版明确不做

- 多租户云托管服务
- 自研 Agent Harness，或 fork OpenCode / Pi 作为产品主体
- 分布式消息队列、Agent 间直接通信协议
- 进程或 worktree 的跨机实时迁移、自动故障迁移
- 自研 worker 守护进程、k8s
- 无人工确认的自动合并到主干

---

## 2. 选型结论

### 2.1 调研过的项目

| 项目 | 定位 | 许可证 | 结论 |
|---|---|---|---|
| aaif-goose/goose | 通用 AI Agent 平台（Rust），Recipes、Subagents、MCP | Apache-2.0 | 成熟，但看板驱动、worktree、Git 管控没有优势；不作为底座 |
| OpenCode (sst/opencode) | 产品化的多模型 Coding Agent；Custom Agents、Server/SDK、worktree API | MIT | 执行层候选；可作为岗位 Agent 运行，或作为将来直连 SDK 适配器的对象 |
| Pi (earendil-works/pi) | 极简可改造 Harness；会话树、TS SDK、内置 MCP | MIT | 执行层候选；适合深度定制的岗位 Agent |
| DeepSeek Harness | 全插件化 Agent Runtime（Cordis） | MIT | Developer Preview，官方明确未经安全审计；只跟踪，不押注 |
| **Herdr**（herdrdev/herdr、herdr-core、herdr-app） | Agent 终端运行时。0.9.x 是带界面的终端工具：Server/Client、Pane、Socket API、worktree、SSH 多机。herdr-core 是 2026-10 新出的无界面运行时，提供带兼容承诺的 API 和事件推送；herdr-app 是它的桌面客户端 | Apache-2.0 | **采用为运行时和人工接管层**；基线为 herdr-core，Herdr 0.9.x 作为回退（D9） |
| herdr-projects（现名 Shepherdr） | 先后做过 Herdr 插件、独立 Web 应用、herdr-app 布局三种形态：本地看板、Coordinator、每任务 worktree、Review、人工批准合并 | MIT | 与本方案高度相似。已评估（0.5a）：**不 fork，借鉴设计**；它让工作机自己 push，我们不采用 |
| herdr-mesh | 把 Herdr 的 Agent/Pane 操作包装成 MCP | — | 仍是终端 Prompt 注入；不提供持久消息，不采用 |
| block/buzz、berd、builderbot | 协作工作区 / 企业桌面壳 / 审查工作台（ACP 生态） | Apache-2.0 / MIT | 背景参考；Staged 的 diff 审查交互可作为 UI 参考 |

### 2.2 最终路线

> 第一版采用：自研控制面 + Herdr Runtime Adapter + 可插拔 Agent CLI。

为什么不 fork OpenCode / Pi：

- 你的核心是"异构 Agent 围绕卡片持续协作"，而不是"一个更好的 Coding Agent"。
- 每种 Harness 都要写适配器；Herdr 已经能运行大量 Agent CLI。
- 把看板和编排写进某个 Harness 内部，会被它的上游变动绑死。

为什么不把 Herdr 当作整个底座：

- Herdr 的 Prompt 不是持久消息：没有收件箱、重放、ACK 和去重。
- Herdr 的 `done` 不等于业务完成。
- 重启后恢复 Session 不等于恢复任务。

以上缺口全部由控制面补足。

### 2.3 什么时候改为直连 OpenCode / Pi SDK

出现以下需求时，新增一个 Direct SDK Runtime Adapter（控制面不变）：

- 产品变成无终端、多租户的托管服务；
- 需要大量并发 Run，终端进程成为负担；
- 需要细粒度的 Token、工具调用和成本事件；
- 需要严格的容器隔离和按租户授权；
- Herdr 的 Prompt 和状态语义成为实际稳定性瓶颈。

### 2.4 许可证注意

- Herdr 为 Apache-2.0：保留 LICENSE / NOTICE；修改过的文件要注明；不得使用其商标。
- OpenCode、Pi 为 MIT：保留版权声明即可。
- herdr-projects（MIT）不 fork；如果参照其文档措辞或代码片段，保留其版权声明，不使用其名称和标识。

---

## 3. 总体架构

### 3.1 分层

```
+-------------------------------------------------------------+
|  Human: Herdr client (PM Office chat, takeover)             |
|         Browser: Workbench (Needs You / Snapshot / Cards)   |
+-------------------------------------------------------------+
|  CONTROL PLANE (source of truth)                            |
|   Role Registry | Card / WorkItem / Timeline | Decision     |
|   Assignment / Run | Event Store + Cursors                  |
|   Event Router / Dispatcher | Git Service | Attachments     |
|   Card MCP (Streamable HTTP, per-assignment token)          |
|   Workbench Web API                                         |
+---------------------------+---------------------------------+
|  RUNTIME ADAPTER          |  (future) Direct SDK Adapter    |
|  Herdr: provision / wake / status / release / takeover      |
+---------------------------+---------------------------------+
|  AGENT HARNESSES: Claude Code | OpenCode | Pi | Codex ...   |
|  each runs in a Herdr pane, talks to Card MCP over HTTP     |
+-------------------------------------------------------------+
|  GIT: central bare repo on hub (hub-initiated fetch/push)    |
+-------------------------------------------------------------+
```

### 3.2 各层职责

| 层 | 负责 | 不负责 |
|---|---|---|
| 控制面 | 角色、卡片、工作项、时间线、交付、审核、拍板、事件路由、游标与 ACK、Git 交付校验、审计 | 运行进程、渲染终端 |
| Runtime Adapter（Herdr） | 启动、恢复、停止 Agent；Workspace / Pane；创建和删除 worktree；按门铃；运行状态；人工接管 | 持久消息、业务状态、任务完成判断 |
| Agent Harness | 具体岗位的推理与工具执行 | 决定自己的业务状态（必须通过 MCP 上报） |
| Card MCP | Agent 读写控制面的唯一入口 | — |
| Git（主机上的中心 bare 仓库） | 跨机器共享代码历史；拉取和推送都由主机发起 | 接受 Agent 推送 |

### 3.3 一条事件的完整流转（示例：测试驳回）

1. 测试 Agent 调用 `submit_review(delivery=D-9, verdict=reject, issues=[...])`。
2. 控制面在同一事务中完成：
   - 写入 Review；
   - 写入 Event（card=C-123，seq=31，type=`review_rejected`）；
   - 开发工作项状态变为 `changes_requested`；
   - D-9 状态变为 `rejected`。
3. Event Router 命中规则"驳回 → 被审核交付的 Assignment"，为 A-17 创建 Run R-5（trigger=E31，状态 `queued`）。A-17 当前空闲，且没有正在执行的写入型 Run，于是派发 R-5。
4. Runtime Adapter 执行 `herdr agent prompt` 发送门铃：
   `[bell] card=C-123 wi=W-4 asg=A-17 run=R-5 seq=31 kind=review_rejected`
5. 开发 Agent 依次：
   - 调用 `get_updates` 读到驳回意见，再调用 `ack_events(seq=31)`；
   - 在原 worktree 修复并 commit（不 push）；
   - 调用 `submit_delivery` 生成 D-10，最后调用 `finish_run`。
6. 主机从该工作机拉取 D-10 的 commit，按 §12.3 校验后固定到中心仓库，然后：
   - D-9 标记为 `superseded`；
   - 设计走查和测试验收两个工作项回到 `ready`，并分别唤醒它们的 Assignment。
7. 整个过程完全由规则处理：PM Ops 不被唤醒，你与 PM Office 的对话不受打扰。

---

## 4. 领域模型

### 4.1 概念与命名

| 概念 | 中文名 | 含义 | 主界面可见 |
|---|---|---|---|
| Card | 目标卡 | 一个阶段性目标或要解决的问题 | 是 |
| Work Item | 工作项 | 为完成目标，某个岗位要承担的一项工作；分产出型（produce）和验证型（verify） | 是（"任务"） |
| Assignment | 责任上下文 | 某角色对某工作项的持续责任，持有 Session、worktree 和所在机器 | 否（执行视图） |
| Run | 执行 | 因某个触发而产生的一次有限执行 | 否（执行视图） |
| Agent Session | 会话 | Harness 中的一个会话，可以被替换 | 否 |
| Timeline Entry | 时间线条目 | 评论、指令、交付、审核、拍板、状态变化的统一展示形式 | 是 |
| Delivery | 交付 | 结构化的产出记录 | 是 |
| Review | 审核结论 | 针对某个交付的结构化结论 | 是 |
| Decision | 待拍板 / 决定 | 持久、可审计的业务决策 | 是 |
| Event | 事件 | 按卡片单调递增编号的事实变化，用于路由、游标和 ACK | 否 |
| Role | 角色 | 岗位说明书：Core Prompt、能力、Harness、模型、权限 | 配置页 |
| Machine | 机器 | 运行 Agent 的主机 | 执行视图 |

记忆口诀：

> Role 是岗位说明书，Assignment 是工单负责人，Session 是当班执行者，Worktree 是工位。评论寄给工单负责人，不寄到工位，也不广播给同岗位的所有人。

### 4.2 实体关系

```
Role (versioned) ----------------------------+
                                             |
Card 1---* WorkItem 1---0..1 Assignment *---1 (Role@version)
  |            |                 |  \
  |            |                 |   +-- 0..1 Worktree (on Machine)
  |            |                 |   +-- 0..1 current Session (RuntimeRef)
  |            |                 +--* Run (1 trigger Event each)
  |            +--* Delivery *---* Review
  |
  +--* Decision ---* affects WorkItem
  +--* TimelineEntry (links: WorkItem? Delivery? Run? Decision?)
  +--* Event (seq per card) --- Cursor(Assignment, Card, acked_seq)

Standing Assignment (scope=project): PM Office, PM Ops — not tied to a WorkItem
```

### 4.3 实体字段（初版，实现时可调整）

以下 `?` 表示可空，`[]` 表示列表。

**Card**

- 基本信息：`id`、`project_id`、`title`、`goal`、`acceptance_criteria`（由卡片模板强制）
- 来龙去脉：`source`（起因：用户原话，或指向某个 Decision）、`out_of_scope`、`deadline?`、`related_cards[]`
- 代码基线：`repo`、`base_branch`
- 管理字段：`priority`、`status`（见 §4.4：中间状态由工作项推导，`done` 要走完成申请）、`resolution?`（`done | superseded | duplicate | wontdo`）、`superseded_by?`（取代本卡的同项目卡片编号，同时保存在 `related_cards[]` 中）、`template`（决定默认生成哪些工作项，以及哪些是必需的）
- 审计：`created_by`、`created_at`
- 派生字段（不存储，实时计算）：`waiting_on[]`、`next_owners[]`、`open_decisions[]`、`review_matrix`（每个交付 × 审核它的验证方 → 对当前 SHA 的结论；产出交付只列以该工作项为目标的验证项，完成申请只列它请求的 PM 验收项）、`why`（一句话原因，≤40 字，见 §8.2）
- `next_owners[]` 中，处于 `ready`、`in_progress`、`changes_requested` 的工作项若关联的 Assignment 已 `released`，退回 `{kind: "role", ref: 工作项的 role_id}`，表示需要重新指派；`active` 和 `suspended` 仍指向该 Assignment。同一角色去重，其他派生字段规则不变。
- 负责人和审核人不写进描述正文；改派作为事件进时间线。

**WorkItem**

- `id`、`card_id`、`title`
- `kind`：`produce` | `verify`
- `role_id`
- `required`：是否是卡片 Done 的必要条件
- `depends_on[]`
- `target_work_item_id?`：仅 verify 类型，表示验证哪个产出型工作项
- `completion_criteria`、`status`、`assignment_id?`
- `template_key?`：模板生成工作项的稳定键，用来识别主产出和本次完成申请的审核项。
- `reported_blocker?`：`{reason, needs: role | human, reported_by, reported_at}`。报告者来自 Actor，时间来自 Clock；它是独立阻塞原因，其他阻塞解除不能清除它。重复上报更新当前报告，历史保留在时间线。

**Assignment**

- 标识：`id`、`scope`（`work_item` | `standing`）、`work_item_id?`
- 常驻模式（M4.5）：`standing_mode?`（`office` | `ops`），仅常驻 `pm` Assignment 使用，由 `cardigan pm create --office|--ops` 写入，之后不能修改；工作项级 Assignment 没有这个字段。旧的常驻行没有它时，按最新 Token 的工具范围推断一次并写回
- 角色：`role_id`、`role_version`
- 状态：`status`（业务状态）、`runtime_state`（运行状态）
- 运行位置：`machine_id`、`runtime_ref`（JSON，见 §11.1）、`session_ref?`（Agent CLI 的会话 ID，由控制面记录，恢复时使用，见 D5）、`eta?`
- 代码：`worktree_path?`、`branch?`、`base_sha?`
- 凭据：`mcp_token_id`
- 时间：`created_at`、`released_at?`

**Run**

- `id`、`assignment_id`、`trigger_event_id`
- `kind`：`initial` | `rework` | `decision_resumed` | `followup` | `fix`
- `status`、`model`
- `started_at?`、`finished_at?`、`outcome`、`summary`
- `heartbeat_at?`、`heartbeat_note?`：仅更新运行记录，不生成时间线巡检消息。
- `review_limit_changes[]?`：记录 `event_id`、新上限、操作者和时间；存在历史 Run 时，放宽动作记在该 Assignment 最近的 Run 上。
- 约束：`UNIQUE(assignment_id, trigger_event_id)`，用于幂等

**TimelineEntry**

- `id`、`short_id`（人类可读、可引用，例如 `C-12#7`）、`card_id`、`event_seq`
- `type`：`comment` | `instruction` | `delivery` | `review` | `decision_request` | `decision_resolved` | `human_action` | `handoff` | `status_change` | `system`
- `author`：`human` | `assignment:<id>` | `system`。由身份决定，不信正文里的署名；需要时记 `on_behalf_of`（例如 PM 转述你的话）
- 关联：`work_item_id?`、`delivery_id?`、`decision_id?`、`human_action_id?`、`run_id?`
- 引用：`reply_to?`、`refs[]`（可以跨卡，指向条目、拍板、卡片、PR）、`supersedes?`、`retracted`。正文里出现的编号由服务端识别并写入 `refs[]`
- 内容：`body`（Markdown）、`mentions[]`、`created_at`
- 一条 Agent 消息同时包含多种结构化内容时（例如交付里附带请求拍板），由 MCP 拆成同一事件下的多个条目。
- 巡检、签收、ETA、等待说明不进时间线，改由运行状态和派生视图表达（0.2 回溯：这类内容约占普通评论的 58%）。

**Delivery**

- `id`、`work_item_id`、`run_id`
- `kind`：`code` | `design` | `doc` | `test_report` | `card_completion` | `other`。`card_completion` 即卡片的完成申请（§4.4）
- `summary`：面向人，≤160 字，超长拒绝；细节放附件或正文
- `subject`（必填）：`{kind: git_head | artifact_sha256 | doc_version, value}`。代码交付以 commit SHA 定位，`branch?`、`pr_url?` 只作参考；`pr_url` 若提供必须是 http/https 的绝对 URL，其他协议、相对地址或无效 URL 返回 validation_failed
- `evidence[]`：由控制面生成（commit、diff 统计、测试命令与结果、附件 id），和 Agent 的自述分开
- `test_results?`、`attachments[]`、`known_gaps[]`
- 完成申请的遗留项以 `precondition`（`work_item:<id>` 或 `decision:<id>`）对应未满足的检查，必须带非空说明和 `followup_card_id`；检查结果由控制面写入 evidence。
- `requested_verifiers[]`（必填，由服务端校验，不接受"A 或 B"）
- `supersedes?`：指向同一工作项、同类版本流（产出或完成申请）的上一版；显式传入时也必须满足此条件。同一工作项的新产出交付让旧产出及旧完成申请失效；完成申请只替代旧完成申请，不使其依据的产出和代码审核失效。完成申请的 subject 必须匹配当前产出版本。
- `status`：`submitted` | `accepted` | `rejected` | `superseded`。合并（含 merge SHA）和部署（含环境）作为事件记录，不是交付状态

**Review**

- `id`、`delivery_id`、`target_sha`（必填，必须等于交付的 `subject`）、`work_item_id`（验证型工作项）、`run_id`
- `kind`：`code` | `design` | `test` | `replay` | `product` | `user`
- `issues[]`：每项 `{severity, description, must_fix, pre_existing, proof?}`，`must_fix` 必填
- `verdict`（`pass` | `reject` | `conditional`）和 `blocking` 由服务端按规则计算，审核者只描述问题（0.5a §9.2）：
  - 有 `must_fix` 的问题就是驳回；
  - `critical` 没有 `proof` 时按 `major` 处理；
  - `pre_existing` 的问题不触发返工，只列出。
- `recheck_required`：有条件通过时是否需要复审
- `stale`（派生）：目标交付有了新版本时为真，旧结论不再算数
- 第二轮起只复查上一轮的问题是否修好、修复有没有引入新问题；要新开问题，必须是 `critical` 并带 `proof`
- `attachments[]`

**Decision**

- `id`、`key`（人类可读的编号，例如 `q(280)`。由 Cardigan 生成，项目内唯一、不复用；文档里引用这个编号）、`card_id?`（为空表示项目级决定）、`raised_by`
- `kind`：`choose`（在选项中选择）| `approve`（批准某个对象，绑定到交付或 SHA）
- `category?`：`general | spending | account | permission | data_deletion`。创建命令要求显式分类，后四类只能由 human 拍板；domain 不从自由文本猜测分类。
- `trigger?=review_limit`：仅控制面在审核轮次用尽时写入，标识专用的 pause / raise_limit 处理；普通 `request_decision` 不接受该字段，不按问题正文或选项名称猜测来源。
- 内容：`question`、`context`、`options[]`（每项 `{key, description, impact}`）、`recommended`、`latest_by?`、`preconditions?`
- 影响：`affected_cards[]`（可以跨卡）、`affected_work_items[]`、`blocking`
- `decider`（必填）：`human` | `role:<id>`。花钱、账号、权限、删除数据这几类只能由人拍板
- `doc_refs[]`：拍板记录在哪份文档的哪个位置（路径、commit、锚点）
- `status`：见 §4.4
- `resolution?`：`{option, rationale, resolved_by, via: needs_you | pm_office_chat | external, raw_quote, via_chain[], external_ref?, batch?, proxy_authority?, at}`。由人拍板时 `raw_quote` 必填；在 Needs You 里作答时自动记录原文
- `amends?`、`superseded_by?`

**HumanAction**（待你执行的操作）

- `id`、`key`、`card_id?`、`requested_by`
- 内容：`instructions`（要执行的命令或操作，写完整）、`why_human`（为什么只能你做：权限、账号、实体设备等）、`expected_return`（做完回传什么）、`due?`
- 影响：`blocked_work_items[]`
- `status`：`open` | `done` | `cancelled`；`result?`：`{text, attachments[], at}`
- 来源：0.2 回溯中，需要你介入的门铃有一半是只有你能做的操作，而不是拍板

**Event**

- `id`（ULID）
- `card_id?`：项目级事件为空
- `seq`：在同一卡片内单调递增
- `type`、`actor`、`payload`、`created_at`

**Cursor**

- `assignment_id`、`card_id`、`acked_seq`

**Machine**

- `id`、`label`、`herdr_machine`（Herdr 中保存的机器名）
- `os`、`arch`、`tags[]`（如 `android-device`、`gpu`）
- `max_assignments`、`status`、`last_seen`

**Attachment**

- `id`、`sha256`、`mime`、`size`、`card_id`、`uploaded_by`、`storage_path`
- `attach_to`：具体的时间线条目或交付，不只挂在卡上
- `kind`：`artifact`（设计稿、规格、导出文档、构建产物）| `evidence`（测试截图、日志等）
- `basis?`：所依据或所等待的 Decision `key`。`artifact` 必填，服务端拒绝缺少 `basis` 的上传
- `approval_status`（派生）：`pending | approved | revoked`，由 `basis` 指向的拍板状态推导
- `supersedes?`：取代旧附件时，旧附件显示为"已取代"

### 4.4 状态机

**Card**：`backlog → todo → in_progress → review → awaiting_merge → done`；除 `done` 和 `cancelled` 外的状态都可以转为 `cancelled`。已完成卡片不能再取消，有问题或需要修改时建新卡（例如回滚卡）。

- 人可通过 `supersedeCard({card_id, superseded_by})` 将 `done` 或 `cancelled` 卡片标记为被同项目另一张卡片取代：状态和工作项不变，`resolution=superseded`，`superseded_by` 明确当前取代者，`related_cards` 去重加入该编号。拒绝自身、不存在、跨项目目标和未结束的原卡；目标卡片无需已完成。写入 `card_superseded` 事件（含 `card_id`、`superseded_by`）及带新卡引用的时间线。重复指定同一取代者不写新事件；更正取代者时保留已有相关卡片和历史事件。看板和列表使用现有样式变量淡化这些卡片，显示“已被 C-m 取代”，详情可跳到新卡；旧数据缺少取代编号时只显示“已被取代”，不从普通关联卡片猜测目标。

- `backlog`、`todo` 属于规划，由 PM 设置；`in_progress`、`review` 由工作项推导，规则自动更新（D4）。
- **`done` 不由规则自动触发**：主产出工作项的负责人提交完成申请（`kind=card_completion` 的交付），写明逐条验收标准的对照、证据和已知遗留；卡片模板指定的审核者（默认 PM，可以配置为你）审核通过后，经 `completion_review_passed` 进入 `awaiting_merge`；没有 Git 提交形式的交付（`subject.kind=git_head`）时同命令经 `merge_not_required` 到 `done`，否则仅合并成功经 `merge_succeeded` 到 `done`。
- 规则只做两件事：除本次完成审核项以外的必需工作项都通过后，提醒负责人可以申请；收到申请时校验前置条件（排除本次完成审核项，其余 `required` 工作项处于成功终态；没有 open 且 `blocking` 的 Decision），并把结果展示给审核者。未满足的条件必须列为已知遗留，并关联后续卡片。本次完成审核项（开发卡中的 PM 验收）在审核通过后才置为 passed，卡片再进入合并阶段，避免前置条件循环（2026-11-04 用户确认）。

`awaiting_merge --merge_conflicted--> in_progress`，`awaiting_merge --request_changes--> in_progress`，`awaiting_merge --cancel--> cancelled`。派生计算保留待合并状态，`resolution=done` 只在真正 done 时写入。待合并期间拒绝新交付和审核；合并确认增加 `request_changes`（退回修改），必须填写非空原因。退回与冲突复用同一套迁移：相应产出 accepted → changes_requested、旧完成申请 supersede、验收项 target_withdrawn 回 todo；退回修改定位完成申请所属的主产出项。原因写入时间线与 `merge_changes_requested` 事件，Router / Dispatcher 为原产出 Assignment 排 `fix` Run，其触发事件保留原因。返回执行阶段后再按原流程交付、审核、申请完成和确认合并，避免修改已确认的合并集合。

**WorkItem（produce，产出型）**

```
todo --deps met--> ready --run starts--> in_progress --submit_delivery--> delivered
delivered --all required verifiers pass--> accepted
delivered / accepted --submit_delivery (new version)--> delivered
delivered --any reject--> changes_requested --rework run--> in_progress
accepted --merge_conflicted / request_changes--> changes_requested
in_progress <--> blocked / waiting_decision
any --> cancelled
```

**没有验证项指向的产出工作项，交付即完成**（2026-11-06 用户拍板）：卡片上没有任何 `verify` 工作项以该工作项为 `target` 时，`submit_delivery` 直接把交付记为 `accepted`、工作项经 `verifiers_passed` 到 `accepted`，时间线额外记一条"无需审核"。下游依赖项仍按懒激活处理：依赖全部完成时才允许它自己的 Run 经 `dependencies_met` 推进到 `ready`（和其它路径一致）。该交付的 `requested_verifiers` 必须为空；有验证项时规则不变，仍须显式请求全部必需验证项。

普通 `report_blocker` 将原因记入 `reported_blocker`，由 PM（或人）调用 `update_work_item(status=in_progress)` 确认解除。确认先清掉这一标记；若还有关联的 open / provisional 阻塞 Decision、open HumanAction 或审核轮次用尽，确认仍成功，工作项保持原暂停状态，不排 Run。反过来先解除 Decision / HumanAction 时，未确认的报告仍阻止恢复。只有最后一个阻塞解除、且审核预算允许，才按当前暂停状态经 `resume` 或 `decision_resolved` 恢复，并输出实际 `resume_work_items`；确认事件另记 `reported_blocker_cleared=true`。已有 Run 尚未结束时继续复用，已结束则按现有快照规则排一个新 Run。没有报告标记时，此入口仍只接受既有 blocked → in_progress 的受控恢复，不得直接设置其他进度或完成状态。

M1 的外层启动只推进 Run。`report_blocker`、阻塞 `request_decision` 和包含自身工作项的 `request_human_action` 在暂停调用者自身工作项前，复用交付/审核的启动校验：必须有当前 running Run；produce 的 todo 在依赖成功后经 dependencies_met 到 ready，再经 run_started 到 in_progress，ready / changes_requested 直接经 run_started；verify 的 ready 仅在审核预算未用尽时经 run_started 到 in_progress。其他人的工作项不会被代为启动，不能暂停时错误包含编号、类型和当前状态。

工作项级 Assignment 请求 `blocking=true` 的 Decision 时，自身仍可执行的工作项去重并入 `affected_work_items`，进入 `waiting_decision` 后再结束 Run；解决最后一个阻塞后才能创建新的恢复 Run。produce 已处于 delivered / accepted 时不自动并入，也不因此结束请求者的 Run；显式要求暂停、report_blocker 或将其加入 HumanAction 阻塞列表时拒绝，并说明该工作项当前状态。新版本交付仍可按既有 delivery_submitted 迁移处理。

**WorkItem（verify，验证型）**

```
todo --target delivered--> ready --> in_progress --pass--> passed (terminal)
in_progress --reject--> failed
in_progress / failed --review_limit_exceeded (non-pass at last allowed round)--> waiting_decision
ready --next review round exceeds limit--> waiting_decision
in_progress / passed / failed --target redelivered--> ready
ready / in_progress / failed / passed --target_withdrawn--> todo
waiting_decision --decision resolved + review budget available + no other blocker--> ready
in_progress --report_blocker / blocking request_decision--> blocked / waiting_decision
blocked --resume--> in_progress
todo / ready / in_progress / failed / blocked / waiting_decision --cancel--> cancelled
```

批准绑定到交付版本：产出项已交付或已验收后仍可提交新版本，回到 `delivered`；正在审核、已通过或已驳回的验证项遇到新版本时回到 `ready`。新产出使旧完成申请失效时，PM 验收尚无新目标，通过 `target_withdrawn` 回到 `todo`，等待新的完成申请后才进入 `ready`，避免误列为下一处理人。该迁移不解除 `blocked` / `waiting_decision`，也不重开 `cancelled`。旧交付的 supersede 和旧审核失效由命令层更新。验证项只有非终态可取消，`passed` / `cancelled` 不接受 cancel；`passed` 可因新版本或目标撤回重新打开。

审核轮次上限是控制面字段，只有 PM Ops 或你能放宽，放宽动作记在 Run 上。最后一轮仍未通过（`reject` 或 `conditional`）时，在下一轮开始前让工作项进入 `waiting_decision`，生成阻塞 Decision，并以 `blocked` 结束当前审核 Run（0.5a §9.3）。先记录 `review_submitted`（`rework_allowed=false`），再记录 `decision_requested`；换新 Run 不能绕过轮次上限。最后一轮 `pass` 仍正常通过。

预算按验证工作项累计，最后一轮 pass 不会重置预算。新交付使验证项重新 ready 后，若下一轮将超限，同一命令立即经 review_limit_exceeded 进入 waiting_decision 并生成 trigger=review_limit 的阻塞 Decision：先记 delivery_submitted，再记 decision_requested。仅结束该验证 Assignment 尚在 running 的 Run，已结束 Run 和产出者 Run 不被改写。已有 open / provisional 上限 Decision 时保留等待，后续交付复用该 Decision。放宽后恢复可沿用最近已完成审核 Run 的快照，即使该 Run 原本正常完成，仍只创建新 Run。

审核上限 Decision 的 `pause` 记录为 `provisional`（保留原话，发出 `decision_provisionally_resolved`），继续阻塞，不恢复工作项或排 Run；以后可在同一 Decision 上确认 `raise_limit`。`raise_limit` 只记录同意放宽，不自行修改上限：轮次仍用尽时工作项保持 `waiting_decision`。PM Ops／人通过 `update_work_item(max_review_rounds)` 放宽后，只有剩余轮次大于零且无其他 open / provisional 阻塞 Decision、open HumanAction，才经 `decision_resolved` 回到 ready，并创建新的 queued / decision_resumed Run。先放宽、后拍板也遵守同一条件；多个阻塞由最后解除者触发恢复，事件的 `resume_work_items` 只列出实际恢复的项。已 rejected 的交付仍需产出方提交新版本后再审核；conditional 可继续审核同一版本。

**Assignment**

- 业务状态：`active` | `suspended` | `released`。S24：人停止常驻 PM 时经 suspend 到 suspended；只有显式 `pm start`／`assignment start` 能经 resume 恢复，恢复与排首个 Run 同事务，不改变工作项 Assignment 的 stop 语义。
- 运行状态：`not_provisioned → provisioning → idle ⇄ running`；异常时 `→ unknown → lost`；确认重新连通时 `unknown --reconnected--> idle`；最终 `→ released`。`lost` / `released` 不通过 reconnected 恢复。

常驻 PM 的 stop 先持久化暂停、经 cancel 结束未完成 Run 并作废 Token，再关闭终端；运行时不可用也不撤回暂停。原 RuntimeRef 保留供关闭重试，清理循环也补查已暂停的常驻 PM。恢复前确认旧终端关闭，再清除旧引用并排新 Run；未知／失联运行状态按 session_replaced 迁移恢复，新启动失败则保持暂停。项目事件保存暂停／恢复及交接信息，attention 显示暂停状态与恢复命令。

**Run**：`queued → dispatched → acked → running → completed | failed | cancelled`；运行环境失联时进入 `unknown`；确认重新连通时 `unknown --reconnected--> running`。重连不表示业务完成，已结束的 Run 不通过 reconnected 恢复。

M5.6：显式 finish_run（completed / blocked / failed）、阻塞 Decision 和审核轮次上限结束 Run 时，Assignment 的 running 经 run_finished 回到 idle，保留 RuntimeRef；这只表示没有在途业务 Run，不代表终端在线。系统在两个 Run 之间替换 Session 后，dispatchRun 校验旧 RuntimeRef 未变化、没有其他未结束 Run，若旧环境为 unknown/lost，只在原在途 Run 已明确结束后才允许经 session_replaced 回 idle，再将原 queued Run 派发与交接事件原子提交；卡片流记录系统 handoff（原因、旧 RuntimeRef、最近 Run/outcome、新 Session 先读卡片和 get_updates），常驻 PM 无卡片时间线时把同一交接正文保存在项目事件中。

**Notification（M3.2）**：一条 `(event, recipient)` 一条通知（store 唯一约束，M3.3），生命周期：

```
pending --bell--> belled --ack--> acked
pending --ack--> acked
belled --retry--> pending          （指数退避重发，§3.3）
pending / belled / delivery_failed --ack--> acked     （失败也可能已送达，§6.8）
pending / belled --deliver_failed--> delivery_failed  （wake 失败，交 PM Ops，不静默重试）
pending / belled / delivery_failed --needs_attention--> needs_attention
```

- `acked` 与 `needs_attention` 是终态：已确认或被升级的通知不再按铃、不再重发、不再改为失败。
- `delivery_failed` 不是终态（PM Ops 可能让它重新进入关注流程），但不允许回到 `pending` 或重新按铃，避免把"调用失败"当成"没送达"（§6.8）。
- 通知在 Assignment 对该卡的 ACK 游标 ≥ 通知的 `seq` 时也视为已确认（§3.2），此时同样经 `ack` 进入 `acked`。
- 升级（`needs_attention`）与投递失败（`delivery_failed`）都要给 PM Ops 一条通知；两者都不是新的 Run。

M2.1 的 queueRun / dispatchRun 是主机内部命令，只接受同项目 human/system Actor，不加入 MCP 工具清单。queueRun 创建 initial/queued Run，以自身 run_queued 事件作为 trigger_event_id，固定 Assignment 的 Role 版本及主机提供的 model / agent_cli_version；同 Assignment 已有任何未结束 Run（含 unknown）则拒绝。dispatchRun 只允许 queued → dispatched，验证 machine_id=local 和工作目录/分支/基线元数据，Assignment 经 provision、provisioned、run_started 到 running。已结束旧 Run 遗留的 runtime.running 先经 run_finished 到 idle；unknown/lost/released 不因新派发自动恢复。已登记的 worktree/branch 必须复用；同机器同路径被其他未结束 Run 占用时拒绝（当前快照只有 RoleReference，保守串行所有共享路径）。派发不推进工作项，首次 MCP 确认时才推进。M5.S 起另一条入口是 MCP 的 `assign`：Router 的 `assignment` 通知让 Dispatcher 用同一对命令排 `initial` Run，`launchRun` 负责建 worktree 和启动（`worktree=write` 的角色由主机准备分支，`readonly` 取当前有效交付 SHA），因此人不必再执行 `assignment start`。

acknowledgeRun 只接受 Run 所属 Assignment 的 Actor，由 MCP 认证后在内部调用，不增加工具许可名称。它经 acknowledge/start 将 dispatched（也兼容已 acked）推进到 running，写 started_at 和 run_started 事件，再复用 activeWork：todo 产出先检查依赖，ready 或返工项开始执行；ready 验证项检查剩余审核预算。等待目标、已交付、终态和暂停项保持原工作状态，不把启动当作解除阻塞；失败返回无部分效果。已 running 的同一 Run 在身份/快照校验后无操作，即使卡片后来已取消也不重新激活工作项。

abortDispatch 只允许同项目 human/system，须带非空 reason，将未结束 Run 经 cancel 标为 cancelled、outcome=failed，保存 summary/finished_at 并发 run_dispatch_aborted；已 cancelled 重复调用无操作，正常结束的 Run 不可再取消。运行状态为 running 时经 run_finished 到 idle 并清空 runtime_ref，保留 worktree/branch/base_sha/Session 元数据，不倒退已确认的工作项。真实终端 release、撤销 Token 和失败补偿顺序由 M2.6 负责；命令不执行或证明外部清理成功。

**Delivery**：`submitted → accepted | rejected | superseded`。

**Decision**：`open → resolved | provisional | withdrawn | superseded`；`provisional → resolved | revoked`；`resolved → revoked | superseded`。代批属于 `resolved`，由 `resolution.proxy_authority` 记录授权来源。

**HumanAction**：`open → done | cancelled`。

**Machine**：`online | degraded | offline | draining`。

### 4.5 不变量（实现和测试都要守住）

1. Role 只定义能力和配置，不拥有 worktree 或 Session。
2. 每个需要改代码的工作项，有且只有一个 Coding Assignment。需要两个开发 Agent 并行修改时，拆成两个工作项或子卡，各自独立分支。
3. 通知路由到 Assignment，再解析到它当前的 Session；不按角色广播。
4. 一个 worktree 同一时刻最多只有一个写入型 Run。
5. Assignment 可以跨多个 Run 复用 Session 和 worktree。Session 可以替换，Assignment 不替换。
6. Assignment 固定在一台机器上。跨机器只能"接管"（新建 worktree 和 Session），不能迁移。
7. 先持久化事件，再按门铃；门铃内容只有 ID。
8. 业务完成以 Delivery / Review 为准，不以 Herdr 的状态为准。
9. 交付只引用 commit SHA，由主机拉取进中心仓库后才生效；附件必须上传，不能写本地路径。
10. 不是每条评论都是 Run。Run 是有限执行：遇到 Decision 就结束，拍板后再创建新 Run。
11. 状态迁移和权限由服务端校验，不依赖 Agent 自觉遵守。
12. Run 记录所用的 Role 版本、模型和 Agent CLI 版本，保证可复现。
13. 卡片的 `done` 必须经过完成申请和审核，规则不能自动把卡片置为 `done`。
14. 交付和审核绑定到版本（SHA）：交付有新版本后，针对旧版本的审核结论自动失效。产物类附件必须带 `basis`（对应的拍板编号）。

---

## 5. 时间线与结构化条目

### 5.1 原则

> 保留时间线作为统一界面；用结构化条目承载指令、交付、审核和拍板；Run 在背后完成实际工作。

一次 Run 可以产生多条时间线条目（进度、交付、拍板请求）。一条评论也不一定触发执行。

### 5.2 条目类型

| 类型 | 谁创建 | 结构化对象 | 触发 |
|---|---|---|---|
| comment | 任何人 | — | 关联工作项时，通知该工作项的 Assignment |
| instruction | PM / 人 | 关联 WorkItem | 创建或唤醒对应 Assignment 的 Run |
| delivery | 产出型 Assignment | Delivery | 唤醒对应的验证型工作项；`card_completion` 唤醒卡片的审核者 |
| review | 验证型 Assignment | Review | 驳回时为产出方创建返工 Run |
| decision_request | 任何 Agent | Decision | 进入 Needs You；受影响工作项变为 `waiting_decision` |
| decision_resolved | 人（或 PM Office 代为记录） | Decision.resolution | 为受阻 Assignment 创建新 Run |
| human_action | 任何 Agent | HumanAction | 进入 Needs You 的"待你执行"；受影响的工作项变为 `blocked`；你完成后为受阻的 Assignment 创建新 Run |
| handoff | 系统或交接的 Assignment | — | 记录换会话、换模型时的交接内容和遗留项；新 Session 必须先确认遗留项（D5） |
| status_change / system | 系统 | Event | 按规则处理 |

### 5.3 业务拍板与工具审批的区别

- **工具审批**：是否允许 `git push`、删除文件等。由 Harness 或 Herdr 的权限机制处理，不进 Decision。
- **业务拍板**：选方案 A 还是 B、是否改需求、是否接受降级交付。一律走 Decision。

只有阻塞性问题才创建 Decision；不阻塞的建议写成普通评论，避免 Decision 泛滥。

---

## 6. 消息、路由与门铃协议

### 6.1 投递流程

1. 控制面持久化条目和 Event，分配卡片内序号 `seq`。
2. Router 计算受影响的 Assignment，必要时创建 Run（`UNIQUE(assignment_id, trigger_event_id)` 保证幂等）。
   - M1 的阻塞拍板会结束受影响的 running Run；解决最后一个阻塞原因时，可从最近的 blocked Run 快照生成新的 `decision_resumed` / queued 记录，沿用同一 Assignment 的 Role、模型和 CLI 版本。Router 复用已有的 `(assignment_id, trigger_event_id)`，不重复创建；没有历史执行快照时由后续调度器提供初始配置。
3. Dispatcher 通过 Runtime Adapter 发送门铃。
4. Agent 调用 `get_updates` 读取完整内容，再调用 `ack_events` 推进游标。
5. 没有 ACK 时：
   - 先查运行状态：Agent 正在工作就不重发，它在本次 Run 结束前会自己拉取更新；
   - Agent 空闲就重发门铃，并按指数退避控制间隔；
   - 超过阈值仍无 ACK，标记 `needs_attention` 交给 PM Ops。

M3.4 的持久化边界见 [ADR 0003](adr/0003-dispatch-delivery-boundary.md)：复用 M3.3 的 `(project_id, stream)` 游标，卡片流以卡片 ID 标识，项目级流用 PROJECT_EVENT_STREAM；每条流只消费自身游标之后的事件并按流内 seq 串行处理，不要求跨卡片的全局顺序。通知、门铃和 ACK 继续使用流内 seq。每次外部投递前先把 Assignment、Run、通知集合及租期写成持久意图，同一 Assignment 最多一个未结束意图。重启后不抢占未过租期的意图，过期且结果不确定时按 delivery_failed 升级 PM Ops，不新建第二个 Run 或静默重复调用；迟到 ACK 仍可确认失败通知。

M3.4 重发策略：首次成功投递之外最多再重发 4 次，等待间隔默认 1、2、4、8 分钟（retryBaseMs / maxRetries 可配置）；最后一次重发再等待最后一档间隔仍无 ACK 才标记 needs_attention。到期时存在任何未结束 Run 或投递意图则等待，ACK 优先；重发沿用原 Run，不重开已结束 Run、不创建第二个 Run。项目级通知仍只首次投递，项目级 ACK 协议未在本批扩展。

MCP 看门狗只观察 running Run，按本次 started_at 与 Assignment 最近任意 MCP 调用时间的较晚者计算，默认 15 分钟（inactivityGraceMs 可配置）；超时产生 needs_attention 通知并交 PM Ops，每个 Run 用持久事件去重，不改变 Run 的业务结果。PM Ops 自身的投递失败、重发用尽或活跃度告警转交 Needs You，并给 PM Office 一条简短提示；PM Office 自身失败只进入 Needs You，避免两边循环升级。

M3.4 主机循环通过 startDispatchLoop 启动：默认每轮结束后等待 1 秒，串行执行 reconcile → Dispatcher.tick → reconcile，不堆积并发 tick。失败通过必填 onError 回调报告，下个间隔再试；回调抛出则停止并清理订阅。stop() 幂等，也可由 AbortSignal 触发：先停止调度和清除等待计时器，再等待本轮外部投递及意图结算，最后停止运行时订阅；done 返回相同的完成结果。M3.5 将它接到 server 的 SIGTERM／关闭流程，必须先 await stop() 再关闭 Store 等主机资源；本接口不注册全局信号、不关闭 Agent 终端。

### 6.2 门铃格式

```
[bell] card=C-123 wi=W-4 asg=A-17 run=R-5 seq=31 kind=review_rejected
→ 请调用 card.get_updates 读取详情
```

门铃不带正文。它只是提示，可能丢失，可能重复；Agent 忙碌时，门铃还会并进它当前的回合（0.3 实测）。所以：

- 门铃里必须带 `seq`。Agent 收到后先查这个 `seq` 是否已经处理过，处理过就忽略。
- 同一 Assignment 的同一 `seq` 不重复按门铃；派生状态没有变化也不按门铃。
- PM Ops 没有新信息时保持静默，不发言。

### 6.3 Agent 侧协议（写进每个角色的 Core Prompt）

- 每次 Run 开始时调用 `get_updates`，结束前再调用一次。
- 读完后调用 `ack_events`。
- 产出必须通过 `submit_delivery` 或 `submit_review` 提交，不能只在终端里说"做完了"。
- 需要拍板时调用 `request_decision`，然后调用 `finish_run(outcome=blocked)` 结束本次 Run。
- 本次 Run 结束必须调用 `finish_run`。
- 空闲时即使没有收到门铃，也可以低频调用 `get_updates` 自查，防止漏铃。

### 6.4 路由规则

| 发生的事 | 默认通知对象 |
|---|---|
| 工作项下的新评论 | 该工作项的 Assignment（作者是它自己时不通知） |
| 卡片级普通评论，没有 @ | 不按门铃；随下一次 `get_updates` 一并读到。作者是人时，合并通知 PM Ops |
| 指令（`instruction_issued`） | 人或常驻 PM Ops 下达；对应未结束工作项的 Assignment，未指派时交给 PM Ops 分配 |
| 工作项被指派（Agent 或 PM 经 MCP `assign`） | 该工作项的 Assignment，**前提是现在就能开工**（产出型无未完成依赖，或验证型的交付已到）；还不能开工的等依赖完成或交付门铃，人从 CLI `assign` 仍由自己显式启动 |
| Delivery 提交 | 验证这个工作项的各个验证型 Assignment；验证项没有负责人、需要指派时给 PM Ops 定向通知 |
| Review 通过 | 不唤醒；检查交付是否全部通过、整卡是否满足 Done 条件 |
| Review 驳回 | 产生被审核 Delivery 的 Assignment（返工 Run） |
| Decision 请求 | 决策人：人则进入 Needs You，并给 PM Office 一条简短提示 |
| Decision 已解决 | 所有被它阻塞的 Assignment（新 Run）；没有负责人、无法恢复时给 PM Ops 定向通知 |
| 依赖完成 | 下游工作项的 Assignment；没有 Assignment 时交给 PM Ops |
| 所有必需工作项都已通过 | 提醒主产出工作项的负责人提交完成申请（不自动关卡） |
| 完成申请 | 卡片模板指定的审核者（默认 PM） |
| 请求你执行操作 | Needs You 的"待你执行"，并给 PM Office 一条简短提示 |
| 门铃发送失败 | 标记 `delivery_failed`，交给 PM Ops，不静默重试 |
| Run 结束但没有交付、审核、阻塞或决策 | PM Ops（异常） |
| Agent 空闲超过宽限期仍未调用 `finish_run` | PM Ops（`needs_attention`） |
| 运行环境失联超过宽限期 | Needs You（是否接管由你决定） |
| merge_conflicted / merge_changes_requested | 冲突产出或被退回的主产出工作项的 Assignment，run_kind=fix；退回原因随触发事件保留，无 active 负责人时交 PM Ops |
| card_merged | PM Ops 摘要 |
| merge_failed / reconcile_finding | PM Ops 升级 |

原则：

> 不是"卡片有更新就通知所有 Agent"，而是"这个事件改变了谁的下一步工作，就通知谁"。

M3.4 按每条流自身的 seq 分页；每条流分别在事务内读取当前项目快照、路由、写通知并推进 `(project_id, stream)` 游标。该流的一页中任一写入失败时，通知与该流游标一起回滚；其他流已提交的进度不受影响，重放由通知唯一约束去重。无法解析的路由保留为 PM Ops 升级。完成申请按交付自身的 requested_verifiers 投递；成功工作项使用领域状态 accepted / passed，提醒主产出申请完成时排除本次 PM 完成审核项，已关闭的卡片不再提醒。卡片 ACK 可确认 pending / belled / delivery_failed，已升级的终态不回退。ACK 游标按流分开：`ack_events` 不带 `card_id` 时推进项目级流（流键为 `""`），项目级通知同样按该游标确认。

常驻 PM（Office / Ops）的 Run 是处理事件的一次工作回合，不是产出型执行：它照常 `finish_run`，`summary` 就是结论，没有交付不算异常，因此**正常结束（`completed`）不产生 `run_attention`**。§7.2 的例外只适用于工作项型 Run 结束却没有交付、审核、阻塞或拍板；验证型的 Run 以 `submit_review` 结束也算有产出（M5.S S25）。任何 Assignment 都不因自己的 Run 结束事件被唤醒（自己给自己写汇报会形成自我循环，M5.S S4）；PM Ops 自己的 Run 失败转交 Needs You，与它自身的投递失败处理一致。

M5.S 起，工作项被指派（Agent 或 PM 经 MCP 调用 `assign`）也走这条路由：Router 给新 Assignment 一条 `assignment` 通知，Dispatcher 用与 `cardigan assignment start` 相同的 `launchRun` 排队 `initial` Run、启动终端并按门铃，不再需要人再敲一条命令（附录 A 第 2 步）。人从 CLI 指派仍走显式启动（`assign --start` 或 `assignment start`），路由不为此按铃，因此不会出现第二个 Run；启动失败走 §6.1 的投递失败路径升级给 PM Ops。验证型工作项在目标交付出现之前不能开工（产出型则是依赖未完成），此时既不排 Run 也不按铃，等交付门铃或依赖完成门铃再启动。

### 6.5 @提及解析

| 卡片情况 | 处理 |
|---|---|
| 只有一个该角色的 Assignment | 通知它 |
| 没有该角色的 Assignment | 交给 PM Ops 决定是否创建 |
| 有多个该角色的 Assignment | 要求发言人明确指定工作项；不广播 |
| 明确指定了 @A-17 或 @W-4 | 直接通知 |

### 6.6 Assignment 运行状态与投递策略

| 状态 | 策略 |
|---|---|
| 正在执行本卡 | 普通事件进入 Inbox，在本次 Run 结束前拉取；高优先级事件（取消、需求变更）由控制面决定插入、暂停或取消 |
| Session 空闲 | 唤醒 Session，创建新 Run |
| 常驻 PM 已暂停 | 门铃留在 Inbox，不自动启动或替换 Session；显式 start 的首条消息携带待处理卡片／项目和 seq，由 Agent 读取 get_updates 并 ack_events，不伪造 ACK |
| 进程已退出 | 按 `session_ref` 恢复；无法恢复则新建 Session，用卡片时间线生成交接摘要 |
| 已交付、尚未清理 | 复用原 Session 和 worktree，创建返工 Run |
| 卡片已关闭、worktree 已清理 | 创建后续工作项和新 Assignment，并引用历史 |

M3.4 的 Runtime 接线只根据未结束的业务 Run 判断忙碌，不用 Harness 的 working/idle 画面状态。已有会话沿用最近已启动 Run 的模型和 CLI 版本快照；新终端通过主机启动回调接收同一个 queued Run 和首条门铃，由回调完成凭据、provision 与 dispatch，不能再建一个 Run。投递结果与通知在事务中结算；真实 ACK 优先于迟到失败，租期过期的不确定意图保留原 Run 并升级 PM Ops。

### 6.7 合并与串行

- 同一卡片的事件串行处理，不同卡片可以并行。
- 同一 Assignment 短时间内的多条事件合并成一次门铃，例如"C-123 从 seq 17 更新到 25：1 个 Delivery、2 条 Review、5 条评论"。

### 6.8 Herdr 状态语义注意事项（已核实）

- `done` 只表示"进入空闲且尚未被查看"，不是卡片完成。
- `blocked` 来自界面识别，不覆盖所有业务阻塞。
- `agent.wait` 返回不代表业务成功。如果 Agent 原本就在工作，等到的可能是上一个回合结束。
- **任何调用方失败都不代表没送达**：超时、客户端被杀、SSH 断开、`agent_prompt_stalled`，prompt 都可能已经送达并执行（0.3 实测）。所以必须依靠 Run 幂等和门铃里的 `seq`。
- Agent 忙碌时再发 prompt，不会排成独立的回合，而是并进当前回合。
- `agent wait` 超时也不代表没完成：实测超时返回后，任务其实已经完成。
- CLI 退出码为 0 不代表 MCP 可用：Token 错误时，三个 Harness 都可能正常退出（0.4 实测）。连接是否可用，以 `whoami` 的调用结果为准。
- 状态来源因运行时而异：Herdr 0.9.x 对 Claude Code、Codex 主要靠画面检测，可能误判；herdr-core 只认程序主动上报（OSC 7501），Pi 原生支持，Claude Code、Codex 目前不支持。业务状态一律以 MCP 为准。

---

## 7. PM 前后台与 Event Router

### 7.1 同一个 PM 角色，两个执行上下文

| | PM Office（前台） | PM Ops（后台） |
|---|---|---|
| 和谁打交道 | 你 | 事件、其他 Assignment |
| 职责 | 讨论需求、创建和修改卡片、回答进展、解释阻塞、呈现拍板、阶段总结 | 处理需要判断的事件、分配和重排工作项、处理返工规划、决定是否升级给你 |
| 收到的门铃 | 只有 Needs You 新增项和重大风险的简短提示 | Router 升级上来的事件（合并后） |
| Assignment 类型 | standing | standing |
| Session 生命周期 | 长期 | 可以定期重建（事实都在控制面，重建成本低） |

两者使用同一个 Role、同一套项目规则和同一个 Card MCP。

> 它们共享"项目事实"，不共享"对话噪声"。

两个 Assignment 靠 `standing_mode`（`office` | `ops`）区分，这是由 `cardigan pm create --office|--ops` 写入一次、之后不能修改的字段。Token 的工具范围由模式决定：office 取 `pm` 角色的工具，ops 去掉 `record_decision`；`cardigan pm start`、Dispatcher 重开终端、`token issue` 都按模式签发，所以 Ops 无论换多少次 Token 都拿不到 `record_decision`。首条提示同时写明当前是前台还是后台。旧数据没有这个字段时，按最新一张 Token 推断一次并写回，之后只看字段。

### 7.2 Event Router：先规则，后 PM

能由规则确定处理的事件不调用 PM，见 §6.4。只有以下情况才升级给 PM Ops：

- 多个任务之间存在冲突，或者多张卡片争抢优先级；
- 同一交付被驳回两次及以上，需要重新规划；
- 交付与需求不一致，或者依赖关系发生变化；
- 需要判断是否暂停后续工作；
- 规则无法处理的异常（Run 结束却没有产出、长时间无 ACK 等）。

规则能确定下一步的事件不升级给 PM Ops：交付提交只唤醒它请求的验证项，验证项没有负责人、需要指派时才给 PM Ops 定向通知；拍板完成只唤醒被它阻塞的 Assignment，只有工作项因为没有负责人而无法恢复时才给 PM Ops 定向通知。`card_merged` 仍给 PM Ops 摘要，因为跨卡依赖需要 PM 判断；完成申请没有已指派的 PM 验收项时也保留定向通知（M5.S S25 后续裁定）。

### 7.3 信息分级与打断规则

| 信息 | 第一接收者 | 是否打断你与 PM Office |
|---|---|---|
| 普通评论、一般进度 | 时间线 | 否 |
| Delivery、Review 通过或驳回 | 相关 Assignment / PM Ops | 否 |
| Agent 执行失败、需要重新规划 | PM Ops | 否 |
| 需要你拍板 | Needs You + PM Office | 是，以决策卡形式 |
| 重大风险，例如需要停止发布 | Needs You + PM Office | 是 |
| 里程碑完成、阶段总结 | 项目动态 / PM Office | 可配置为定时摘要 |

规则：

> 只有"需要你做决定"或"继续执行可能造成明显损失"的信息，才允许打断主对话。

0.2 回溯的数据：14 天里 PM 收到门铃 3918 条，你自己的消息只有 464 条；PM 因门铃往你的对话里写了 3853 段汇报。随机抽 300 条逐条判断，82.7% 属于 PM 内部调度或一般进展汇报，不需要你做任何事；需要立即提醒你的只有 6%。

### 7.4 新需求与拍板

**新需求**：你在 PM Office 中提出需求后，PM Office：

1. 查找相关的已有卡片；
2. 判断是修改原卡还是新建卡片；
3. 给出影响范围和优先级建议；
4. 简单需求直接创建，复杂需求先生成草稿让你确认；
5. 创建后交给 PM Ops 分配。

**拍板**：

1. 执行 Agent 创建 Decision。
2. Decision 出现在 Needs You 里，PM Office 给出一句话摘要和建议。
3. 你可以在 Needs You 里操作，也可以在对话里说"选 A"。后一种情况由 PM Office 调用 `record_decision`，记录原话和来源。Phase 2 起，花钱、账号、权限、删除数据四类只能在 Workbench 里确认（D12）。
4. 系统唤醒受影响的 Assignment，PM Ops 据此调整后续任务。

---

## 8. 用户界面（Workbench）

### 8.1 第一版形态

- **PM Office 对话**：仍在 Herdr 窗口里。终端里的 CLI Agent 很难桥接到 Web 聊天，第一版不做；Phase 3 再考虑通过 ACP 或直连 SDK 做 Web 聊天。
- **Web Workbench**：由控制面提供，负责其余所有功能，见 8.2–8.6。

M5.1 实现的骨架（实现细节见 `docs/plans/phase-1-m5.md` §3.1–§3.3）：

- **服务与监听**：`apps/server` 里一个独立于 MCP 的监听，默认 `127.0.0.1:7781`（`CARDIGAN_WEB_PORT` 只改端口）。同一个监听提供 `/api/*` 和 `apps/web` 的构建产物。仍只绑定回环地址，配置成非回环地址时拒绝启动；从别的设备可经本机 HTTPS 反向代理访问，必须显式配置 `CARDIGAN_WEB_PUBLIC_ORIGINS`，也可继续用 `ssh -L` 隧道。该变量是逗号分隔的 HTTPS 来源列表，例如 `https://workbench.example:8443`：每项以 `https://` 开头，包含主机名，可带端口，不得带路径（含末尾 `/`）、用户名密码、查询、片段或通配符；无效配置启动时用中文报错。未设置或为空时保留原有行为。代理必须保留外部 `Host` 和浏览器的 `Origin`，TLS 由代理终止，再转发到回环监听。
- **请求校验**：`Host` 接受 `127.0.0.1:<port>`、`localhost:<port>`、所绑定的回环地址及显式配置 HTTPS 来源的 `host:port`（HTTPS 默认端口省略），其他值仍为 421（防 DNS rebinding）；写请求的 `Origin` 接受对应回环 Host 的 HTTP 来源和显式配置的 HTTPS 来源，其他值仍为 403，GET/HEAD 保持原有豁免；JSON 接口要求 `application/json`。不根据 `X-Forwarded-*`、`Forwarded` 等请求头推断来源或协议。统一安全响应头：`default-src 'self'`、禁止内联脚本、`X-Frame-Options: DENY`、`frame-ancestors 'none'`。
- **登录**：`cardigan web set-password` 交互输入两次密码（不经命令行参数），用 scrypt 加盐哈希（`node:crypto`，不加依赖）。接口为 `POST /api/login`、`POST /api/logout`、`GET /api/me`，另有只读的 `GET /api/session` 供登录页判断是否已设密码。会话 Cookie 为 HttpOnly + SameSite=Strict + Path=/，默认 7 天；请求 Host 属于显式配置的 HTTPS 来源时，登录和登出 Cookie 都加 Secure，普通回环访问不加，其余属性不变。会话记录存数据库，只保存会话标识的哈希，登出和改密码立即失效。登录失败按来源计数并退避，密码最短 12 位。经本机 HTTPS 反向代理（例如 Tailscale Serve）访问时，所有请求的来源都是回环地址，退避实际上是全局计数：连续输错会让所有设备一起等待。单人使用可以接受；不信任 `X-Forwarded-For` 等转发头，因为同机的其他账号（包括 Agent 账号）也能直接连回环端口并伪造它们。
- **凭据隔离**：MCP Token 访问 Workbench API 一律 401（API 只认会话 Cookie），会话 Cookie 对 MCP 端点无效。
- **只读接口**：`GET /api/projects`；`GET /api/projects/:id/cards`（`filter=needs_me|agent`，每张卡带 domain 派生的 `status`、`waiting_on`、`next_owners`、`why`）；`GET /api/projects/:id/cards/:card`（工作项、时间线、交付、审核、决策、附件和 §8.4 的关联区）；`GET /api/projects/:id/needs-you`（含一句话原因和已等待时长）；`GET /api/projects/:id/snapshot`（§8.3）；`GET /api/projects/:id/execution`（§8.5 的 Assignment、Run、runtime、worktree、游标）；`GET /api/projects/:id/activity`（§8.6，按卡片、角色、类型过滤并分页）。全部以 `{ kind: "human" }` 身份复用 domain 已有的查询（`projectSnapshot`、`listNeedsYou`），只读事务，不推进任何 Agent 游标。
- **实时刷新**：`GET /api/projects/:id/stream?after=<流:seq,...>`（SSE，`project` 代表项目级流），心跳 15 秒，断线重连按流补发缺失的 seq；不带 `after` 时从当前最新事件开始，不重放历史。
- **附件下载**：`GET /api/projects/:id/attachments/:id`；只有已知位图类型（png/jpeg/gif/webp/avif）可以内联，SVG、HTML 等一律 `Content-Disposition: attachment`，并附 `default-src 'none'; sandbox` 的 CSP，避免 Agent 写的文档在本站执行脚本。
- **前端**：`apps/web` 是纯 SPA，不引带样式的组件库、状态管理库和路由库；抽屉、菜单、弹出层、提示框等交互组件用 Radix 的无样式单独包（版本写死，不引 Radix Themes、Tailwind 或其他样式库），外观由自己的 CSS 变量控制（Phase 1.5 U.S-1，2026-11-08 用户拍板）。三个界面用哈希路由（`#/p/<项目>/cards?view=list|board`、`#/p/<项目>/cards/<编号>`，约 40 行解析；旧的 `board`/`list` 路由重定向到 `cards` 并保留筛选），状态放在页面组件的局部 state 里。卡片页内定位用卡片路由的 `?at=<元素 id>` 参数（例如 `#/p/<项目>/cards/<编号>?at=decision-q(2)`），不用额外的 `#fragment`：哈希本身就是路由，额外片段会替换路由并让 Workbench 回退到别的项目；解析失败时保留当前页面，不静默切换项目。Markdown 用 `markdown-it`（`html: false`，`validateLink` 只放行 http、https 和站内路径，外链自动加 `rel="noopener noreferrer"`）。样式是一份 CSS 变量表，跟随 `prefers-color-scheme` 切换深色；状态一律"文字 + 颜色"，不只靠颜色。

Phase 1.5 U5a 把看板和列表合并为一个“卡片”页：标题显示卡片总数，右侧用带文字的列表/看板切换；筛选栏使用“名称：当前值”下拉按钮、可拉伸搜索框和“显示”菜单（默认勾选编号、等待标记、负责角色、进度、更新时间和下一步，“原因”默认不勾选，其余字段仍全开；已经存在浏览器里的选择保持不变，2026-11-09 用户拍板），点卡片从右侧抽屉打开同一份卡片详情组件（`card=<编号>` 写进卡片页路由，刷新/后退可恢复或关闭）。看板空列收成竖排窄条，列表使用浅色表头、行尾箭头和总数行；抽屉顶部右侧依次为在完整页面打开、复制链接、分隔线和关闭图标。完整的视觉细节以 `docs/plans/phase-1.5-ui.md` §8.2 为准。

Phase 1.5 U1 的展示规范见 `docs/plans/phase-1.5-ui.md` §3：220px 左侧导航将 Needs You（带待处理数量）置顶，再按工作／运行分组；浅深主题使用同一套语义颜色和字号变量。页面共用标题、带说明的编号标签、中文状态词、相对／本地时间（悬停显示完整时间和时区）、空状态、筛选栏和超过六行的长内容折叠。筛选与翻页放进当前视图的哈希路由参数，复制链接、刷新和前进后退可恢复；卡片页内定位仍用 S23 的 `?at=`。项目动态使用统一中文事件名，原始类型与负载仅在展开详情中显示。Needs You 左栏数量与页面共用读结果，随现有 SSE 刷新，写操作后同时更新；各页面内部区块和交互的重新布局留给 U2–U4b，不改变 API 或安全边界。

U6c 随 Workbench 打包 Inter Variable（英文和数字）、Noto Sans SC Variable（中文）和 JetBrains Mono Variable（代码），采用固定版本的 Fontsource 包，均为 SIL OFL 1.1 授权。入口引入本地 CSS，由 Vite 输出同源 WOFF2 资产，中文保留 `unicode-range` 切片按需加载；不走外部 CDN、不将字体内联为 data URL，继续使用既有 `font-src 'self'` 和 `font/woff2` 响应。三份 OFL 原文保存在 `apps/web/public/licenses/` 并随 dist 发布。字体栈先用上述字体，再回退系统字体；正文 `text-autospace: normal` 自动处理中文与西文／数字间距，不支持的浏览器忽略；`tabular-nums` 仅用于表格、时间和计数。行内代码按所在文字的 0.92 倍，代码块 13px；字号统一取 CSS 变量，字重只用 400 与 600。

### 8.2 Needs You（常驻）

- 待你拍板的 Decision、**待你执行的操作（HumanAction）**、待你验收的交付（包括由你审核的完成申请）、高风险操作确认、需要你决定是否接管的失联 Assignment。待你执行的操作和待拍板分开显示。
  - "待你验收的交付"在第一版不会出现：唯一的开发卡模板由 PM 审核完成申请（D4），验证项也不指派给你。模板允许由你担任审核者时，再补人工审核的命令、接口和这一类的显示。
- 每一项只显示一句原因（≤40 字，来自标准原因或 Agent 原问题的裁剪），全文留在卡片页（0.5a §9.1）。
- 不紧急的拍板合并成批次呈现；阻塞性的拍板和风险立即提醒（0.2 回溯：需要你介入的事项中，72% 可以合并或延后）。
- 在 Needs You 里作答时，系统自动记录你的原话。
- 显示已等待多久。
- Decision 的 opened_at 从对应 decision_requested 事件的 created_at 取得，项目级拍板使用项目事件流；缺少事件的旧卡片数据可回退到时间线。Web 与 MCP list_needs_you 共用领域查询，由适配层注入当前时间计算非负 waited_ms；只有缺少起始事实时才返回未知，不因为没有卡片时间线而丢失等待时间。
- 可以直接操作：选方案、批准 / 驳回、要求补充信息、查看关联卡片、让 PM 解释后果。

M5.2 的人的写入口（均为 `/api/projects/:project` 下的 POST，Cookie 会话 + 同源 Origin + JSON）：

| 路径 | 操作 |
|---|---|
| `/cards/:card/comments` | Markdown 评论与 mentions，可带 work_item_id/reply_to/supersedes；身份固定为 human |
| `/cards/:card/instructions` | work_item_id + body，复用 issueInstruction |
| `/decisions/:decision/resolve` | option + 可选 raw_quote/rationale；空原话记为“在 Needs You 选择了 X”，合并确认和 keep/force_clean 都走同一路径 |
| `/decisions/:decision/comments` | action=request_information/explain，可带 body；分别 @ 发起 Assignment / 常驻 PM Office |
| `/human-actions/:action/complete` | text + 可选 attachments，复用 completeHumanAction |
| `/cards/:card/attachments` | base64 file + mime/kind/attach_to，复用 prepareAttachment/uploadAttachment；可带 sha256/basis/supersedes，单个 ≤10MiB |

写处理器读取请求体之前检查登录会话，读取之后及写事务内再次验证；写事务加载同一份项目快照；domain 拒绝时实体、事件和编号一起回滚。评论先创建条目，再把附件绑定到返回的条目编号；附件文件在事务外写入主机数据目录，后续事务拒绝时保留内容寻址文件，避免删掉共享 blob，沿用 §9.3 的清理约定。项目级决策没有卡片时间线，当前补充信息/解释评论拒绝，需在卡片上讨论；不存在可 @ 的发起方或 Office 时也明确拒绝。普通决策回答不受此限制。

Needs You 的只读接口同时提供决策 category、清理 assignment_id，以及 active 且 runtime_state 为 unknown/lost 的运行异常项，供界面排序、检查终端与定位工作树；同时返回首次失联时间、宣告 lost 时间和最近 Run，Web 与 MCP list_needs_you 共用领域查询，页面只补充展示，不增加接管操作；不由前端猜测或改业务状态。

卡片详情的 `card.references` 和每条 `timeline[].references` 返回 domain 的结构化编号引用；同一响应只构建一次引用索引，不为每条时间线重新遍历项目历史。不存在的编号 `exists=false` 且没有 card_id，前端保留原文。

M5.4 的 Needs You 使用 `#/p/<项目>/needs-you`：运行异常、阻塞/风险事项优先，普通拍板合在可折叠的一组，待执行操作独立显示。每项显示一句原因和已等待时间（页面内每分钟更新）；操作原话和结果草稿在刷新或失败后保留。拍板、补充/解释评论、完成操作调用上述 Web API；清理的 Diff、失联的终端/attention 入口提供 shell 引用后的可复制命令。项目级决策无卡片时间线时禁用补充/解释并提示到 PM 对话中说明，普通拍板仍可完成。

### 8.3 项目快照（不是消息流）

- 进行中的卡片、Review 中的卡片、阻塞中的工作项、最近的 Delivery。
- 每张卡的"下一步负责人"。
- 等待你的事项和等待 Agent 的事项分开显示。

PM Office 回答"项目现在怎么样"时，查询的就是这份快照，而不是回忆它收到过的门铃。Workbench 的 `#/p/<项目>/snapshot` 将等你/等 Agent、进行中/审核与待合并、阻塞事项和最近交付分区显示；每张卡展示下一步负责人并链接到卡片。

Phase 1.5 U4b 在快照顶部显示五项概览，按卡片计数、去重，分组可重叠；链接到列表路由的 `overview=human|agent|progress|review|blocked` 筛选，使用与快照相同的判定，避免同时等待人和 Agent 的卡片在跳转后丢失。阻塞概览沿用现有读模型中等待审核／明确阻塞的工作项范围，提示按卡片计数。下方只展示非空分区；最近交付表格显示卡片、工作项、状态、提交时间与单行截断摘要，悬停保留全文。提交时间来自该交付的 `delivery_submitted` 事件，旧数据可回退交付时间线，缺失时明确显示未知，不使用卡片的后续更新时间。

### 8.4 卡片页

主体是时间线，不同类型条目有不同样式。卡片页始终回答五个问题：

1. 目标是什么？
2. 进行到哪一步？
3. 下一步该谁做？
4. 被什么阻塞？
5. 最终由谁验收、依据是什么？

工作项清单可以折叠显示，每项包含负责人、状态和交付。

Phase 1.5 U5a 起，从“卡片”页点击卡片也可以从右侧抽屉打开同一份详情组件；抽屉顶部提供关闭、在完整页面打开和复制链接，抽屉打开状态由卡片页路由的 `card=<编号>` 表示（详见 `docs/plans/phase-1.5-ui.md` §8.2）。

卡片页右侧栏有"关联"区：列出这张卡关联的拍板（例如 `q(280)` 待批 / 已批 / 已撤回）、卡片和 PR（打开 / 已合并 / 已部署），每项显示编号和当前状态，点击即可跳转。时间线和描述里出现的编号由服务端识别后自动变成链接。domain 的 `resolveReferences` 在一致的项目快照内返回 C/W/D/A/R/V 编号、q(n)/h(n) 和 C-n#序号的类型、存在性、当前状态及所属卡片；不存在的编号保留文本，不返回卡片目标，前端不得生成链接。附件缩略图上显示所依据的拍板编号和状态，已取代的附件折叠显示。

Phase 1.5 U3 将详情分为约 760px 主栏与约 360px 的 sticky 侧栏：主栏顶部只展示编号、标题、状态和更新时间，下方展示目标、验收标准、时间线及最后的评论框；侧栏集中进度、下一步、阻塞、工作项、拍板与关联。时间线随页面滚动，按时间正序排列，默认加载最近 20 条；每次可选 20／50／100 条，数量随筛选写进路由，提供“加载更早的记录”。初次打开定位最新记录，用户交互或新快照后不再强制跟随；显式 `?at=` 优先，通过只读请求自动加载到更早的目标条目并展开系统组，重新筛选清除旧定位参数。Phase 1.5 U5c 采用方向 B：按浏览器本地日期分组，交付、审核、拍板以左侧色条和“类型、编号、结果”标题突出结论，摘要下面用一行灰色元数据展示工作项和版本；Git SHA 只显示前 7 位，点击复制完整值。U5c 最初将评论折叠为两行，U6b 按第二轮走查调整为下述完整正文卡片；连续且同一天、同类型、同作者的系统记录仍可合并。条目序号保留在悬停提示与锚点，Assignment 编号改为头部小标签。筛选（条目类型、发言方）、已加载数量和加载更早的记录压成一行，加载条数移入小菜单；菜单和提示框复用 U5-0 的公共组件。交付、审核和拍板从结构化对象展示，系统合并确认使用与 Needs You 一致的中文标题和选项名。

Phase 1.5 U6b 在方向 B 基础上增加贯穿时间线的细竖线和同尺寸线性类型图标。评论、指令及结构化记录共用角色首字母头像、粗体发言方、Assignment 小标签和相对时间头部，完整时间保留悬停提示；交付、审核、拍板继续以状态色强调结果。评论和指令使用有底色、无阴影的卡片，正文 15px、行距 1.7，默认完整显示，仅超过约 15 个渲染行时渐隐折叠。系统记录直接显示执行者、动作及相对时间，有具体详情时在行尾提供“详情”，没有行首三角；上传事件以只读字段 `attachment_id` 绑定真实附件，白名单位图在行尾以小缩略图复用 Lightbox。日期使用小字与细线。1280 宽时侧栏收为 240px，卡片抽屉最小宽度增至 780px（仍不超过视口），使正文约可容纳 40 个汉字；抽屉初始顶部、既有 `?at=` 定位和安全 Markdown 规则不变。

U6c 将交付、审核、拍板的“类型、编号、状态”移入头部右上角，与头像／发言方第一行垂直居中，状态标签右边缘对齐，带浅底色、圆点和文字；正文不再重复该标题，评论和指令右上角留空。时间线正文（含交付／审核摘要）15px，发言方与卡片小标题 14px，时间、编号、元数据、日期、系统行、状态及展开／详情控件 13px；行内代码的相对缩放沿用 §8.1。

Phase 1.5 U5b 在标题上方显示真实来源：用户原话作为可折叠引用；另一张卡片的拍板来源显示该卡编号、标题与拍板链接。相关卡片默认最多显示三张，其余折叠，没有来源或关联时不显示这一行。标题下的 sticky 区块导航按“概览、工作项、交付与审核、时间线、附件”的实际顺序平滑滚动，空区块不出现，滚动时高亮当前区块；完整工作项清单与交付／审核索引移入主栏。完整页面使用窗口滚动，抽屉使用自身滚动容器且打开仍从顶部开始；导航右端“写评论”滚动并聚焦输入框。概览末尾列出完整历史中最新的审核结论和拍板结果，最多三条，点击按原条目定位，必要时扩展时间线读取窗口。

U5b 只读模型补充来源拍板所在卡片、最多三条 `recent_conclusions`、附件 `uploader_role` 与 `uploaded_at`。上传时间严格来自该附件的 `attachment_uploaded` 事件，不用绑定条目的创建时间代替；缺少上传事实的旧数据明确显示未知。附件区使用网格，白名单位图沿用下载接口延迟加载，并用公共 Lightbox 切换预览；其他类型显示文件图标，所有附件显示编号、上传者、时间、大小与下载，被替换的版本继续折叠。附件接口及安全响应头不变。

U3 卡片读模型补充 `updated_at`（本卡事件的最后时间，空流回退创建时间），条目的 `event_type`、`author_role`、`review_id`、`decision_option`；审核编号由该条事件绑定，拍板结果和原话使用当时事件与条目，不用后来修订的决定覆盖历史。读取窗口使用 `limit`，`at` 请求会扩展窗口直到目标，不再由旧的默认 200 条限制定位。接口继续使用同一只读快照，不推进 Agent 游标。当前数据没有不可变的逐条验收证据映射，因此清单不推测勾选：完成申请整体通过只链接该申请，不把“卡已完成”或可修改的验证项文字当作逐项通过证据。正文编号采用最长编号优先的单次替换，保护已有 Markdown 链接和代码片段，生成的链接不再参与后续匹配。

### 8.5 执行视图（调试和运维）

- 展示 Assignment、Run、Session、worktree、机器、游标。
- 每个状态旁边都有动作，例如：

| 状态 | 可执行动作 |
|---|---|
| Agent 无响应 | 恢复会话、重试、更换 Agent |
| worktree 有未提交修改 | 查看 Diff、保留、强制清理 |
| Review 驳回 | 创建修复 Run |
| 失联 | 等待、接管到另一台机器 |
| 所有必需项完成 | 最终验收并关闭 |
| 任意 Assignment | 在 Herdr 中打开（给出命令或机器 + workspace） |

Workbench 的 `#/p/<项目>/execution` 展示 Assignment 的持久 PM 模式、机器、Session、登记工作树、分支、最近 MCP 活动、Run 快照/历史和 ACK 游标。最新 Run 从按编号倒序的完整列表读取，排队但尚无 started_at 的 Run 不会被旧 Run 遮住。已有未结束 Run 或卡片已关闭/等待合并时不提供启动命令；运行环境异常提供终端/attention 检查，实际停止、启动和清理由人执行现有 CLI 或 Needs You 决策。命令仅复制、不自动运行。执行视图与 Needs You 的 CLI 命令旁提示先用 `deploy/install-cli.sh` 安装 `cardigan`（§13.1），复制按钮只复制命令本身。

### 8.6 项目动态

完整事件流，可按卡片、角色、类型过滤，默认折叠。PM Ops 做过的调度和理由也记录在这里。M5.4 使用 `#/p/<项目>/activity`，按卡片编号、角色、事件类型筛选，通过 before 游标查看更早事件或返回最新；事件负载作为转义文本展开显示，保留调度理由和 actor/seq，链接回关联卡片。筛选/翻页只读，不推进 Agent 的 ACK。

M5.4 的实时刷新由当前项目共用一个 SSE 订阅：按 stream 保存已见最大 seq，断线后主动关闭旧连接，3 秒后用各流游标重连；尚未收到任何事件时显式发送 project:0，避免从“现在”开始漏掉断线变化。初次连接和重连成功均重新读取当前视图，补上建连窗口；100ms 内的事件合并刷新。卡片详情只响应本卡和项目级流，其余项目视图响应项目内事件；重复/乱序 seq 不回退游标。切换项目、登出时关闭连接和重连计时器，游标不跨项目复用。刷新保留已有数据与表单，错误可重试；连接中断时复核登录，会话失效返回登录页。

### 8.7 看板第一版范围（自研）

Agent 只通过 Card MCP 读写，看板界面只服务你一个人，所以第一版可以做得很窄。

**做：**

- 卡片列表和看板视图：按状态分列；可以筛选"等我处理"和"等 Agent 处理"。
  - U4b 看板只有一行、永不折行：展开列固定宽 280px，空列默认收成 48px 窄条，显式展开偏好放在 `expanded=<状态列表>` 路由参数中。放不下时只在看板区域内横向滚动（`overflow-x: auto`，滚动条始终可见），右侧还有列未显示完时边缘显示渐隐提示，滚到最右端提示消失；页面本身不出现横向滚动（2026-11-09 第二轮走查改为一行，取代按宽度折行）。有新卡片进入空列时自动展开。卡片展示负责角色、工作项进度、更新时间；等待拍板显示“等你拍板”、待人执行显示“待你执行”，使用等待色；仅 `waiting_on.kind=blocked` 显示红色“阻塞”。多个原因分别展示并按类型去重，普通待审核不加标记。
- 卡片详情：
  - 目标、验收标准、工作项清单；
  - 时间线，评论、指令、交付、审核、决策用不同样式显示；
  - 评论输入框，支持 @提及、Markdown、粘贴图片和附件。
- 决策卡直接在页面上操作：选方案、批准或驳回、要求补充。
- 卡片页的关联区：拍板、卡片、PR 的编号和状态，点击跳转；时间线里的编号自动变成链接；附件显示所依据的拍板状态（§8.4）。
- 界面实时刷新：按控制面的事件序号，通过 SSE 推送。
- 认证：第一版只有你一个人用账号登录，Agent 用 Token。

**不做：** 甘特图、日历、迭代周期、所见即所得编辑器、多用户权限、移动端、邮件通知。代码 diff 第一版先给出可以直接运行的 git 命令，之后再加 diff 视图。

---

## 9. Card MCP 接口

### 9.1 传输与认证

- 使用 Streamable HTTP，不用 stdio。单机也这样做，因为这是多机的前提。
- 启动前由主机为 Assignment 签发 Bearer Token，作用域为：它的卡片、工作项和角色允许的工具。
- 写操作的身份由 Token 决定，不信 Agent 在参数里自报的身份。
- 写类工具接受 `idempotency_key`；同一个键配不同的请求内容判为错误，而不是覆盖。
- Token 绑定 `(assignment_id, role_version, allowed_tools)`，Session 被替换时作废。
  - 纯函数 assign 输出 Assignment 和 Token 签发意图（含项目内唯一责任引用、Role 版本、工具集合）；Token 的随机材料、哈希及同事务存储由适配层处理，不进入 domain 输入或输出。
  - MCP 路径下 assign 仅登记 Assignment、保留 mcp_token_id 元数据，不执行 token_requests，不签发可用 Token。新建响应标记 token_status=pending_host_issuance；重复指派已存在的 Assignment 标记 host_managed，仅说明凭据归主机管理，不表示已签发。任何 MCP 响应（含重放）、幂等缓存和日志均不得携带 Token 明文。
  - 实际签发由 M1.7b 中人执行的 CLI 或 M2 启动流程负责：在同一主机侧事务里校验当前 Assignment、Role 版本及工具许可，再调用事务内 issueToken，数据库只存哈希。明文只交给人或写入目标 Assignment 自己的 MCP 配置（worktree 外），不交给 PM 或其他 Agent；Session 替换时撤销旧 Token。
- 模型 Provider 的认证和 MCP 认证相互独立；接入是否成功，以实际调用 `whoami` 的结果为准（0.4）。
- M4.4 起认证拒绝状态不是 active 的 Assignment：释放或暂停的 Assignment 即使 Token 尚未作废也一律 401。释放时作废 Token（§12.6）是第一道防线，这条检查是第二道，避免作废前继续读卡片或更新。
- 第一版可以用无状态的 Streamable HTTP：每个请求独立认证，写操作重试依靠 `idempotency_key`。
- 服务只监听局域网接口，不对公网开放；不信任的网络环境加 TLS 或走 Tailscale 之类的通道。

### 9.2 工具清单（初版）

| 工具 | 可用角色 | 作用 |
|---|---|---|
| `whoami()` | 全部 | 返回本 Assignment 的上下文：卡片、工作项、角色、机器、worktree、分支 |
| `get_card(card_id)` | 全部 | 卡片、工作项、开放的 Decision、最近的交付摘要；不含仓库路径等主机路径，Agent 的代码位置以 `whoami` 的 `worktree_path` 为准 |
| `get_updates(card_id?, since_seq?)` | 全部 | 游标之后的事件和条目 |
| `ack_events(card_id?, up_to_seq)` | 全部 | 推进游标；不填 `card_id` 时推进项目级流，和 `get_updates` 对称 |
| `post_comment(card_id, body, work_item_id?, mentions[], reply_to?, refs[], supersedes?)` | 全部 | 发评论；正文里的编号由服务端自动识别 |
| `issue_instruction(card_id, work_item_id, body)` | 仅常驻 PM Ops | 下达指令，生成 instruction 时间线和 instruction_issued 事件；人走 Workbench API |
| `report_blocker(work_item_id, reason, needs: role\|human)` | 全部 | 报告阻塞 |
| `request_human_action(card_id, instructions, why_human, expected_return, blocked_work_items[], due?) → key` | 全部 | 请求你执行只有你能做的操作，进入 Needs You |
| `request_decision(card_id?, kind, question, context, options[], recommended, affected_cards[], affected_work_items[], blocking, decider) → key` | 全部 | 发起拍板，返回编号 |
| `upload_attachment(card_id, file, mime, kind, attach_to, basis?, sha256?, supersedes?)` | 全部 | 返回附件元数据；file 为标准带填充 base64，解码后 ≤10MiB（10×1024×1024 字节）；artifact 必须有 basis |
| `heartbeat(run_id, note?)` | 全部 | 心跳 |
| `finish_run(run_id, outcome: completed\|blocked\|failed, summary)` | 全部 | 结束本次 Run |
| `submit_delivery(work_item_id, kind, summary, subject, requested_verifiers[], branch?, pr_url?, test_results?, attachments[], known_gaps[], supersedes?)` | 产出型角色 | 提交交付。`kind=card_completion` 即卡片的完成申请，只有主产出工作项的负责人可以提交。`summary` 面向人且不超过 160 字；长内容放 `test_results`、`known_gaps` 或附件 |
| `submit_review(delivery_id, target_sha, kind, issues[], attachments[], recheck_required?)` | 验证型角色 | 提交审核结论；`verdict` 和 `blocking` 由服务端计算 |
| `create_card` / `update_card` / `create_work_item` / `update_work_item` | PM | 管理卡片与工作项 |
| `assign(work_item_id, role_id, machine_id?)` | PM | 登记指派（第一版手动指定机器），Token 待主机侧签发；Agent/PM 经 MCP 指派后系统为该 Assignment 排 `initial` Run |
| `project_snapshot()` / `list_needs_you()` | PM | 项目快照和待你处理的事项 |
| `record_decision(decision_id, option, rationale, raw_quote, via_chain[]?, batch?)` | 仅 PM Office | 记录你在对话中做出的决定，`raw_quote` 为你的原话 |

你在 Web 界面上的操作走 Workbench Web API，不经过 MCP。`recordDecision` 允许人记录所有 `decider=human` 的决策，`via=needs_you`，保留非空原话；MCP 的 `record_decision` 仍限 PM Office。`issue_instruction` 同时校验角色/Token 工具许可和 Assignment 的持久模式 `standing_mode=ops`；Office 和工作项 Assignment 不显示也不能调用。工作项必须属于该卡、未 accepted/passed/cancelled，卡片不可已关闭或等待合并。

S21：MCP `create_card` 的 `repo`、`base_branch` 都可省略，分别使用 Token 所属项目登记的仓库和默认基线；默认值在写命令事务内读取。缺少可用默认值时返回 validation_failed，提示由人登记项目或显式提供字段，不猜其他项目的仓库。显式值继续按既有 domain／Git 规则处理。幂等键绑定原始请求，登记信息后来变化也不改变成功请求的重放结果。`create_card`／`update_card` 给 Agent 的响应同样隐藏 repo，主机持久化记录仍保留完整仓库信息。

M1.5 已负责 `whoami`、`get_card`、`get_updates`、`ack_events` 的实现与测试；domain 不再提供第二套同名命令。M1.3 的项目查询仅保留 `project_snapshot`、`list_needs_you`。

M1.6c 的 `heartbeat`、`finish_run` 与附件上传复用写命令的幂等事务；心跳不生成事件或时间线，结束 Run 不代表业务完成。`project_snapshot`、`list_needs_you` 不要求幂等键，在同一个只读事务中加载完整项目 CommandState 并执行 domain 查询，具有下述完整快照的规模成本。

### 9.3 服务端校验（不依赖 Agent 自觉）

- 状态迁移必须符合 §4.4 的状态机。
- 产出交付的 `requested_verifiers` 只选择 `get_card` 中 `target_work_item_id` 等于当前产出工作项的验证项，覆盖其中所有必需项；PM 验收审完成申请，不填入产出交付。完成申请仍按模板请求 PM 验收。已有工作项不符合审核目标或非空列表遗漏必需验证项时，invariant_violation 消息列出对应工作项编号。
- `submit_delivery` 时，主机按 §12.3 拉取并校验 `subject` 指定的 SHA；拉取失败或校验不通过则拒绝，被拒的请求不会覆盖已接受的交付。
  - M1 使用注入的 DeliveryVerifier 做事务外预检，生成绑定项目、Assignment、Run、工作目录/分支和 subject 的进程内凭据；同步命令在事务内重查当前状态后分配编号，输出实体变更、事件和时间线，不自行访问仓储或 Git。
  - MCP 先调用 store.runIdempotent 检查缓存；缓存命中/键冲突不做预检，未命中以内部标记回滚空事务，再在只读事务内取预检快照。prepareDelivery 在该事务关闭后执行；最终再次调用同一幂等入口，在新写事务快照上归约，原子提交实体、事件、时间线和幂等结果。失败 Result 转为抛错，编号分配也回滚；预检后重查 Token 是否已撤销。
  - M1.6a 使用可注入的 DeliveryVerifier，默认接受并返回空 evidence，不把桩结果声称为真实 Git 校验。MCP 的 CommandState 在同一事务中加载项目内各实体/Role/游标/时间线列表，以及项目级和每张卡的全部事件。成本随项目历史线性增长，每张卡还需一次事件查询；大项目会增加内存、JSON 解码时间和 SQLite 写锁占用。按相关实体收窄或提供专用快照查询属后续优化，不能拆成不一致的多次事务读取。
- `submit_review` 的 `target_sha` 必须等于目标交付的 `subject`；交付有新版本后，旧的审核结论自动失效。
- 卡片的完成申请只接受主产出工作项负责人的提交，并附上前置条件的校验结果（§4.4）。
- 产物类附件缺少 `basis` 时拒绝上传。
  - M1 的 `file` 只接受规范 base64；适配层解码、计算 sha256，若请求带 sha256 则核对；不接受客户端文件路径或存储凭据。HTTP 请求体有界（最大 base64 长度加 1MiB JSON 元数据余量），超限返回 413；附件本身超限返回 validation_failed。
  - 缓存未命中后，在数据库事务外经 prepareAttachment 调用 AttachmentStore：新建目录权限 700、文件 600，临时文件完整写入后原子发布至 CARDIGAN_DATA_DIR/attachments/<sha256>；已有同摘要文件校验内容后复用。元数据只返回相对 storage_path，不暴露主机绝对路径。apps/server 的显式 dataDir 同时用于数据库与附件。
  - 落盘后，在新的幂等事务内重查 Token、读取项目快照并执行 uploadAttachment；拒绝或持久化失败回滚所有数据库变更、编号、事件和幂等记录。已发布文件保留，可能成为未引用文件；不在失败请求中删除，以免破坏其他附件或并发上传的共享内容。重试可复用；未引用文件、崩溃残留临时文件的清理和磁盘配额留待后续，不在 M1.6 扩展实现。
- 审核最后一轮仍为 reject 或 conditional 时，不再创建返工 Run，转为阻塞 Decision 并结束当前 Run（§4.4）；只有 PM Ops 或你能放宽上限。
- 只有验证型工作项的 Assignment 能对其目标交付调用 `submit_review`。
- `record_decision` 仅限 PM Office，并且必须带 `raw_quote`。

---

## 10. Role Registry 与 Agent 启动

### 10.1 Role 字段

- 标识：`role_id`、`version`、`display_name`
- `kind`：`standing` | `work`
- 提示：`core_prompt`（包含 §6.3 的协议）、`project_rules_ref`
- 能力：`capabilities`（可承担的产出型 / 验证型工作项种类），以及 `abilities`（例如 `vision`：能否看图）。验证型工作项可以声明所需能力，路由时检查（0.2 回溯：出现过"我看不到图，画面请你判断"）
- 执行：`harness`（`claude-code` | `opencode` | `pi` | `codex` | …）、`provider`、`model`、`reasoning_effort`
- MCP：`mcp_servers[]`（Card MCP 必选，其余如设计工具 MCP）
- 权限：`permissions`，包括 MCP 作用域、Git 推送范围、是否需要 worktree
- 调度：`required_machine_tags[]`
- 其他：`budget?`、`launch_profile_ref`

Role 修改后版本号递增，Run 记录所用版本。

M2.1 的 Role 子集包含 role_id、version、display_name、kind、core_prompt、harness（claude-code/codex/pi）、launch_profile_ref、allowed_tools、capabilities、abilities、worktree（none/write/readonly）、required_machine_tags；不带运行时路径或 Session。旧 RoleReference 结构不变，roleReference(Role) 将 version 映射为 role_version。持久化和版本不可变校验归 M2.2。

### 10.2 Launch Profile（每种 Harness 一份）

每份 Launch Profile 说明以下内容：

- 启动命令模板；
- 如何指定 Provider / 模型；
- 如何注入 Core Prompt（CLI 参数、配置文件或 Agent 定义）；
- 如何写入 MCP 配置（含该 Assignment 的 Token）；
- Herdr 如何识别状态（主动上报还是画面检测）；
- 恢复会话的命令（按会话 ID，不用"继续上一次"）；
- 确切的 CLI 版本，以及**关闭自动更新**的方法（0.4 实测：Claude Code 在测试中途自动升级了一个小版本）；
- 工具许可：MCP 工具必须显式放行（Codex 默认的审批策略会拒绝调用）；
- 可用性检查：启动后调用 `whoami`，不以退出码判断；
- 超时设置。

三种 Harness 的接入方式（0.4 实测，详见 `docs/research/0.4-mcp-harness.md`）：

| Harness | MCP 配置 | 注意 |
|---|---|---|
| Claude Code | `--mcp-config <仓库外的文件>`，Token 用 `${MCP_TOKEN}` 引用；`CLAUDE_CONFIG_DIR=<run_dir>/claude` 隔离配置与会话 | 首次预置引导完成、仅当前 cwd 的信任、主题和 bypass 确认（2.1.318 实测）；关闭自动更新；按 session_id 恢复 |
| Codex | 独立的配置目录（`CODEX_HOME`），`bearer_token_env_var`；`projects.<path>.trust_level="trusted"` 只登记本 Assignment 的 worktree 和其基础仓库根 | worktree 的项目根由 Git common dir 决定（0.161.0 实测）；显式放行 MCP 工具；按 thread_id 恢复 |
| Pi | `PI_CODING_AGENT_DIR` 指向独立目录，Header 引用环境变量 | 不能用 `--no-extensions`（会关掉内置 MCP）；原生上报状态（OSC 7501） |

Claude 的配置与会话目录固定在 Assignment 的 `runs/<project>/<assignment>/claude`，跨 Run、`resume_or_replace` 保留；`launch.sh` 在启动 CLI 前由实际运行账号创建并设为 0700（local 为主机用户，agent-ssh 为 agent），拒绝软链接、非目录和其他用户持有的目录，不清空已有会话。主机只写外层启动文件，不预建或写入这个 Agent 私有目录，避免主机持有的 0700 目录阻止 Agent 保存 `.claude.json`、projects 和 sessions。

`launch.sh` 在创建目录之后、exec Claude 之前，仅当 `.claude.json` 不存在时写入 `hasCompletedOnboarding`、`lastOnboardingVersion` 和 `projects.<cwd>.hasTrustDialogAccepted`；同一次初始化中，若 `settings.json` 也不存在，写入 `theme=dark`、`skipDangerousModePermissionPrompt=true` 和 `autoMemoryEnabled=false`。文件由运行账号以 0600、noclobber 创建；已有文件不覆盖。后者只跳过配置中已选择的 bypass 模式警告，不改变 Launch Profile 的权限模式。首条位置参数前加 `--`，防止可变长的 `--allowedTools` 吞掉消息；连同预置引导状态保证首条消息正常提交。不会自动修补已有但未完成引导的配置。按 §15 D7，每次 Assignment 的 `--settings` 文件也显式设置 `autoMemoryEnabled=false`（Claude Code 2.1.318 实测），覆盖既有私有配置里的开启值；不删除历史记忆或 Session，不修改通用的人工 `cardigan launch` 配置。验证记录见 [M5.S 自动记忆验证](research/m5s-claude-memory.md)。

Codex 的基础仓库根由主机按 §12.2 的托管路径传入编译器，不由主机进入 Agent 仓库执行 Git 探测；没有 worktree 时只登记当前 cwd，不登记上层目录或通配路径。信任配置仍在 Assignment 的独立目录，不修改用户全局配置。实测步骤与边界见 [M2.S Harness 首次启动信任验证](research/m2s-harness-trust.md)。

M5.S S9：三种 Harness 的 Assignment 启动环境统一通过 `GIT_CONFIG_COUNT`／`GIT_CONFIG_KEY_n`／`GIT_CONFIG_VALUE_n` 设置 `safe.directory`，仅登记本 Assignment 的 worktree 和基础 clone。首个空值清除继承的 safe.directory 列表（包括全局 `*`），包装器清除可覆盖它的 `GIT_CONFIG_PARAMETERS`；没有 worktree 的角色不授予仓库例外。不写用户或系统 Git 配置，不信任上层目录或通配路径；该环境随会话保留，Session 替换时重新生成。

**接入点与启动配置**（2026-11-04 用户确认）

现在每个 CLI 用自己的方式区分接入点：Claude Code 用 `--settings` 文件，Codex 用 `config.toml` 的 profile，Pi 用 `/login` 和 `PI_CODING_AGENT_DIR`。日常使用时再靠 shell 别名来切换，而别名在非交互方式启动时用不了，也无法记录"这次执行用了哪个接入点"。Cardigan 用两层配置统一管理：

| 层 | 内容 | 例子 |
|---|---|---|
| 接入点（Provider） | 属于哪种 Harness、地址、模型映射，以及**密钥的引用**（只写变量名，不写值） | `of`、`sensen`、`kimi-k3`、`sensenjoy`、`deepseek` |
| 启动配置（Launch Profile） | Harness、接入点、模型、权限模式、额外参数、是否关闭自动更新、恢复会话的参数 | `claude-of`、`codex-yolo`、`pi-deepseek` |

- 角色通过名字引用启动配置。换接入点只改这个名字，角色的版本号随之递增，Run 里记录实际用的启动配置和 CLI 版本（不变量 12）。
- Cardigan 只负责生成各家 CLI 需要的东西，不替代它们原有的机制：Claude Code 用临时生成的 `--settings` 文件；Codex 用它原生的 `--profile` 和 `-c` 覆盖项；Pi 用 `--provider`、`--model` 和 `PI_CODING_AGENT_DIR`。
- **人和 Agent 共用同一套配置**：`cardigan launch <启动配置>` 按配置在当前终端里启动 CLI，可以取代各种 shell 别名；`--print` 只打印实际命令（密钥遮盖）；`check` 检查 CLI 是否安装、版本、密钥是否齐全。
- 存放位置：启动配置和接入点不含密钥，放在 `~/.config/cardigan/launch.yaml`，或者私有的 `cardigan-deploy`；密钥统一放在 `~/.config/cardigan/secrets.env`（权限必须是 600，否则拒绝读取）或系统钥匙串。都不进主仓库，也不进数据库（§14）。
- 长期方向：§13.7 的模型网关（Phase 3）把接入点收进网关，到时接入点只需指向网关。

注入的提示词、MCP 配置和 Token 一律写在 worktree 之外的 Assignment 运行目录，或者已被 git 忽略的路径，**绝不提交进仓库**。

### 10.3 Core Memory

- **固定部分**：角色说明、行为准则、协议、项目规则。放在 Role Registry，有版本，第一版就实现。
- **演进部分**：跨任务积累的经验和偏好。由 Agent 通过 MCP 提议更新，经 PM 或你审核后合入，启动 Session 时注入。放到 Phase 3。
- **定期提炼—整合（D10，2026-11-06 决定）**：在 Phase 3 的自动化做好之前，先按人工流程做。每个阶段结束时，请各项目的资深 PM 按统一的 9 节结构提炼规则，每条写明证据、可信度和适用范围：角色边界、拆任务和派活、跟进和催办、验收和审核、何时打断用户和怎么汇报、和执行 Agent 的沟通约定、失败案例、工具经验、试过但效果不好的做法。Claude 对照各份报告和现有设计，把规则分成五类：已由系统覆盖、系统缺口、进通用 Core Prompt、项目级素材、要你拍板。整合结果写成 `docs/research/` 下的研究文档，定稿的规则由实现者写进角色包。第一次整合见 `docs/research/pm-practice-distillation.md`。

### 10.4 初始角色建议

| 角色 | 类型 | worktree | 主要权限 | Harness 和模型（D3） |
|---|---|---|---|---|
| pm（office） | standing | 常驻不需要；工作项验收只读（按完成申请 SHA 检出） | PM 工具 + `record_decision` | Claude Code（Opus） |
| pm（ops） | standing | 常驻不需要；工作项验收只读（按完成申请 SHA 检出） | PM 工具（不能记录人的决定） | Claude Code（Opus） |
| designer | work | 只读（按 SHA 检出） | 设计走查：界面、交互和文案验证；设计工具 MCP；截图 | 接入移动端项目时再定 |
| coder | work | 需要 | 代码产出；只在本地 commit，没有任何推送权限 | Codex（GPT-6-Astra） |
| reviewer | work | 只读（按 SHA 检出） | 代码审核 | Claude Code（和 coder 用不同模型，交叉检查） |
| tester | work | 只读（按 SHA 检出） | 测试验收；需要带对应能力标签的机器（如真机） | 接入移动端项目时再定 |

默认角色包（`packages/roles`）已包含 `pm`、`coder`、`reviewer`、`designer`、`tester` 五个 Core Prompt。`designer` 和 `tester` 都是验证型角色：在只读 worktree 里工作，用 `submit_review` 审核当前版本，`target_sha` 必须等于被审交付的 `subject`，`verdict` 由服务端计算。

`pm（office）` 和 `pm（ops）` 是同一个角色 `pm` 的两个常驻 Assignment（§7.1）：共用角色说明和项目规则，权限按 Assignment 的 `standing_mode` 区分，只有 office 能调用 `record_decision`；模式在 `cardigan pm create --office|--ops` 时写入，之后不能修改。

每张卡的 PM 验收工作项单独指派一个工作项级的 `pm` Assignment，开独立会话完成验收，不交给常驻的 PM Ops。这样验收会话只装这张卡的上下文，也符合 §9.3"只有验证型工作项的 Assignment 能提交审核"（2026-11-05 用户确认：效果优先，可以多开 PM 会话）。工作项级 PM 验收的 `pm` 角色设为 `readonly` 时，主机按完成申请的 SHA 检出只读 worktree（复用 reviewer 的只读准备逻辑）；常驻 PM 即使共用同一个 `pm` 角色也仍然没有 worktree。

---

## 11. Runtime Adapter

控制面只通过 §11.1 的接口使用运行时，Herdr 的 workspace、tab、pane 等概念不进入 domain。基线是 herdr-core，Herdr 0.9.x 作为回退（D9，见 [`docs/adr/0001-runtime-baseline.md`](adr/0001-runtime-baseline.md)）。

### 11.1 接口（与具体实现无关）

```
provision(assignment, role, machine) -> RuntimeRef
wake(ref, doorbell) -> {sent: bool, error?}   # sent=false 也可能已经送达，见 §6.8
status(ref) -> {process: alive|exited|unknown,
                agent: working|blocked|done|idle|error|unknown, observed_seq}
interrupt(ref)
resume_or_replace(ref) -> RuntimeRef
human_entry(ref) -> string                    # 人工打开的方式
release(ref, {force}) -> result               # 只结束运行时侧的终端；worktree 清理归 §12

RuntimeRef = {machine_id, runtime_machine, terminal_ref, agent_name,
              agent_session_id?, worktree_path?, branch?}
```

- `observed_seq` 取自运行时的事件序号，不用本地时钟。
- `agent_session_id` 是 Agent CLI 自己的会话 ID，由控制面记录（D5）。herdr-core 不追踪它，Herdr 0.9.x 会上报。
- domain 的 Runtime 保留上述七个异步方法，返回独立 RuntimeResult，稳定错误码为 runtime_not_found、runtime_unavailable、version_mismatch、runtime_timeout、runtime_conflict、invalid_launch，不改变 MCP 业务错误码。provision 另接收主机编译的 RuntimeLaunch（command、args、cwd、agent_name、labels）；resume_or_replace 也接收该启动描述，方便传入恢复参数。接口不执行 IO、不接收 Token 明文；具体版本检查、事件订阅、超时和错误映射由 M2.3 实现。

### 11.2 两种实现的映射（0.3 实测）

| 接口 | herdr-core 0.1.x（基线） | Herdr 0.9.x（回退） |
|---|---|---|
| provision | 控制面先按 §12 建 worktree，再 `hc run --bg --name <全局唯一名> --cwd <worktree> --on <machine> --label assignment=<id> <启动命令>` | `worktree create --cwd <base_clone> --branch <branch> --path <§12 约定的目录>`，再 `agent start <全局唯一名> --kind <kind> --pane <root_pane>`。必须显式给 `--path`，不用 Herdr 的默认目录 |
| wake | `hc send <t> <门铃> [--if idle]`；`--wait` 等的是这次发送开启的回合 | `agent prompt <target> <门铃>`；Agent 处于 blocked 时拒绝，5 秒内没进入工作状态则报 `agent_prompt_stalled` |
| status | `hc events` 订阅：快照、增量事件、15 秒心跳；单次查询用 `hc get` | 只能轮询，以 `api snapshot` 为主（一次拿全） |
| interrupt | `hc interrupt <t>` | 没有独立命令，用 `agent send-keys <target> esc` |
| resume_or_replace | `hc run --keep`，加 Agent CLI 自己的恢复参数（按会话 ID） | 在同一 worktree 里重新 `agent start`，恢复参数透传给 Agent CLI |
| human_entry | `hc attach <machine>/<t>`（`--observe` 只看不动），或在 herdr-app 里打开 | Herdr 客户端里的机器名 + workspace |
| release | `hc kill` / `hc rm`；worktree 由 §12 清理 | `worktree remove --workspace <id> [--force]`；有未提交修改时报 `dirty_worktree_requires_force` |

状态来源：herdr-core 只认程序主动上报的状态（OSC 7501）。Pi 原生支持；Claude Code 和 Codex 目前不支持，第一版依靠 Agent 通过 MCP 调用 `finish_run`、`heartbeat` 报告，需要时在 Launch Profile 里加一个状态转换层。业务状态一律以 MCP 为准（§6.8）。

本机也当作一台机器处理（`machine_id=local`），代码路径和多机一致。

M2.3 的 HerdrRuntime 创建时检查 hc --version，默认锁 0.1.18；默认 session 为 cardigan（可用 CARDIGAN_HC_SESSION 配置）。所有调用显式设置 HC_SESSION 和 HC_SOCKET，socket 默认放在 XDG_RUNTIME_DIR/cardigan/ 下，没有运行目录变量时使用当前用户的临时目录；不继承用户 HC_SESSION/HC_SOCKET 或配置文件里的 socket 选择。读状态/订阅前先检查 socket 存在且为 Unix socket，缺失就返回 runtime_unavailable，避免读命令自动拉起 core。普通调用默认 10 秒超时；事件订阅超过 max(调用超时,20秒) 没有消息则中止，兼容 hc 的 15 秒心跳。

status 先 hc get，再取 hc events 的初始快照，同时使用该快照的状态和 seq（get 本身没有事件序号），不把 status_ms 或本地时钟当 observed_seq。events 暴露 snapshot / 增量 / heartbeat / missed 的类型、seq 和数据，可用 AbortSignal 取消；退出时回收订阅子进程。wake 的错误不能证明未送达。release(force=false) 拒绝 working/blocked；force=true 才能中止忙碌终端，正常释放使用 kill + rm，不动 worktree。resume_or_replace 采用显式替换路径：校验启动描述后释放旧终端，再用 hc run --keep 启动主机提供的恢复命令，保持 RuntimeRef 的业务元数据；Agent Session 恢复参数由主机编译，不能推断已恢复原会话。失败后的补偿由 M2.6 负责。

未分类的运行时 Error 仍返回 runtime_unavailable，但附带脱敏后的 message（最多 1000 字符），便于定位调用错误；过滤凭据标签、认证头、URL 密码、私钥块及当前进程中已知的凭据环境变量值，不转储 stack、cause、stdout/stderr 或任意异常对象。已分类的 RuntimeFailure 保留原有错误码和消息。

### 11.3 已知限制（0.3 实测）

- **门铃送达无法从调用方判断**：调用失败、客户端被杀、SSH 断开时，prompt 都可能已经送达并执行。Run 幂等和门铃里的 `seq` 是硬要求（§6.2）。
- Agent 忙碌时再发 prompt，会并进它当前的回合，不能假设"一条 prompt 等于一个回合"。
- 名字只在单个运行时实例内唯一，所以 Agent 名要全局唯一（例如 `coder-c123-w4`），并始终配合 `machine_id` 使用。Herdr 0.9.x 的 `state_change_seq` 是 server 级计数，不是单个 Agent 的计数。
- Herdr 0.9.x 专有：
  - `--machine` 不能和 `--session` 一起用，远程只能操作该机器保存的那个 session；
  - 没有事件订阅；
  - `pane run` / `pane send-text` 写进的是 pane 里的 Agent 界面，不是 shell。控制面不能用它执行命令或读写文件（herdr-core 用 `machine.exec`、`file.*`）。
- 断线时，命令行调用直接失败，没有缓存；界面上变灰的缓存状态也不能用来判断存活。
- 运行时的 socket 没有按客户端区分的身份或权限控制；同一台机器上的 Agent 能互相操作，影响范围限于这台机器（§14）。
- 多机连接：Herdr 0.9.x 验证过 Linux 连 macOS（0.3）；herdr-core 0.1.18 验证过 Linux 上的 core 管理 macOS 工作机（2026-11-05，ADR 0001 复核记录）。macOS 上的 core 管理 Linux 工作机尚未实测，Phase 2 开工前补测。
- herdr-core 的 `hc run` 选项必须写在程序名前面；没有传环境变量的选项；终端名限制为 1–32 个 `a-z 0-9 - _`。

---

## 12. Worktree 与 Git 服务

### 12.1 原则：所有 Git 网络操作由主机发起

- 中心仓库是主机数据目录下独占的 bare 仓库：`<CARDIGAN_DATA_DIR>/central/<project_id>.git`（根目录可配置），目录为主机拥有的 0700。它从 `projects.repo_path` 登记源经 `clone --bare --no-local` 临时目录校验 bare 类型和请求基线后发布；登记源始终只读，合并结果由用户自己 fetch 回去，M4 不自动推送外部平台。
- 工作机和 Agent **不持有任何 Git 凭据，不能 push**。主机通过已有的单向 SSH 从工作机拉取，并向工作机推送基线。
- 项目如果托管在 GitHub / GitLab，只有主机持有其凭据，合并后由主机推送上去。
- 参照实现（herdr-projects / Shepherdr）让工作机自己 push 到 origin，我们不采用：工作机不持有凭据，这一点不可协商。
- 单机时用同一套代码，拉取直接走本地文件路径（`git-transport` 的本地实现）。

M4.2 的 CentralRepositoryService 通过 domain 的 GitCentralPort 调用 CentralGitTransport。中心配置绑定登记源的规范路径，来源变更要求显式重建。syncFromSource 只将登记源基线 fetch 到 refs/cardigan/source/<base_branch>：中心是其祖先时用 update-ref 的旧值比较快进；相同、中心领先、分叉分别返回 up_to_date / ahead / diverged，后两者不移动中心基线。新写入型 worktree 创建前同步；分叉时仍从中心基线创建，并在返回值 `source_sync` 中报告 `diverged`，由 M4.4 组装层放进 attention，不阻塞新任务。`source_sync` 也区分快进、相同和中心领先；只读或复用已有 worktree 时不执行同步、不返回该字段，旧 worktree 和原基线记录不改。

### 12.2 布局与命名

- 每台机器每个项目一个基础 clone：`/srv/agent/repos/<project>`，来源为主机中心仓库
- worktree：`/srv/agent/worktrees/<project_id>/<assignment_id>`。Assignment 编号按项目分配，路径按项目分层。由主机的 Git 服务创建，不使用运行时的默认目录（两台机器上 Herdr 的默认目录并不一致，0.3 实测）
- 分支：`agent/<card_id>/<work_item_id>`
- provision 时记录 `base_sha`。
- 基线同步：主机把中心仓库的 main 推到各工作机基础 clone 的 `refs/remotes/origin/main`，不碰工作机当前检出的分支；工作项显式从记录的基线建 worktree。不要通过关闭 `receive.denyCurrentBranch` 来同步工作目录（0.5b 实测）。
- 只有 PM Ops 或 Router 明确要求时才 rebase 到最新基线，避免意外改动。

GitWorktreeService 经 domain 的 GitWorktreePort 调用 LocalGitTransport，并由组装层注入 CentralRepositoryService 取得中心基线，不逆向引用 transport。默认目录为 CARDIGAN_DATA_DIR/agent/repos/<project_id> 和 agent/worktrees/<project_id>/<assignment_id>，可分别配置根目录；自定义 worktreesRoot 下同样按项目分层。project_id 入路径前校验为安全片段，拒绝空串、`.`、`..`、路径分隔符和以 `-` 开头的值。只接受绝对本地仓库路径，基础 clone 使用 --no-local --no-checkout 从中心仓库经临时目录发布；fetch 显式使用中心的本地路径，并同时拉取 heads 到 remotes/origin 及 refs/cardigan/deliveries/* 固定交付。现有 clone 必须匹配中心来源；M2 的旧来源 clone 拒绝复用并提示显式重建，不自动删除。

write 工作项从 fetch 后的 origin/<base_branch> 当前提交创建 agent/<card>/<work_item>；返回 worktree_path、branch、base_sha 供 M2.6 持久化到 Assignment。既有目录必须是该基础 clone 登记的 worktree 且分支匹配，复用时不 reset、不重建、不移动工作项自己的提交或未提交文件；有已记录 base_sha 时保留它，尚未记录时返回现有 HEAD。readonly 必须提供目标提交 SHA，创建 detached worktree；M5.S S7 起，在两次 Run 之间收到新审核目标时，先同步中心固定交付，再将没有已跟踪改动的 detached worktree 检出到新 SHA，保留原 base_sha 记录；只读目录的未跟踪测试缓存保留且不阻止切换，已跟踪改动、分支不匹配或 Git 拒绝覆盖的路径冲突仍拒绝。写 worktree 的保护不变，不强制覆盖。detached 表示不挂分支，不等于文件系统只读权限。

worktree=none 跳过 Git。isDirty 包含已跟踪、暂存和未跟踪改动，仅查询。GitWorktreePort 不暴露 push；M4.3 起另有 `changes`（改动文件清单）、`diffHead`、`removeWorktree(force)`、`deleteBranch`，只由清理流程在完成备份和可删判定后调用，参数必须显式给出 `force`。外部目录、错误分支、错误来源一律拒绝覆盖。不同项目的同号 Assignment 可以在同一个 worktrees 根目录下并存，各自使用独立的基础 clone 和项目子目录，提交和未提交文件互不影响。

agent-ssh 模式中，主机不能执行 Agent 可修改仓库的 Git 配置。首次由 Agent 执行入口在受保护的临时目录里 `git init --shared=0660`（对象格式与中心一致），主机再在私有中心 bare 仓库中 `git push --atomic --receive-pack=<Agent 入口>`，成功后发布基础 clone。同步只推送 `refs/heads/*:refs/remotes/origin/*` 和 `refs/cardigan/deliveries/*`，按 Git 协议协商增量对象；不生成整仓 bundle、不改基础 clone 当前检出的分支和未提交文件。同用户模式仍直接从中心 clone/fetch。已有来源绑定同一中心的 bundle clone 也可接受后续推送，不重建工作树；来源改变仍拒绝复用。

receive-pack 与 upload-pack 共用专用 SSH 策略和 0600 凭据检查，命令绑定主机选定的基础 clone 路径、完整引用参数，忽略 Git 附加的路径；Agent 端禁 hook，并启用 transfer.fsckObjects。基础 clone 的本地查询、worktree 操作一律经 Agent 执行入口。repos 和 worktrees 的父层保持 2750，主机预建 2770 叶子供 Agent 写入。失败的非空临时 clone 不由主机递归删除，留待 M4 显式清理。

Git 超时分为两档：查询默认 30 秒（`CARDIGAN_GIT_QUERY_TIMEOUT_MS` / `queryTimeoutMs`）；clone、fetch、push、bundle 默认 30 分钟（`CARDIGAN_GIT_TRANSFER_TIMEOUT_MS` / `transferTimeoutMs`）。参数单位为毫秒，显式适配器选项优先于环境变量；必须为 1–2147483647 的整数。超时仍杀进程，错误指出操作及对应配置名。Agent 工作区查询的预算传给 hc exec，中心的传输预算直接覆盖 Git/SSH pack 流，不缓冲整个 pack 到 Node 内存。

### 12.3 交付

1. Agent 在 worktree 里 commit，不 push。
2. 调用 `submit_delivery`，带上 SHA。
3. 主机在事务前通过按项目绑定的 GitDeliveryVerifier 校验：只接受对应仓库格式的完整小写 SHA（SHA-1 为 40 位、SHA-256 为 64 位），从基础 clone 拉取数据库中 Assignment.branch 对应的分支到 refs/cardigan/incoming/<assignment_id>；不使用 Agent 提交的分支参数。Assignment 必须记录写入型分支和 worktree_path。
   - cat-file -t 必须为 commit；merge-base --is-ancestor 必须证明 SHA 属于拉取到的分支顶端快照。不存在／非 commit 与不在分支上分别拒绝，不生成候选或交付 ref。
   - 通过后只创建 refs/cardigan/candidates/<assignment_id>/<sha> 防止回收，返回 sha、branch、base_sha、commits_ahead 证据；base_sha 优先取 Assignment 记录，缺失时取项目中心基线。非 git_head 的 subject 返回空 Git 证据。
4. 数据库事务提交后，由 M4.4 调用 pinDelivery(project, delivery_id, sha) 创建 refs/cardigan/deliveries/<delivery_id>：已有同 SHA 为幂等成功，不同 SHA 拒绝，所有创建均比较旧值为不存在。固定失败不回滚已提交交付，由日志及对账从 candidates 修复。
5. backupAgentBranches 将基础 clone 的 agent/* 拉到 refs/cardigan/backups/local/agent/*。fetch 原子更新、明确不 prune；失败不推进或删除旧备份，也不改变业务结果。默认 10 分钟调度及失败日志由 M4.4 组装。基础 clone 路径尚不存在时静默跳过，先用 lstat 确认且只忽略此处的 ENOENT；断链、权限错误，以及后续中心仓库／Git／SSH 错误继续报告，不把所有 ENOENT 都当作“未建仓库”。

agent-ssh 拉取在中心仓库里运行 fetch --upload-pack，上传端复用同一专用 SSH 入口（专用密钥、独立 known_hosts、严格主机校验、禁用转发、agent@localhost）。现有 captureAgent 只返回捕获的文本，Git 需要双向二进制流；agentUploadPack 因此复用现有 SSH 参数生成流式命令，绑定主机选定的基础 clone 路径并完整引用参数，不经文本捕获或 JSON 转换。主机开启 transfer.fsckObjects；Agent 路径（含链接）缺少该入口时拒绝，不回退到主机身份。

GitDeliveryVerifier 的实例绑定项目，因为 Assignment 编号仅在项目内唯一；M4.4 必须按当前请求项目选择实例，并接入事务外 prepareDelivery／事务内新快照 submitDelivery／事务后固定流程。M4.2 不修改 MCP 的现有默认桩。

### 12.4 验证

验证型 Agent 所在机器如果还没有该 SHA，主机先把它推过去；然后在该机器上按 SHA 建立只读（detached）worktree 进行检查。

CLI 启动、server 新开／替换审核会话、已有会话每次按铃前，都从持久化状态选取目标工作项最新且未被 supersede 的交付，要求 subject=git_head；完成验收项则选择请求该验证项的完成申请。不从旧门铃取 SHA，也不回退到 main 或旧交付。共享 Git 准备逻辑放在 host（含 Agent 传输适配），保持主机只在中心执行 Git。Dispatcher 先检查没有在途 Run，再持久化投递意图，之后准备审核目录、按铃；准备失败沿用投递失败升级。审核正在执行时不改 checkout，等本次 Run 结束后处理新目标。

### 12.5 合并

- 只在主机独占的中心 bare 仓库内合并，不检出文件：依次 `merge-tree --write-tree`、`commit-tree`，全部成功后用 `update-ref <ref> <new> <old>` 比较更新基线。M4 不推送外部平台。
- 前提：整卡完成审核通过、处于 awaiting_merge。模板 merge_policy 为 confirm / auto，开发卡默认 confirm；创建卡片时固定策略，旧卡缺省 confirm。主机可通过 CommandPorts.templates 注入模板配置，MCP 参数不能改策略。
- confirm 自动生成 trigger=merge_confirmation 的人类 Decision（merge / hold / request_changes），绑定当前完成申请。人或 PM Office 记录 merge 后才可合并；hold 保留待合并状态，人或 PM Ops 可用 requestMerge 重开一份确认，旧决定被 supersede。request_changes 必须附非空原因，按 §4.4 退回主产出修改；CLI 为 `cardigan merge request-changes <C-n> --reason <原因> [--project <p>]`，Workbench 的“退回修改”先要求填写原因再提交。
- 纯函数 mergePlan 校验待合并状态、当前已接受的完成申请、确认及其他阻塞；返回每个 produce 最新未 supersede 的已接受、Git 提交形式的交付（`subject.kind=git_head`，不按 `kind` 分类），按工作项数字编号排序。未接受或尚无交付的工作项跳过，不因已知遗留阻止完成审核；前置条件仍由完成申请的 known_gaps 和后续卡片校验。没有可合并交付时同命令经 merge_not_required 完成；组装层还须校验固定 ref 与 SHA 一致。
- recordMergeResult 只允许 system，必须携带 mergePlan 的 completion_id；合并成功到 done 并发 card_merged，失败保持卡片并发 merge_failed，冲突让卡片回 in_progress、冲突产出 accepted → changes_requested。冲突会 supersede 旧完成申请、将其验收项通过 target_withdrawn 退回 todo；重新交付使旧代码审核失效，再次完成需重新确认。
- 同一卡片／完成版本／同一结果的重放无变更或事件；其他过期完成版本结果拒绝。命令不访问 Git；M4.4 按 merge_conflicted 的工作项找到原 Assignment，消费 Router 返回的 run_kind=fix 并排修复 Run。
- 出现冲突时，为原 Coding Assignment 创建一个修复 Run。
- M4.3 的 `mergeIntoBase` 返回四种结果：`merged`（新顶端与前一个基线）、`conflicted`（第一份冲突交付和冲突文件列表，**不改任何 ref**）、`stale`（比较后更新失败，说明基线被别的合并或同步推进，不强写）、`noop`（计划里的交付都已是基线祖先，重复执行不会产生第二个合并提交）。合并前逐个校验交付 SHA 等于 `refs/cardigan/deliveries/<id>`，不一致就拒绝；合并提交的作者和提交者显式设为配置的 `Cardigan <cardigan@localhost>`（可配置），不继承主机的 Git 身份。
- 合并执行循环（M4.4）处理 Git 提交形式的交付，doc、design 等类型不绕过默认 confirm 策略的人类确认；与 Dispatcher 并列运行，默认每 5 秒一轮、可配置：逐项目找出 awaiting_merge 且 mergePlan 通过的卡片，先 syncFromSource 再 mergeIntoBase，最后以 system 身份 recordMergeResult。同一项目同时只跑一个合并；`stale` 不写事件，下一轮重算；`noop` 记为 merged 并取当前基线顶端（卡片要真正到 done）；Git 抛错（例如固定 ref 与计划不一致）每份完成申请只记一条 merge_failed，不逐轮刷事件。收到 SIGTERM 时先停派发，再等当前合并结束才关闭。
- 不在工作机的 worktree 里合并。

### 12.6 清理与对账

- releaseAssignment 允许人、常驻 PM Ops 或 system；必须没有任何未结束 Run（含 queued/unknown）。system 只自动释放 done/cancelled 卡片的工作项 Assignment，不释放常驻 PM；PM Ops 只能手动释放 scope=work_item 的 Assignment；常驻 Assignment（包括 PM Office）仅允许 human 释放。Assignment 与 runtime 都经 release 迁移，保留工作目录、分支和运行时引用供清理；assignment_released 带 worktree_path/branch/token_id/runtime_ref。M4.4 在同一轮清理中作废该 Assignment 的所有 Token、释放终端。终端回收不依赖项目是否登记仓库或 Assignment 是否有 worktree；每轮也补查所有已释放 Assignment（包括由人释放的常驻项）。运行时仍存活时执行 force release，业务无未结束 Run 的前置条件仍由 domain 保证，不受 Harness 的 working 标签阻挡。terminal 不存在视为完成；失败逐项报告并在下一轮重试，不缓存失败或仅凭上次成功跳过补查，关闭未确认前不删除其 worktree。
- requestWorktreeCleanup 只允许 system 对已 released 且有 worktree 的 Assignment 发起决策，附未提交／未备份原因；trigger=worktree_cleanup、category=data_deletion、decider=human、keep/force_clean，不阻塞已释放的工作项。同 Assignment 只保留一份未决申请；已解决决定也复用，尤其 keep 后不再因对账重复询问。人或 Office 可记录原话，既有 decision_requested 路由进入 Needs You 并提示 PM Office。补丁备份、文件删除和强制清理均由 M4.3/M4.4 执行，domain 不做 IO。
- 清理判定（M4.3 `removeWorktree`）：先做一次备份拉取，把分支提交保存进中心仓库；再取 worktree 的改动文件清单和分支顶端是否已在中心仓库的某个 ref 里。写 worktree 包含未跟踪文件；只读 worktree（Assignment 无分支且 Git 登记为 detached）只看已跟踪改动，未跟踪测试缓存不算未保存工作，可随目录清理。有任一问题且未强制时返回 `needs_decision` 并附改动摘要，worktree、分支和提交都保留；强制清理时先把 `git diff HEAD` 和未跟踪文件清单写到主机目录 `<data>/cleanup/<project_id>/<assignment_id>-<时间>.patch`（0600），再删除 worktree 和分支。clean 且提交已备份时直接删除。Git 移除后的空 Assignment 目录和空项目父目录由主机用 rmdir 收尾，不递归删除 Agent 内容；已有 Git 登记消失的空目录同样可收尾，非空残留仍报告并保留。`diffWorktree` 给 `cardigan worktree diff` 提供同一份摘要和补丁。
- 定期对账（M4.3 `listWorktreeState` + 纯函数 `reconcile`）：比对基础 clone 的 `git worktree list`、worktree 根目录下的实际目录、数据库里的 Assignment 和中心仓库的固定交付 ref，报告六类发现——孤儿 worktree（存在但无 Assignment 拥有）、缺失（active Assignment 记录的 worktree 不存在）、失效登记（Git 登记了但目录已不在）、有 `git_head` 交付但没有固定 ref、M2.7 留下的失败临时 clone（`<clone 根>/.clone-*`）、登记源与中心基线分叉。**只报告，从不删除**，是否处理由组装层（M4.4）发起清理决策或放进 attention。
- 未提交、尚未被主机拉取的修改，以及 ahead / behind 数据，由 Dispatcher 通过 SSH 在对应机器上执行 git 命令获取（Herdr 没有这个 API）。agent-ssh 下这些仓库操作（`status`、`worktree list`、`diff`、`worktree remove`、`branch -D`）一律经 Agent 执行入口，主机身份的 git 只在中心仓库里运行。
- M4.4 的清理循环与合并循环并列：每轮先对 done/cancelled 卡片的工作项 Assignment 走 releaseAssignment（system），作废其所有 Token、`runtime.release` 释放终端，然后对 released 且有 worktree 的 Assignment 执行 `removeWorktree`。干净的直接删除；有未提交改动或分支未备份的发起一次 worktree_cleanup 决策；决策为 `force_clean` 时由循环执行强制删除（补丁先落盘），`keep` 则永久保留、不再询问。worktree 目录已经不存在的 Assignment 直接跳过，由对账负责报告。
- 对账循环把每轮发现写进 `reconcile_findings` 表：主键是「种类 + 主体（路径／交付／Assignment）」，记录首次发现、最近看到和已解决时间；重新出现算新发现。只有新发现（含解决后重现）写一条项目级 `reconcile_finding` 事件，由 Router 交给 PM Ops，同一发现不会每轮刷新事件。发现「有 git_head 交付但没有固定 ref」时，先尝试用 `refs/cardigan/candidates/<assignment>/<sha>` 重建固定 ref，成功就不算发现。`cardigan attention` 展示未解决的对账发现（含登记源分叉）。
- 循环周期都可配置：合并 `CARDIGAN_MERGE_INTERVAL_MS`（默认 5 秒）、清理 `CARDIGAN_CLEANUP_INTERVAL_MS`（默认 60 秒）、对账 `CARDIGAN_RECONCILE_INTERVAL_MS` 与备份 `CARDIGAN_BACKUP_INTERVAL_MS`（默认各 10 分钟）。停止信号到来时先停派发，再依次等合并、清理、对账、备份的当前一轮结束。
- `cardigan worktree diff <A-n>` 走同一份改动摘要和补丁；`cardigan worktree clean <A-n> --force` 与 `cardigan worktree keep <A-n>` 以人的身份回答未决的 worktree_cleanup 决策（原话记为命令行确认），实际删除仍由清理循环执行，命令本身不删文件。

### 12.7 写锁

同一个 worktree 已有写入型 Run 在执行时，Dispatcher 不派发新的写入型 Run，后来的事件进入 Inbox 排队。

---

## 13. 部署

### 13.1 单机（Phase 1）

所有组件都在一台机器上：控制面、数据库、Card MCP（HTTP，监听 localhost 或局域网）、运行时、所有 Agent。按 D6，Phase 1 先在工作机（Linux 笔记本）上开发和运行。
单机也必须遵守 §13.3 的约定。

主机 CLI 推荐先运行 `pnpm exec tsc -b apps/cli` 构建，再用 `deploy/install-cli.sh` 安装，无需 sudo。脚本在 `~/.local/bin` 生成 `cardigan`，调用本仓库的 `apps/cli/dist/bin.js`；主机 PATH 需包含该安装目录和 Node.js 24。支持 `--bin-dir`、`--repo`、`--runtime-env` 和只打印、不写文件的 `--dry-run`；相对路径在安装时解析。生成命令第二行是固定的 `# cardigan: managed by deploy/install-cli.sh` 标记；只覆盖第二行以 `# cardigan:` 开头的普通文件，拒绝其他文件和符号链接。仓库更新后重新构建，移动后重新安装，详见 [deploy/README.md](../deploy/README.md)。

安装的命令每次执行时加载并导出存在的 runtime.env，默认位置为 `~/.config/cardigan/agent-ssh/runtime.env`，缺失时跳过。在 `agent-ssh` 模式下，用 `id -Gn` 检查当前进程是否已有 `cardigan-share` 组身份；没有则用 `sg cardigan-share -c` 运行，每个参数及 CLI 入口路径分别做 shell 引用，避免特殊字符被执行。已有组身份或 local 模式直接运行 CLI，保留调用者的工作目录、参数和退出码。安装 CLI 不更改账号或组权限；server 仍按 Agent 安装器提示加载配置并在取得共享组身份的主机终端启动。

CLI 与 server 的 `bin.ts` 先安装警告过滤，再动态导入业务模块，保证在加载 `node:sqlite` 之前生效，直接用 `node apps/server/dist/bin.js` 启动也适用。仅屏蔽类型为 `ExperimentalWarning`、消息完整等于 `SQLite is an experimental feature and might change at any time` 的提示；其他实验性警告和普通警告仍由 Node 原样处理，不需要包装脚本用 `grep -v` 过滤。入口的退出码和错误输出格式保持不变。任务与验证范围见 [C-4 计划](plans/sqlite-startup-warning.md)。

CLI、server 与运行时配置默认共用主机用户的 `~/.local/share/cardigan`，不随启动 cwd 改变。CLI 优先使用 `--data-dir`，其次 `CARDIGAN_DATA_DIR`；server 使用 `CARDIGAN_DATA_DIR`。显式相对路径按启动 cwd 解析为绝对路径。读取或写入数据的 CLI 命令在打开数据库前向 stderr 显示 `数据目录：<绝对路径>`；设置密码时在询问密码前显示，stdout 的 JSON 输出保持原格式。已有 `.data` 数据不自动搬迁；继续使用它时需显式指定目录，安装器若使用其他路径也应保持相同配置。

人可用 `cardigan card update <C-n> [--title <标题>] [--goal <目标>] [--acceptance <标准1;标准2>] [--priority <n>] [--status backlog|todo|cancelled] [--superseded-by <C-m>] [--project <p>]` 修改、取消或标记被取代的卡片。至少指定一个修改字段，验收标准按分号拆分（命令行中需加引号）；项目省略时取 `CARDIGAN_PROJECT`，再取数据库里唯一的项目。CLI 以 human 身份在同一事务内调用 domain `updateCard` 和（指定 `--superseded-by` 时）`supersedeCard`；组合修改任一步失败则全部回滚。取消按状态机同步取消工作项，保留已通过的验证项；不开放手动设置执行进度或完成状态。对已完成卡片使用 `--status cancelled` 返回中文错误，提示建新卡并用 `--superseded-by` 标记旧卡。取代标记只接受已完成或已取消的原卡及同项目的另一张现存卡片；本次 Workbench 仅展示，不增加标记按钮。成功输出卡片编号及修改字段，非法参数或被领域状态机拒绝的转换返回中文错误和非零退出码，不写入部分改动。基础命令计划见 [C-3 CLI 修改卡片](plans/cli-card-update.md)，取代规则见 [Phase 2 P2a-5](plans/phase-2.md#2-p2a-自举做顺约-1-周)。

### 13.2 多机拓扑（Phase 2）

```
 Laptop (client only)
  ├─ Browser  -> Workbench
  └─ Herdr client (all machines in one sidebar; takeover)
                    |
 +------------------+------------------------------------------+
 | HUB (always-on)                                             |
 |  control plane + DB + Card MCP (HTTP) + attachments         |
 |  dispatcher (OS user `orchestrator`, holds SSH keys)        |
 |  central bare git repo (optional push to GitHub/GitLab)     |
 |  Herdr server (user `agent`): PM Office / PM Ops panes      |
 +-------+--------------------------------------^--------------+
   SSH hub->worker only (herdr, git fetch/push) |  HTTP only (MCP, token)
         v                                      |
 +----------------+   +----------------+        |
 | WORKER A       |   | WORKER B       |--------+
 | user `agent`   |   | user `agent`   |
 | Herdr server   |   | Herdr server   |
 | base clones    |   | devices attached|
 | worktrees      |   | tester agents  |
 | coder agents   |   |                |
 +----------------+   +----------------+
```

- 主机 → 工作机：SSH，用于 provision、门铃、状态查询、清理，以及所有 Git 操作（拉取交付、推送基线、查询状态）。
- 工作机 → 主机：只有 HTTP（MCP 和附件上传）。
- 工作机不能 SSH 到主机，也不能 SSH 到其他工作机。
- 主机必须常开，笔记本只当客户端。主机本身也可以兼做工作机。
- 主机自己的 Herdr 可以通过 `ssh agent@localhost` 作为一台机器加入，这样调度器的 SSH 密钥和 PM 窗口的用户就能分开。

### 13.3 从第一天就遵守的约定

1. Card MCP 走 HTTP，每个 Assignment 一个作用域 Token。
2. 每个 Assignment 都记录 `machine_id` 和 `runtime_ref`，单机时为 `local`。
3. Agent 名全局唯一。
4. 交付只引用 commit SHA，由主机拉取进中心仓库；Agent 不 push。
5. 附件通过 MCP 上传，不写本地路径。
6. 只在中心合并。

不遵守这些约定，单机版以后改成多机要多花约 2–3 周。

### 13.4 Agent 运行环境

| 阶段 | 方式 |
|---|---|
| 第一版 | 每台机器建专用系统用户 `agent`，Herdr server 和所有 Agent 都以它的身份运行。它没有任何机器的 SSH 密钥，碰不到你的个人文件，没有 sudo |
| 第二阶段（按需） | 每个 Assignment 一个容器 / devcontainer，或者限制网络访问 |
| 一般不需要 | 虚拟机 |

为什么第一版就要专用用户：你的几台机器之间已经互相授权。如果 Agent 用你的账号运行，它就继承了到所有机器的免密登录，一次误操作或提示注入的影响范围就是整个集群。
接受的残余风险：同一台机器上的 Agent 能通过本机 Herdr 操作其他窗口，影响范围限于这一台。

M2.7 采用 [ADR 0002](adr/0002-agent-account-isolation.md)：Linux 安装器由用户用 sudo 执行，固定 SHA256 校验 hc 0.1.18，专用 SSH 密钥只留在主机账号；agent 密码锁定、无 sudo，授权文件和 home 父层由 root 控制。Cardigan data 保持主机独占 0700；agent 工作根与 data 分开，运行目录、基础 clone 和 worktree 都按项目分层。专用共享组仅主机用户和 agent；凭据文件 0660、运行目录 2770，父层由主机控制。local 模式必须提示没有账号隔离；agent-ssh 只映射到配置的 agent@localhost，不开放任意机器。真实隔离验收留给用户安装后执行。

一键启动和 assign --start 使用同一运行模式配置；agent-ssh 的 CLI 版本查询和共享 Git 经配置好的 Agent 执行入口，不能回退到主机账号。主机写入隔离运行目录，再 provision/dispatch；排入 Run 后的目录、Git、编译、写文件及派发失败统一回收已知终端、删除 token/secrets.env、撤销新 Token 并取消 Run（记录失败阶段）。清理失败逐项报告，不跳过后续补偿。stop 在终端释放及 Token 撤销后同样清理残留凭据；worktree 保留。这套启动与回收流程实现在 `packages/host`（§20），`cardigan assignment start` 与 Dispatcher 新开会话共用同一份代码。

### 13.5 角色放置

| 角色 | 放在哪 |
|---|---|
| pm-office / pm-ops | 主机 |
| designer | 任意机器 |
| coder | 工作机，按 `max_assignments` 控制并发 |
| tester | 带能力标签的机器（真机、模拟器、GPU） |
| reviewer | 任意机器 |

### 13.6 环境一致性

- 工具链用 mise、nix 或 devcontainer 统一定义；Agent CLI 版本固定。
- provision 前做环境检查：仓库存在、`base_sha` 可以获取、工具链满足要求。不满足就拒绝派发，并在 Needs You 里提示。
- 端口：每个 Assignment 分配一段端口范围，通过环境变量传入，避免并行 worktree 的开发服务器冲突。
- 磁盘：每个 worktree 都有自己的依赖和编译缓存，要有清理策略；同一机器上尽量共享包缓存。
- 订阅制 CLI（Claude Code、Codex）需要在每台机器上分别登录。
- Agent CLI 关闭自动更新，Run 记录所用的 CLI 版本（0.4 实测：测试中途 Claude Code 自动升级了一个小版本）。

### 13.7 模型凭据

- 方案 A：每台工作机在环境变量里保存服务商 API Key。
- 方案 B（Phase 3）：主机运行模型网关，工作机只拿网关 Token。好处是密钥不落在工作机上，能按 Assignment 统计成本，也能按角色统一选模型。

### 13.8 机器登记与调度

- Machine 登记表：见 §4.3。健康状态来自 `status server` 和心跳。
- 第一版由 PM 在 `assign` 时**手动指定机器**。
- Phase 3 再做按能力标签和负载的自动分配。
- Assignment 一旦固定到某台机器，之后的 Run 都派到这台。

### 13.9 故障处理

1. 心跳超时：Assignment 运行状态变为 `unknown`，**不立即换机器重跑**，因为旧机器可能只是暂时断网，仍在改代码。失联判断不依据 CLI 的退出码，而看运行时的事件序号是否还在推进；SSH 设置连接超时（0.5b 用 3 秒验证），外层命令另设截止时间。
   - 在仍为 `unknown` 时确认重连，显式发出 `reconnected`：Assignment 运行状态回 `idle`，未结束的 Run 回 `running`；不据此判定任务成功或失败。
2. 宽限期（建议 5–10 分钟，可配置）后仍失联：变为 `lost`，进入 Needs You，由你选择等待或接管。
3. 接管：从主机最后一次拉取到的 SHA 在另一台机器新建 worktree 和 Session，用时间线生成交接摘要。原机器恢复后，它的 worktree 进入清理流程。
4. 为了让接管不丢工作：Agent 在检查点 commit；主机按 §12.3 定期拉取 `agent/*` 分支。

---

M3.4 通过主机 RuntimeMonitor 订阅每个未结束 Run 所在终端的 hc events。lost / finished / removed、快照缺少终端、订阅失败或结束先经 connection_lost 把 Assignment 和在途 Run 标为 unknown；不把终端状态当业务完成。默认 45 秒没有订阅消息也按失联处理，可用 eventSilenceMs 配置；相同 seq 的心跳刷新连接活跃度，但不重放状态变化。新订阅的完整快照可以确认重连，同一订阅丢弃重复和倒退的状态事件，旧 RuntimeRef 的迟到消息不能影响替换后的 Session。

首次失联写入持久事件作为宽限期起点（lossGraceMs 默认 5 分钟）；重复失联消息和 server 重启不重置计时。宽限期内确认 alive 时经 reconnected 恢复 Assignment=idle、Run=running；超时则只将 Assignment 标为 lost，原 Run 保持 unknown，进入 Needs You 并给 PM Office 简短提示。lost 不自动重连、不接管、不建第二个 Run。状态变更、事件与升级通知在同一事务提交，不新增迁移。RuntimeMonitor 提供 reconcile / stop 接口，订阅 abort 后等待清理；M3.5 负责实际组装。

M5.6 将两个 Run 之间的失联与在途失联分开处理：Dispatcher 投递前遇到 runtime_not_found 或 runtime_unavailable，且没有 dispatched/acked/running/unknown Run 时，先持久化投递意图，再让主机用与 provision 相同的编译产物调用 resume_or_replace。复用已排队 Run、Assignment、worktree 和运行目录，轮换 Token；成功后将新 RuntimeRef、系统 handoff 与 dispatch 一起提交，再写启动哨兵。没有在途 Run 时不依赖 RuntimeMonitor 的订阅或宽限期触发恢复；在途时继续执行上述 unknown → lost 流程，不自动替换。

resume_or_replace 在旧终端不存在时可重开；release 返回 runtime_unavailable 时仅在确认 core socket 不存在后允许继续，由 hc run 自行拉起 core。socket 仍存在但清理结果不确定时拒绝。替换失败沿用 delivery_failed 立即升级及启动补偿，不静默挂起、不自动重复替换；用户已确认该行为与 §6.8 一致，指数退避仅用于已投递但未 ACK 的门铃。CLI 会话 ID 的记录与恢复参数仍未实现；此处为新 Session，依靠交接和卡片接续。

## 14. 安全模型汇总

| 资产 / 风险 | 措施 |
|---|---|
| 主机到各工作机的 SSH 密钥 | 只由主机上的 `orchestrator` 用户持有，单向 |
| 机器间已有的互相授权 | Agent 运行在没有密钥的 `agent` 用户下 |
| Herdr Socket（无 ACL） | 接受同机 Agent 可互相操作；影响范围限于单台机器 |
| Card MCP | Token 仅由主机侧签发；MCP 不签发或返回明文，PM 不能借 assign 获取其他 Assignment 的凭据；身份和状态迁移由服务端校验 |
| Web Workbench | 仍只监听回环地址（127.0.0.1），配置成非回环地址拒绝启动；外部访问可经本机 HTTPS 反向代理，必须用 `CARDIGAN_WEB_PUBLIC_ORIGINS` 显式配置来源（格式见 §8.1），未配置时保持原有回环访问，也可用 `ssh -L` 隧道；Host/Origin 只放行原有回环值与配置来源，不信任转发头；登录用 scrypt 加盐密码哈希，会话 Cookie 为 HttpOnly + SameSite=Strict + Path=/，请求 Host 属于配置的 HTTPS 来源时登录及登出均加 Secure；数据库只存会话标识的哈希，登出和改密码立即失效；MCP Token 与会话凭据互不通用 |
| Git | 工作机和 Agent 不持有任何 Git 凭据；主机 Git 使用独占中心仓库，Agent 可写仓库内的 Git 由 Agent 执行；主机拉取／增量推送分别通过专用 SSH 的 upload-pack／receive-pack，绑定基础 clone 路径，推送只更新基线镜像和固定交付 ref；从 Agent 仓库拉取通过绑定专用 SSH 入口的 upload-pack 传递 pack 数据；中心操作清空继承的 GIT_*，禁用系统／全局配置及 hook，只允许 file 协议，启用 transfer.fsckObjects；M4 不推送外部平台 |
| 模型密钥 | 只放在环境变量或网关；不写进数据库、评论和仓库 |
| 注入的提示词和 Token | 主机写入目标 Assignment 自己的 MCP 配置，放在 worktree 外；不进入其他 Agent 的对话记录，Session 替换时作废旧 Token |
| 仓库内容中的提示注入 | Agent 没有 sudo；高风险操作走工具审批；业务变更走 Decision |
| 主机单点 | 定期备份数据库；第一版接受单点 |
| 运行时 | herdr-app 默认开启使用遥测，部署时必须关闭；herdr-core 的状态目录含终端输出和屏幕存档，按机密目录处理 |
| 运行目录和凭据副本 | local 使用 0700 / 0600；agent-ssh 使用主机与 agent 专用组的 2770 / 0660（脚本 0770），父层 2750；写入不跟随链接，读取后删除凭据；日志脱敏；release 时清理 |

---

## 15. 决策（Phase 0 已全部敲定）

| 编号 | 决策 | 结论 |
|---|---|---|
| D1 | 看板层 | **已决定（2026-10-27）**：自研看板，不依赖 Gitea 等外部看板。理由：数据只在控制面一处，不需要同步层；端到端测试不依赖外部服务；商业化不受上游约束。第一版范围见 §8.7；外部看板的评估保留在附录 C |
| D2 | 技术栈 | **已决定（2026-10-27）**：TypeScript（Node 24 LTS）+ pnpm workspace；数据库第一版用 SQLite（WAL，单写入进程），需要多写入时再迁移到 Postgres；Web 前端用 React + Vite，纯 SPA，静态文件由 `apps/server` 提供，不用 SSR。理由：官方 MCP SDK 成熟，Web 可以同语言，OpenCode / Pi 的 SDK 也是 TS，便于以后做直连适配器；实现由 AI 完成，React 生成的代码最稳定。Herdr 通过 CLI 子进程调用，与语言无关。HTTP 框架、SQLite 驱动、测试框架等细节在骨架任务的计划中确定 |
| D3 | 每个角色用哪个 Harness 和模型 | **已决定（2026-11-04）**：第一版只深度适配 Claude Code 和 Codex。pm-office、pm-ops 用 Claude Code（Opus）；coder 用 Codex（GPT-6-Astra）；reviewer 用 Claude Code，写代码和审代码由不同模型交叉检查。Pi 保留启动配置，不作为默认。designer、tester 接入移动端项目时再定。Phase 1 完成后，Cardigan 先用来管理它自己的开发 |
| D4 | 卡片完成条件 | **已决定（2026-10-29、11-04）**：完成由主产出工作项的负责人申请，默认 PM 审核，卡片模板可以改为你审核（§4.4）。哪些工作项是必需的，由卡片模板配置；第一版只提供"开发卡"模板，必需项为开发、代码审核、PM 验收 |
| D5 | Session 策略 | **已决定（2026-11-04）**：Session 跟随 Assignment，跨 Run 复用；失联或上下文过长时替换，替换时必须写交接记录（§5.2 的 `handoff`）。Agent CLI 的会话 ID 由控制面记录，恢复时用各 CLI 自带的恢复参数 |
| D6 | 机器清单 | **已决定（2026-11-04）**：第一版两台机器：一台常开的 macOS arm64 台式机做主机，一台 Linux x86_64 笔记本做工作机；Phase 1 的单机 MVP 先在笔记本上开发和运行。具体清单放在 `cardigan-deploy`。开发 Cardigan 本身不需要测试真机 |
| D7 | "core memo"的含义 | **已决定（2026-11-04）**：第一版只做固定的角色说明（Role Registry，有版本号）；演进式记忆放到 Phase 3 |
| D8 | 是否借鉴或 fork herdr-projects | **已决定（2026-11-04）**：不 fork，借鉴设计（`docs/research/0.5a-herdr-projects.md` §9） |
| D9 | 运行时基线 | **已决定（2026-11-04），2026-11-05 复核维持**：herdr-core，锁定 0.1.18；Herdr 0.9.5 作为回退。见 `docs/adr/0001-runtime-baseline.md` 的复核记录 |
| D10 | PM 角色的经验来源和人格 | **已决定（2026-11-06）**：pm 角色的规则来自各项目 PM 的实战经验，按 §10.3 的"定期提炼—整合"流程更新；PM Office 不沿用任何现有 PM 的人格和说话方式，用提炼出的规则代替。见 `docs/research/pm-practice-distillation.md` |
| D11 | 你不在时的代拍板 | **已决定（2026-11-06），Phase 2 实现**：允许 PM 按书面的常驻授权，替你决定一部分 `decider=human` 的 Decision。授权是控制面里的记录，写明范围（按 category 限定）、期限和例外；代批的 Decision 标为 `delegated`，汇总进你回来时的摘要。`spending`、`account`、`permission`、`data_deletion` 四类永远不能代批 |
| D12 | 高风险拍板的确认方式 | **已决定（2026-11-06），Phase 2 实现**：`spending`、`account`、`permission`、`data_deletion` 四类 Decision 必须由你在 Workbench 里确认，PM Office 在对话里转录的 `record_decision` 不能解决这四类；`general` 类保持现状 |

---

## 16. 实施路线图

### Phase 0 · 预研与零代码验证（1–2 周）

按讨论中确定的最小改造顺序推进：先在现有实践里验证模式，再写代码。

| 项 | 内容 | 验收 |
|---|---|---|
| 0.1 | 在现有 Herdr 实践中把 zhangliang 拆成 `zhangliang-office` 和 `zhangliang-ops`，所有门铃改发给 ops | 连续一周，主对话只被拍板和重大风险打断，ops 仍能正常调度 |
| 0.2 | 回溯现有看板项目的卡片和评论时间线：评论按 §5.2 归类；交付、审核、拍板实际写了哪些信息；PM 在哪里靠猜决定下一步 | 修订 §4.3 的字段和 §9.2 的工具参数；给出是否试行 0.1 的建议 |
| 0.3 | Herdr 预研：评估 herdr-core / herdr-app 换代，给出运行时基线（D9）的建议；一台本机 + 一台远程机，验证 `--machine` 下的 worktree create / remove、agent prompt、agent wait、agent list；断线和门铃失败的表现 | 一页结论，包含 D9 建议和确切的命令参数 |
| 0.4 | MCP 预研：每个选定的 Harness 都能连上一个带 Bearer Token 的 Streamable HTTP MCP 测试服务 | 产出各 Harness 的 Launch Profile 草稿 |
| 0.5 | 评估 herdr-projects；预研主机发起的 Git 模型：从工作机拉取 commit、推送基线、模拟断线后接管（1–2 天） | 给出 D8 的结论；Git 模型跑通 |
| 0.6 | 敲定 D3–D9（D2 已于 v0.4 决定） | 更新本文档 |
| 0.7 | 代码骨架：pnpm workspace、§20.1 的全部包、依赖方向检查 | 全新 clone 上 build / test / lint / 依赖检查全部通过；故意违反依赖方向会被拦住 |
| 0.8 | 同类产品对比、名字收尾检查（非开发） | 给出差异点和名字风险的结论 |

任务级计划见 [`docs/plans/phase-0.md`](plans/phase-0.md)。Phase 0 已于 2026-11-04 完成，各项结论见 `docs/research/`；0.1 没有单独试行，PM 前台和后台改在 Phase 1 M3 实现。

### Phase 1 · 单机 MVP（4–8 周）

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M1 | 领域模型、状态机、事件存储（seq / 游标）、Card MCP（HTTP + Token） | 状态机和不变量的单元测试；MCP 契约测试；伪造身份、非法状态迁移会被拒绝 |
| M2 | Role Registry、Launch Profile、Runtime Adapter（herdr-core，`machine=local`；开工前按 D9 复核） | 从卡片一键创建 coder 的 Assignment：worktree 建好，Agent 启动并通过 `whoami` / `get_card` 读到任务 |
| M3 | Event Router、门铃、ACK、重发、PM Office / Ops（PM 前台和后台在此实现，替代 0.1 的试行） | 路由规则表全覆盖的测试；重复门铃不产生重复 Run；同一 Assignment 的多条事件合并 |
| M4 | Git 服务：主机拉取交付、验证 worktree、中心合并、清理、对账 | 伪造的或不在该分支上的 SHA 被拒；有未提交修改的 worktree 不被静默删除；孤儿 worktree 能被发现 |
| M5 | Workbench + 自研看板（§8.7）：卡片列表和看板视图、卡片时间线、Needs You、项目快照、执行视图 | 附录 A 场景完整跑通 |

### Phase 2 · 多机（3–5 周）

| 工作 | 粗估 |
|---|---|
| 预研结论落地：远程门铃、等待、worktree、断线表现 | 1–2 天 |
| Runtime Adapter 加入机器维度；名字全局唯一 | 1–2 天 |
| 机器登记、健康检查、手动指定机器 | 2–4 天 |
| Git：基础 clone 初始化、远程拉取交付和定期拉取、基线推送、远程清理 | 3–5 天 |
| 附件上传 | 1–2 天 |
| 工作机初始化脚本：`agent` 用户、工具链、Agent CLI、凭据（移动端真机测试会更多） | 2–5 天 |
| 故障处理：`unknown` → 宽限期 → `lost` → 手动接管；半成品推送 | 3–5 天 |
| 安全收口：SSH 方向、分支权限、Token 作用域 | 2–3 天 |
| 高风险 Decision 只能在 Workbench 确认（D12） | 1–2 天 |
| 常驻授权和代拍板（D11） | 2–3 天 |

验收场景：

1. coder 在工作机 A，tester 在带能力标签（例如 `android-device`）的工作机 B，PM 在主机。验收时可以用模拟的测试 Agent，不要求接真机。
2. 执行中拔掉 A 的网线：Assignment 进入 `unknown`，宽限期后进入 Needs You。
3. 你选择接管：从主机最后拉取到的 SHA 在机器 C 继续执行。
4. A 恢复后，它的旧 worktree 进入清理流程。

### Phase 3 · 加固（按需）

- 容器隔离
- 模型网关与按 Assignment 统计成本
- 按能力标签和负载自动分配机器
- 演进式角色记忆
- 审计导出
- 直连 SDK 适配器
- PM Office 的 Web 聊天（ACP 或 SDK）
- 借鉴 Staged 的 diff 审查交互

---

## 17. 工作量汇总

| 阶段 | 粗估 | 主要不确定性 |
|---|---|---|
| Phase 0 | 已完成（2026-10-27 至 11-04） | — |
| Phase 1 | 4–8 周（含自研看板，偏上限） | Agent 是否稳定遵守 MCP 协议；Herdr 状态检测的可靠性；看板范围膨胀 |
| Phase 2 | 3–5 周（遵守 §13.3 时） | 工作机环境初始化，尤其移动端构建和真机测试 |
| Phase 3 | 4–8 周以上 | 按需取舍 |

假设：1 名熟悉全栈和 Git 的开发者，AI 辅助；局域网内互相信任；2–5 台机器；不做多租户。

---

## 18. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| Agent 不遵守协议（忘记 ACK、不调用 `finish_run`、只在终端说"做完了"） | 卡片状态停滞 | 协议写进 Core Prompt；Router 超时检测，标记 `needs_attention`；交付必须经过服务端校验 |
| Herdr 状态误判（画面检测） | 门铃重发不当 | 业务状态以 MCP 为准；Herdr 状态只作提示 |
| 运行时换代：herdr-core 仍是预览版，Herdr 0.9.x 和它并行 | Adapter 失效、接口变动 | 锁版本；Adapter 只暴露 §11.1 的接口，并做契约测试；M2 开工前复核 D9，满足回退条件就退回 Herdr 0.9.5 |
| Agent CLI 自动更新 | 执行中途行为改变，结果无法复现 | Launch Profile 关闭自动更新；Run 记录 CLI 版本 |
| 门铃丢失或重复 | 漏处理或重复执行 | seq + 游标 + Run 幂等 + Agent 自查更新 |
| PM 上下文膨胀 | 判断质量下降 | 前后台分离；PM Ops 定期重建会话；用快照代替历史 |
| Decision 泛滥 | 你被频繁打扰 | 只有阻塞性问题才能创建；PM Office 合并呈现 |
| 多机环境不一致 | 构建失败、误报 | 初始化脚本 + provision 前环境检查 |
| 并行分支冲突 | 合并失败 | 只在中心串行合并；冲突时创建修复 Run |
| 主机单点 | 调度停摆 | 定期备份数据库；Agent 在本次 Run 内可以继续工作，恢复后对账 |
| 磁盘和端口耗尽 | 运行失败 | 清理策略、端口范围、`max_assignments` |
| 自研看板范围膨胀 | 拖慢 Phase 1 | 严格按 §8.7 的"做 / 不做"清单；Agent 不用界面，界面只服务一个人 |

---

## 19. 参考资料

- Herdr：[仓库](https://github.com/herdrdev/herdr) · [Agent Automation](https://herdr.dev/docs/agent-automation/) · [Socket API](https://herdr.dev/docs/socket-api/) · [Agents](https://herdr.dev/docs/agents/) · [Plugins](https://herdr.dev/docs/plugins/) · [Session State](https://herdr.dev/docs/session-state/) · [Connecting machines](https://herdr.dev/docs/connecting-machines/) · [Persistence and remote access](https://herdr.dev/docs/persistence-remote/) · [CLI reference](https://herdr.dev/docs/cli-reference/) · [Worktree API 源码](https://github.com/herdrdev/herdr/blob/master/src/app/api/worktrees.rs)
- [herdr-projects](https://github.com/eliasstravik/herdr-projects) · [herdr-mesh](https://github.com/runchr-works/herdr-mesh)
- OpenCode：[Agents](https://opencode.ai/docs/agents/) · [SDK](https://opencode.ai/docs/sdk/) · [Permissions](https://opencode.ai/docs/permissions/) · [Worktree API](https://github.com/sst/opencode/blob/dev/packages/protocol/src/groups/worktree.ts)
- Pi：[仓库](https://github.com/earendil-works/pi) · [Security](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md)
- Goose：[文档](https://goose-docs.ai/) · [Subagents](https://goose-docs.ai/docs/guides/context-engineering/subagents)
- DeepSeek Harness：[Architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md) · [Worktrees](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/worktrees.md) · [Safety](https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md)
- ACP：[Agent Client Protocol](https://agentclientprotocol.com/overview/introduction)

---

## 20. 仓库规划

原则：第一版用一个主仓库（monorepo）。只有满足以下任一条件才单独拆仓库：

- 上游或许可证不同，例如 fork 别人的项目；
- 访问权限不同，例如含机器清单的私有部署配置；
- 发布节奏或使用方不同，例如以后公开的角色模板市场。

| 仓库 | 可见性 | 内容 |
|---|---|---|
| `cardigan` | 私有（商业化方式确定前） | 全部产品代码和文档 |
| `cardigan-deploy` | 私有 | 你自己的环境：机器清单、工作机初始化脚本（`agent` 用户、工具链、Herdr、SSH 密钥分发）、主机 compose、备份脚本、环境变量模板（密钥本身不入库） |

### 20.1 主仓库结构

技术栈见 D2：TypeScript + pnpm workspace。

```
cardigan/
├── AGENTS.md            # 所有模型共用的规则；CLAUDE.md 用 @AGENTS.md 引用
├── docs/                # 开发方案、架构决策记录（adr/）、各阶段任务计划（plans/）
├── packages/
│   ├── domain/          # 纯领域模型：实体、状态机、不变量、端口接口（不做 IO）
│   ├── store/           # 数据库表结构、迁移、事件存储、游标
│   ├── mcp-server/      # Card MCP（HTTP、Token、工具定义）
│   ├── router/          # 事件路由与派发
│   ├── git-service/     # 交付校验、合并、清理、对账
│   ├── git-transport/   # 主机发起的 Git 操作：本地 / SSH 拉取、基线推送、定期拉取
│   ├── runtime-herdr/   # 运行时适配：Herdr 实现
│   ├── host/            # 主机侧启动编排：签发 Token、编译并写运行目录、provision、dispatch、失败补偿
│   └── roles/           # 默认角色包 + 各 Agent CLI 的启动配置
├── apps/
│   ├── server/          # 把各包组装起来的主进程，跑在主机上
│   ├── web/             # 工作台 + 自研看板（§8）：React + Vite SPA
│   └── cli/             # 管理命令：添加机器、指派、自检
├── e2e/                 # 端到端测试：SQLite + 本地 bare 仓库 + 模拟 Agent，跑附录 A
└── deploy/examples/     # 通用部署示例（不含任何真实环境信息）
```

### 20.2 依赖方向

`domain` ← `store` / `router` / `mcp-server` / `git-service` / `roles` ← `runtime-herdr` / `git-transport` ← `host` ← `apps`

- `domain` 不依赖任何其他包；运行时和 Git 传输通过 `domain` 中定义的端口接口接入。
- `host` 是包和 apps 之间的一层：`cardigan assignment start` 与 Dispatcher 在终端已退出时新开会话走**同一份**启动流程（`launchRun`），Token 轮换、启动编译、运行目录写入、provision、dispatch、start 哨兵和失败补偿只实现一次；apps 之间不互相依赖，只依赖 `host`。CLI 保留参数校验、启动配置和模型选择、`queueRun` 与 worktree 准备，server 只把门铃文本和系统 Actor 交给这份实现。
- apps 只能依赖本层以下（`host` 及其下的包），`host` 只能依赖 `packages` 中它下面的层，`.dependency-cruiser.cjs` 的分层表与本节一致。
- CLI 和 server 的启动警告过滤共用 `@cardigan/host/warnings` 独立子路径；该模块无业务依赖，不经 `host` 主入口导入，避免在安装过滤前间接加载 SQLite。
- 用 lint 规则强制依赖方向（dependency-cruiser 或 TypeScript project references）。以后要拆包或换实现（例如直连 SDK 的运行时）时几乎不用改代码。

### 20.3 被开发项目怎么接入

目标项目保持独立仓库，只需加入两样东西：

- `AGENTS.md`：该项目的规则；
- `.cardigan/project.yaml`：卡片模板、必需工作项、测试命令、端口范围等。

接入新项目不需要改 Cardigan 本身。

### 20.4 开发 Cardigan 本身的分工

| 角色 | 模型 / 工具 | 职责 |
|---|---|---|
| 规划 | Claude | 写各阶段的任务级计划 |
| 实现 | Codex（Codex CLI）、DeepSeek（Pi） | 实现功能，附带单元测试 |
| 验收测试 | 另一个实现模型（交叉） | 根据计划写验收测试和契约测试 |
| 审核 | Claude | 只审核、提修改意见，不提交代码 |
| 合并 | Claude | 常规 PR 审核通过后由 Claude 合并，并给用户一份合并 brief；涉及需要用户拍板的事项（产品或架构决策、范围变化、安全取舍、对外发布、花钱）时，由用户决定后再合并；冲突退回实现者修复 |

DeepSeek 的 Pi 环境：

- 插件在项目级声明（`.pi/settings.json`），不写用户级配置：
  - `pi-subagents`：子 Agent（scout / worker / reviewer 等）；
  - `pi-web-access`：查文档和资料，默认无需 API key；
  - `cc-safety-net`：拦截破坏性命令（如 `git reset --hard`、`git push --force`、危险的 `rm -rf`）和读取密钥文件。Pi 执行工具前不会逐条确认，所以需要这层防护。
- 首次在本仓库启动 Pi 时需要信任项目，否则以上插件不加载。
- 本项目不加载用户级的 lark skill（与开发 Cardigan 无关，只会增加提示词）。Pi 的项目级排除规则管不到用户级目录，所以 `.pi/settings.json` 先显式列出 `~/.agents/skills`，再排除 `lark-*`（Pi 1.4.0 实测有效）。
- 模型密钥用 Pi 的 `/login` 保存到 `~/.pi/agent/auth.json`（权限 600），不放进环境变量，也不写进仓库。这样 Pi 启动的子进程不会从环境变量继承到密钥。
- Pi 每个目录只读第一个找到的上下文文件，顺序为 `AGENTS.override.md`、`AGENTS.md`、`CLAUDE.md`。因此在本仓库中 Pi 读 `AGENTS.md`，不会读到 Claude 的角色说明。

---

## 附录 A · 端到端验收场景（Phase 1 M5）

基于讨论中的"0.2.5 发版后的相关改动与验收"卡片：

1. 你在 PM Office 提出需求，PM Office 按开发卡模板创建卡片 C-1（§15 D4），并补充产品确认、设计走查和测试验收，共包含以下工作项：
   - 产品确认（produce，PM）
   - 开发（produce，coder，required，模板项）
   - 代码审核（verify→开发，reviewer，required，模板项）
   - 设计走查（verify→开发，designer，required）
   - 测试验收（verify→开发，tester，required）
   - PM 验收（verify，PM，required，模板项）
2. 产品确认完成后，开发工作项变为 `ready`。PM Ops 指派 coder，系统建立 Assignment、worktree 和分支，并按门铃。
3. coder 读取卡片，实现并在本地提交（不 push），提交 Delivery D-1（附带前后对比的附件，附件带上对应的拍板编号）。
4. 代码审核、设计走查和测试验收自动进入 `ready`，三个 Assignment 被唤醒。全程不打扰你。
5. 代码审核和设计走查提交 `pass`；测试验收提交 `reject`（例如真机上起飞有空白帧）。
6. 系统为原 coder 的 Assignment 创建返工 Run，复用原 Session 和 worktree；D-2 提交后，D-1 标记为 `superseded`。
7. 测试验收复核 D-2 时再次 `reject`。第二次返工中，coder 发现需要改变产品行为，在交付新版本之前调用 `request_decision`（blocking），开发进入 `waiting_decision`，本次 Run 以 `blocked` 结束。（已交付的产出项调用 `request_decision` 不会结束请求者的 Run，见 §4.4，所以拍板发生在交付之前。）
8. Needs You 出现该 Decision，PM Office 给你一句话提示。你在对话里说"按方案 A"，PM Office 调用 `record_decision` 记录。
9. 系统为 coder 创建 `decision_resumed` Run，产出 D-3（D-2 标记为 `superseded`）；代码审核、设计走查和测试验收复核通过。默认审核上限是 3 轮，测试验收在第 3 轮通过，不触发上限 Decision。
10. 所有必需项都通过后，系统提醒 coder 提交完成申请；PM 审核通过，卡片进入 Done，并合并到主干（需要你确认）。
11. worktree 被清理，时间线完整记录全过程。
12. 你随后问"现在整体怎么样"，PM Office 查询项目快照作答，不需要重放门铃历史。

通过标准：

- 只因"产品口径需要你拍板"和"合并确认"打断你，不出现系统内部原因的打扰（运行失联、投递失败、清理询问等）（2026-11-08 用户确认；原标准"只在第 8 步和第 10 步被打断"假设整个需求只有一个产品问题，M5.S 实测中真实需求有多处口径需要定）；
- 门铃人为重复发送不产生重复 Run；
- 中途重启 Herdr server 后，所有 Assignment 都能恢复或得到明确处理。

---

## 附录 B · 讨论来源

- `2026-10-24-220532-httpsgithubcomblockbuzzgit-httpsgithub.txt`：调研、选型、数据模型、PM 前后台
- `2026-10-24-231212-….txt`：多机部署
- `kimi-export-session_-20261024-151119.md`：另一个 Agent 的多机评估（已合并：专用用户、手动指定机器、`unknown` + 宽限期）
- 2026-10-25 至 10-27 的会话（尚未导出）：看板工具评估（附录 C）、定名、仓库规划、自研看板、主机发起的 Git 模型
- 2026-10-27 至 11-04 的 Phase 0 预研结论见 `docs/research/`。
- 以上讨论记录不在本仓库中。

---

## 附录 C · 开源看板工具评估（2026-10-25）

> v0.3 结论：不采用外部看板，决定自研（见 §15 D1）。以下评估保留作参考。

筛选标准：

1. 开源，可以商业化；
2. 轻量，测试和部署简单，迭代快；
3. 能作为本系统的看板层：有 API、Webhook、评论时间线，能给每个 Agent 建独立身份。

### C.1 结论

| 推荐度 | 工具 | 理由 |
|---|---|---|
| 首选 | **Gitea** | MIT；单个可执行文件 + SQLite；一个程序就包含中心 Git 仓库、Issue、看板、PR 审核和 Webhook；官方 gitea-mcp（MIT，支持 HTTP）。不足是管理界面偏开发者，自定义字段只能用标签代替 |
| 首选 | **Kaneo** | MIT；一个应用容器 + Postgres；TS（Hono + React），改起来快；有 REST API、项目级 Webhook、MCP，并集成 GitHub / Gitea；功能有看板、列表、日历、甘特图、子任务、依赖、自定义字段。项目较年轻，细节要验证 |
| 有条件 | Fizzy（37signals） | 单个容器；API 覆盖卡片、评论、步骤、标签、Webhook，体验最好。但 O'Saasy 许可证禁止把它当作同类托管服务卖给第三方；如果产品以托管方式对外提供，存在许可证风险 |
| 仅内部用 | Kanboard | MIT；PHP + SQLite，极轻；有 JSON-RPC API 和插件。作者已声明进入维护模式，界面较旧 |

### C.2 不推荐

| 工具 | 原因 |
|---|---|
| Plane | AGPL-3.0（修改后通过网络提供需要公开源码）；官方 compose 有十几个容器；工作项类型和自定义属性在 Pro 及以上付费版 |
| Vikunja | 单个 Go 程序 + SQLite，功能合适，但许可证是 AGPL-3.0 |
| Planka | 社区版是 Fair Use License（fair-code），不是开源许可证；部分功能付费 |
| Kan | AGPL-3.0；Webhook 尚未提供 |
| Huly | EPL-2.0；很重（MongoDB、Elasticsearch、MinIO 等）；原仓库已冻结，官方托管服务已停 |
| Taiga | MPL-2.0；Django 加多个服务，偏重 |
| Leantime | AGPL-3.0；需要 MySQL |
| Focalboard | standalone 版官方声明不再维护 |
| Forgejo | 自 v9 起改为 GPL-3.0；可用，但不如 Gitea 宽松 |
| Vibe Kanban | Apache-2.0；每任务一个 worktree，支持 10 多种 Agent，值得参考；但官方已宣布停止维护（sunsetting） |
| Backlog.md | MIT；任务以 Markdown 存在仓库里，多机时各分支状态会分叉，与"控制面是唯一事实来源"冲突；网页只绑定 127.0.0.1 |

### C.3 和本方案的集成方式

- 看板只负责给人看的界面，以及存卡片和评论。Assignment、Run、Event、游标、Delivery / Review / Decision 留在控制面。
- Agent 不直接用看板自带的 MCP 写入，统一走 Card MCP，否则会绕过状态机和 SHA 校验。PM Office 可以开放只读。
- 写入方向：Agent 调用 Card MCP，控制面校验后通过看板 API，以该 Agent 的身份发评论。
- 读取方向：人在看板上评论或改状态时，看板发 Webhook 给控制面，控制面写入 Event，再由 Router 路由。另外要定时增量拉取做对账，弥补 Webhook 丢失。
- Needs You 面板仍然自己做。

### C.4 用 Gitea 时的概念对应

| 本方案 | Gitea |
|---|---|
| Card | Issue |
| Work Item | 子 Issue，或任务清单 + Issue 依赖 |
| Timeline | Issue 评论（每个 Agent 一个 Gitea 用户） |
| 代码 Delivery | PR（commit SHA 天然可校验） |
| 代码 Review | PR 审核 |
| 设计 / 测试 Review | 带标签的结构化评论 |
| Decision | 带 `decision` 标签的 Issue + 控制面里的 Decision 记录 |
| 中心 Git 仓库 / 中心合并 | Gitea 本身 |

### C.5 验证清单（每个候选 2–3 天）

1. 能否给每个 Agent 建独立用户和 API Token，评论能否显示真实作者。
2. Webhook 是否覆盖评论、状态、指派、标签的变化；失败会不会重试；能否按时间增量拉取来对账。
3. 子任务、依赖、自定义字段或标签，能否表达"工作项 + 产出 / 验证 + 是否必需"。
4. 能否通过 API 上传附件；评论的 Markdown 渲染效果如何（用来展示 Delivery 等结构化条目）。
5. 从零起一套测试环境、重置、备份和恢复，各要多久。
6. 对照商业化方式（是否以托管服务对外提供），许可证是否允许。

### C.6 对工作量的影响

- 不用自己做卡片界面和时间线；但要多写一个同步适配器（接收 Webhook、定时对账、把结构化条目渲染成评论），约 1–2 周。
- 和完全自建看板相比，Phase 1 约能省 1–2 周，而且界面是成熟的。

### C.7 资料来源

- [Kaneo](https://github.com/usekaneo/kaneo)
- [Gitea](https://github.com/go-gitea/gitea) · [gitea-mcp](https://gitea.com/gitea/gitea-mcp)
- [Fizzy](https://github.com/basecamp/fizzy)（[许可证](https://github.com/basecamp/fizzy/blob/main/LICENSE.md)、[API 文档](https://github.com/basecamp/fizzy/tree/main/docs/api)）
- [Kanboard](https://github.com/kanboard/kanboard)
- [Plane](https://github.com/makeplane/plane) · [Plane 定价](https://plane.so/pricing)
- [Vikunja](https://github.com/go-vikunja/vikunja) · [Planka](https://github.com/plankanban/planka) · [Kan](https://github.com/kanbn/kan)
- [Huly](https://github.com/hcengineering/platform) · [Taiga](https://github.com/taigaio/taiga-back) · [Leantime](https://github.com/Leantime/leantime)
- [Focalboard](https://github.com/mattermost-community/focalboard) · [Forgejo](https://codeberg.org/forgejo/forgejo)
- [Vibe Kanban](https://github.com/BloopAI/vibe-kanban) · [Backlog.md](https://github.com/MrLesk/Backlog.md)
