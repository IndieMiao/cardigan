# Flow 5 开放与 GitHub 分层检查

基线：Flow Lite `ba76d4ec`。本批落实 `flow-v2.md` §4.1、§5 的第 3–5 级开放，以及 `p2a-13-merge-queue.md` §2 在 GitHub 执行器上的接线；不开放第六级、不修改实际项目偏好。

## Flow

- `FLOW_VERSION_MAX=5`。缺省项目与旧卡仍为 1；人的项目设置只决定新卡，旧卡继续经原有安全边界显式升级。
- 第 3 级交付要求当前 SHA 预检通过；第 4 级系统确认和发布前复查沿既有事务与 CAS；第 5 级系统汇总完成申请、自动指派验证人、减少机械通知沿既有版本判断。
- 第 5 级在运行时登记 `dev@2`、`product@1`，建卡、目录、CLI 和 Web 使用相同默认目录；已有项目保存的 `dev@1` 不遮住新默认。无模板迁移，不改旧卡固定版本，1–4 级继续原默认。
- `auto_merge` 对所有流程版本有效，与第 4/5 级共用同一个确认、授权审计和发布入口；重复确认不增加解决事件。显式 `off`、暂停和人的类别授权仍生效。
- 开第 4/5 级之前，人必须确认项目偏好 `system_merge_shadow_policy.release_paths`（无默认；允许显式 `[]`）。沿原偏好命令保存完整策略，保留其中的 `role_rule_paths`。具体人类操作和现场配置建议记在交付报告，不写生产配置。

## GitHub 范围协议

- 新 workflow 的 `scope`、`affected_paths`、`skip_checks` 均可选；缺省、未知或非法组合按 full。只允许 test/e2e 按 docs_only 跳过，只允许 test 缩到受影响包。
- 主机从已计算的 `CheckoutCheck.skipReason/affectedPaths` 生成 inputs。受影响路径限 64 个、4096 字节及 `^(packages|apps)/[a-z0-9-]+$`；workflow 再独立校验。值经 env 进入验证器，经过验证才写步骤 outputs；测试使用 shell 数组传参，不执行输入字符串。
- 沿用 D2 的基线派发、候选 SHA/tree 验证、固定 App 身份和精确 run 绑定。workflow_dispatch 的原生 ref 选择 workflow 版本；本执行器固定派发到项目基线（Cardigan 为 main），候选分支中的 workflow 不参与执行。因此新 workflow 需先合入并同步 GitHub main。
- GitHub 执行器新增 `scoped_checks: true` 能力开关，只在人确认可信基线 workflow 已支持 inputs 后启用。缺省不发新 inputs，丢弃本次执行的缩小元数据，保持旧 workflow 的全量行为；不在未知 POST 之后自动重派发。
- 步骤名称和顺序不变，仍严格检查单 job、步骤数量、编号、身份和六项检查顺序。预期的 docs 跳步记为 `skipped` / `docs_only`；前项失败造成的其它跳步记为 `not_run`，不能算 passed。整轮通过允许已声明的 docs 跳步，其余必需步骤必须成功。
- 保留 SSH 的 `scope/skip_docs_only` 配置方式；GitHub 的命令由可信 workflow 固定，生产还需给 test 设置 `scope: affected`、给 test/e2e 设置 `skip_docs_only: true`。不改 tiers 或合并队列行为。

## 验证边界

契约覆盖版本 1–5 的建卡和模板默认、无迁移登记、Flow Lite 与系统确认幂等；单元与 workflow 脚本执行测试覆盖三种范围、输入白名单、注入与输出污染、精确测试参数、步骤结果和旧派发兼容。运行仓库要求的七项验证。

真实冒烟仅操作 `refs/heads/ci/smoke/zl-scope/<attempt>`，App 派发 main，候选 Git 经主机代理、REST 直连。新 workflow 未在 main 时，仅能验证旧协议的全量兼容；三个新范围的远端行为留作合并后的首次验证，报告必须明确区分，不能把旧 workflow 的全量通过当作缩小范围已远端验收。
