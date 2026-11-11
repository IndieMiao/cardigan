# M1.3 命令契约

本任务分为两个依赖 PR：第一部分为公共命令内核、交付、审核及完成申请；第二部分补齐协作、PM、附件、Run 和查询工具。公共入口为 `@cardigan/domain`。

## M2.1 启动命令

- queueRun / dispatchRun 只接受同项目 human/system Actor，不是 MCP 工具。queueRun 输入 assignment_id、model、agent_cli_version、可选 launch_profile_ref，生成 initial/queued Run 和 run_queued 事件（同时作为触发事件），快照固定的 Role 版本和 Assignment.employee_id；拒绝 inactive Assignment、闭卡、归属变化和已有未结束 Run。
- dispatchRun 输入 run_id、runtime_ref、可选 base_sha 及主机实际编译的 launch_snapshot（model、agent_cli_version、launch_profile_ref），仅 queued Run 可在派发时记录它；RuntimeRef 携带 worktree_path / branch / agent_session_id，归约记录到 Assignment，工作目录存在时必须有有效基线 SHA。旧 worktree/branch 必须复用，同机器共享路径上有未结束 Run 时保守拒绝；所有状态变更走 transition。第一次派发从 not_provisioned 经 provisioning/idle 到 running；旧 Run 已结束时可把遗留 running 经 run_finished 归到 idle 再派发。unknown/lost/released 需另行恢复，不能跳过。
- M5.6：dispatchRun 可由 system 携带 replacement（旧 RuntimeRef、runtime_not_found/runtime_unavailable/launch_profile_changed/tool_catalog_changed 原因）；校验旧引用仍匹配且无其他未结束 Run 后，将 session_replaced 事件及系统 handoff 与当前 queued Run 的派发原子提交，清除旧 CLI 会话 ID。常驻 Assignment 无卡片时间线，交接正文保存在项目事件中。
- acknowledgeRun 输入 run_id，仅接受拥有该 Run 的 active Assignment Actor，供 MCP 认证后内部调用，无独立 MCP 工具名。dispatched 经 acknowledge/start 到 running（兼容 acked），写 started_at 和 run_started；复用 activeWork 检查依赖/审核预算并激活自己的可执行工作项，其他工作项不动。等待目标、暂停或已交付的工作项保持原状态。重复确认 running Run 无变更/事件；检查失败时不返回部分效果。
- abortDispatch 输入 run_id/reason，只允许 human/system，经 cancel 标记 cancelled/outcome=failed、记录原因和结束时间。已 cancelled 可重试；completed/failed 拒绝。运行状态为 running 时经 run_finished 到 idle 并清空 runtime_ref，保留工作目录和 Session 元数据，允许后续排新 Run；不倒退工作项、不删除 worktree。外层负责 release 终端和撤销 Token，此命令不替代 IO 清理。
- Runtime 的编译输入、端口错误与业务 Result 分开；domain 不启动终端、写文件或签发 Token。命令的快照读取、编号、实体和事件仍需外层同一事务提交；M2.6 接入真实启动和首次 MCP 调用。

## 调用和持久化边界

- `CommandState` 是单个项目的当前快照；包含实体、版本化 Role、事件和时间线。调用方负责在事务内读取一致快照，不能把不同项目的同号实体混在一起。
- 命令输入为 `state, Actor, params, CommandPorts`，输出 `Result<CommandEffect<T>>`：data、changes、events、timeline 和 token_requests。拒绝只返回错误码，不暴露半成品变更；输入快照不被修改。
- Actor 由认证层构造。内核核对项目、Assignment 存在/active、固定的 Role 版本、角色及 Token 的工具许可；工作项 Assignment 只能访问本卡，常驻 PM 可访问项目。正文或参数里的署名不能覆盖 author。
- Clock 和 IdAllocator 注入。适配器须在同一个事务内分配编号并写入整批结果；收到失败 Result 必须回滚该事务（包括已分配编号）。domain 不调用仓储，不直接做网络、文件、数据库、哈希或随机数 IO。
- `prepareDelivery` 是事务外端口预检，实际调用注入的 DeliveryVerifier；`submitDelivery` 是同步归约，验证进程内凭据并重查当前快照。凭据不是 MCP 参数，不能由客户端 JSON 构造，也不应持久化。M1 可注入接受/拒绝桩，M4 换为真实 Git 校验。
- M1.6c 的附件参数 file 是规范带填充 base64（解码后 ≤10MiB），适配层计算 sha256 并核对可选的客户端摘要，经 prepareAttachment 在事务外写入内容寻址 AttachmentStore。uploadAttachment 在新的幂等事务快照中验证身份、basis 和 attach_to；失败回滚数据库，但保留已发布文件，避免误删共享内容。元数据返回相对 storage_path；未引用文件及崩溃临时文件的清理留待后续。
- projectSnapshot / listNeedsYou 在同一个只读事务的 CommandState 上执行，不写幂等缓存；heartbeat / finishRun 则复用写命令的幂等入口。
- 初始 Run 的创建/派发、Token 的实际随机值/哈希和幂等缓存由外层负责；命令不接受调用者自报的 Run 归属或 Token 权限。现有 store 的幂等入口应包裹命令事务，不能直接重复归约替代请求幂等。

## 交付、审核和完成申请

- `prepareDelivery` / `submitDelivery`：只允许产出工作项当前 Assignment，并要求恰好一个 running Run。摘要按 Unicode 码点限制 160；subject 必填，git_head 接受 40/64 位十六进制，artifact_sha256 接受 64 位，doc_version 为非空字符串。
- 交付、审核和暂停自身工作项共用 activeWork：todo 产出先校验依赖再启动，ready / changes_requested 产出走 run_started；ready 验证项在有剩余轮次时才启动。启动要求当前 running Run，不把 Run 启动等同于工作项已经 in_progress。
- requested_verifiers 必须是明确、不同的验证 WorkItemId。产出交付只填 target_work_item_id 等于当前工作项的验证项，并覆盖其中所有必需项；PM 验收审完成申请，不能填入产出交付。已有工作项的目标不符或非空列表遗漏必需项时，invariant_violation 消息列出对应编号，不能用“角色 A 或 B”绕过验证。证据来自预检，参数中的 evidence/author/run_id 不作为可信字段。
- 新产出替代该工作项的旧产出和旧完成申请：产出验证项回到 ready，失去完成申请目标的 PM 验收项回到 todo，等新完成申请再 ready。supersedes 只指向同类上一版（产出 / 完成申请），显式传入时也校验类型。完成申请只替代旧完成申请，绑定当前产出的相同 subject，保留已经通过的代码审核。
- 主产出及 PM 验收项通过模板稳定键识别。按用户确认，前置条件排除本次 PM 验收项；其余未满足项必须有精确 precondition 键、说明及同项目后续卡片。检查结果加入 evidence，不能由调用者伪造“已通过”。
- `submitReview`：只允许该交付请求的验证 Assignment；SHA/交付版本过期拒绝。verdict/blocking 通过 M1.2 计算，忽略客户端同名字段；普通审核使产出被接受或返工，完成审核后进入 awaiting_merge；无 Git 提交形式的交付（subject.kind=git_head，不按 kind 分类）时同命令直接 done，其余经合并后才 done。
- conditional 不算必需验证通过。已终结的交付不能继续改结论，需要新交付版本；每个 Run 只提交一次审核，请求重放由外层幂等处理。
- 第二轮起沿用问题描述（去除首尾空白）作为复查匹配依据；新增非 pre_existing 问题必须 critical 且有 proof。此处不做语义相似度判定。
- 达到上限且仍为 reject 或 conditional 时，在下一轮开始前生成阻塞 Decision、验证项进入 waiting_decision，当前审核 Run 以 blocked 结束；先发 review_submitted（rework_allowed=false），再发 decision_requested，不创建返工 Run。最后一轮 pass 正常通过；换新 Run 不能绕过上限。不存在用户可写的“自动通过”开关。
- 最后一轮 pass 后，新交付同样检查累计预算；已用尽时立即从 ready 经 review_limit_exceeded 进入 waiting_decision，生成 trigger=review_limit 的 Decision，先发 delivery_submitted 再发 decision_requested。仅结束验证方正在运行的 Run，保留已结束 Run 和产出者 Run；后续交付保留并复用现有 open / provisional 上限 Decision。恢复可从最近已完成审核 Run 取快照创建新 Run，无需把旧 Run 改写为 blocked。
- 上限 Decision 带控制面写入的 trigger=review_limit；普通 requestDecision 不接受该标记。Office 记录 pause 时用 provisional 保持阻塞，发 decision_provisionally_resolved，不恢复或排 Run；之后可在同一 Decision 上确认 raise_limit。raise_limit 不直接改上限：审核轮次仍用尽时继续等待，直到 Ops／人用 updateWorkItem 放宽且没有其他阻塞，才 ready 并排新 decision_resumed Run。先放宽后拍板同样可恢复。reject 后仍需新交付；conditional 可继续审核原交付。

## 验证与边界

CLI 的 `cardigan card update <C-n> [--title <标题>] [--goal <目标>] [--acceptance <标准1;标准2>] [--priority <n>] [--status backlog|todo|cancelled] [--superseded-by <C-m>] [--project <p>]` 以 human Actor 调用 `updateCard` / `supersedeCard`，至少提供一个修改字段。`--acceptance` 按分号拆分并去除空白与空项（整体需加引号，至少保留一条），`--priority` 必须为有限数值。项目选择复用 `--project`、`CARDIGAN_PROJECT`、数据库唯一项目的顺序，也支持通用 `--data-dir`。取消卡片和工作项由 domain 状态机处理，已通过的验证项保持 passed；拒绝 done → cancelled/todo/backlog，也不能手动设置 done / review / in_progress。已完成卡片取消时以中文提示建新卡（例如回滚卡），再用 `--superseded-by` 标记旧卡。成功输出卡片编号和修改字段；无字段、非法参数及不允许的转换返回中文错误和非零退出码，拒绝时事务不持久化任何部分效果。

`supersedeCard(state, actor, {card_id, superseded_by}, ports)` 是仅限同项目 human 的命令，不增加 MCP 工具。原卡必须处于 done/cancelled；目标必须是同项目另一张现存卡片，目标状态不限。保留卡片状态和工作项，写 `resolution=superseded`、`superseded_by`，并向 `related_cards` 去重加入目标；不从普通关联关系猜测取代者。产生 `card_superseded` 事件（payload: `{card_id, superseded_by}`）及带卡片引用的时间线。相同目标重试无副作用；更正目标保留既有相关卡片和历史事件。CLI 组合字段更新与取代标记在同一事务内提交，任一步拒绝均回滚（包括事件和编号分配）。

契约测试通过公开函数、确定性 Clock/IdAllocator 和可配置验证桩执行，测试名标明不变量。真实鉴权入口、同事务提交、Token 签发和传输幂等由 store/MCP/组装层验收；本任务不实现这些 IO 层。

合法状态迁移统一调用 M1.2；对其没有定义迁移的前态，返回 illegal_transition，不强行改写状态。长度、权限和版本等语义由命令检查；MCP 输入的完整 JSON 类型校验仍由 M1.6 的 zod 参数层负责。

## 其余工具

| 工具                                | 公开函数                                 | 主要约束                                                                                                               |
| ----------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| post_comment / report_blocker       | postComment / reportBlocker              | 服务端抽取引用；同作者、同卡才可 supersede；人工阻塞返回结构化请求指引                                                 |
| request_decision / record_decision  | requestDecision / recordDecision         | 明确 decider/category；敏感分类只许 human；Office 记录原话、via_chain 和 batch 标识                                    |
| request_human_action                | requestHumanAction / completeHumanAction | 阻塞目标工作项；completeHumanAction 是人操作的内部入口，不增加 MCP 工具                                                |
| upload_attachment                   | prepareAttachment / uploadAttachment     | 适配器先算 sha256、经 AttachmentStore 准备内容，归约只收进程内凭据和元数据；artifact 必须有存在的 basis 和具体挂载目标 |
| heartbeat / finish_run              | heartbeat / finishRun                    | 仅本 Assignment 的 Run；保留版本快照；heartbeat 不进入时间线；结束 Run 不等于业务通过                                  |
| create_card / update_card           | createCard / updateCard                  | PM／人；开发卡强制验收标准，禁止手动置 done 或 review/in_progress                                                      |
| create_work_item / update_work_item | createWorkItem / updateWorkItem          | PM／人；保护模板必需项，仅允许受控 blocked → in_progress；上限只能由 Ops／人放宽                                       |
| assign                              | assign                                   | 同一工作项保持唯一责任上下文；重复指派复用 Assignment／Session，不重发 Token；M1 仅 local                              |
| project_snapshot / list_needs_you   | projectSnapshot / listNeedsYou           | 项目级 PM／人；复用 M1.2/M1.2b 派生，列出待人决策、待人操作和运行异常                                                  |

协作细节：

- Office/Operations 共用 pm 角色：Office 是常驻 PM 且 Token 允许 record_decision；Ops 是不具备该工具许可的常驻 PM。工作项级 PM 验收 Assignment 不能代替 Office。实际 Token 授权仍由认证层核实。
- reportBlocker 将 reason、needs、来自 Actor 的 reported_by 和 Clock 的 reported_at 保存到 WorkItem.reported_blocker。只有 PM／人用 updateWorkItem(status=in_progress) 确认清除该标记；即使还有其他阻塞，确认也成功，但保持 blocked / waiting_decision，resume_work_items 为空，事件记录 reported_blocker_cleared=true。其他 Decision / HumanAction 解除不能清掉报告，未确认时也不会恢复。最后一个原因解除、审核预算允许后，按当前暂停状态走 resume 或 decision_resolved；已有 Run 保持运行，没有未结束 Run 时按既有规则排一次新 Run。没有报告标记时保留原有受控恢复限制。
- category 的准确性由上层受控输入/策略保证；已标记为敏感类别的请求只能选择 human，本实现不做自然语言意图分类。batch 是批次标识，多条决定以同一标识关联，未增加批量 RPC。
- reportBlocker、阻塞 requestDecision 和包含自身工作项的 requestHumanAction 在暂停自身之前调用共用启动校验；不会代为启动其他 Assignment 的工作项。不能暂停时错误包含工作项编号、类型和状态。
- 工作项级 Assignment 请求阻塞拍板时，自动将自身可执行工作项去重并入 affected_work_items，再结束相关 running Run；produce 已 delivered / accepted 时不自动并入也不结束自身 Run，显式暂停则拒绝。解决最后一个阻塞原因且审核预算充足后，已有执行历史的责任上下文生成新的 queued Run，复用 Assignment／Session 和最近 blocked Run 的版本快照（上限拍板也可沿用已完成的审核 Run）。没有历史快照时只返回触发事件，后续调度负责初始配置；不启动 Harness、不按门铃。
- reported_blocker、多个 Decision/HumanAction 同时阻塞同一工作项时，不因其中一项完成就提前恢复；恢复事件的 resume_work_items（包括 completeHumanAction）只列实际恢复项。对同一个已自动结束的 blocked Run 再 finish_run(blocked) 为无副作用确认。
- 评论识别 C-n、C-n#m、q(n)、h(n)、D-n 以及 GitHub 风格 pull / GitLab merge_requests 链接；跨卡引用不会授予跨卡修改权限。引用解析不发网络请求。
- token_requests 只有签发所需元数据，token_id 包含项目和 Assignment，不含随机 Token 值。MCP 适配层只登记 Assignment，不执行签发、不返回 Token 明文；新建响应为 token_status=pending_host_issuance，重复指派为 host_managed（不保证已签发）。M1.7b 的人用 CLI 和 M2 启动流程负责在主机事务内校验 Assignment / Role 版本 / 工具许可并调用 issueToken；明文只交给人或写入该 Assignment 自己的 MCP 配置（worktree 外），Session 替换时撤销旧 Token。MCP 响应、幂等缓存和日志不携带明文。
- 附件哈希验证、文件落盘、失败后的内容清理和传输大小上限由 M1.6 适配层负责。prepareAttachment 需在认证之后调用，上传元数据拒绝不会自动删除已准备的内容。
- whoami / get_card / get_updates / ack_events 由 M1.5 的 mcp-server 工具与测试单独维护，domain 删除对应重复实现。projectSnapshot / listNeedsYou 仍要求一致且完整的项目快照，卡片状态及 waiting_on/next_owners/why 复用已合并的派生函数。

## M4.1 合并确认与计划

- CardTemplate.merge 为 none / confirm / auto，开发卡默认 confirm。createCard 从项目当前启用模板固定 template/template_version 和 Card.merge_policy，旧卡按 dev v1、confirm 读取；MCP 参数不能覆盖策略。
- 完成审核通过后先发 review_submitted，再按策略发 decision_requested；确认绑定当前完成申请，merge / hold 均保留 awaiting_merge，只有 merge 允许执行。recordDecision 对合并确认开放 human 入口，记录原话和 needs_you 来源；原有 Office 入口保持。requestMerge 仅人或常驻 PM Ops 可用，仅对已 hold 的确认重新申请。新增 request_changes（退回修改），rationale 和 raw_quote 均须非空；Web 不为此选项生成默认原话。确认必须绑定当前已接受的完成申请。退回时卡片经 request_changes 回 in_progress，完成申请所属的主产出 accepted → changes_requested，旧完成申请 supersede，PM 验收经 target_withdrawn 回 todo。与 merge_conflicted 共用 reopenMerge 迁移；发出 decision_resolved 后再发 merge_changes_requested，payload 带 decision_id/completion_id/work_item_id/run_kind=fix/reason，时间线记原因。Router 和 Dispatcher 为原 Assignment 排 fix Run，trigger_event_id 关联含原因的事件，不在 domain 重复排 Run。
- mergePlan(state, card_id) 无 IO，返回 card_id/title/base_branch/completion_id 和按工作项编号排序的 deliveries（delivery_id/work_item_id/sha）。只收最新未被取代且已接受的 Git 提交形式的交付（subject.kind=git_head，不按 kind 分类）；未接受或尚无交付的工作项跳过，known_gaps 仍由完成申请校验。没有可合并交付时直接 done。检查当前完成申请及确认，未决阻塞会拒绝；M4.4 负责一致快照和固定 ref 校验。待合并期间冻结交付与审核，冲突或退回修改后才能重新交付；之后需重新审核、申请完成和确认合并。

## M4.1 合并结果、释放和清理

- recordMergeResult(state, system, { card_id, completion_id, result }, ports)：result 为 merged { merge_sha, previous_sha } / conflicted { delivery_id, files } / failed { reason }（用 kind 区分）。检查当前 mergePlan 及完成版本；只允许 system。除已记录结果的精确重放外，非 awaiting_merge 拒绝。以完成版本和规范化结果去重，旧结果不能完成新版本；事件 payload 为 completion_id、result，冲突另带 work_item_id/run_kind=fix。
- merged 写 done/resolution；failed 仅写事件；conflicted 回 in_progress，冲突产出经 merge_conflicted 返工，旧完成申请 supersede、PM 验收经 target_withdrawn 等待新目标。Router 输出原产出 Assignment 的 fix 通知；真正排 Run、按铃属于 M4.4，未在命令里另建第二个 Run。
- releaseAssignment({ assignment_id }) 允许人／常驻 PM Ops／system，无未结束 Run 才迁移两个 Assignment 状态并写 assignment_released。system 只自动释放闭卡的工作项 Assignment；PM Ops 只能释放 scope=work_item，常驻 Assignment 仅允许 human 释放；重复释放前也先校验这一权限。事件携带 token_id（非明文）、runtime_ref、worktree_path、branch；M4.4 沿用 M2 stop 方式撤销该 Assignment 的全部 Token 并释放终端，domain 不证明外部清理已完成。
- requestWorktreeCleanup({ assignment_id, reason }) 只允许 system；要求已 released 且有工作目录，创建绑定 Assignment 的人类 keep/force_clean 决策。未决或已解决决定均复用，keep 不再重复询问。recordDecision 对此类决策开放 human 入口；不扩充 MCP 工具。

## P2a-1a 合并检查

- 主机加载命令状态时可提供 `project_settings.merge_gate_enabled`；MCP 参数不能配置该字段，未启用项目的原行为保持。
- `prepareMergePlan` 仅忽略当前完成申请的合并确认，其他阻塞仍拒绝；正式 `mergePlan` 继续要求确认。启用闸门后，冲突／失败可以在确认前记录，成功必须满足确认及不变量 21。
- `recordMergeCheck(state, system, input, ports)` 记录 queued／running／passed／failed／timed_out／interrupted，绑定 card、completion、attempt、candidate 和 tree。结束结果只接受一次，精确重放无事件；failed／timed_out 的同树重试必须先由人 `recheckMerge({card_id})`，中断可自动重排。每次重排使用全新 attempt，未结束检查不能并发替换。
- `recordMergeResult(merged)` 在启用闸门时要求同完成申请、同 tree 的 passed 记录；`noop=true` 必须 merge_sha == previous_sha，由主机证明交付均已包含，不创建虚假的检查记录。`latestMergeCheck` 和 `hasPassedMergeCheck` 是无 IO 的事件投影。

## M5.2 人的操作与编号

`issueInstruction(state, actor, {card_id, work_item_id, body}, ports)` 仅接受人或常驻 PM Ops（持久 standing_mode=ops），校验工具许可、同卡和未结束状态；closed/awaiting_merge 卡片不能下指令。输出 instruction_issued 事件及 instruction 时间线；不直接排 Run，复用 Router 指令规则。MCP 名称为 issue_instruction，复用幂等事务；Office、工作项 Assignment 不显示且不能调用。

`recordDecision` 允许人记录所有 decider=human 的决策，via=needs_you；原话和理由仍必填。MCP 的 PM Office 路径不变。`submitDelivery` 的 pr_url 若提供必须是合法绝对 HTTP/HTTPS URL；预检和事务内归约均拒绝其他协议/相对地址（validation_failed），不会为无效 URL 做 Git 预检。

`extractReferences` 支持工作项、Assignment、Run 和 Review 编号；`resolveReferences(state, body)` 在当前项目快照中返回去重的编号、kind、status、exists 和可用的 card_id。未知编号无卡片目标，不应生成链接；函数不访问仓储或外部 PR。

M5.6：阻塞 Decision 和审核轮次上限的隐式 Run 结束与 finish_run 共用收尾，Assignment 回 idle。未知/失联环境不由业务收尾判定重连。

S24：`pauseStandingAssignment` 是只允许同项目 human 的主机命令，仅作用于常驻 pm。它经 suspend 暂停 Assignment、经 cancel 结束未完成 Run，保留 RuntimeRef 供主机回收。`queueRun(..., {resume:true})` 也仅允许人恢复 suspended 常驻 PM，并在同一个纯命令中恢复状态、排新 Run；系统派发不能使用该选项。CLI 在暂停事务内撤销 Token、结清被手动中断的投递意图，关闭失败会保持暂停；显式 start 失败也重新暂停。工作项 stop 保持原语义。

S21 / V10a：MCP create_card 可省略 repo／base_branch。需要仓库的模板由适配层在命令事务内从 Token 所属项目登记信息补齐；显式字段保留，缺少登记默认值返回 validation_failed。不需要仓库的模板不自动绑定项目仓库。domain createCard 按模板检查字段，不做仓储 IO。幂等使用未补默认值的原始请求作为指纹；成功重放不重新读取项目配置。create_card／update_card 的 MCP 响应隐藏 repo，实体变更仍保存完整字段。

## P2-V V1a 全局员工命令

计划：[p2v-1-employee.md §3 V1a](../../docs/plans/p2v-1-employee.md)。入口均从 `@cardigan/domain` 导出，不增加 MCP 工具。

- `createEmployee(employees, actor, input, ports)`：只有 human 可创建，`name/title/role_id` 必填，`bio` 默认空、`avatar/launch_profile_ref` 默认 null；产生 active 员工和 `employee_created`。编号由独立 `GlobalIdAllocator` 分配 `E-n`，不接受项目参数。
- `updateEmployee(employees, actor, id, patch, ports)`：只有 human 可修改名字、职位、简介、头像引用和启动配置；至少一个字段，拒绝角色、状态、编号和审计字段。`avatar/launch_profile_ref=null` 清空，简介用空字符串。保留 `created_at`，更新 `updated_at`，产生 `employee_updated`。
- `deactivateEmployee / activateEmployee(employees, actor, id, ports)`：只有 human 可停用／恢复，经 employee 状态机迁移，产生 `employee_deactivated / employee_activated`；重复设置已有状态无变化、无事件。没有删除入口，不修改任何 Assignment。
- 名字／职位／简介上限为 40 / 40 / 200 个 Unicode 字符，拒绝控制和格式控制字符；去除首尾空白，名字的全角空格转半角。所有项目的 active 名字按 Unicode `toLowerCase()` 不区分大小写比较，显示名保留大小写；创建、重命名和恢复均检查，inactive 可以重名。
- 设置非空配置引用必须存在于 `ports.launch_profiles`（主机读取 `launch.yaml` 后注入）。普通修改和停用／恢复不要求旧配置还存在。配置选择不改变角色。domain 不做文件 IO；项目角色登记由下述 assign 命令检查。
- 归约返回 `EmployeeEffect`（data、employees、events），由 store 在同一 `uow.run` 事务内保存员工、全局计数器及全局事件。全局流独立于原有项目／卡片流，事件保存 human 身份、员工快照和审计时间；拒绝不返回部分效果，编号在字段校验之后分配。列表通过全局只读仓储读取，CLI 默认过滤 inactive，可用角色过滤和 `--all`。


## P2-V V1b 员工指派与读取视图

计划：[p2v-1-employee.md §3 V1b](../../docs/plans/p2v-1-employee.md)；大小写规则按 C-21 的用户拍板覆盖计划旧描述。

- `assign` 新增可选 `employee_id`（员工 E-n 或在职名字）。新指派校验员工在职、角色与工作项一致且已在目标项目登记；重复指派保留原员工，不能在已有 Assignment 上添加、删除或替换员工，已停用员工可继续原责任。
- 未指定员工时，从该角色在职员工中先排除审核冲突，再按有无未结束 Run、最近一次指派时间升序挑选；从未指派最优先，同时间按数字编号排序。CommandState 的 `employees` 和 `employee_activity` 是事务内全局只读快照，负载统计跨项目并正确区分项目内 Assignment 编号。无在职员工才退回匿名；全部候选冲突返回 invariant_violation。
- 审核隔离双向检查：验证项员工不得是其目标产出项任何历史 Assignment 的员工（包括 released）；完成验收项与模板主产出项同理。不同员工放行，一方或双方匿名不猜测身份。assign 和提交交付／审核共用隔离校验；原 Assignment 级隔离不变。
- Run 由 Assignment 复制 `employee_id`；主机在排队及派发时记录实际 `launch_profile_ref`。选择顺序为员工配置 → 固定 Role 版本配置，实际 Harness 取所选配置，工具权限仍取 Role。员工修改配置仅影响后续新 Run；继续使用旧会话前检查配置是否变化。
- `authorView` / `runAuthorView` 只生成查询投影：employee 含 id/name/title/avatar，无员工为 null，author_display 为“未命名的 <角色>”。交付和审核按原 Run 归属解析，不修改 author 或权限。MCP whoami 的员工字段由 Token 所属 Assignment 查询。
- 存储迁移 0010 使用与 domain 相同的 Unicode name_key 规则。旧库同名在职员工保留最小编号的原名，其他追加员工编号，冲突再追加序号，原名前缀按 40 字上限截短；保留身份与在职状态，每次改名写 system 全局事件和原名。重跑不重复改名或审计，规则详见开发方案 §4.3。


## P2-V V9a 项目角色命令

计划：[p2v-9-10-roles-templates.md §2.1](../../docs/plans/p2v-9-10-roles-templates.md)。入口从 `@cardigan/domain` 导出，不增加 MCP 工具。

- 输入为 `RoleCommandState {project_id, roles}`、认证层 Actor、参数和 `CommandPorts`；`canManageRoles(actor, project_id)` 独立判断，只允许同项目 human，Phase 3 扩展此处。返回 `Result<RoleEffect>`（data、roles、events），store 的 `persistRoleEffect` 在同一事务写入版本及项目事件。
- `createRole(state, actor, definition, ports)` 新建 v1；`updateRole(state, actor, id, patch, ports)` 追加 latest+1。拒绝修改编号、版本和状态；可编辑显示名、类型、instructions、兼容 core_prompt、Harness／启动配置引用、capabilities、abilities、worktree、allowed_tools 和机器标签。
- `copyRole(state, actor, {source, role_id, display_name?}, ports)`：source 由主机从默认包或同一事务内的源项目读取；新编号从 v1 开始、状态 active；源后续变化不影响副本。重新按目标编号校验权限，不能通过复制 pm 给其他编号授予 record_decision。
- `deactivateRole / activateRole(state, actor, id, ports)` 追加 inactive / active 版本；重复设置已有状态无版本和事件。`rollbackRole(state, actor, id, version, ports)` 复制历史内容到 latest+1，重新校验权限，保留当前启停状态。
- `validateRole` 覆盖系统工具白名单：produce 禁 submit_review，verify 禁 submit_delivery，standing 以上述 PM 固定列表为上限；任意未知名称拒绝；record_decision 仅 pm；验证型 worktree 只允许 readonly/none。旧 kind=work 保存时通过工具／验证能力标记转成明确类型，不能绕过验证型限制。Token 的 office 作用域继续在主机签发时收窄。
- `instructions` 禁止包含系统协作规则／协议的标题和任意一条规则原文，`roleInstructionsError` 与系统文本常量由 domain 共用；新建、修改、复制、回退及启停写入均返回 validation_failed。roles 启动编译复查同一边界，确保三种 Harness 不输出重复段落。只有 core_prompt 的旧角色不受影响；完整旧提示词应通过显式转换剥离系统段落，不能直接粘贴到 instructions。
- 新指派前 `isRoleActive` 始终检查最新版，即便显式要求旧版也不能绕过停用；重复指派复用原 Assignment，已有 Assignment 与 Run 保持固定版本和历史权限。不存在角色仍为 not_found。
- 事件为 role_created、role_copied、role_updated、role_deactivated、role_activated、role_rolled_back；保存 Actor 和完整版本快照。验证失败无部分效果。
- instructions/status 存入原 roles.doc，不改表；旧记录缺省 active，没有 instructions 就继续使用原 core_prompt，转换和启动拼接位于 roles 包。迁移不重写旧文档，不自动把旧提示词当作新格式。
- `upgradeRole(state, actor, id, source, ports)`（C-55）：source 由主机从默认角色包解析（domain 不依赖 roles 包），只取 instructions、allowed_tools、capabilities、kind、worktree；返回 `{unchanged, previous, diff, effect?}`，diff 含新增／移除的工具和能力、字段变化及放宽项（新增工具、新增能力、worktree 放宽、类型改变）。内容相同（工具、能力不计顺序）时 `unchanged=true`，无版本无事件；否则写入走 `updateRole`，共用权限和 validateRole。`previewRoleUpgrade(state, actor, id, source)` 是不需要 ports 的同一计算（含 validateRole），供 `--dry-run` 在只读事务里使用。CLI：`cardigan role upgrade <角色> --from-default [--dry-run]`，非默认角色由 CLI 中文拒绝。
- 工具白名单是新版本写入边界：旧库已有角色在读取、assign、queueRun 和主机启动时不调用 validateRole，不因历史宽工具范围或旧 kind 被拒绝。写入同一内容的新版本仍需通过校验，既有 Token 作用域控制不变。回归覆盖旧 schema 升级后的 coder/reviewer/pm 与三种 Harness。

## P2-V V10a 卡片模板与无仓库流程

- `manageCardTemplate(state, actor, params, ports)` 只允许 `canManageCardTemplates(actor)` 为真的 human，输出版本及 `card_template_changed` 项目事件，不向 MCP 注册。params 为 `add|update` 加 definition、`copy` 加 template_id/new_id/可选 version、`activate|deactivate` 加 template_id，或 `rollback` 加 template_id/version。写入 card_templates 与事件同事务；编号冲突、找不到版本、直接修改内置模板均拒绝。更新、停用、恢复、回退追加版本，回退保留当前启停状态，复制生成启用的自定义 v1。
- definition 包含 id/title/description、requires_repo、merge、require_acceptance_criteria、work_items、primary_work_item_key（可为 null）、completion。校验 key 唯一、验证目标为同模板产出项、主产出类型、review 必须有主产出、非 none 合并需要仓库。角色检查使用项目最新版本，缺省 status 为 active；未登记／inactive 拒绝，产出需 submit_delivery、验证需 submit_review。角色完成审核必须有对应必需验收项。停用无需角色仍有效；其他写入及建卡均校验。
- `createCard` 增加 template_id，缺省 dev，兼容 template（同时提供必须一致）。按当前启用模板生成工作项并记录 template_version；停用不能建卡。repo/base_branch 可缺省，但 requires_repo 时必填，分支不能脱离仓库；验收标准可缺省为空，仅 require_acceptance_criteria 模板强制非空。旧卡按 v1 解析。后续完成申请、审核、员工隔离与读取视图均解析卡片固定版本。
- `markCardDone(state, actor, {card_id, result, attachments?}, ports)` 只允许 `canMarkCardDone(actor)` 为真的 human，且模板为 human_mark_done。结果必须非空，附件必须已上传且属于本卡；必需工作项全部 accepted/passed，无项可直接完成。经 human_mark_done 状态迁移写 done/resolution、card_marked_done（result/attachments）及状态时间线。已完成／取消卡拒绝，updateCard 仍不能直接写 done。
- `merge=none` 模板及无仓库卡拒绝 git_head；artifact_sha256/doc_version 的产出仍先交付、再由主产出提交完成申请。验收项从模板指定角色和无产出目标的工作项确定，不能混入普通产出审核。完成审核通过且没有 Git 候选时复用 merge_not_required 进入 done，无仓库卡及 worktree=none 角色不建 worktree。
- `completion={mode:review, reviewer:human}` 的申请 requested_verifiers 为空，系统创建绑定本次交付的 completion_review Decision，沿用 recordDecision 的原话和身份审计；approve 接受申请并走同一完成路径，reject 将申请拒绝、卡片退回 in_progress，completion_reviewed 事件复用驳回路由为主产出安排 rework。新产出／新完成申请使旧未决验收失效；过期批准拒绝，不自动完成。
- 存储迁移 0011 建立 `(project_id, template_id, version)` 主键及版本不可覆盖约束；为每个老项目和新建项目写入 dev/general/artifact v1，老卡 template 不变、补 template_version=1。无仓库视图省略 repo/base_branch，CLI 显示合并基线缺省为“无”。

### P2a-1b 合并后推送

- `recordMergeResult(merged)` 在可信 `project_settings.merge_push` 存在时同事务追加项目级 `merge_push_queued`，绑定成功合并事件与 SHA；失败、冲突和重复结果不新建队列。
- `beginMergePush` / `recordMergePushResult` 只允许 system，前者选择并持久化队首范围，重启返回同一未完成 attempt；后者记录 `merge_pushed` / `merge_push_failed`，重复同结果幂等，不改卡片状态。
- `checkMergePushRange` 只允许 system：输入主机在发布锁内读到的中心基线当前 head 及其到 `base_sha` 的完整第一父链。边界须有证据（上次 merge_pushed 或人接受的边界），链上每个提交须落在 card_merged 记录且 previous_sha 在链上闭合的段内或已被接受，待推 SHA 须仍在链上；否则写 `merge_push_held`（reasons）和项目级 HumanAction，该目标暂停。`acceptMergePushHold` 只允许 human，完成该事项并信任列出的 SHA 及候选边界；stale／broken／超限不可接受。以其他方式关闭事项视为回退，`beginMergePush` 写 `merge_push_hold_resolved(mode=reverted)` 并丢弃暂停及以前的队列。
- rejected / auth / other 建 HumanAction 暂停该目标，只有 human 完成事项才能进行一次合并积压范围的重试。network 退避上限 30 分钟，连续两小时以上建一条事项，成功后撤销仍 open 的网络事项。重试时间和计数均保存在事件中；不把远程或命令原始错误传给 domain。

## C-55 常驻 PM 换版本

- `rotateStandingPm(state, actor, {standing_mode}, ports)`：只接受 human（Agent 因工具名不在角色里被拒，system 不能访问此命令）。找唯一在岗的同模式常驻 pm；已暂停或不存在时中文拒绝。最新 pm 版本等于在岗版本时返回 `unchanged=true`，无改动无事件。
- 否则在同一个 effect 里依次：新建同模式、固定最新版本的 standing Assignment（先写入）；复制旧游标；取消旧的未结束 Run；释放旧 Assignment；发 `assignment_released`（`replaced_by`）与 `standing_pm_rotated`（`decisions`、`human_actions`、`cancelled_run_ids`）；不调用 `handoffWithoutOps`。写入前检查新版本具备接手工具（拍板需要 `resolve_delegated_decision`，审核上限拍板需要 `update_work_item`，待你执行需要 `triage_human_action`），缺工具时 validation_failed、无任何改动；effect 最后断言没有改写 decisions 或 human_actions。任一步被拒，整个 effect 不产生。
- 主机（`apps/cli/src/pm-rotate.ts`）在持久化 effect 的同一事务里作废旧 Token、用 store 的 `reassignNotifications` 把旧 Assignment 的未结束通知改给新的（投递失败的通知 ack 旧行、为新 Assignment 新建待投递行），并结束旧会话未完成的投递尝试。CLI：`cardigan pm rotate --ops|--office`。
