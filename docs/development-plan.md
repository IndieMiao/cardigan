# Cardigan · 多 Agent 协作开发系统开发方案

- 版本：v0.3（2026-10-27）
  - v0.3：项目定名 Cardigan；D1 决定自研看板，不依赖 Gitea 等外部看板；Git 改为"主机发起"模型（§12）；新增 §8.7 看板第一版范围和 §20 仓库规划。
  - v0.2：新增附录 C（看板工具评估）。
- 用途：后续开发的指导文档。设计已基本收敛；技术栈与若干决策仍待定，见 §15。
- 来源：本目录下三份讨论记录（见附录 B）。凡是"已核实"的外部能力，均来自 2026-10-24 查阅的官方文档或源码。

---

## 0. 一页摘要

**这是什么**：一个由"人 + 核心 Agent"驱动的多岗位协作系统。你主要和 PM Agent 讨论需求、看进展、拍板；PM 负责分配任务、监控进度；产品、设计、开发、测试等岗位 Agent 负责执行。所有协作围绕"卡片 + 时间线"展开。

**架构一句话**：

> 自研控制面（唯一事实来源，含自研看板） + Herdr（Agent 运行时和人工接管层） + 可插拔 Agent CLI（Claude Code / OpenCode / Pi / Codex 等）。Agent 通过 Card MCP 读写事实；Herdr 只负责"按门铃"；所有 Git 网络操作都由主机发起。

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
| **Herdr** (herdrdev/herdr) | Agent 终端运行时：Server/Client、Pane、Socket API、worktree、SSH 多机 | Apache-2.0 | **采用为运行时和人工接管层** |
| herdr-projects | Herdr 插件：本地看板、Coordinator、每任务 worktree、Review、人工批准合并 | MIT | 与本方案高度相似；Phase 0 评估其数据模型，决定借鉴还是 fork |
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
- 如果 fork herdr-projects（MIT），保留版权声明。

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
6. 主机从该工作机把 D-10 的 commit 拉进中心仓库（拉取成功即完成校验），然后：
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

- 基本信息：`id`、`project_id`、`title`、`goal`、`acceptance_criteria`
- 代码基线：`repo`、`base_branch`
- 管理字段：`priority`、`status`、`template`（决定默认生成哪些工作项，以及哪些是必需的）
- 审计：`created_by`、`created_at`
- 派生字段（不存储，实时计算）：`waiting_on[]`、`next_owners[]`、`open_decisions[]`

**WorkItem**

- `id`、`card_id`、`title`
- `kind`：`produce` | `verify`
- `role_id`
- `required`：是否是卡片 Done 的必要条件
- `depends_on[]`
- `target_work_item_id?`：仅 verify 类型，表示验证哪个产出型工作项
- `completion_criteria`、`status`、`assignment_id?`

**Assignment**

- 标识：`id`、`scope`（`work_item` | `standing`）、`work_item_id?`
- 角色：`role_id`、`role_version`
- 状态：`status`（业务状态）、`runtime_state`（运行状态）
- 运行位置：`machine_id`、`runtime_ref`（JSON，见 §11.1）、`session_ref?`
- 代码：`worktree_path?`、`branch?`、`base_sha?`
- 凭据：`mcp_token_id`
- 时间：`created_at`、`released_at?`

**Run**

- `id`、`assignment_id`、`trigger_event_id`
- `kind`：`initial` | `rework` | `decision_resumed` | `followup` | `fix`
- `status`、`model`
- `started_at?`、`finished_at?`、`outcome`、`summary`
- 约束：`UNIQUE(assignment_id, trigger_event_id)`，用于幂等

**TimelineEntry**

- `id`、`card_id`、`event_seq`
- `type`：`comment` | `instruction` | `delivery` | `review` | `decision_request` | `decision_resolved` | `status_change` | `system`
- `author`：`human` | `assignment:<id>` | `system`
- 关联：`work_item_id?`、`delivery_id?`、`decision_id?`、`run_id?`
- 内容：`body`（Markdown）、`mentions[]`、`created_at`

**Delivery**

- `id`、`work_item_id`、`run_id`
- `kind`：`code` | `design` | `doc` | `test_report` | `other`
- `summary`
- 代码定位：`branch?`、`commit_sha?`、`pr_url?`
- `test_results?`、`attachments[]`
- `requested_verifiers[]`
- `status`：`submitted` | `accepted` | `rejected` | `superseded`

**Review**

- `id`、`delivery_id`、`work_item_id`（验证型工作项）、`run_id`
- `kind`：`design` | `code` | `test` | `product`
- `verdict`：`pass` | `reject` | `conditional`
- `issues[]`：每项包含 `{severity, description, must_fix}`
- `attachments[]`
- `blocking`：是否阻塞整卡完成

**Decision**

- `id`、`card_id`、`raised_by`
- 内容：`question`、`context`、`options[]`（每项 `{key, description, impact}`）、`recommended`
- 影响：`affected_work_items[]`、`blocking`
- `decider`：`human` | `role:<id>`
- `status`
- `resolution?`：`{option, rationale, resolved_by, via: needs_you|pm_office_chat, human_quote?, at}`

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

### 4.4 状态机

**Card**：`backlog → todo → in_progress → review → done`；任意状态都可以转为 `cancelled`。
Card 进入 Done 的条件：

- 所有 `required` 工作项都处于成功终态；
- 没有 open 且 `blocking` 的 Decision；
- PM 验收（或你本人验收）通过。

**WorkItem（produce，产出型）**

```
todo --deps met--> ready --run starts--> in_progress --submit_delivery--> delivered
delivered --all required verifiers pass--> accepted (terminal)
delivered --any reject--> changes_requested --rework run--> in_progress
in_progress <--> blocked / waiting_decision
any --> cancelled
```

**WorkItem（verify，验证型）**

```
todo --target delivered--> ready --> in_progress --pass--> passed (terminal)
in_progress --reject--> failed --target redelivered--> ready
```

**Assignment**

- 业务状态：`active` | `suspended` | `released`
- 运行状态：`not_provisioned → provisioning → idle ⇄ running`；异常时 `→ unknown → lost`；最终 `→ released`

**Run**：`queued → dispatched → acked → running → completed | failed | cancelled`；运行环境失联时进入 `unknown`。

**Delivery**：`submitted → accepted | rejected | superseded`。

**Decision**：`open → resolved | withdrawn | superseded`。

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
12. Run 记录所用的 Role 版本和模型，保证可复现。

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
| delivery | 产出型 Assignment | Delivery | 唤醒对应的验证型工作项 |
| review | 验证型 Assignment | Review | 驳回时为产出方创建返工 Run |
| decision_request | 任何 Agent | Decision | 进入 Needs You；受影响工作项变为 `waiting_decision` |
| decision_resolved | 人（或 PM Office 代为记录） | Decision.resolution | 为受阻 Assignment 创建新 Run |
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
3. Dispatcher 通过 Runtime Adapter 发送门铃。
4. Agent 调用 `get_updates` 读取完整内容，再调用 `ack_events` 推进游标。
5. 没有 ACK 时：
   - 先查运行状态：Agent 正在工作就不重发，它在本次 Run 结束前会自己拉取更新；
   - Agent 空闲就重发门铃，并按指数退避控制间隔；
   - 超过阈值仍无 ACK，标记 `needs_attention` 交给 PM Ops。

### 6.2 门铃格式

```
[bell] card=C-123 wi=W-4 asg=A-17 run=R-5 seq=31 kind=review_rejected
→ 请调用 card.get_updates 读取详情
```

门铃不带正文。它只是提示，可能丢失，也可能重复。

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
| 指令 | 对应工作项的 Assignment；还没有 Assignment 时交给 PM Ops 分配 |
| Delivery 提交 | 验证这个工作项的各个验证型 Assignment；PM Ops 只收摘要 |
| Review 通过 | 不唤醒；检查交付是否全部通过、整卡是否满足 Done 条件 |
| Review 驳回 | 产生被审核 Delivery 的 Assignment（返工 Run） |
| Decision 请求 | 决策人：人则进入 Needs You，并给 PM Office 一条简短提示 |
| Decision 已解决 | 所有被它阻塞的 Assignment（新 Run）；PM Ops 收摘要 |
| 依赖完成 | 下游工作项的 Assignment；没有 Assignment 时交给 PM Ops |
| 整卡满足 Done 条件 | PM 验收工作项 |
| Run 结束但没有交付、阻塞或决策 | PM Ops（异常） |
| Agent 空闲超过宽限期仍未调用 `finish_run` | PM Ops（`needs_attention`） |
| 运行环境失联超过宽限期 | Needs You（是否接管由你决定） |

原则：

> 不是"卡片有更新就通知所有 Agent"，而是"这个事件改变了谁的下一步工作，就通知谁"。

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
| 进程已退出 | 按 `session_ref` 恢复；无法恢复则新建 Session，用卡片时间线生成交接摘要 |
| 已交付、尚未清理 | 复用原 Session 和 worktree，创建返工 Run |
| 卡片已关闭、worktree 已清理 | 创建后续工作项和新 Assignment，并引用历史 |

### 6.7 合并与串行

- 同一卡片的事件串行处理，不同卡片可以并行。
- 同一 Assignment 短时间内的多条事件合并成一次门铃，例如"C-123 从 seq 17 更新到 25：1 个 Delivery、2 条 Review、5 条评论"。

### 6.8 Herdr 状态语义注意事项（已核实）

- `done` 只表示"进入空闲且尚未被查看"，不是卡片完成。
- `blocked` 来自界面识别，不覆盖所有业务阻塞。
- `agent.wait` 返回不代表业务成功。如果 Agent 原本就在工作，等到的可能是上一个回合结束。
- Prompt 超时不代表没送达，直接重试可能重复执行，所以必须依靠 Run 幂等。
- Claude Code、Codex 的状态主要靠终端画面检测，可能误判；OpenCode、Pi 可以主动上报状态。

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

### 7.2 Event Router：先规则，后 PM

能由规则确定处理的事件不调用 PM，见 §6.4。只有以下情况才升级给 PM Ops：

- 多个任务之间存在冲突，或者多张卡片争抢优先级；
- 同一交付被驳回两次及以上，需要重新规划；
- 交付与需求不一致，或者依赖关系发生变化；
- 需要判断是否暂停后续工作；
- 规则无法处理的异常（Run 结束却没有产出、长时间无 ACK 等）。

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
3. 你可以在 Needs You 里操作，也可以在对话里说"选 A"。后一种情况由 PM Office 调用 `record_decision`，记录原话和来源。
4. 系统唤醒受影响的 Assignment，PM Ops 据此调整后续任务。

---

## 8. 用户界面（Workbench）

### 8.1 第一版形态

- **PM Office 对话**：仍在 Herdr 窗口里。终端里的 CLI Agent 很难桥接到 Web 聊天，第一版不做；Phase 3 再考虑通过 ACP 或直连 SDK 做 Web 聊天。
- **Web Workbench**：由控制面提供，负责其余所有功能，见 8.2–8.6。

### 8.2 Needs You（常驻）

- 待你拍板的 Decision、只有你能解决的阻塞、待你验收的交付、高风险操作确认、需要你决定是否接管的失联 Assignment。
- 显示已等待多久。
- 可以直接操作：选方案、批准 / 驳回、要求补充信息、查看关联卡片、让 PM 解释后果。

### 8.3 项目快照（不是消息流）

- 进行中的卡片、Review 中的卡片、阻塞中的工作项、最近的 Delivery。
- 每张卡的"下一步负责人"。
- 等待你的事项和等待 Agent 的事项分开显示。

PM Office 回答"项目现在怎么样"时，查询的就是这份快照，而不是回忆它收到过的门铃。

### 8.4 卡片页

主体是时间线，不同类型条目有不同样式。卡片页始终回答五个问题：

1. 目标是什么？
2. 进行到哪一步？
3. 下一步该谁做？
4. 被什么阻塞？
5. 最终由谁验收、依据是什么？

工作项清单可以折叠显示，每项包含负责人、状态和交付。

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

### 8.6 项目动态

完整事件流，可按卡片、角色、类型过滤，默认折叠。PM Ops 做过的调度和理由也记录在这里。

### 8.7 看板第一版范围（自研）

Agent 只通过 Card MCP 读写，看板界面只服务你一个人，所以第一版可以做得很窄。

**做：**

- 卡片列表和看板视图：按状态分列；可以筛选"等我处理"和"等 Agent 处理"。
- 卡片详情：
  - 目标、验收标准、工作项清单；
  - 时间线，评论、指令、交付、审核、决策用不同样式显示；
  - 评论输入框，支持 @提及、Markdown、粘贴图片和附件。
- 决策卡直接在页面上操作：选方案、批准或驳回、要求补充。
- 界面实时刷新：按控制面的事件序号，通过 SSE 推送。
- 认证：第一版只有你一个人用账号登录，Agent 用 Token。

**不做：** 甘特图、日历、迭代周期、所见即所得编辑器、多用户权限、移动端、邮件通知。代码 diff 第一版先给出可以直接运行的 git 命令，之后再加 diff 视图。

---

## 9. Card MCP 接口

### 9.1 传输与认证

- 使用 Streamable HTTP，不用 stdio。单机也这样做，因为这是多机的前提。
- 每个 Assignment 签发一个 Bearer Token，作用域为：它的卡片、工作项和角色允许的工具。
- 写操作的身份由 Token 决定，不信 Agent 在参数里自报的身份。
- 写类工具接受 `idempotency_key`。
- 服务只监听局域网接口，不对公网开放；不信任的网络环境加 TLS 或走 Tailscale 之类的通道。

### 9.2 工具清单（初版）

| 工具 | 可用角色 | 作用 |
|---|---|---|
| `whoami()` | 全部 | 返回本 Assignment 的上下文：卡片、工作项、角色、机器、worktree、分支 |
| `get_card(card_id)` | 全部 | 卡片、工作项、开放的 Decision、最近的交付摘要 |
| `get_updates(card_id?, since_seq?)` | 全部 | 游标之后的事件和条目 |
| `ack_events(card_id, up_to_seq)` | 全部 | 推进游标 |
| `post_comment(card_id, body, work_item_id?, mentions[])` | 全部 | 发评论 |
| `report_blocker(work_item_id, reason, needs: role\|human)` | 全部 | 报告阻塞 |
| `request_decision(card_id, question, context, options[], recommended, affected_work_items[], blocking, decider)` | 全部 | 发起拍板 |
| `upload_attachment(file) → attachment_id` | 全部 | 上传截图、录屏、设计稿 |
| `heartbeat(run_id, note?)` | 全部 | 心跳 |
| `finish_run(run_id, outcome: completed\|blocked\|failed, summary)` | 全部 | 结束本次 Run |
| `submit_delivery(work_item_id, kind, summary, branch?, commit_sha?, pr_url?, test_results?, attachments[], request_verify[])` | 产出型角色 | 提交交付 |
| `submit_review(delivery_id, kind, verdict, issues[], attachments[], blocking)` | 验证型角色 | 提交审核结论 |
| `create_card` / `update_card` / `create_work_item` / `update_work_item` | PM | 管理卡片与工作项 |
| `assign(work_item_id, role_id, machine_id?)` | PM | 指派（第一版手动指定机器） |
| `project_snapshot()` / `list_needs_you()` | PM | 项目快照和待你处理的事项 |
| `record_decision(decision_id, option, rationale, human_quote)` | 仅 PM Office | 记录你在对话中做出的决定 |

你在 Web 界面上的操作走 Workbench Web API，不经过 MCP。

### 9.3 服务端校验（不依赖 Agent 自觉）

- 状态迁移必须符合 §4.4 的状态机。
- `submit_delivery` 时，主机从该 Assignment 所在机器拉取 `commit_sha`；拉取失败，或该 SHA 不在该 Assignment 的分支上，则拒绝。
- 只有验证型工作项的 Assignment 能对其目标交付调用 `submit_review`。
- `record_decision` 仅限 PM Office，并且必须带 `human_quote`。

---

## 10. Role Registry 与 Agent 启动

### 10.1 Role 字段

- 标识：`role_id`、`version`、`display_name`
- `kind`：`standing` | `work`
- 提示：`core_prompt`（包含 §6.3 的协议）、`project_rules_ref`
- 能力：`capabilities`（可承担的产出型 / 验证型工作项种类）
- 执行：`harness`（`claude-code` | `opencode` | `pi` | `codex` | …）、`provider`、`model`、`reasoning_effort`
- MCP：`mcp_servers[]`（Card MCP 必选，其余如设计工具 MCP）
- 权限：`permissions`，包括 MCP 作用域、Git 推送范围、是否需要 worktree
- 调度：`required_machine_tags[]`
- 其他：`budget?`、`launch_profile_ref`

Role 修改后版本号递增，Run 记录所用版本。

### 10.2 Launch Profile（每种 Harness 一份）

每份 Launch Profile 说明以下内容：

- 启动命令模板；
- 如何指定 Provider / 模型；
- 如何注入 Core Prompt（CLI 参数、配置文件或 Agent 定义）；
- 如何写入 MCP 配置（含该 Assignment 的 Token）；
- Herdr 如何识别状态（主动上报还是画面检测）；
- 恢复会话的命令。

注入的提示词、MCP 配置和 Token 一律写在 worktree 之外的 Assignment 运行目录，或者已被 git 忽略的路径，**绝不提交进仓库**。

### 10.3 Core Memory

- **固定部分**：角色说明、行为准则、协议、项目规则。放在 Role Registry，有版本，第一版就实现。
- **演进部分**：跨任务积累的经验和偏好。由 Agent 通过 MCP 提议更新，经 PM 或你审核后合入，启动 Session 时注入。放到 Phase 3。

### 10.4 初始角色建议

| 角色 | 类型 | worktree | 主要权限 |
|---|---|---|---|
| pm-office | standing | 不需要（可选只读 clone） | PM 工具 + `record_decision` |
| pm-ops | standing | 不需要 | PM 工具（不能记录人的决定） |
| designer | work | 按需 | 设计相关产出与走查；设计工具 MCP；截图 |
| coder | work | 需要 | 代码产出；只在本地 commit，没有任何推送权限 |
| reviewer | work | 只读（按 SHA 检出） | 代码审核 |
| tester | work | 只读（按 SHA 检出） | 测试验收；需要带对应能力标签的机器（如真机） |

---

## 11. Runtime Adapter（Herdr 实现）

### 11.1 接口（与具体语言无关）

```
provision(assignment, role, machine) -> RuntimeRef
wake(ref, doorbell) -> {sent: bool, error?}
status(ref) -> {process: alive|exited|unknown, agent: working|blocked|done|idle|unknown, observed_at}
interrupt(ref)
resume_or_replace(ref) -> RuntimeRef
human_entry(ref) -> string            # 人工打开方式：机器名 + workspace
release(ref, {force}) -> result       # worktree 有未提交修改时拒绝，除非 force

RuntimeRef = {machine_id, herdr_machine, workspace_id, pane_id, agent_name,
              worktree_path?, branch?}
```

### 11.2 与 Herdr 的映射

具体参数以所用版本的 CLI reference 为准，Phase 0 核实。

| 接口 | Herdr |
|---|---|
| provision | `herdr [--machine M] worktree create --cwd <base_clone> --branch <branch>` → 作为 Workspace 打开 → 在根 Pane 按 Launch Profile 启动 Agent |
| wake | `herdr [--machine M] agent prompt <pane> "<doorbell>"` |
| status | `herdr [--machine M] agent list` / `api snapshot` |
| release | `herdr [--machine M] worktree remove`（有删除保护，需要时显式 force） |
| human_entry | Herdr 客户端里的机器名 + workspace |

本机也当作一台机器处理（`machine_id=local`），代码路径和多机一致。

### 11.3 已知限制（已核实）

- Pane、Workspace 编号和 Agent 名字只在单台 Herdr server 内唯一。所以 Agent 名要全局唯一，例如 `coder-c123-w4`，并且始终配合 `machine_id` 使用。
- `--machine` 支持的命令：workspace、worktree、tab、pane、notification、agent（`attach` 除外）、api snapshot、status server，以及基于 API 的插件命令。列表里没有事件订阅，所以远程状态靠轮询加 MCP 心跳。
- 没有跨机器的 Agent 间消息。门铃统一由 Dispatcher 发。
- 断线时 Herdr 界面上显示的是变灰的缓存状态，不能用来判断 Agent 是否存活。
- Socket API 只在本机可用，没有按 Agent 区分的身份或权限控制。
- 多机连接支持 Linux / macOS / Windows 客户端，连接 Linux / macOS（x86_64、aarch64）或 Windows x86_64 server。

---

## 12. Worktree 与 Git 服务

### 12.1 原则：所有 Git 网络操作由主机发起

- 中心仓库是主机上的 bare 仓库：`/srv/cardigan/repos/<project>.git`。
- 工作机和 Agent **不持有任何 Git 凭据，不能 push**。主机通过已有的单向 SSH 从工作机拉取，并向工作机推送基线。
- 项目如果托管在 GitHub / GitLab，只有主机持有其凭据，合并后由主机推送上去。
- 单机时用同一套代码，拉取直接走本地文件路径（`git-transport` 的本地实现）。

### 12.2 布局与命名

- 每台机器每个项目一个基础 clone：`/srv/agent/repos/<project>`
- worktree：`/srv/agent/worktrees/<assignment_id>`
- 分支：`agent/<card_id>/<work_item_id>`
- provision 时记录 `base_sha`。
- 基线同步：主机把中心仓库的 main 推到各工作机基础 clone 的 `refs/remotes/origin/main`，不碰工作机当前检出的分支。
- 只有 PM Ops 或 Router 明确要求时才 rebase 到最新基线，避免意外改动。

### 12.3 交付

1. Agent 在 worktree 里 commit，不 push。
2. 调用 `submit_delivery`，带上 SHA。
3. 主机从该 Assignment 所在机器拉取这个 SHA，存入中心仓库的 `refs/cardigan/deliveries/<delivery_id>`，并更新对应的 `agent/*` 分支。
   - 拉取成功即完成校验；
   - 拉取失败，或该 SHA 不在该 Assignment 的分支上，则拒绝交付。
4. 主机定期（建议每 10 分钟）拉取各工作机的 `agent/*` 分支，作为半成品备份，供接管使用。

### 12.4 验证

验证型 Agent 所在机器如果还没有该 SHA，主机先把它推过去；然后在该机器上按 SHA 建立只读（detached）worktree 进行检查。

### 12.5 合并

- 只在中心合并：主机上的集成 clone 执行合并，并更新中心仓库的 main；需要时再推送到外部托管平台。
- 前提：整卡验收通过，并且你确认（可按卡片模板配置）。
- 出现冲突时，为原 Coding Assignment 创建一个修复 Run。
- 不在工作机的 worktree 里合并。

### 12.6 清理与对账

- 合并或取消后执行 `release`。worktree 有未提交修改时，在 Needs You 里给出"查看 Diff / 保留 / 强制清理"。
- 定期对账：比对 `herdr worktree list` 与数据库，发现孤儿 worktree 和缺失的 worktree。
- 未提交、尚未被主机拉取的修改，以及 ahead / behind 数据，由 Dispatcher 通过 SSH 在对应机器上执行 git 命令获取（Herdr 没有这个 API）。

### 12.7 写锁

同一个 worktree 已有写入型 Run 在执行时，Dispatcher 不派发新的写入型 Run，后来的事件进入 Inbox 排队。

---

## 13. 部署

### 13.1 单机（Phase 1）

所有组件都在一台常开机器上：控制面、数据库、Card MCP（HTTP，监听 localhost 或局域网）、Herdr server、所有 Agent。
单机也必须遵守 §13.3 的约定。

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

### 13.7 模型凭据

- 方案 A：每台工作机在环境变量里保存服务商 API Key。
- 方案 B（Phase 3）：主机运行模型网关，工作机只拿网关 Token。好处是密钥不落在工作机上，能按 Assignment 统计成本，也能按角色统一选模型。

### 13.8 机器登记与调度

- Machine 登记表：见 §4.3。健康状态来自 `status server` 和心跳。
- 第一版由 PM 在 `assign` 时**手动指定机器**。
- Phase 3 再做按能力标签和负载的自动分配。
- Assignment 一旦固定到某台机器，之后的 Run 都派到这台。

### 13.9 故障处理

1. 心跳超时：Assignment 运行状态变为 `unknown`，**不立即换机器重跑**，因为旧机器可能只是暂时断网，仍在改代码。
2. 宽限期（建议 5–10 分钟，可配置）后仍失联：变为 `lost`，进入 Needs You，由你选择等待或接管。
3. 接管：从主机最后一次拉取到的 SHA 在另一台机器新建 worktree 和 Session，用时间线生成交接摘要。原机器恢复后，它的 worktree 进入清理流程。
4. 为了让接管不丢工作：Agent 在检查点 commit；主机按 §12.3 定期拉取 `agent/*` 分支。

---

## 14. 安全模型汇总

| 资产 / 风险 | 措施 |
|---|---|
| 主机到各工作机的 SSH 密钥 | 只由主机上的 `orchestrator` 用户持有，单向 |
| 机器间已有的互相授权 | Agent 运行在没有密钥的 `agent` 用户下 |
| Herdr Socket（无 ACL） | 接受同机 Agent 可互相操作；影响范围限于单台机器 |
| Card MCP | 每个 Assignment 一个作用域 Token；身份由 Token 决定；服务端校验状态迁移 |
| Web Workbench | 即使在局域网也要登录；只监听局域网接口 |
| Git | 工作机和 Agent 不持有任何 Git 凭据；拉取和推送都由主机发起；只在中心合并；外部托管平台的凭据只在主机 |
| 模型密钥 | 只放在环境变量或网关；不写进数据库、评论和仓库 |
| 注入的提示词和 Token | 写在 worktree 外，或已被 git 忽略的路径 |
| 仓库内容中的提示注入 | Agent 没有 sudo；高风险操作走工具审批；业务变更走 Decision |
| 主机单点 | 定期备份数据库；第一版接受单点 |

---

## 15. 待定决策（Phase 0 内敲定）

| 编号 | 决策 | 选项 / 建议 |
|---|---|---|
| D1 | 看板层 | **已决定（2026-10-27）：自研看板**，不依赖 Gitea 等外部看板。理由：数据只在控制面一处，不需要同步层；端到端测试不依赖外部服务；商业化不受上游约束。第一版范围见 §8.7；外部看板的评估保留在附录 C 作参考 |
| D2 | 控制面技术栈 | 建议 TypeScript（Node LTS）：官方 MCP SDK 成熟，Web 可以同语言，OpenCode / Pi 的 SDK 也是 TS，便于以后做直连适配器。Herdr 通过 CLI 子进程调用，与语言无关。数据库第一版用 SQLite（WAL，单写入进程），需要多写入时再迁移到 Postgres |
| D3 | 每个角色用哪个 Harness 和模型 | 先每个角色选一种，避免第一版同时深度适配多种 |
| D4 | 卡片 Done 条件 | 设计走查、测试验收、PM 验收中，哪些必须通过；建议按卡片模板配置 |
| D5 | Session 策略 | 默认：Session 跟随 Assignment，跨 Run 复用；失联或上下文过长时替换。请确认 |
| D6 | 机器清单 | 哪台常开做主机，哪台接测试真机，各自的系统和架构 |
| D7 | "core memo"的含义 | 固定角色说明（第一版实现），还是持续演进的记忆（Phase 3） |
| D8 | 是否借鉴或 fork herdr-projects | 看完它的数据模型和扩展接口后决定 |

---

## 16. 实施路线图

### Phase 0 · 预研与零代码验证（1–2 周）

按讨论中确定的最小改造顺序推进：先在现有实践里验证模式，再写代码。

| 项 | 内容 | 验收 |
|---|---|---|
| 0.1 | 在现有 Herdr 实践中把 zhangliang 拆成 `zhangliang-office` 和 `zhangliang-ops`，所有门铃改发给 ops | 连续一周，主对话只被拍板和重大风险打断，ops 仍能正常调度 |
| 0.2 | 在现有看板用评论模板试行结构化条目：`[交付]`、`[审核]`、`[待拍板]`、`[决定]` | PM Ops 只看模板字段就能判断下一步 |
| 0.3 | Herdr 预研：一台本机 + 一台远程机，验证 `--machine` 下的 worktree create / remove、agent prompt、agent wait、agent list；断线和门铃失败的表现 | 一页结论，包含确切的命令参数 |
| 0.4 | MCP 预研：每个选定的 Harness 都能连上一个带 Bearer Token 的 Streamable HTTP MCP 测试服务 | 产出各 Harness 的 Launch Profile 草稿 |
| 0.5 | 评估 herdr-projects；预研主机发起的 Git 模型：从工作机拉取 commit、推送基线、模拟断线后接管（1–2 天） | 给出 D8 的结论；Git 模型跑通 |
| 0.6 | 敲定 D2–D7 | 更新本文档 |

### Phase 1 · 单机 MVP（4–8 周）

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M1 | 领域模型、状态机、事件存储（seq / 游标）、Card MCP（HTTP + Token） | 状态机和不变量的单元测试；MCP 契约测试；伪造身份、非法状态迁移会被拒绝 |
| M2 | Role Registry、Launch Profile、Herdr Runtime Adapter（`machine=local`） | 从卡片一键创建 coder 的 Assignment：worktree 建好，Agent 启动并通过 `whoami` / `get_card` 读到任务 |
| M3 | Event Router、门铃、ACK、重发、PM Office / Ops | 路由规则表全覆盖的测试；重复门铃不产生重复 Run；同一 Assignment 的多条事件合并 |
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

验收场景：

1. coder 在工作机 A，tester 在带真机的工作机 B，PM 在主机。
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
| Phase 0 | 1–2 周 | 技术栈（D2）尚未确认 |
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
| Herdr 版本快速变化 | Adapter 失效 | 固定版本；Adapter 隔离所有 CLI 调用；对 Adapter 做契约测试 |
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

技术栈按 D2 建议的 TypeScript + pnpm workspace 设计；如果换语言，目录划分和依赖方向的规则不变。

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
│   └── roles/           # 默认角色包 + 各 Agent CLI 的启动配置
├── apps/
│   ├── server/          # 把各包组装起来的主进程，跑在主机上
│   ├── web/             # 工作台 + 自研看板（§8）
│   └── cli/             # 管理命令：添加机器、指派、自检
├── e2e/                 # 端到端测试：SQLite + 本地 bare 仓库 + 模拟 Agent，跑附录 A
└── deploy/examples/     # 通用部署示例（不含任何真实环境信息）
```

### 20.2 依赖方向

`domain` ← `store` / `router` / `mcp-server` / `git-service` ← `runtime-herdr` / `git-transport` ← `apps`

- `domain` 不依赖任何其他包；运行时和 Git 传输通过 `domain` 中定义的端口接口接入。
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
| 实现 | Codex（Codex CLI）、DeepSeek（OpenCode 或 Pi） | 实现功能，附带单元测试 |
| 验收测试 | 另一个实现模型（交叉） | 根据计划写验收测试和契约测试 |
| 审核 | Claude | 只审核、提修改意见，不提交代码 |
| 合并 | Claude 准备，你确认 | 冲突退回实现者修复 |

---

## 附录 A · 端到端验收场景（Phase 1 M5）

基于讨论中的"0.2.5 发版后的相关改动与验收"卡片：

1. 你在 PM Office 提出需求，PM Office 创建卡片 C-1，包含以下工作项：
   - 产品确认（produce，PM）
   - 开发（produce，coder，required）
   - 设计走查（verify→开发，designer，required）
   - 测试验收（verify→开发，tester，required）
   - PM 验收（verify，PM，required）
2. 产品确认完成后，开发工作项变为 `ready`。PM Ops 指派 coder，系统建立 Assignment、worktree 和分支，并按门铃。
3. coder 读取卡片，实现、推送，提交 Delivery D-1（附带前后对比的附件）。
4. 设计走查和测试验收自动进入 `ready`，两个 Assignment 被唤醒。全程不打扰你。
5. 设计走查提交 `pass`；测试验收提交 `reject`（例如真机上起飞有空白帧）。
6. 系统为原 coder 的 Assignment 创建返工 Run，复用原 Session 和 worktree；D-2 提交后，D-1 标记为 `superseded`。
7. 返工中 coder 发现需要改变产品行为，调用 `request_decision`，本次 Run 以 `blocked` 结束。
8. Needs You 出现该 Decision，PM Office 给你一句话提示。你在对话里说"按方案 A"，PM Office 调用 `record_decision` 记录。
9. 系统为 coder 创建 `decision_resumed` Run，产出 D-3；设计走查和测试验收复核通过。
10. 所有必需项满足后，PM 验收工作项被唤醒并通过；卡片进入 Done，并合并到主干（需要你确认）。
11. worktree 被清理，时间线完整记录全过程。
12. 你随后问"现在整体怎么样"，PM Office 查询项目快照作答，不需要重放门铃历史。

通过标准：

- 你只在第 8 步和第 10 步的合并确认时被打断；
- 门铃人为重复发送不产生重复 Run；
- 中途重启 Herdr server 后，所有 Assignment 都能恢复或得到明确处理。

---

## 附录 B · 讨论来源

- `2026-10-24-220532-httpsgithubcomblockbuzzgit-httpsgithub.txt`：调研、选型、数据模型、PM 前后台
- `2026-10-24-231212-homezhangshaojiprojectsnewcc2026-10-24-22.txt`：多机部署
- `kimi-export-session_-20261024-151119.md`：另一个 Agent 的多机评估（已合并：专用用户、手动指定机器、`unknown` + 宽限期）
- 2026-10-25 至 10-27 的会话（尚未导出）：看板工具评估（附录 C）、定名、仓库规划、自研看板、主机发起的 Git 模型
- 以上讨论记录不在本仓库中，存放在 `~/projects/newcc/`。

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
