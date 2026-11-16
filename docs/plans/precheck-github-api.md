# 作者预检与空闲角色升级修复

原任务包含 GitHub 作者预检启动失败、失败占位泄漏和旧开发 Assignment 缺少当前流程必需工具。第三轮按用户决定拆分：预检与名额回收由另一张卡先交付，本卡随后只交付角色升级；收到前卡已合入 main 的通知后同步基线、去除重复差异。不改变生产配置，不增加工具或绕过交付门禁。

- 预检使用与正式合并检查一致的 Git 方法接收者绑定。未知执行器异常保留错误类型及经过主机去敏、限长的信息，写入检查日志和结果事件。
- GitHub journal 识别可信预检 attempt 与候选。业务终态、取代或执行器变化触发幂等收尾：reserved 且无 publisher、dispatch ID、绑定身份时可释放；publishing 必须等原推送收尾，dispatching 必须恢复并确认远端终态，不能用本地失败伪造远端退出。预检候选清理沿用精确 SHA 租约与 journal 围栏。
- 内部非常驻 Assignment 在没有未结束 Run、停止流程或未收尾启动时自动升级到当前默认角色。先记录持久升级围栏并作废旧 token，再确认旧 RuntimeRef 退出，最后更新原 Assignment 的版本并记录 session_replaced。保留员工、工作项、分支、worktree 与未提交内容；下一次正常唤醒创建新会话，并依据系统升级审计重建新版本 token 的工具集合；同版本和无审计换版仍保留旧 token 的工具上限。手改冲突复用 B9 人工处理；未知退出继续等待。
- 卡片升级到流程第 3 级以上时，拒绝已有产出 Assignment 缺少 request_check/get_check_log 或仍在升级的情况，说明等待自动升级后重试。已升级的生产卡由维护循环补偿，无需再次执行 flow-upgrade。

验证覆盖真实接收者、预检与正式检查共享并行容量、六步结果、异常去敏、历史泄漏恢复、推送/派发不确定性、升级围栏、Run 忙闲、退出确认、重复 tick、手改冲突与工作区保留。运行全套指定检查，并对授权的 GitHub 测试分支做一次真实预检，最终删除分支并逐一确认 404。

## 第二轮评审修正

采用 ADR 0005 方案 C 的受限变体：仅内部工作项、与当前默认包一致的角色在空闲时自动升级；旧 Token 作废，新版本首次签发可获得默认包新增工具。按 Flow Lite 由系统/PM 处理并知会，本任务报告列出 coder、reviewer、independent_reviewer 的工具差异及生产影响范围；不修改 ADR 0005 或开发方案正文，里程碑收尾统一同步。

- 升级围栏视为 Dispatcher 忙碌，通知保持 pending。人先 stop 清空引用后，允许下一轮维护安全收尾，再按正常 start 恢复；会话状态沿原 runtime 状态机转换。
- 先检查终端已退出/不存在或 Agent 为 idle、done、error；unknown 必须没有未结束 Run，且最近 Run 的结束和最后 MCP 活动都已过去至少 10 分钟，建立围栏的事务内重核。没有 Run 或 MCP 活动的会话从 Assignment 创建时开始计算，缺失 Run 结束时间保守等待。使用 force:false 释放；Cardigan 的交互及观察 attach 持有同一维护锁，接入期间不退役会话。原始 hc attach 没有可查询计数，不增加不可靠的进程推断。
- 失败重试间隔依次为 1、2、4、5 分钟，此后封顶 5 分钟；等待超过 15 分钟后首次到期重试只发一次 PM 提示，不直接生成交人的事项。
- 默认每项目 60 秒扫描一次，一次只选择两个会话，跨控制器的在途围栏总数也不超过两个。每轮只构造一次最新角色/指纹索引；维护计入 route.role_upgrade，异常只记固定日志，不中断其它调度。
- 持久退避写入失败时保留已有围栏、记录固定错误日志，并继续本轮后续候选。交互/观察 attach 的锁会推迟同 Assignment 的 host_ops restart/cancel 和 start --restart-session；普通 wake/launch 使用另一锁域。

第三轮验证：本机只运行角色相关定向 vitest（--maxWorkers=4）、domain test:types、lint、check:deps；全量 test 与 e2e 在 GitHub 可信 main workflow 检查候选 HEAD，使用独立 card 避免共用并发组。排队超过 15 分钟改用 cardigan-ci。结束删除本次候选分支并确认 404。
