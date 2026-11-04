# Phase 1 · M3 任务计划：Event Router、门铃、ACK、重发、PM Office / Ops

- 版本：v2（2026-11-05）：M3.2 改由 Pi 实现（Codex 还在做 M2 收尾），交叉验收相应对调；补充 M3.1 的后续事项
- v1（2026-11-05）
- 对应：开发方案 §16 Phase 1 M3；§6 消息、路由与门铃协议；§7 PM 前后台与 Event Router；§13.9 故障处理
- M3 的验收（开发方案 §16）：**路由规则表全覆盖的测试；重复门铃不产生重复 Run；同一 Assignment 的多条事件合并。**
- 只做 `machine_id=local`。M3 不做：Git 拉取交付和合并（M4）、Web 界面和 Needs You 页面（M5，M3 只提供数据和 CLI 查看）、多机接管（Phase 2）。
- 前提：M2 已合并（一键启动、Runtime 适配器、worktree）。M2.7 的 Agent 专用用户模式和 M3 无关，两种运行模式下 M3 的逻辑相同。

## 1. 任务总览

| 任务 | 内容 | 实现 | 验收测试 | 依赖 | 分支 |
|---|---|---|---|---|---|
| M3.1 | router：§6.4 路由规则、§6.5 @提及解析、§7.2 升级规则、§6.7 合并（纯函数） | Pi | Codex（M3.T2） | 无 | `feat/m3-router` |
| M3.2 | domain：门铃触发的 Run、通知与升级的状态机 | Pi | Codex（M3.T2） | 无 | `feat/m3-domain-notify` |
| M3.3 | store：通知收件箱、Router 游标、迁移 | Pi | Codex（M3.T2） | M3.2 | `feat/m3-store-inbox` |
| M3.4 | Dispatcher：投递、ACK、重发、失败、看门狗、运行时事件 | Codex | Pi（M3.T1） | M3.1–M3.3 | `feat/m3-dispatcher` |
| M3.5 | PM Office / Ops 与 server 组装 | Pi | Codex（M3.T2） | M3.4 | `feat/m3-pm-office-ops` |
| M3.T1 | 交叉验收：Dispatcher | Pi | — | M3.4 | `test/m3-dispatch` |
| M3.T2 | 交叉验收：路由规则表、通知状态机、收件箱、PM 前后台 | Codex | — | M3.1、M3.2、M3.3、M3.5 | `test/m3-routing` |
| M3.S | 真实 Agent 冒烟：coder（Codex）+ reviewer（Claude Code）+ PM Ops 走一轮交付、驳回、返工、通过 | Claude | — | M3.5、M2.S | — |

```
M3.1（Pi，可立即开始） ─────────────┐
M3.2（Pi） ─ M3.3（Pi） ────────────┼─ M3.4（Codex） ─ M3.5（Pi） ─ M3.T2（Codex） ─ M3.S
                                    └─ M3.T1（Pi）：M3.4 合并后
```

## 2. 通用约定

沿用 M2 计划 §2：每个 PR 约 800 行以内；domain 测试从 `createCard` + `assign` 的真实状态出发；验收测试只看计划和开发方案、只用公开接口、每条用例做注入验证；真实 hc 的测试用独立 session 和 socket，结束时关掉 core。

## 3. 关键设计（本计划确定）

### 3.1 判断 Agent 忙不忙：以 MCP 为准

Claude Code、Codex 不通过 OSC 7501 上报状态（§6.8），M3 不加状态转换层。Dispatcher 的判断只依据控制面自己的事实：

| Assignment 的情况 | 处理（§6.6） |
|---|---|
| 有未结束的 Run（dispatched / acked / running） | 不按门铃。新事件留在收件箱，Agent 按 §6.3 在 Run 结束前调用 `get_updates` 自己拉取 |
| 没有未结束的 Run，终端还活着 | 新建 Run（`trigger_event_id` = 触发事件），在现有终端上派发，然后按门铃 |
| 终端已退出或丢失 | 按 M2 的一键启动流程新开会话（新 Token），首条提示就是门铃；按会话 ID 恢复留到以后 |
| Assignment 已释放 | 不投递，交给 PM Ops |

运行时上报的状态（Pi 原生支持 OSC 7501）只作为辅助信息展示，不参与投递决策。

### 3.2 收件箱与合并

- Router 按事件顺序消费每个项目的事件流，持久化游标；每个（事件，接收者）最多产生一条通知（唯一约束），重复处理同一事件不会重复通知。
- 接收者可以是：某个 Assignment、PM Ops、PM Office、Needs You。
- 同一 Assignment 的多条待投递通知合并成一次门铃（§6.7），格式在 §6.2 基础上带 seq 范围和摘要：

  ```
  [bell] card=C-123 asg=A-17 seq=17..25 summary="1 delivery, 2 reviews, 5 comments"
  → 请调用 card.get_updates 读取详情
  ```

- 通知在 Assignment 对该卡的 ACK 游标 ≥ 通知的 seq 时视为已确认。

### 3.3 重发、失败与看门狗

- 按门铃后迟迟没有 ACK：Assignment 有未结束的 Run 就不重发；否则按指数退避重发（默认 1、2、4、8 分钟，可配置），超过次数（默认 4 次）标记 `needs_attention` 并通知 PM Ops。
- `wake` 调用失败：标记 `delivery_failed`，通知 PM Ops，**不静默重试**（§6.4）。调用失败不代表没送达（§6.8），所以不新建第二个 Run。
- 活跃度看门狗：Run 处于 running，但超过宽限期（默认 15 分钟，可配置）没有任何 MCP 调用（含 `heartbeat`），标记 `needs_attention` 交给 PM Ops。
- 运行时失联（`hc events` 报终端 lost / finished，而 Run 未结束）：Assignment 运行状态按 §13.9 变为 `unknown`；超过宽限期仍未恢复变为 `lost`，进入 Needs You，并给 PM Office 一条简短提示。是否接管由你决定。

### 3.4 PM Office / Ops

- 两个都是常驻的 `pm` Assignment（M1.7b 的 `cardigan pm create --office|--ops`），用 M2 的一键启动跑起来；它们共用 `pm` 角色，首条提示和 `whoami` 返回的工具范围告诉它当前是前台还是后台。
- PM Office 只在 Needs You 新增项和重大风险时收到简短提示（§7.3）；其他事件一律不打扰它。
- PM Ops 收到 Router 升级上来的事件（§7.2），按 Assignment 合并后投递。
- 默认角色包里 `pm` 的 Core Prompt 要写清两种模式各自的职责和打断规则（§7.1、§7.3），以及 Office 用 `record_decision` 记录你的原话。

## 4. 各任务说明

### M3.1 router：路由规则（Pi）

- 纯函数：输入一个事件和当前项目快照，输出接收者列表（Assignment / PM Ops / PM Office / Needs You）和通知种类。覆盖 §6.4 表格的**每一行**、§6.5 的四种 @提及情况、§7.2 的五类升级条件。
- 合并函数：输入同一 Assignment 的待投递通知，输出一条门铃文本和 seq 范围（§6.7、本计划 §3.2）。
- 原则（§6.4）："这个事件改变了谁的下一步工作，就通知谁"；作者是自己时不通知自己。
- 验收：§6.4 的每一行、§6.5 的每一种情况、§7.2 的每一类都有至少一个测试，测试名写明对应的行；合并结果的 seq 范围和摘要正确。

### M3.2 domain：门铃触发的 Run、通知状态机（Codex）

- `queueRun` 支持 `initial` 之外的种类（`rework`、`decision_resumed`、`followup`、`fix`），`trigger_event_id` 用触发事件的 ID；同一（Assignment，触发事件）只能有一个 Run（store 已有唯一约束，domain 也要拒绝）。
- 在已有终端上派发：`dispatchRun` 复用 Assignment 现有的 `runtime_ref`，不重新 provision。
- 通知和升级的状态机：`pending → belled → acked`，以及 `delivery_failed`、`needs_attention`；写进开发方案 §4.4。
- 记录 Assignment 最近一次 MCP 活动时间（看门狗用），由 mcp-server 在每次工具调用时更新。
- 验收：迁移表的允许和禁止迁移各至少一个测试；同一触发事件重复排队被拒（"重复门铃不产生重复 Run"）。

### M3.3 store：收件箱、Router 游标（Pi）

- 迁移：通知表（项目、接收者、卡片、事件、seq、种类、状态、尝试次数、下次尝试时间），唯一约束（事件，接收者）；Router 游标表（每个项目一条事件流的已处理位置）；Assignment 最近活动时间。
- 读取待投递通知按接收者分组；ACK 判断读 M1 的游标表。
- 验收：同一事件重复写通知不产生第二条；游标只能前进；事务失败全部回滚。

### M3.4 Dispatcher（Codex）

- server 里的长期循环：消费新事件 → 调用 M3.1 路由 → 写收件箱 → 按 §3.1 的规则投递 → 按 §3.3 处理 ACK、重发、失败、看门狗。
- 订阅 `hc events`（M2.3 已提供），把终端 lost / finished 映射到 Assignment 的运行状态（§13.9）。
- 循环要能安全重启：重启后从持久化的游标和收件箱状态继续，不重复投递、不重复建 Run。
- 验收：用假 Runtime 和真实 store 覆盖 §3.1 表格每一行、§3.3 每一条；"同一 Assignment 的多条事件合并"、"重复门铃不产生重复 Run"各有专门测试；进程在投递中途被杀后重启，结果一致。

### M3.5 PM Office / Ops 与 server 组装（Pi）

- `cardigan pm start`：为 Office 和 Ops 各自一键启动（复用 M2.6），已在运行就跳过。
- 默认角色包里 `pm` 的 Core Prompt 按 §3.4 补充两种模式。
- server 启动时运行 Router 和 Dispatcher，收到 SIGTERM 时停止循环并等当前投递结束。
- CLI 查看：`cardigan inbox [--assignment A-n]`（待投递和失败的通知）、`cardigan attention`（`needs_attention`、`delivery_failed`、失联）、`cardigan needs-you`（M5 之前的临时入口）。
- 验收：端到端（真实 server、真实 hc、假 Agent）：coder 交付 → reviewer 被按门铃并新建 Run → reviewer 驳回 → coder 被按门铃（返工 Run）→ 重复投递不产生第二个 Run；多条事件合并成一次门铃；PM Ops 收到升级；PM Office 只收到 Needs You 提示。

### M3.T1、M3.T2 交叉验收

- **M3.T1（Pi）**：M3.4 的投递规则、ACK、重发退避、失败、看门狗、重启后的一致性。
- **M3.T2（Codex）**：M3.1 的路由规则表（逐行）和 @提及；M3.2 的通知状态机和 Run 种类；M3.3 的收件箱唯一性和游标；M3.5 的 PM 前后台分工和打断规则。

### M3.S 真实 Agent 冒烟（Claude）

真实的 coder（Codex）、reviewer（Claude Code）和 PM Ops（Claude Code），走一轮"交付 → 驳回 → 返工 → 通过 → 完成申请"，确认门铃、Run 新建、合并和 ACK 在真实 Agent 上成立。依赖 M2.S 已经跑通。结果写进本计划的附录。

## 5. 后续事项（M3 不处理）

| 事项 | 处理 |
|---|---|
| 按会话 ID 恢复 Agent（D5），而不是新开会话 | 以后在 Runtime 的 `resume_or_replace` 里接各家 CLI 的恢复参数 |
| Claude Code、Codex 的状态转换层（把它们的事件转成 OSC 7501） | 等 M3.S 看实际需要再定 |
| Needs You 页面 | M5 |
| M3.1 的完成申请按"卡上第一个 pm 验证项"找审核者；更准确的做法是用完成申请自己的 `requested_verifiers` | M3.4 接入时顺手改 |

## 6. M3 完成的标准

- M3.1–M3.5、M3.T1、M3.T2 全部合并；M3.S 冒烟通过并记录。
- 开发方案 §16 M3 的三条验收都有对应的自动化测试。
- Claude 根据 M3 的实际情况写 M4 的任务计划。
