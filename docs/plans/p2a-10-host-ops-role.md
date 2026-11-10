# P2a-10 主机运维角色：先补确定性自动化，再引入"大乔"

- 对应：`docs/plans/phase-2.md` §2 P2a 表新增一行 P2a-10（本计划新增，指向本文件）；背景见试行发现 35（失控进程）、40（部署后常驻 PM 工具清单不刷新）、41（投递失败后 Run 卡在 `dispatched` 要手动 stop/start）；C-56（投递失败与超时的自动恢复，在做，不属于本计划）、P2a-9（全机 Run 并发上限，已排期，不属于本计划）。用户 2026-11-10 同意方向；边界参照用户在 sensen-godot 项目的运维角色"大乔"的实践（只管会话健康，不派活、不审核合并、不建卡、不定口径，按会话/窗格 ID 定位，不按名字或模式匹配，不用"↑+回车"之类的桌面操作恢复会话）。
- 前提：P2-V V1（Employee 实体）已合并——引入"大乔"作为 Employee 依赖它。C-56、P2a-9 不是本计划的前置条件，可与本计划并行：C-56 解决"投递失败"这一种失效模式，P2a-9 解决并发过载，本计划解决的是"规则覆盖不到、需要有人盯着判断"的那一部分（Run 卡在 dispatched 且不是投递失败、失控进程、偶发检查失败、常驻会话过期、attention 积压）。三者互不阻塞，谁先合并都不影响另外两个。
- 开发方案要改的章节（本计划只做拆分，不改正文；实现 PR 合并后由 Claude 按各 PR 描述统一回填）：§7（PM 前后台旁新增一类常驻角色"运维"，及它和 PM Ops 的汇报关系）、§9.2（新增 `host_ops_*` 工具清单）、§10.1/10.4（角色清单新增 `host_ops`，Launch Profile 新增 `codex-sol`）、§13.1（CLI 新增 `cardigan host-ops create/start`，以及巡检周期配置项）、§14/§14.1（角色权限边界新增 host_ops 类工具白名单与不变量）。

## 1. 目标

1. 先用确定性规则消灭不需要判断的那部分手工操作（发现 40：部署后常驻 PM 和长期会话的工具清单不刷新），这部分不需要新角色，只需要给现有的 Session 替换机制加一个新的触发条件。
2. 对仍然需要判断的运维工作（失控进程、偶发检查失败重试、会话健康巡检、attention 积压、脱敏导出请求）引入一个新的常驻角色：内部 `role_id` 定为 `host_ops`，面向用户是员工"大乔"，职位"主机运维"。
3. 给这个角色一组白名单工具，不给它 shell、sudo、Git 推送权限或密钥；所有破坏性操作由 server 提供专用工具代为执行，且执行前核对目标归属、执行后留痕。
4. 职责边界完全对齐用户给出的"大乔"实践：只管本机 Agent 会话的健康；不派活、不审核合并、不建卡、不定口径；口径问题和处理不了的事项报 PM Ops；高风险（部署、改主机配置、删数据、D12 四类）一律报人，不代为确认。

## 2. 关键设计

### 2.1 两层：自动化先行

- C-56（投递失败自动恢复）、P2a-9（并发上限）按各自计划推进，不在本计划范围内；本计划只在"任务来源"（§2.6）里说明三者如何分工，避免重复造轮子。
- **子任务 0（本计划新增，排第一位，可独立先合并）：部署后刷新常驻会话的工具清单（发现 40）**。
  - 现状核实（代码调查，2026-11-10）：角色的工具白名单在保存角色时校验（`packages/domain/src/commands/role.ts`），MCP Token 的 `allowed_tools` 在签发时固定并绑定 `(assignment_id, role_version, allowed_tools)`（§9.1 不变）；Session 的自动替换（`session_replaced`）目前只有两条触发路径：运行时失联（`runtime_not_found`/`runtime_unavailable`，`apps/server/src/dispatch.ts` 的 `deliver()`）和员工的 `launch_profile_ref`/模型变化（同一函数里的 `replaceProfile` 分支）。**没有第三条"部署了新代码，Token/角色工具清单已经落后"的触发条件**——这正是发现 40 的根因候选之一。
  - 实现卡必须先做一次诊断，而不是直接假设根因：到底是（a）Token 的 `allowed_tools` 确实没有随新版角色定义刷新，还是（b）Harness 自己缓存了 MCP 的 `tools/list`（例如 Claude Code 可能只在会话开始时拉一次），服务端刷新 Token 也无法让它当场看到新工具。两种根因的修法不同：（a）只需要在现有 `replaceProfile` 判断旁加一条"当前 Token 的工具集合与按最新角色版本重新编译后的工具集合不一致"的检测；（b）则不管后端怎么刷新 Token，都必须真正走一次 `session_replaced` 才能让 Agent 看到新工具，即诊断结论可能是"这件事本来就只能靠替换 Session，没有更轻的办法"。
  - 设计方向（在诊断结论为需要替换 Session 的前提下）：server 启动时记录一次"当前部署版本/启动时间"（可以是现有的 `agent_cli_version` 之外的一个新字段，或直接用 server 进程启动时间做近似）；在 `apps/server/src/dispatch.ts` 的 `deliver()` 里，比照已有 `replaceProfile` 分支，新增一条"本次 Run 要唤醒的 Assignment，其当前 Session 是在更早的部署版本下创建的，且该角色的工具清单确实变了"判断，命中时复用现有 `replacement` 路径（`packages/domain/src/commands/launch.ts` 的 `dispatchRun` 的 `p.replacement`，仅 `actor.kind==="system"` 可用，不需要放宽这条限制），不新增 Runtime Adapter 接口，不新造机制。
  - 这条规则覆盖"下一次该 Assignment 自然需要被唤醒"的时机；长期挂着不动、没有自然唤醒时机的常驻 PM（例如长期空闲的 PM Ops）仍需要大乔用 `host_ops_restart_standing_pm` 主动触发（见 §2.3）。

### 2.2 运维角色的定位

- `role_id` 定为 `host_ops`；这是内部概念，不在界面上直接暴露角色编号，用户面对的是员工"大乔"、职位"主机运维"（员工名已有现成素材：`packages/domain/src/avatar-library.ts` 的四大名著头像库里已经收了 `library:da-qiao`/"大乔"/《三国演义》，不需要再跑 avatar-studio 生成新素材）。
- `kind="standing"`（沿用 `packages/domain/src/role.ts` 的 `RoleKind`），按项目存储，和 `pm` 一样；本计划只给 `cardigan` 项目开一个 `host_ops` 常驻 Assignment（§6"不做"说明范围）。
- **不是** `pm` 的第三种 `standing_mode`：`standing_mode` 这个字段按 §7.1 的现状只属于 `role_id="pm"` 的常驻 Assignment（office/ops 两态），`host_ops` 是独立的角色编号，没有这个字段，也不会被 `backfillStandingModesInTransaction` 一类的 pm 专用逻辑碰到。**命名已决定（2026-11-10，用户拍板）**：`role_id` 固定为 `host_ops`，不用 `ops`，避免和既有术语"PM Ops"（`standing_mode="ops"`）同名不同指造成混淆；界面和文档统一把这个角色称为"主机运维（大乔）"，与"PM 后台／PM Ops"分开表述，不再是留待实现时决定的开放项。

### 2.3 职责、工具与它们各自对应的现有能力（代码调查结论）

逐项对照用户给的"大乔"边界，翻译成 Cardigan 的工具，并标注每个工具底下复用的现有能力、需要新增什么：

| 工具（MCP，仅 `role_id=host_ops`） | 底层能力 | 现状（2026-11-10 调查） | 本计划要做的事 |
|---|---|---|---|
| `host_ops_read_diagnostics(project_id?)` | attention、Run 状态、会话上下文用量、暂停的常驻 PM、对账发现 | `cardigan attention`（`apps/cli/src/inbox.ts`）和 MCP `list_needs_you`（`packages/domain/src/commands/queries.ts`，仅 PM 可调用）已经聚合了：`needs_attention`/`delivery_failed` 通知、`lost`/`unknown` 的 Assignment、暂停的常驻 PM、对账发现；但都不对 `host_ops` 这类 Agent 开放 | 新增只读 MCP 工具，复用这两处已有的查询逻辑（不重新实现一套聚合），只是新增一个允许 `role_id=host_ops` 调用的入口；额外补"会话上下文用量"字段（见 §2.5，现状完全没有） |
| `host_ops_restart_assignment(assignment_id, reason)` | Run 卡在 `dispatched`/`acked` 的恢复（发现 41） | 没有"重启 Assignment"这个域命令；今天最接近的人工操作是 `cardigan assignment stop` + `cardigan assignment start`，前者内部调用 `abortDispatch`（`packages/domain/src/commands/launch.ts`）并释放/强杆终端，后者走正常 `queueRun`/`launchRun`。`abortDispatch` 对应的 `CommandName` 是 `abort_dispatch`，在 `packages/domain/src/commands/core.ts` 里属于 `hostOnly` 列表之一，但该列表目前只在 `actor.kind==="system"` 时收紧检查，并不天然拒绝 `assignment` 类型的 actor（因为它现在根本没有被 MCP 暴露出来，所有调用都来自 CLI 的 human 身份） | 新增 MCP 工具，内部按顺序调用 `abortDispatch` + 正常的 `queueRun`（`reuse_queued` 语义），等价于把 `assignment stop` + `assignment start` 包成一步；在 `core.ts` 里给 `abort_dispatch` 新增一条显式 `ensure`（参照已有 `recheck_merge` 的人类专属写法），放行 `actor.kind==="human"` 或者"`actor.kind==="assignment"` 且该 Assignment 的 `role_id==="host_ops"`、`status==="active"`、同项目" |
| `host_ops_cancel_run(run_id, reason)` | 单纯取消一个 Run，不重启 | 同上，底层是 `abortDispatch`；没有独立暴露 | 同上，复用放宽后的 `abort_dispatch` 授权；是 `host_ops_restart_assignment` 的子操作，单独暴露给"只想停、不想立刻重启"的场景 |
| `host_ops_recheck_merge(card_id)` | 偶发合并检查失败重试 | **已经实现**（P2a-1 已落地）：`recheckMerge`（`packages/domain/src/commands/merge-check.ts`）、CLI `cardigan merge recheck`、Workbench `POST /cards/:id/recheck-merge`。授权在 `core.ts` 里写死 `tool !== "recheck_merge" || actor.kind === "human"`，从未对 Agent 开放 | 只需要把 `core.ts` 这一条 `ensure` 从"只认 human"放宽为"human 或者 role_id=host_ops 的 active Assignment"，新增 MCP 工具直接调用既有的 `recheckMerge`；域命令本身（前置条件：当前完成申请最新检查为 `failed`/`timed_out`）不用改 |
| `host_ops_restart_standing_pm(assignment_id, reason)` | 常驻 PM 长时间挂着不动、工具清单过期但没有自然唤醒时机 | `pauseStandingAssignment`（`packages/domain/src/commands/standing.ts`）目前写死 `actor.kind==="human"` 且目标必须是 `role_id==="pm"`；配合的恢复走 `resumeStanding`（内部函数，由 `queueRun(resume:true)` 触发，CLI `assignment start`/`pm start` 间接调用，不是独立命令） | 放宽 `standing.ts` 里 `standing()` 这个校验辅助函数的 actor 限制（human 或 role_id=host_ops 的 active Assignment），目标仍然只能是 `role_id==="pm"` 的常驻 Assignment——`host_ops` 不能暂停自己，也不能暂停其他工作项级 Assignment |
| `host_ops_kill_agent_process(assignment_id, pid, reason)` | 失控的空转进程、反复崩溃的 headless Edge（发现 35） | **明确的能力缺口**：`Runtime.release(ref, {force})`（`packages/runtime-herdr/src/index.ts`）把进程管理完全委托给 `hc kill`/`hc rm`，不经过 PID；现有唯一按 PID 操作的代码是合并闸门自己的检查进程清理（`packages/host/src/checkout-worker.ts` 的 `stopCores()`），只认"属于这次检查容器、uid 匹配、`herdr-core` 进程"，不是给任意 Assignment 的进程树用的；`agent-ssh` 的 SSH 封装（`packages/runtime-herdr/src/agent-ssh.ts`）本身不含 PID 逻辑 | 这是本计划里最不确定的一块，单独拆到 PR C（§3），先补"Assignment → 根 PID"的记录（在 `provision`/`launch.ts` 启动时记下 Agent CLI 子进程的 PID，或在 agent-ssh 账号下按已登记终端名反查进程组），再做"核对该 PID 确实在这棵进程树下"的校验，没有这一步就不能安全开放这个工具 |
| `host_ops_export_redacted_db(assignment_id, scope)` | h(2)：Agent 请人准备脱敏数据库副本 | **完全没有**：`packages/roles/src/redact.ts` 只是把 launch 命令里的密钥值替换成 `***`，用于打印/日志，不是给 SQLite 数据库做脱敏导出；代码里没有任何"导出/脱敏数据库"的实现 | 不在本计划里预先设计脱敏规则（哪些表/列要打码是数据安全决策，不是任务拆分能定的）；本计划只约定接口形状：host 提供一个固定规则的导出函数，输出放到发起请求的 Assignment 自己的运行目录（不是任意路径，不把数据库文件路径暴露给 `host_ops`），`host_ops` 只是触发者不是执行者；**脱敏范围由 Claude 在 PR C 开工前拟定草案，交用户确认后才能实现**（§7 已知风险） |

补充不变量（新增，domain 契约测试覆盖）：

1. `host_ops_*` 系列工具只能出现在 `role_id="host_ops"` 的角色的 `allowed_tools` 里（对称于 `commands/role.ts` 现有"`record_decision`/`resolve_delegated_decision`/`triage_human_action` 只能给 `role_id="pm"`"的写法，新增一条反向限定）。
2. `role_id="host_ops"` 的角色不能包含：`record_decision`、`resolve_delegated_decision`、`triage_human_action`、`submit_delivery`、`submit_review`、`create_card`、`update_card`、`create_work_item`、`update_work_item`、`assign`、`issue_instruction`（"不派活、不审核合并、不建卡、不定口径"的硬边界）。
3. `assign(work_item_id, role_id="host_ops", ...)` 直接拒绝：`host_ops` 只能是 `scope="standing"` 的 Assignment，不能被指派到任何工作项（注意 `pm` 角色本身既能常驻也能按工作项指派做完成验收，`host_ops` 没有这个双重身份，需要单独这条校验，不能照抄 `pm` 的模式）。
4. 所有执行类 `host_ops_*` 工具（`host_ops_restart_assignment`、`host_ops_cancel_run`、`host_ops_kill_agent_process`、`host_ops_restart_standing_pm`）在真正执行前，必须重新从数据库按编号（`A-n`/`R-n`/PID）查一遍目标确实存在、属于同项目、状态符合预期；核对失败整体拒绝，不留部分效果。`host_ops_kill_agent_process` 额外要求查到的 PID 确实在该 Assignment 记录的进程树里。
5. 每次执行类 `host_ops_*` 调用成功后，写一条带工具名、目标编号、理由、actor 的审计事件（新增 `host_ops_action_taken`，复用现有"先持久化事件再做外部动作"的顺序，不新建独立的审计表）。
6. `host_ops` 发起的任何 `request_decision`/`request_human_action` 仍按 Agent 身份处理（`decider` 不会因为是 `host_ops` 发起就变成 `role:pm` 或 `human`）；D12 的四类高风险拍板继续只认 `human`，`host_ops` 不能代拍或转录，和 PM Office/PM Ops 现有的限制一样。

### 2.4 汇报关系

- 对 PM Ops 负责：常规巡检结果、`host_ops_read_diagnostics` 看到但权限内处理不了的事项、涉及口径的问题，`host_ops` 用 `post_comment`（@ PM Ops）或 `request_human_action` 转交，不新增专门的路由规则——复用 §6.4 现有"没有 Assignment 时交给 PM Ops"和 §6.5 的 @提及解析；实现中如果发现确有必要为"host_ops 发现的事项"单开一类通知，再在实现卡里评估，本计划不预先要求。
- 不直接面对用户：`host_ops` 不出现在任何 Decision 的 `decider` 里，不能调用 `record_decision`；需要人确认的事项（高风险、部署、改主机配置、删数据、D12 四类）一律 `request_human_action`，走现有"PM Ops 分拣 → host/human"的路径（`triageHumanAction` 的 `disposition: "host"` 已经存在，对应界面文案"主机操作"/"等待主机操作"，`packages/domain/src/commands/coordination.ts`）。本计划不改分拣逻辑本身，只是让 `host_ops` 成为"被转交 host 操作后，第一个尝试处理它的人"，处理不了再按现有流程留给人工。
- `host_ops` 本身是一个普通的常驻 Assignment：它的 Run 结束没有产出会按 §6.4"Run 结束但没有交付、审核、阻塞或决策"规则转给 PM Ops（异常），不自我循环（§6.4 不变量"任何 Assignment 都不因自己的 Run 结束事件被唤醒"同样适用于它）；`host_ops` 自己卡住或失联，按现有 lost/unknown 流程处理，不特殊化。

### 2.5 会话上下文用量

- 现状（代码调查确认）：`Run` 只有 `heartbeat_note`（自由文本）和 `heartbeat_at`，domain 里完全没有 `context_usage`/`token_usage` 一类的结构化字段；§11.3 的已知限制里也没提运行时上报这类数据。这正是 P2d 的 `D-C2`（上下文水位）要做的事，还没开工。
- 本计划的态度：不在这里重做 D-C2，`host_ops_read_diagnostics` 返回的字段提前留一个可选的 `context_usage_pct?`；D-C2 落地前，由主机按一个退化指标估算（例如同一个 `session_ref` 下累计的 Run 次数或该 Session 已持续的时长，具体公式实现时定，默认阈值 80%，可配置），并在返回里标注"估算"；D-C2 落地后换成真实用量，不改 `host_ops_read_diagnostics` 的外部字段形状。
- 超阈值时的动作：先让该 Agent 写交接，再走 §2.1 提到的既有 `session_replaced` 机制替换会话，交接内容进时间线或项目事件（已有机制，不是新能力）；`host_ops` 只是"建议/触发"这次替换，不直接给终端发按键——对应用户教训"用'↑+回车'恢复会话导致 14 个窗格并入同一会话"，`host_ops` 的所有操作都走编号化的正式工具，不摸终端。

### 2.6 按 Assignment / Run / PID 定位，不按名字或模式匹配

- 每个 `host_ops_*` 工具的入参都是编号（`A-n`/`R-n`/PID），不接受名字、项目目录名、窗格标题或模式；对应用户教训"按目录名猜收件人发错人"。
- §2.3 第 4 条不变量就是这条原则在 domain 层的落地：执行前必须重新用编号查一遍目标，不信任调用参数里附带的任何名字或描述文字。

### 2.7 任务来源

- `triageHumanAction` 的 `disposition="host"` 已经存在（目前只是改写 handoff 文案后仍然走到 Needs You，由人处理）；本计划让这类事项同时通知 `host_ops`，由它先尝试在权限内处理，处理不了再按现有流程留给人。
- `host_ops_read_diagnostics` 返回的 attention 积压条目（`needs_attention`/`delivery_failed`、lost/unknown Assignment、对账发现）。
- 定时巡检：默认每 30 分钟一次（参照用户的"大乔"实践），由 Dispatcher 像现有常驻 PM 一样定期唤醒 `host_ops` 的 Session（复用现有唤醒机制，不新造一个独立的定时器系统），周期可配置（`CARDIGAN_HOST_OPS_PATROL_INTERVAL_MS`，风格对齐 §12.6 其它循环间隔配置项的命名）。
- 和 C-56、P2a-9 的分工：C-56 覆盖的"投递失败"场景不会出现在 `host_ops` 的巡检范围里（避免两边都处理同一件事）；P2a-9 的排队展示是现成的只读信息，`host_ops_read_diagnostics` 可以带上，但不做任何调整并发上限的动作。

### 2.8 大乔的 Launch Profile

- 模型 `codex-sol`（`gpt-6.1-sol`，用户 2026-11-10 指定；该模型名在现有分析类任务里已经用过，参见 `docs/research/0.2-board-retrospective.md`"Codex gpt-6.1-sol"）。
- 上线前由 Claude 按 §10.2 的两层配置（Provider + Launch Profile）新增一份 `codex-sol` 的启动配置，写进主机 `~/.config/cardigan/launch.yaml`（不进仓库），实测 `whoami` 可用才算完成。
- 以后 V2（接入点管理页）上线后，这个 profile 可以换成更便宜的模型，不需要改角色定义——角色和模型已经在 §10.2 解耦（员工的 `launch_profile_ref`）。

## 3. 拆分（三张卡，按顺序）

| PR | 分支 | 内容 | 依赖 |
|---|---|---|---|
| A | `feat/p2a-10a-session-refresh` | 子任务 0：部署版本/工具清单落后的诊断结论 + `apps/server/src/dispatch.ts` 新增一条 `session_replaced` 触发条件；不涉及 `host_ops` 角色 | — |
| B | `feat/p2a-10b-host-ops-role` | `host_ops` 角色定义与权限边界（`toolNames`、`ROLE_TOOL_ALLOWLISTS`、§2.3 的六条不变量 + 契约测试）；MCP 工具 `host_ops_read_diagnostics`、`host_ops_restart_assignment`、`host_ops_cancel_run`、`host_ops_recheck_merge`（放宽 `core.ts` 里 `recheck_merge` 的 actor 限制）、`host_ops_restart_standing_pm`（放宽 `standing.ts` 的 actor 限制）；CLI `cardigan host-ops create`/`cardigan host-ops start`（参照现有 `cardigan pm create`）；默认角色包新增 `host_ops` 的 Core Prompt | 不依赖 A，可并行 |
| C | `feat/p2a-10c-host-ops-destructive-tools` | `host_ops_kill_agent_process`（先在 `packages/host` 补 Assignment→PID 的记录与校验）+ `host_ops_export_redacted_db`（脱敏范围由 Claude 在开工前拟定草案，交用户确认后才能实现，不在本计划里预先拍板具体范围） | B 合并后；开工前需要 Claude 拟好脱敏范围草案并取得用户确认 |

每张卡控制在几百行以内；B 如果超长，把 MCP 工具单独拆一张（先落地角色定义和不变量，再接工具）。

## 4. 测试

- domain 契约测试：§2.3 六条不变量逐条覆盖（`host_ops_*` 只能给 `role_id=host_ops`；`host_ops` 不能有六类工具；`assign` 拒绝 `role_id=host_ops`；执行类工具的前置核对失败不留部分效果；`host_ops_action_taken` 事件写入；`host_ops` 不能让 `decider` 变成非 human/role:pm 之外的值）。
- `core.ts`/`standing.ts` 放宽后的 actor 校验：只认 `role_id=host_ops` 的 `active` Assignment；其它角色（包括 `pm`）、非本项目、已释放的 `host_ops` Assignment 一律拒绝；原有的 human-only 行为不变（回归测试）。
- 子任务 0：按诊断结论编写契约测试，覆盖"工具清单未变 → 不触发替换""工具清单变了但没有自然唤醒时机 → 仍不自动触发（留给 `host_ops_restart_standing_pm`）""工具清单变了且有自然唤醒时机 → 触发 `session_replaced`"三种边界。
- 验收测试（假 Agent）：Run 卡在 `dispatched` → `host_ops` 巡检发现 → `host_ops_restart_assignment` → 恢复 `running`；合并检查失败 → `host_ops_recheck_merge` → 通过；全程不需要真实 Harness。
- 改了 `packages/domain`（含测试文件）照常跑 `pnpm --filter @cardigan/domain test:types`。

## 5. 上线（Claude 负责）

1. PR A、B 合并后，新增 Launch Profile `codex-sol`，实测 `whoami`。
2. `cardigan employee add --name 大乔 --title 主机运维 --role host_ops --avatar library:da-qiao --launch-profile codex-sol`（头像素材已有，不新增生成任务）。
3. `cardigan host-ops create` 给 `cardigan` 项目开一个 `host_ops` 常驻 Assignment（PR B 要新增这条 CLI，上线步骤依赖它）。
4. 观察一周：对照发现 35/40/41，记录哪些还需要 Claude 手动介入、哪些已经由 `host_ops` 处理；PR C（失控进程、脱敏导出）视观察结果和用户确认再排期。
5. 每一步更新 memory 和开发方案对应章节。

## 6. 不做

- 不做跨项目、跨机器的巡检：本计划只给 `cardigan` 项目开一个 `host_ops` Assignment；用户在其它项目（zili-plane、sensen-godot）的"大乔"是另一套非 Cardigan 的实践，不在本计划范围内，也不要求迁移。
- 不做 `host_ops` 专属的 Web 聊天或 UI：复用现有 Needs You、`cardigan attention`、CLI。
- 不做"运行中动态调整 reasoning effort"的新接口：Role 的 `reasoning_effort` 是版本级静态字段，员工换 Launch Profile 已经能触发 Session 替换（§10.2），但"同一次会话里临时调高/调低 effort"目前没有对应机制，需要时另开任务。
- 不预先设计 `host_ops_export_redacted_db` 的具体脱敏规则（哪些表/列打码是数据安全决策；由 Claude 在开工前拟定草案交用户确认，见 §7）。
- 不改 C-56、P2a-9 的设计或进度。

## 7. 已知风险

- 运维 Agent 自己卡住或误操作：由 PM Ops 巡检它（`host_ops` 是普通常驻 Assignment，纳入现有异常路由，不特殊化）；所有破坏性工具都有 §2.3 第 4 条的前置核对和第 5 条的事件记录，出问题可审计、可回溯。
- `host_ops_kill_agent_process` 依赖尚未存在的"Assignment → PID"记录能力，PR C 开工前需要再评估 agent-ssh 下多账号隔离和进程树判断的实现难度，可能比预想复杂；没有把握前不要为了赶进度放宽"核对该进程属于某个 Assignment 的进程树"这一条。
- `host_ops_export_redacted_db` 的脱敏范围是数据安全决策，本计划不预先拍板；由 Claude 在 PR C 开工前拟定具体范围草案（哪些表、哪些列、附件内容是否包含），交用户确认后才能实现，没有确认就不要开工这部分。
- 子任务 0（部署后刷新工具清单）的根因还没有最终确认：如果根因在 Harness 一侧（例如 Claude Code 只在会话开始时拉一次 MCP 工具列表，没有远程强制刷新的办法），那么无论服务端怎么推送新 Token，都还是要靠替换 Session 才能生效，PR A 的范围可能比"加一个判断条件"更大，需要在实现卡里先写清楚诊断结论再动代码。
- `codex-sol` 是否够用需要实测；用户已表示效果优先，以后有 V2 接入点管理页后可以换成更便宜的模型，不需要改角色定义。
