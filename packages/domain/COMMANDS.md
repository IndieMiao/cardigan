# M1.3 命令契约

本任务分为两个依赖 PR：第一部分为公共命令内核、交付、审核及完成申请；第二部分补齐协作、PM、附件、Run 和查询工具。公共入口为 `@cardigan/domain`，本文件先记录第一部分。

## 调用和持久化边界

- `CommandState` 是单个项目的当前快照；包含实体、版本化 Role、事件和时间线。调用方负责在事务内读取一致快照，不能把不同项目的同号实体混在一起。
- 命令输入为 `state, Actor, params, CommandPorts`，输出 `Result<CommandEffect<T>>`：data、changes、events、timeline 和 token_requests。拒绝只返回错误码，不暴露半成品变更；输入快照不被修改。
- Actor 由认证层构造。内核核对项目、Assignment 存在/active、固定的 Role 版本、角色及 Token 的工具许可；工作项 Assignment 只能访问本卡，常驻 PM 可访问项目。正文或参数里的署名不能覆盖 author。
- Clock 和 IdAllocator 注入。适配器须在同一个事务内分配编号并写入整批结果；收到失败 Result 必须回滚该事务（包括已分配编号）。domain 不调用仓储，不直接做网络、文件、数据库、哈希或随机数 IO。
- `prepareDelivery` 是事务外端口预检，实际调用注入的 DeliveryVerifier；`submitDelivery` 是同步归约，验证进程内凭据并重查当前快照。凭据不是 MCP 参数，不能由客户端 JSON 构造，也不应持久化。M1 可注入接受/拒绝桩，M4 换为真实 Git 校验。
- 初始 Run 的创建/派发、Token 的实际随机值/哈希和幂等缓存由外层负责；命令不接受调用者自报的 Run 归属或 Token 权限。现有 store 的幂等入口应包裹命令事务，不能直接重复归约替代请求幂等。

## 交付、审核和完成申请

- `prepareDelivery` / `submitDelivery`：只允许产出工作项当前 Assignment，并要求恰好一个 running Run。摘要按 Unicode 码点限制 160；subject 必填，git_head 接受 40/64 位十六进制，artifact_sha256 接受 64 位，doc_version 为非空字符串。
- requested_verifiers 必须是明确、不同的验证 WorkItemId，覆盖所有必需验证方，不能用“角色 A 或 B”绕过验证。证据来自预检，参数中的 evidence/author/run_id 不作为可信字段。
- 新产出替代该工作项的旧产出和旧完成申请，并重置相关验证项。完成申请只替代旧完成申请，绑定当前产出的相同 subject，保留已经通过的代码审核。
- 主产出及 PM 验收项通过模板稳定键识别。按用户确认，前置条件排除本次 PM 验收项；其余未满足项必须有精确 precondition 键、说明及同项目后续卡片。检查结果加入 evidence，不能由调用者伪造“已通过”。
- `submitReview`：只允许该交付请求的验证 Assignment；SHA/交付版本过期拒绝。verdict/blocking 通过 M1.2 计算，忽略客户端同名字段；普通审核使产出被接受或返工，完成审核才改变 Card.done。
- conditional 不算必需验证通过。已终结的交付不能继续改结论，需要新交付版本；每个 Run 只提交一次审核，请求重放由外层幂等处理。
- 第二轮起沿用问题描述（去除首尾空白）作为复查匹配依据；新增非 pre_existing 问题必须 critical 且有 proof。此处不做语义相似度判定。
- 达到上限且仍驳回时，在下一轮开始前生成阻塞 Decision、验证项进入 waiting_decision，当前审核 Run 以 blocked 结束；review_submitted 携带 rework_allowed=false，不创建返工 Run。不存在用户可写的“自动通过”开关。

## 验证与边界

契约测试通过公开函数、确定性 Clock/IdAllocator 和可配置验证桩执行，测试名标明不变量。真实鉴权入口、同事务提交、Token 签发和传输幂等由 store/MCP/组装层验收；本任务不实现这些 IO 层。

合法状态迁移统一调用 M1.2；对其没有定义迁移的前态，返回 illegal_transition，不强行改写状态。长度、权限和版本等语义由命令检查；MCP 输入的完整 JSON 类型校验仍由 M1.6 的 zod 参数层负责。
