# M1.3 命令契约

本任务分为两个依赖 PR：第一部分为公共命令内核、交付、审核及完成申请；第二部分补齐协作、PM、附件、Run 和查询工具。公共入口为 `@cardigan/domain`。

## 调用和持久化边界

- `CommandState` 是单个项目的当前快照；包含实体、版本化 Role、事件和时间线。调用方负责在事务内读取一致快照，不能把不同项目的同号实体混在一起。
- 命令输入为 `state, Actor, params, CommandPorts`，输出 `Result<CommandEffect<T>>`：data、changes、events、timeline 和 token_requests。拒绝只返回错误码，不暴露半成品变更；输入快照不被修改。
- Actor 由认证层构造。内核核对项目、Assignment 存在/active、固定的 Role 版本、角色及 Token 的工具许可；工作项 Assignment 只能访问本卡，常驻 PM 可访问项目。正文或参数里的署名不能覆盖 author。
- Clock 和 IdAllocator 注入。适配器须在同一个事务内分配编号并写入整批结果；收到失败 Result 必须回滚该事务（包括已分配编号）。domain 不调用仓储，不直接做网络、文件、数据库、哈希或随机数 IO。
- `prepareDelivery` 是事务外端口预检，实际调用注入的 DeliveryVerifier；`submitDelivery` 是同步归约，验证进程内凭据并重查当前快照。凭据不是 MCP 参数，不能由客户端 JSON 构造，也不应持久化。M1 可注入接受/拒绝桩，M4 换为真实 Git 校验。
- 初始 Run 的创建/派发、Token 的实际随机值/哈希和幂等缓存由外层负责；命令不接受调用者自报的 Run 归属或 Token 权限。现有 store 的幂等入口应包裹命令事务，不能直接重复归约替代请求幂等。

## 交付、审核和完成申请

- `prepareDelivery` / `submitDelivery`：只允许产出工作项当前 Assignment，并要求恰好一个 running Run。摘要按 Unicode 码点限制 160；subject 必填，git_head 接受 40/64 位十六进制，artifact_sha256 接受 64 位，doc_version 为非空字符串。
- 交付、审核和暂停自身工作项共用 activeWork：todo 产出先校验依赖再启动，ready / changes_requested 产出走 run_started；ready 验证项在有剩余轮次时才启动。启动要求当前 running Run，不把 Run 启动等同于工作项已经 in_progress。
- requested_verifiers 必须是明确、不同的验证 WorkItemId，覆盖所有必需验证方，不能用“角色 A 或 B”绕过验证。证据来自预检，参数中的 evidence/author/run_id 不作为可信字段。
- 新产出替代该工作项的旧产出和旧完成申请：产出验证项回到 ready，失去完成申请目标的 PM 验收项回到 todo，等新完成申请再 ready。supersedes 只指向同类上一版（产出 / 完成申请），显式传入时也校验类型。完成申请只替代旧完成申请，绑定当前产出的相同 subject，保留已经通过的代码审核。
- 主产出及 PM 验收项通过模板稳定键识别。按用户确认，前置条件排除本次 PM 验收项；其余未满足项必须有精确 precondition 键、说明及同项目后续卡片。检查结果加入 evidence，不能由调用者伪造“已通过”。
- `submitReview`：只允许该交付请求的验证 Assignment；SHA/交付版本过期拒绝。verdict/blocking 通过 M1.2 计算，忽略客户端同名字段；普通审核使产出被接受或返工，完成审核才改变 Card.done。
- conditional 不算必需验证通过。已终结的交付不能继续改结论，需要新交付版本；每个 Run 只提交一次审核，请求重放由外层幂等处理。
- 第二轮起沿用问题描述（去除首尾空白）作为复查匹配依据；新增非 pre_existing 问题必须 critical 且有 proof。此处不做语义相似度判定。
- 达到上限且仍为 reject 或 conditional 时，在下一轮开始前生成阻塞 Decision、验证项进入 waiting_decision，当前审核 Run 以 blocked 结束；先发 review_submitted（rework_allowed=false），再发 decision_requested，不创建返工 Run。最后一轮 pass 正常通过；换新 Run 不能绕过上限。不存在用户可写的“自动通过”开关。
- 最后一轮 pass 后，新交付同样检查累计预算；已用尽时立即从 ready 经 review_limit_exceeded 进入 waiting_decision，生成 trigger=review_limit 的 Decision，先发 delivery_submitted 再发 decision_requested。仅结束验证方正在运行的 Run，保留已结束 Run 和产出者 Run；后续交付保留并复用现有 open / provisional 上限 Decision。恢复可从最近已完成审核 Run 取快照创建新 Run，无需把旧 Run 改写为 blocked。
- 上限 Decision 带控制面写入的 trigger=review_limit；普通 requestDecision 不接受该标记。Office 记录 pause 时用 provisional 保持阻塞，发 decision_provisionally_resolved，不恢复或排 Run；之后可在同一 Decision 上确认 raise_limit。raise_limit 不直接改上限：审核轮次仍用尽时继续等待，直到 Ops／人用 updateWorkItem 放宽且没有其他阻塞，才 ready 并排新 decision_resumed Run。先放宽后拍板同样可恢复。reject 后仍需新交付；conditional 可继续审核原交付。

## 验证与边界

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
| project_snapshot / list_needs_you   | projectSnapshot / listNeedsYou           | 项目级 PM／人；复用 M1.2/M1.2b 派生，列出待人决策和待人操作                                                            |

协作细节：

- Office/Operations 共用 pm 角色：Office 是常驻 PM 且 Token 允许 record_decision；Ops 是不具备该工具许可的常驻 PM。工作项级 PM 验收 Assignment 不能代替 Office。实际 Token 授权仍由认证层核实。
- reportBlocker 将 reason、needs、来自 Actor 的 reported_by 和 Clock 的 reported_at 保存到 WorkItem.reported_blocker。只有 PM／人用 updateWorkItem(status=in_progress) 确认清除该标记；即使还有其他阻塞，确认也成功，但保持 blocked / waiting_decision，resume_work_items 为空，事件记录 reported_blocker_cleared=true。其他 Decision / HumanAction 解除不能清掉报告，未确认时也不会恢复。最后一个原因解除、审核预算允许后，按当前暂停状态走 resume 或 decision_resolved；已有 Run 保持运行，没有未结束 Run 时按既有规则排一次新 Run。没有报告标记时保留原有受控恢复限制。
- category 的准确性由上层受控输入/策略保证；已标记为敏感类别的请求只能选择 human，本实现不做自然语言意图分类。batch 是批次标识，多条决定以同一标识关联，未增加批量 RPC。
- reportBlocker、阻塞 requestDecision 和包含自身工作项的 requestHumanAction 在暂停自身之前调用共用启动校验；不会代为启动其他 Assignment 的工作项。不能暂停时错误包含工作项编号、类型和状态。
- 工作项级 Assignment 请求阻塞拍板时，自动将自身可执行工作项去重并入 affected_work_items，再结束相关 running Run；produce 已 delivered / accepted 时不自动并入也不结束自身 Run，显式暂停则拒绝。解决最后一个阻塞原因且审核预算充足后，已有执行历史的责任上下文生成新的 queued Run，复用 Assignment／Session 和最近 blocked Run 的版本快照（上限拍板也可沿用已完成的审核 Run）。没有历史快照时只返回触发事件，后续调度负责初始配置；不启动 Harness、不按门铃。
- reported_blocker、多个 Decision/HumanAction 同时阻塞同一工作项时，不因其中一项完成就提前恢复；恢复事件的 resume_work_items（包括 completeHumanAction）只列实际恢复项。对同一个已自动结束的 blocked Run 再 finish_run(blocked) 为无副作用确认。
- 评论识别 C-n、C-n#m、q(n)、h(n)、D-n 以及 GitHub 风格 pull / GitLab merge_requests 链接；跨卡引用不会授予跨卡修改权限。引用解析不发网络请求。
- token_requests 只有签发所需元数据，token_id 包含项目和 Assignment，不含随机 Token 值。M1.6b 适配层通过 store 的事务内 issueToken，将签发、Assignment、事件和幂等结果一并提交；首次成功的 assign 响应附加 issued_tokens 数组（assignment_id、token_id、token），明文只在提交后加入响应，不入库、不入缓存或日志。重放或重复指派不重发，首次响应丢失时需要受控重签，不能从哈希恢复。
- 附件哈希验证、文件落盘、失败后的内容清理和传输大小上限由 M1.6 适配层负责。prepareAttachment 需在认证之后调用，上传元数据拒绝不会自动删除已准备的内容。
- whoami / get_card / get_updates / ack_events 由 M1.5 的 mcp-server 工具与测试单独维护，domain 删除对应重复实现。projectSnapshot / listNeedsYou 仍要求一致且完整的项目快照，卡片状态及 waiting_on/next_owners/why 复用已合并的派生函数。
