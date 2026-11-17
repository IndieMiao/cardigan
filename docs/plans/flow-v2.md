# Flow v2：单负责人闭环（GitHub Actions 检查、失败直退、作者预检、系统合并）

- 状态：草稿，待排入 `docs/plans/phase-2.md`，待拆卡实现。
- 对应 ADR：[`docs/adr/0010-single-owner-loop.md`](../adr/0010-single-owner-loop.md)。关键设计以该 ADR 为准，本计划只做任务拆分、改动点、验收和迁移。
- 对应拍板：用户 2026-11-15 的流程方案拍板（A1/A2/A3/B/C/D），以及同日补充：GitHub Actions 为首选执行器且 D 先做、两层测试、计划细节六条（见第 12 节）。本计划不重新讨论这些决定。
- 代码基准：行号以当前运行版 main@`9afbd6af` 为准（本地登记源的 main 落后远端 200 多个提交，不作行号依据）。实现时先 `git grep` 复核，行号漂移以函数名为准。
- 必读：开发方案 §3.5、§4.3、§4.4（合并确认、C-46/C-66/C-79/C-115/C-116）、§4.5 不变量 13/15/16/20/21/23/27/29、§6.4、§7.1、§7.4、§12.1、§12.5、§12.7、§12.9、§14、§20.2；ADR 0004、0006、0007、0008。

## 1. 背景

数据来自 2026-11-15 的三份只读评审（两份流程评审、一份耗时统计），窗口为 11-12 至 11-15 的 72 小时，样本为窗口内合并的约 165 张卡：

| 现象 | 数据 | 含义 |
|---|---|---|
| 拍板主要是开发流程 | 新发起的 376 条拍板里合并确认 257 条（68%）；开发流程类合计 81.5%～86.5%（两份评审口径不同） | 产品层面的拍板只有一成多，人 3 天点了约 204 次 |
| 检查失败后的回路最贵 | 58 次失败；失败到重新入队平均 43.4 分钟，其中约 28.7 分钟没有任何活动；失败到合并中位 70 分钟、平均 121 分钟 | 失败先交 PM Ops 或人选“退回”，作者才收到通知 |
| 每次失败要重走全链 | 每个失败回路平均多约 15 个 Run（重新审核、完成申请、PM 验收、新确认、新检查） | 真正改代码通常只要几分钟 |
| 失败多在 test 步骤 | 58 次里 48 次在 test；常见原因是别的包的测试断言了旧行为 | 作者本地只跑受影响测试，完整反馈来得太晚 |
| PM Ops 是串行瓶颈 | PM Ops 约占全部 Run 的 41% | 选审核员、叫作者修、合并确认都要等 PM Ops 起一轮 |
| 检查本身不慢 | 通过的检查中位约 3.7 分钟；全量 test 在 12 worker 的检查机上约 168 秒、7,485 个用例，e2e 约 67 秒 | 慢在流转，不在执行 |
| 独立审核有价值 | 代码审核退回率约 24%，独立复核约 8%，PM 验收约 1.6% | 保留独立审核，PM 验收可按卡片类型取舍 |

另有两个前提：Agent 已经是 `bypassPermissions` / `--yolo`，限制来自账号、凭据和架构，不来自工具审批；现有 SSH 检查机的并发上限是 3，撑不住更多员工并行。

## 2. 目标

1. 一张开发卡由一个产出负责人持续闭环：自测 → 自助预检（GitHub Actions）→ 交付 → 独立审核 → 系统合并；检查失败直接回到这个负责人，带失败日志。
2. 合并确认不再作为拍板出现；人只处理产品层面的拍板、D12 四类、敏感卡、对外发布和角色规则改动。
3. PM Ops 退出机械调度，只做规划、建卡、产品拍板提问和异常处理。
4. 合并检查和预检默认跑在 GitHub 托管 runner 上，用免费公开仓库的并发容量支撑更多员工并行；SSH 执行器保留给私有项目和 GitHub 不可用时备用。
5. 所有改动对旧卡不生效：卡片固定流程版本，人按项目偏好切换新卡的版本。

## 3. 不做什么

1. 不做 ADR 0004 的合并队列和批次检查。A3 上线后再看数据决定。
2. 不做 C-308（增量复核，在做）和 C-321（公开前清理与许可证，在做）的内容；C-321 是 D 的前置条件。
3. 不给任何 Agent GitHub 凭据，不让 Agent push；不用自建 GitHub runner、不用 `pull_request_target`、CI 里不放 secret。
4. 不改独立复核的轮次上限规则（C-253/C-301 照旧），不让作者会话的 subagent 代替正式审核。
5. 不改 Agent 的启动权限（已是 bypass / yolo）和隔离账号（ADR 0002）。
6. 不做外部贡献者 PR 的 CI。外部 PR 只靠仓库设置“需审批才能运行 workflow”挡住；以后若加 `pull_request` workflow，其结果也不能作为合并依据。
7. 不迁移部署：部署仍由 C-201 监督器执行，不迁到 GitHub job。
8. 不新建看板功能，不扩大 §8.7 范围。

## 4. 关键设计（摘要）

### 4.1 流程版本（不混用新旧规则）

- `Card.flow_version`（整数，建卡时固定，类似 `template_version`）。旧卡缺省为 1。
- 项目偏好 `flow_version`：新卡使用的版本，只有人能改。代码常量 `FLOW_VERSION_MAX` 限定可选上限，由每一级最后一个任务合并时上调，所以一级里的任务没全部合并前，人不能把项目切到这一级。
- 各级含义：

| 级别 | 新增规则 | 前提任务 |
|---|---|---|
| 1 | 现行流程 | — |
| 2 | 检查失败系统退回、偶发失败自动重跑、本卡日志工具、`request_recheck` | A1a–A1d |
| 3 | 作者预检 `request_check`，交付要求该 SHA 预检通过；本地两层测试 | A2a、A2b、L1、C2a |
| 4 | 系统合并、暂停开关 | A3a、A3b |
| 5 | 并行审核收齐、普通审核自动加轮、系统汇总完成申请、PM Ops 退出机械调度 | B1–B3b、C1、C2b |
| 6 | 运行异常自动恢复一次（根链一次上限加终身预算）；PM 通知只在第六级及以上卡的原槽位内按紧急程度排序 | C3（Q-744 选 B1） |

- 旧卡只能由人经 `upgrade_card_flow` 升级，并且只能在安全边界：卡片不是 done/cancelled，没有未作废的完成申请，没有运行中的检查。`awaiting_merge` 的卡按原版本走完。
- 执行器（SSH 或 GitHub）不属于流程版本，按项目配置选择；同一 attempt 只用一个执行器。

### 4.2 GitHub Actions 执行器（D，先做）

```
主机：候选提交（基线 + 交付）→ 推到 ci/<card>/<delivery 或 assignment>/<attempt>
     → workflow_dispatch（ref=main 上的可信 workflow，inputs：sha、tree、card、delivery、attempt、kind）
     → 按 run-name 和绑定字段找到 run，记 run_id
     → 统一轮询 → 结束后映射步骤结果；失败时取失败 job 日志、脱敏截取
     → recordMergeCheck（system）
```

- workflow 只从 main 读取：候选里对 `.github/` 的改动只在合并后生效，系统自动给这类交付加 `security` 标签（D6）。
- workflow 检出 inputs 指定的 SHA，核对 `HEAD` 和 tree 与 inputs 一致，否则失败；`permissions: contents: read`；`persist-credentials: false`；不读 secret。
- 缓存只恢复、不保存：候选代码运行的 job 不写缓存，防止缓存投毒；缓存由 main 上的独立 workflow 在 push 后生成。
- 结果的可信绑定：主机只认满足全部条件的 run：workflow 路径等于配置值、`event=workflow_dispatch`、`head_branch` 是基线分支、`head_sha` 在中心仓库基线历史里、触发者是主机 GitHub App 的机器人身份（`<app-slug>[bot]`，由配置提供）、`run_attempt=1`、run-name 与本次 attempt 完全一致。任一不符按 `executor_unreachable` 处理，不记 passed。tree 仍由主机从候选提交读取，不变量 21 不变。
- 容量：执行器配置 `max_concurrent`，按 GitHub 账号的并发 job 上限配置（以官方文档为准；写计划时免费账号约 20 个并发 Linux job，且同一账号下所有仓库共用）。每次检查用 1 个 job，6 个步骤串行，第一版不分片；双跑期测得 test 步骤明显变慢时，再另开卡把 test 用 vitest `--shard` 拆成 2 个 job。同卡同一时刻最多一个 run 在途，由主机排队保证；workflow 另设同卡 `concurrency` 组（`cancel-in-progress: false`）兜底，主机看到被并发组取消的 run 按 `interrupted` 重排，不按失败处理。
- REST 限额：主机每个执行器一个轮询器，每个周期一次列表请求（带 ETag，304 不计限额），只对状态变化的 run 再查 job 和日志；遇到 403/429 按 `Retry-After` 退避。轮询周期和每小时请求预算可配置。
- `hc` 缺失必须失败：workflow 从 `deploy/install-agent.py` 解析 hc 版本和 sha256，下载校验，核对 `hc --version`；测试辅助在 `CARDIGAN_REQUIRE_HC=1` 时，hc 缺失或版本不符直接让套件失败，不再 `skipIf` 跳过。
- test 的 `--maxWorkers` 取 runner 的 CPU 数（标准公开 runner 为 4 vCPU）。
- 合并、作废或超期后由主机删除 `ci/` 分支，只允许删 `ci/` 前缀。
- 主机凭据用 GitHub App（不用 PAT）：App 只安装在本仓库，权限为 `actions:write`、`contents:write`、`metadata:read`，不配 webhook。主机私有配置提供 `app_id`、`installation_id` 和私钥文件路径；主机用私钥签 JWT 换取 installation token，令牌只在内存中使用、到期前重换，不落盘，不进仓库、数据库、日志或 Agent 运行目录。

### 4.3 A1 检查失败直接退回

- 当前完成申请的检查结束为 `failed` 或 `timed_out`、且没有触发自动重跑时，`recordMergeCheck` 在同一事务内以 system 走现有退回迁移（`reopenMerge` + `merge_changes_requested`，`via=system_rule`，`rule=flow-v2/A1`），给原产出 Assignment 排 `fix` Run。原因字段带失败步骤、首个 FAIL 和脱敏日志摘要（GitHub 执行器取自失败 job 日志）。旧完成申请和未决、已确认的合并确认按 C-47/C-46 作废，保留原授权记录。
- `executor_unreachable`、`interrupted` 不算代码失败，不退回。
- 偶发失败：C-116 的超时自动重跑扩展为“超时或已知基础设施特征”，每份完成申请共用一次自动重跑额度。
- 敏感卡和 D12 卡也由 system 退回（退回不扩大权限）；合并仍交人。
- 作者判断失败与本卡无关时，可调用一次 `request_recheck`：以原 SHA 重新交付，沿用对同一 SHA、同一树的审核结论（系统 A1 退回不计入 C-307 的审核代次），生成新完成申请并在当前基线上重跑。同一组产出 SHA 只能用一次。
- 本卡产出方和验证方可经只读工具 `get_check_log` 读取本卡 attempt 的脱敏日志，有单次和总长度上限。

### 4.4 A2 作者自助预检

- `request_check({work_item_id})`：只接受该产出项当前 active 的 Assignment。主机按交付的同一路径取该 Assignment 分支 HEAD，在“当前基线 + HEAD”上构造候选，用项目执行器（cardigan 项目默认 GitHub）和与合并检查完全相同的配置跑一次，`kind=precheck`。结果经门铃回到该 Assignment 的会话（复用原会话起 followup Run）。
- 同一 Assignment 同时最多一个预检；合并检查优先于预检，非抢占（Q-486）。
- 流程版本 ≥3 时，`submit_delivery`（Git 交付）要求同卡已有该 SHA 的通过预检，否则拒绝并提示先 `request_check`。
- 预检通过只是交付门槛，不能作为合并依据；最终合并检查仍在最新基线的候选树上跑。
- 两层测试（用户 2026-11-15 拍板）：
  - 本地层：coder 以及 reviewer、独立复核员、PM 等任何角色，在本地会话里只跑与改动相关的非全量检查：增量构建、lint、deps、相关单测（`vitest related` 或 `--changed`），改 `packages/domain` 时加跑 `pnpm --filter @cardigan/domain test:types`。本地不跑全量测试，也不跑 e2e（e2e 会在本机起 herdr-core，与生产 hc 同机）。
  - 远程层：全量测试和 e2e 只在 GitHub Actions 上跑，即 `request_check` 预检和最终合并检查。
  - 本地结果是 Agent 自报，不能作为审核或合并依据；可信依据只有绑定 `run_id`、SHA、候选树的远程 run。
  - 本地测试 worker 上限从 2 提到 4，仍是主机配置项（`agent-tests.yaml` 的 `max_workers`），改动标 `numeric_rule`（任务 L1）。
  - 卡片“测试范围”不再要求写全量 `pnpm test`，改写成“本地相关测试 + 远程预检通过”（C2a 写进 PM 建卡规则，B3b 写进新模板的审核完成标准）。

### 4.5 A3 系统合并

- 流程版本 ≥4 的卡进入待合并时，不命中强制交人条件的合并确认由 system 持有（`decider: "system"`），不进 Needs You 的待拍板；`pmMergeBlockers` 全部清空、项目未暂停自动合并时，由 system 解决为 `merge`，在 Needs You 知会区写一条知会，之后走原合并、检查和发布流程。
- 仍交人：卡上有与本卡合并内容相关的 D12 四类或 `scope_change` 拍板（含来源拍板）、人标的敏感卡、命中对外发布路径、角色规则改动（Q-279，复用主机的 `role_rule_inventory`）、确认已带 `human_required_reason`。
- 项目偏好 `auto_merge_paused`（只有人能改）：暂停时系统不解决确认，已由系统解决但未发布的合并在发布前被挡住，留在待合并，Needs You 显示“自动合并已暂停（N 张等待）”。暂停不影响检查、A1 退回和人亲自确认。
- 自举项目合并即自动部署（C-201）：改部署监督器或数据库迁移的卡，PM 在建卡时标敏感或打 `security`（C2a 写进 PM 规则，早于第 4 级上线）。产品拍板前移到建卡或开工（来源拍板）。

### 4.6 B 审核精简、C PM Ops 退出调度

- 保留一位独立代码审核员；审核只针对已有通过预检的 SHA（A2b 保证）。
- 并行验证：一方 reject 后，另一方仍可对同一交付提交 Review（目标交付为 rejected、且没有更新交付时），问题转给作者，不再需要 PM 协调。
- 普通验证项达到轮次上限时由系统直接加一轮，不生成 `review_limit` 拍板；达到人设的系统加轮次数上限后只发 PM Ops 异常提醒。独立复核照旧（C-301）。
- 完成申请由系统在所有必需验证项通过后汇总生成；新内置模板 `dev@2`（工程卡）不含 PM 验收，验收标准对照并入代码审核；`product@1`（产品卡、界面卡）保留 PM 验收。旧卡模板不变。
- 选审核员（已有 C-237 自动指派）、叫作者修复、检查通过后的发布都由 system；PM Ops 只收异常。

## 5. 任务表

改 `packages/domain`（含测试文件）的任务，都要附契约测试，并运行 `pnpm --filter @cardigan/domain test:types`。下表“独立复核”列为“是”的卡，PM 要按 AGENTS.md 配必需的 `independent_reviewer` 验证项。行号见第 6 节。

| 任务 | 卡 | 标题 | 依赖 | 可否在转公开前合并 | 风险标签建议 | 独立复核 |
|---|---|---|---|---|---|---|
| F0 | 新卡 | 流程版本固定与项目开关 | — | 是 | permission | 是 |
| D1 | 新卡 | 检查执行器接口抽取（行为不变） | — | 是 | security | 是 |
| D2 | 新卡 | 可信 workflow 与 hc 必须存在 | — | 是（合并后推到 GitHub 才生效） | security | 是 |
| D3 | 新卡 | GitHub 执行器：推候选、dispatch、绑定 run（含追踪数据模型） | D1 | 是（用假 API 测试） | security、permission | 是 |
| D4 | 新卡 | 统一轮询、结果映射、失败日志拉取与脱敏 | D3 | 代码可以，真实联调要等公开 | security、numeric_rule | 是 |
| D5 | 新卡 | ci/ 分支清理 | D3 | 同上 | security | 是 |
| D6 | 新卡 | `.github/` 等路径的交付自动加 `security` 标签 | — | 是 | security、permission | 是 |
| D7 | 运维卡 | cardigan 项目切到 GitHub 执行器（双跑后切换权威） | D2–D6、C-321、仓库转公开、C-316 | 否 | security | 否（无代码；切换由人确认） |
| A1a | 新卡 | 检查失败系统直接退回 | F0、D1 | 是 | security、permission | 是 |
| A1b | 新卡 | 基础设施偶发失败自动重跑一次 | A1a、D4 | 是 | security、numeric_rule | 是 |
| A1c | 新卡 | 本卡检查日志只读工具 `get_check_log` | D1 | 是 | security、permission | 是 |
| A1d | 新卡 | `request_recheck`（每组 SHA 一次） | A1a | 是 | permission | 是 |
| A2a | **改 C-298** | 作者自助预检 `request_check` | D1、A1c | 是（SSH 可先跑） | security、permission、numeric_rule | 是 |
| A2b | 新卡 | 交付要求该 SHA 预检通过 | A2a | 是 | permission | 是 |
| L1 | 新卡 | 本地两层测试：worker 上限默认 4、Agent 环境禁跑 e2e | — | 是 | numeric_rule、security | 是 |
| C2a | 新卡 | 角色包改写一：测试分层与作者闭环工具用法 | A1c、A1d、A2a、L1 | 是 | permission、numeric_rule | 是；合并交人（Q-279） |
| A3b | 新卡 | 暂停自动合并开关 | F0 | 是 | permission | 是 |
| A3a | **改 C-320** | 系统合并（不再生成合并确认拍板） | A3b、A1a、D6 | 是 | security、permission | 是 |
| B1 | 新卡 | 并行验证问题一次收齐 | F0 | 是 | permission | 是 |
| B2 | 新卡 | 普通审核系统自动加轮，不生成拍板 | F0 | 是 | permission、numeric_rule | 是 |
| B3a | 新卡 | 系统汇总完成申请 | A3a | 是 | permission | 是 |
| B3b | 新卡 | 内置模板 `dev@2`、`product@1` | B3a | 是 | permission | 是 |
| C1 | 新卡 | 系统调度收口：PM Ops 只收异常 | A3a、B3a | 是 | permission | 是 |
| C2b | 新卡 | 角色包改写二：PM Ops 职责收窄、建卡规则、模板选择 | A3a、B3b、C2a | 是 | permission | 是；合并交人（Q-279） |
| C3 | 从 C-320 拆出（C-363） | 运行异常自动恢复一次、PM 待办按紧急程度排序；属于第六级 | C1 | 是 | numeric_rule | 视实现 |

文档卡（本计划、ADR 0010 及 ADR 0007 状态修改）先合入；波次 0 的卡可以与文档卡并行开工，卡片附本计划。

建议顺序（D 优先）：

- 波次 0（转公开前）：F0、D1、D2、D6 并行；D3 接着 D1。
- 波次 1（C-321 合并、主机侧转公开后）：D4、D5 联调，D7 双跑并切换。A1a 在 D1 合并后即可开工，可与 D3–D5 并行；A1 级在 SSH 执行器上也能启用。
- 波次 2：A1b、A1c、A1d；全部合并后上调 `FLOW_VERSION_MAX` 到 2。
- 波次 3：A2a（C-298 改范围）、A2b、L1、C2a；上调到 3。L1 不依赖其它任务，可以更早合并。
- 波次 4：A3b、A3a（C-320 改范围）；上调到 4。启用前人要确认 `release_paths` 配置（可以显式为空）。
- 波次 5：B1、B2、B3a、B3b、C1、C2b；上调到 5。
- 波次 6：C3；上调到 6。前提是前五级的任务全部合并，C3 审核和检查通过。旧卡不自动升级到第六级；第六级的实际开放、偏好切换和现场恢复另行处理，不随 C3 合并自动发生。

## 6. 各任务的范围、改动点、验收和测试

### F0 流程版本固定与项目开关

- 范围：`Card.flow_version`；`ProjectPreferences.flow_version`；`FLOW_VERSION_MAX`；`upgrade_card_flow`（domain 命令，只接受 human；CLI `cardigan card flow-upgrade <C-n…> --to <N>`）；辅助函数 `flowAtLeast(card, n)`。
- 改动点：`packages/domain/src/entities.ts:135`（Card 的 `template_version` 旁新增字段）；`packages/domain/src/commands/pm.ts:135`（`createCard` 固定版本，与 `template_version` 同处）；`packages/domain/src/preferences.ts:48`（`ProjectPreferences`）；偏好写入沿用 `set_project_preferences` 的 human 校验；`apps/cli` 新子命令。
- 验收：
  1. 新卡取当时的项目偏好值；偏好未设置为 1；旧卡读出为 1。
  2. 偏好只有 human 能写，超出 `FLOW_VERSION_MAX` 或非整数返回 `validation_failed`；Agent（含 PM Office/Ops）写入被拒。
  3. `upgrade_card_flow` 只接受 human；卡片 done/cancelled、有未作废的完成申请、检查 queued/running、`awaiting_merge` 时拒绝并给中文原因；不允许降级，除非卡片处于 backlog/todo。
  4. 每次变化写 `card_flow_upgraded`（含前后版本、操作者）和时间线；值不变不写事件。
  5. 升级到 ≥5 时，本卡仍 open/provisional 的普通验证项 `review_limit` 拍板在同一事务按 B2 规则处理（标为被流程升级取代并加一轮），独立复核的不动。（B2 合并前此分支不可达，由 `FLOW_VERSION_MAX` 保证。）
- 测试：domain 契约测试覆盖 1–5 和 Actor 权限；CLI 参数测试；store 旧库读出缺省值；`pnpm --filter @cardigan/domain test:types`。

### D1 检查执行器接口抽取

- 范围：把现有 SSH 执行路径收到一个接口后面，行为不变，为 GitHub 执行器和预检铺路。
- 改动点：`packages/host/src/merge-gate-executors.ts:6`（`MergeGateExecutor` 增加 `type: "ssh" | "github"`，缺省 ssh），`:168` 解析、`:200` `resolveProjectExecutor`、`:221` `executorExecution`；`apps/server/src/merge-checks.ts:104`（`MergeCheckOptions.run`）、`:475` `target()`、`:484` `slot()`、`:584` `execute()`（分发 `:621`、执行 `:628`、回收 `:745`、不可达归类 `:680-707`）抽出 `CheckExecutor` 接口：`dispatch(request) → handle`、`poll(handle)`、`cancel(handle)`、`fetchFailureLog(handle)`；`CheckRequest.kind = "merge_check" | "precheck"`。`CheckUpdate`（`packages/domain/src/commands/merge-check.ts:131`）和 `MergeCheckView`（`packages/domain/src/entities.ts:225`）预留可选字段 `failure_excerpt`（主机生成、已脱敏、限长）和 `external_run`（D3 用），domain 只校验格式，只接受 system。
- 验收：
  1. 现有 `merge-checks`、`merge-gate-executors`、`merge-gate-config` 测试不改断言全部通过；不写 `type` 的旧配置行为逐字节一致（SSH 命令不变）。
  2. 用假执行器实现接口，跑通 queued → running → passed/failed/timed_out/interrupted/executor_unreachable 全部状态。
  3. `failure_excerpt` 超长或含未脱敏标记时 `recordMergeCheck` 拒绝；非 system Actor 带这两个字段被拒。
- 测试：host、server 现有测试；新增接口契约测试（假执行器）；domain 契约测试（字段校验）；`pnpm --filter @cardigan/domain test:types`。

### D2 可信 workflow 与 hc 必须存在

- 范围：新增 `.github/workflows/cardigan-check.yml`（只 `workflow_dispatch`）和 `.github/workflows/cache-warm.yml`（push 到 main 时生成依赖缓存）；测试辅助让 hc 缺失时失败。
- workflow 要点：inputs 为 `sha`、`tree`、`card`、`delivery`（预检时为 Assignment 编号）、`attempt`、`kind`；`run-name` 由这些值拼成，与主机记录的 attempt 标识一致；`permissions: contents: read`；同卡 `concurrency` 组，`cancel-in-progress: false`；检出 inputs 的 SHA（`persist-credentials: false`），核对 `git rev-parse HEAD` 和 `HEAD^{tree}`；Node 24 + corepack；依赖缓存只恢复不保存；步骤 `install`、`build`、`test`、`lint`、`deps`、`e2e` 各自一个 step，id 与现有检查名一致，test 用 runner CPU 数作 `--maxWorkers`；e2e 前从 `deploy/install-agent.py` 解析 hc 版本与 sha256 下载校验，核对 `hc --version`，设置 `CARDIGAN_REQUIRE_HC=1`；job `timeout-minutes` 取现有检查总超时。不引用任何 secret，不用 `pull_request_target`。
- 改动点：hc 探测与 `skipIf` 在 `apps/server/src/m3-e2e.acceptance.test.ts:48/300`、`apps/server/src/m2-assignment.acceptance.test.ts:44/274`、`packages/runtime-herdr/src/runtime.acceptance.test.ts:245/278`、`packages/runtime-herdr/src/runtime.contract.test.ts:153/253`、`apps/cli/src/m2-start.acceptance.test.ts:250/270`，统一改用 `test-support` 里的一个辅助函数；hc 版本来源 `deploy/install-agent.py:20`、`:22-25`（C-313 若先合入升级版本，workflow 自动跟随）。
- 验收：
  1. 未设 `CARDIGAN_REQUIRE_HC` 时，本机缺 hc 的行为与现在一致（跳过）；设为 1 且缺 hc 或版本不符时，相关套件失败并报“hc 缺失或版本不符”。
  2. workflow 静态检查（仓库内用 YAML 解析的单元测试）：只有 `workflow_dispatch` 触发；顶层 permissions 只有 `contents: read`；没有 `secrets.` 引用；checkout 带 `persist-credentials: false`；候选 job 里的缓存 action 只用 restore；6 个 step id 与 `merge-gate.yaml` 检查名一致。
  3. HEAD 或 tree 与 inputs 不符时第一步就失败，后续步骤不执行。
- 测试：新增 workflow 静态测试；`test-support` 辅助函数单测；受影响的 5 个测试文件定向运行。改了 `.github/`，PM 手动打 `security`（D6 上线前）。

### D3 GitHub 执行器：推候选、dispatch、绑定 run

- 范围：`GithubCheckExecutor` 实现 D1 接口的 `dispatch`；推候选分支；绑定 run；`external_run` 记录。
- 改动点：
  - 鉴权：主机用 App 私钥签 JWT，换 installation token；令牌只放内存、过期前刷新，任何日志和错误信息只写固定类别。推送和 REST 调用都用这个令牌（HTTPS），不复用现有推 main 的 SSH 部署密钥。
  - 推送：`packages/git-transport/src/central.ts:157`（`pushMergedCommit` 旁新增只允许 `refs/heads/ci/` 前缀、不带 `+` 的推送函数）；refspec 写法参照 `packages/git-transport/src/merge-push.ts:110`；分支名 `ci/<card>/<delivery 或 assignment>/<attempt>`，只含安全字符。现有外部推送只能推配置分支（`merge-push-config.ts:130`），本卡不放宽它。
  - dispatch 与查找：新增 host 侧 GitHub REST 客户端（只在 `packages/host` 或 `apps/server`，domain 不做 IO，§20.2）；`POST .../actions/workflows/<file>/dispatches`，`ref` 为基线分支；dispatch 响应若带 run 编号则直接用，否则按 `event=workflow_dispatch`、分支、创建时间窗和 run-name 精确匹配查找。
  - 绑定校验：第 4.2 节的全部条件；`head_sha` 必须在中心仓库基线历史里（主机用中心仓库判断）。
  - 配置：`executors.<name>` 增加 `type: github`、`repo`、`workflow`、`app_id`、`installation_id`、`private_key_file`（主机私有文件，0600，校验方式同现有身份文件）、`bot_login`（`<app-slug>[bot]`）、`max_concurrent`；解析在 `merge-gate-executors.ts:168`。
  - 记录：`recordMergeCheck`（`merge-check.ts:153`）对 github 执行器的 running/终态要求 `external_run = {provider, run_id, run_attempt, html_url, workflow_sha}`，缺失拒绝。
- 验收：
  1. 用假 GitHub API：推送只发生在 `ci/` 前缀；尝试推其它 ref 或带强制更新被拒。
  2. 找到的 run 任一绑定条件不符（路径、事件、分支、触发者、`run_attempt>1`、run-name 不一致、`head_sha` 不在基线历史）都不记 passed，按 `executor_unreachable` 处理并写安全类别。
  3. 私钥、JWT 和 installation token 都不出现在事件、日志、错误信息、磁盘文件和 Agent 可读的任何字段里（用合成私钥做负向测试）；令牌过期后自动重换。
  4. 同卡已有在途 run 时不再 dispatch，排队等待。
- 测试：host 单测（假 API、假 Git）；domain 契约测试（`external_run` 校验，非 system 拒绝）；`pnpm --filter @cardigan/domain test:types`。

### D4 统一轮询、结果映射、失败日志

- 范围：`poll`、`cancel`、`fetchFailureLog`。
- 改动点：每个 github 执行器一个轮询器，挂在 `apps/server/src/merge-loop.ts:91` 构造 `MergeChecks` 的同一处；列表请求带 ETag，403/429 按 `Retry-After` 退避；job 的 step 结论映射为 passed/failed/timed_out/skipped/not_run，run 取消映射为 interrupted，等待开始超过配置时长映射为 `executor_unreachable`；失败时下载失败 job 日志，经 `packages/host/src/merge-gate-log.ts:22` 的脱敏器写入主机私有日志（`:119` 目录校验、`:140` 写入、`:170` `log_ref`、`:226` 摘要），再提取首个 FAIL 生成 `failure_excerpt`；超时分类复用 `packages/host/src/merge-check-timeout.ts:107`（`checkTimedOutOnly`）；attempt 作废或中断时取消对应 run。
- 数值（已确认的默认值，仍为配置项，本卡标 `numeric_rule`）：轮询周期 20 秒；每小时 REST 预算 2,000 次（低于官方对 App 的限额）；等待开始上限 15 分钟；`failure_excerpt` 4 KiB。
- 验收：
  1. 假 API 下 10 个并发 run 时，每个周期只发 1 次列表请求；304 不重复处理；限额响应后按 `Retry-After` 暂停，不丢 attempt。
  2. step 名缺失、多余或顺序不符时整次结果按失败关闭处理（不记 passed）。
  3. 下载的日志经过脱敏后才落盘；合成凭据在日志、摘要、`failure_excerpt` 中都不出现。
  4. server 重启后按已记录的 `run_id` 继续轮询，不重复 dispatch。
- 测试：server、host 单测（假 API、假时钟）；日志脱敏回归 `packages/host/src/merge-gate-log.test.ts`。

### D5 ci/ 分支清理

- 范围：attempt 进入终态且卡片已合并、取消或该完成申请已作废时删除对应 `ci/` 分支；定期清扫超过保留期的孤儿分支。
- 改动点：`packages/git-transport` 新增只允许删除 `refs/heads/ci/` 前缀的函数；清扫挂在 D4 的轮询器维护周期；保留期为配置项，默认 7 天。
- 验收：只删 `ci/` 前缀；删除失败只记录、下次重试，不阻塞合并；不会删除仍有在途 run 的分支。
- 测试：host 单测（假远端）。

### D6 指定路径的交付自动加 `security` 标签

- 范围：产出交付改动文件命中 `auto_security_paths` 时，system 给卡片加 `security`（只加不删），并通知 PM Ops 补必需的 `independent_reviewer` 验证项（不变量 29 的硬门照旧拦截完成申请，不自动建项）。
- 改动点：主机改动文件证据沿用 C-238 的路径获取（`apps/server/src/merge-shadow.ts:15` `MergeShadowObserver`）或交付校验时的 `role_rule_inventory` 同一来源；路径匹配复用 `packages/domain/src/preferences.ts:330` `validMergePathList` 和 `merge-shadow.ts` 的 `pathCondition`；新增 system 专用命令 `applyAutoRiskTags`，写事件、时间线，调用 `syncRiskTagMerge`（`packages/domain/src/commands/merge.ts:540`）。偏好 `auto_security_paths` 只有人能改，`.github/**` 固定包含、不能删除。默认配置另含（人可增删）：`packages/store/migrations/**`（数据库迁移）、`packages/host/src/deployment*`（部署监督器，含 `deployment.ts`、`deployment-config.ts`、`deployment-node.ts`、`deployment-recovery` 等）、`apps/cli/src/self-deploy.ts`（自举部署 CLI 入口）。现有路径清单只支持精确路径和 `/**` 后缀，本卡把匹配扩展为“最后一段可带一个 `*` 前缀通配”，并同步 `validMergePathList` 的校验与测试。
- 验收：
  1. 交付改到 `.github/`、数据库迁移目录或部署监督器文件时，同一事务卡片带上 `security`，时间线写明命中的路径；已有标签不重复写事件；人删除默认路径后不再命中（`.github/**` 除外）。
  2. 读不到改动文件证据时视为不确定：不加标签，但该卡在流程版本 ≥4 时不允许系统合并（交人）。
  3. Agent 不能调用该命令，也不能删除系统加上的标签（PM/human 仍可按现有权限删除，删除写审计）。
- 测试：domain 契约测试；server 侧证据接线测试；`pnpm --filter @cardigan/domain test:types`。

### D7 cardigan 项目切到 GitHub 执行器（运维卡）

- 前置：C-321 合并并推到 GitHub；主机侧把仓库转为公开；D2–D6 合并且 workflow 已在 GitHub main 上；建议 C-316（同项目并行检查）已合并，否则同项目合并检查仍只有一条通道。
- 步骤（写成给人的编号步骤）：仓库设置 Actions 默认权限为只读、禁止 Actions 创建或批准 PR、外部贡献者的 workflow 需审批、开启 secret 推送保护；main 分支保护只允许主机推送；GitHub App 已由人创建并核对（只装本仓库，`actions:write`、`contents:write`、`metadata:read`，无 webhook），主机私有配置写入 `app_id`、`installation_id`、私钥文件和 `<app-slug>[bot]`；cardigan 项目先进入双跑：SSH 执行器为权威，GitHub 执行器作影子跑同一候选。
- 切换标准（默认值，配置项，`numeric_rule`）：双跑 20 次检查结果一致（已知偶发除外，逐条说明），GitHub 侧 test、e2e 都真实执行（hc 已安装，无整组跳过）；之后人把项目的权威执行器切到 GitHub，SSH 保留为备用。GitHub 不可用时由人或主机运维改回 SSH，不在同一 attempt 内自动切换。
- 验收：切换前后各一份记录（时间线或运维记录），含双跑对照表；切换后预检和合并检查都走 GitHub。

### A1a 检查失败系统直接退回

- 改动点：
  - `packages/domain/src/commands/merge-check.ts:363-415`：在写 `merge_check_finished` 之后，若结果为 failed/timed_out、未触发自动重跑、卡片 `flow_version ≥ 2`、该完成申请仍是当前申请，同一事务调用新函数 `systemReturnFailedCheck`：复用 `reopenMerge`（`packages/domain/src/commands/merge-rework.ts:8`）并写 `merge_changes_requested`（字段同 `packages/domain/src/commands/merge.ts:389` `requestMergeChanges`，`via=system_rule`、`rule=flow-v2/A1`、`run_kind=fix`、`reason` 由失败步骤 + `failure_excerpt` 组成）；绑定该申请的 open 合并确认按 C-47 作废，已确认的按 C-46 标为 superseded 并保留原授权。
  - `packages/router/src/route.ts:1634-1686`：`flow_version ≥ 2` 的卡不再给 PM Ops 发“请处理失败检查”；`merge_changes_requested` 已在 `route.ts:1605-1621` 给原产出 Assignment 排 `fix` Run，没有活跃产出方时按 `:1625` 转 PM Ops（异常）。
  - `packages/domain/src/commands/merge-delegation.ts:336-345`、`packages/domain/src/commands/coordination.ts:1010-1060`：PM 处理失败检查的 C-66/C-79/C-115 路径对 `flow_version ≥ 2` 的卡拒绝（已由系统处理），对旧卡不变。
- 验收：
  1. 新版卡检查 failed → 同一事务：卡片 `awaiting_merge → in_progress`、产出项 `accepted → changes_requested`、完成申请 superseded、完成验收项 `target_withdrawn`、原产出 Assignment 收到 `fix` 门铃，原因含失败步骤和首个 FAIL。
  2. 敏感卡、D12 卡同样退回；退回后再合并仍交人（回归 `mergeNeedsHuman`）。
  3. `interrupted`、`executor_unreachable`、触发 C-116 自动重跑的失败不退回。
  4. 已确认合并（人、PM 或超时代批）的卡检查失败 → 原确认 superseded、原授权保留，作者收到 `fix`。
  5. 旧卡（`flow_version=1`）行为与现在完全一致（回归 C-46/C-66/C-79/C-115 现有契约测试）。
  6. 退回后基线前进，不再为已作废的申请排检查（断言 `apps/server/src/merge-checks.ts:321-327` 的重新准备不覆盖已作废申请）。
- 测试：domain 契约测试（上面 1–6，含敏感/D12/已确认三种）；router 测试；`pnpm --filter @cardigan/domain test:types`。

### A1b 基础设施偶发失败自动重跑一次

- 改动点：主机在判定超时（`packages/host/src/merge-check-timeout.ts:107`）的同一处增加 `infra_flaky` 判定，特征清单放执行器配置（初值：vitest worker 进程异常退出、托管 runner 失联、依赖下载网络错误；清单由人审）；domain 在 `merge-check.ts:368-374` 把重跑条件从 `timeout_only` 扩成 `timeout_only || infra_flaky`，与 C-116 共用 `hasTimeoutAutoRerun`（`:65`）的“每份完成申请一次”额度（重命名为通用的自动重跑判定，保留旧事件兼容）。
- 失败申请不随基线重跑：`apps/server/src/merge-checks.ts:402-413` 的“同树终态不重排”扩展为“当前申请最新结果为 failed/timed_out 时，基线前进也不重新准备”，除非 `recheck_requested`（主要影响旧卡）。
- 验收：特征只由主机按完整日志判定，domain 不读文本；同一申请第二次偶发失败不再重跑而按 A1a 退回；清单为空时不判定为偶发；旧卡同一失败申请在基线前进 3 次后检查次数不增加。
- 测试：host 判定单测（正例、混有断言失败的反例）；domain 契约测试；server 测试；`pnpm --filter @cardigan/domain test:types`。

### A1c 本卡检查日志只读工具 `get_check_log`

- 范围：`get_check_log({card_id, attempt_id, offset?, limit?})`，只允许本卡产出项和验证项当前 active 的 Assignment 调用；只能读本卡的 attempt（合并检查和预检）；返回主机私有日志中已脱敏的文本，单次上限 64 KiB、单个 attempt 累计上限 1 MiB（默认值，配置项）；不接受路径。
- 改动点：工具名加入 `packages/domain/src/entities.ts:44` `toolNames`；按角色类型白名单 `packages/domain/src/role.ts:95-112`；默认角色工具 `packages/roles/src/role-pack.ts:576-589`、`:609-618`；MCP 注册 `packages/mcp-server/src/server.ts:66-75`；日志读取复用 `apps/server/src/web/merge-check-log.ts:51` 的读取逻辑（不复用 Web 会话鉴权）；`get_card` 的 `merge_check`（`packages/mcp-server/src/tools/get-card.ts:66/116`）补 attempt 列表。
- 验收：其它卡、其它项目、已释放 Assignment、PM Office/Ops、host_ops 调用被拒；超出上限截断并标明；日志文件不存在时返回明确错误，不泄露路径；合成凭据不出现。
- 测试：mcp-server 权限测试；domain 白名单契约测试；`pnpm --filter @cardigan/domain test:types`。改角色包，合并交人（Q-279）。

### A1d `request_recheck`

- 范围：作者判断失败与本卡无关时使用。只接受本卡主产出项当前 active 的 Assignment；条件：最近一次完成申请由 A1 系统退回、之后没有新的产出交付、该组产出 SHA 未用过 recheck；效果：以原 SHA 重新交付，沿用对同一 SHA、同一树的有效审核，生成新完成申请（`recheck_of` 指向旧申请）并排检查。
- 改动点：`packages/domain/src/commands/review-reuse.ts:84` 的 `review_epoch` 不计 `via=system_rule` 且 `rule=flow-v2/A1` 的 `merge_changes_requested`；`reusableReviews`（`:281`）其余条件不变；新增 MCP 工具（白名单同 A1c 的几处）；完成申请的验收沿用规则：B3a 之前沿用对旧申请的完成验收结论（同交付集合、同 SHA、同树），B3a 之后由系统重新汇总。
- 验收：第二次调用被拒；代码有改动（SHA 不同）时不能用 recheck；沿用的审核在发布前 `planFor`（`merge.ts:198-240`）仍按现有规则重查有效性；人或审核员退回（非系统 A1）的卡不能 recheck。
- 测试：domain 契约测试；`pnpm --filter @cardigan/domain test:types`。改角色包，合并交人。

### A2a（改 C-298）作者自助预检 `request_check`

- C-298 现状：风险卡交付后系统自动跑预检、PM 可手动请求；已有交付在审，卡片按用户指示暂停。改范围后：去掉“风险卡自动触发”和“PM 手动请求”，改为所有新版卡的作者自助触发；保留已完成的调度（Q-486 合并优先、非抢占、独立队列）、结果入库、日志与失败终态处理；执行走 D1 接口，cardigan 项目默认 GitHub。原 AC 中“普通代码审核是否等待预检查”的偏好删除（A2b 统一为交付门槛）。
- 改动点：MCP 工具（白名单同 A1c）；主机取 Assignment 分支 HEAD 的路径与交付相同（不让 Agent 传 SHA 以外的任何参数）；候选准备复用 `apps/server/src/merge-checks.ts:317` `prepare()`；事件 `precheck_queued/started/finished`（含 attempt、head_sha、base_sha、tree、步骤结果、摘要、`log_ref`、`external_run`）；router 把 `precheck_finished` 只发给发起的 Assignment；`get_card` 展示预检状态。
- 验收：
  1. 只有本产出项 active Assignment 能调用；同一 Assignment 已有 queued/running 预检时拒绝。
  2. 预检与合并检查用同一执行器、同一检查配置；cardigan 项目切到 GitHub 后预检就是一次 GitHub run。
  3. 有可执行的合并检查时不启动新预检；已运行的预检不被打断。
  4. 预检通过记录不能被 `recordMergeResult`（`packages/domain/src/commands/merge-result.ts:34`）当作合并依据（契约测试断言）。
  5. 失败日志可经 `get_check_log` 读取。
- 测试：沿用 C-298 已列的 domain、host、server、router 测试范围；`pnpm --filter @cardigan/domain test:types`。改角色包，合并交人。

### A2b 交付要求该 SHA 预检通过

- 改动点：`packages/domain/src/commands/delivery.ts:66` `inspect()`（交付前置校验）：`flow_version ≥ 3`、项目启用合并闸门、`subject.kind=git_head` 时，要求同卡存在 `head_sha` 等于交付 SHA 的 passed 预检；否则 `illegal_transition`，中文提示“请先 request_check”。
- 验收：SHA 不同、预检失败或仍在跑时拒绝；预检通过但基线已前进仍允许交付；非 Git 交付、未启用闸门的项目、旧卡不受影响。
- 测试：domain 契约测试；`pnpm --filter @cardigan/domain test:types`。

### L1 本地两层测试：worker 上限默认 4、Agent 环境禁跑 e2e

- 范围：本地测试 worker 上限的缺省值从 2 改为 4（仍可由主机 `agent-tests.yaml` 的 `max_workers` 覆盖，生产配置由主机运维同步改为 4）；员工启动环境注入 `CARDIGAN_AGENT_LOCAL_TESTS=1`，依赖 hc 的验收和 e2e 套件在该环境下以明确提示跳过，`pnpm test:e2e` 直接拒绝并提示“e2e 只在远程检查里跑”。
- 改动点：`packages/host/src/agent-test-config.ts:49`、`:64`（缺省值）；`packages/roles/src/test-worker-limit.ts:67`、`:93`、`:98`（上限注入，逻辑不变）；员工启动环境注入沿用 C-168 的路径（`packages/host/src/launch.ts`，开发方案 §13.4）；D2 新增的 `test-support` hc 辅助函数同时处理 `CARDIGAN_AGENT_LOCAL_TESTS`（本地跳过）和 `CARDIGAN_REQUIRE_HC`（远程缺失即失败），两者同时设置时以“失败”为准。
- 验收：
  1. 未配置 `agent-tests.yaml` 时员工会话的 vitest 上限为 4；配置值仍优先；改 `--maxWorkers` 不能放宽（回归 C-168）。
  2. 员工会话里运行 hc 相关套件或 `pnpm test:e2e` 不会启动 herdr-core，输出固定提示。
  3. GitHub workflow 里（`CARDIGAN_REQUIRE_HC=1`、未设本地标记）上述套件正常执行。
- 测试：host、roles 单测；test-support 辅助函数单测；受影响验收测试文件定向运行（在非员工环境）。

### A3b 暂停自动合并开关

- 范围：偏好 `auto_merge_paused`（只有人能改；Workbench 设置页、CLI `cardigan preference set auto-merge-paused on|off`）。
- 改动点：`packages/domain/src/preferences.ts:48`；Needs You 显示暂停横幅和等待数；发布前校验在 A3a 接入。
- 验收：Agent 写入被拒；每次切换写 `project_preferences_updated`；暂停期间人亲自确认的合并照常发布；暂停不影响检查和 A1 退回。
- 测试：domain 契约测试、Web/CLI 测试；`pnpm --filter @cardigan/domain test:types`。

### A3a（改 C-320）系统合并

- C-320 现状：backlog，验收标准是“规则明确的合并确认交系统、运行异常自动重试、PM 待办排序”，且限定“不新增任何放宽”。改范围后只保留合并部分，按 A3 重写验收标准；原“运行异常自动重试”“PM 待办排序”移到 C3。
- 改动点：
  - `packages/domain/src/commands/merge.ts:322` `requestConfirmation` / `:445-473` `completionPassed`：`flow_version ≥ 4` 时，若 `mergeRequiresHuman`（`packages/domain/src/commands/delegation.ts:97`）为假、未命中 `release_paths`、D6 证据完整，确认的 `decider` 为 `system`；否则为 human 并写 `human_required_reason`（列明原因）。`assignDecision`（`delegation.ts:279`）对 `decider=system` 不改派 PM。
  - 新增 system 专用命令 `systemConfirmMerge`，在 `apps/server/src/merge-loop.ts:160-171`（`autoConfirmMerge` 同一扫描处）调用：事务内重查 `pmMergeBlockers`（`packages/domain/src/commands/merge-delegation.ts:38`）为空、`auto_merge_paused` 为假、仍不需要人；满足则解决为 `merge`（`resolved_by=system`、`via=system_rule`、`proxy_authority` 指向项目偏好事件），写知会。
  - `merge.ts:198-240` `planFor`：发布前对 system 解决的确认再查暂停开关、`pmMergeBlockers` 和强制交人条件；资格变化时复用 `syncSensitiveMerge`（`:488`）、`syncRiskTagMerge`（`:540`）、`syncRoleRuleMerge`（`:643`）的作废并转人机制。
  - 启用校验：项目偏好切到 4 时要求 `system_merge_shadow_policy.release_paths` 已显式设置（可以为空数组，表示人接受不按路径识别对外发布）。
- 验收：
  1. 全部门禁满足 → 系统合并，Needs You 只有知会，没有待拍板；`card_merged` 后卡片 done。
  2. 下面每一项单独成立时都交人：敏感卡、相关 D12 四类、`scope_change`（含来源拍板）、命中发布路径、角色规则改动、带 `human_required_reason`、D6 证据缺失。
  3. 任一 `pmMergeBlockers` 条目存在（检查未过、验证项未过、必需产出未 accepted、未处理 must_fix、风险卡独立复核未对当前交付编号和 SHA 通过）→ 不合并、不生成拍板，等待条件变化；检查失败走 A1a。
  4. 暂停开关打开 → 不解决、已解决未发布的不发布；关闭后自动继续。
  5. 发布前出现新的强制交人条件 → 系统确认 superseded，新建人工确认。
  6. 旧卡（`flow_version ≤ 3`）沿用 C-49/ADR 0006/C-309/C-310 现有规则（回归全部现有不变量 23 契约测试）。
- 测试：domain 契约测试（上面 1–6 逐条，单独置否）；server merge-loop 测试；Needs You 投影测试；`pnpm --filter @cardigan/domain test:types`。

### B1 并行验证问题一次收齐

- 改动点：`packages/domain/src/commands/delivery.ts:659-663`：`flow_version ≥ 5` 时，目标交付为 `rejected`（被另一验证方驳回）、没有更新的交付、本验证项在该交付的 `requested_verifiers` 里且尚未对它提交时，允许提交；不改变产出项状态（已是 `changes_requested`）；验证项按结论进入 passed/failed，计入该交付这一轮。router 把迟到 Review 的问题转给作者当前会话（`route.ts:705` `routeReview`）。
- 验收：已有更新交付时迟到提交仍以 `stale_target` 拒绝；迟到 pass 在新交付到来后照常失效；旧卡不变。
- 测试：domain 契约测试（并发顺序：A reject → B pass / B reject / B 未提交即新交付）；router 测试；`pnpm --filter @cardigan/domain test:types`。

### B2 普通审核系统自动加轮

- 改动点：`packages/domain/src/commands/review-limit.ts:24` `requestReviewLimit`：`flow_version ≥ 5` 且不是 `independent_reviewer` 时，不生成 Decision，同一事务加一轮并写 `review_limit_raised_by_system`；次数达到 `system_review_limit_max_raises`（`preferences.ts:51`，人填写）后不再加，只给 PM Ops 发异常提醒（不是拍板）。与 C-239（`packages/domain/src/commands/system-review-limit.ts:28`）共存：旧卡仍走 C-239。
- 验收：新版卡普通验证项不再出现 `review_limit` 拍板；独立复核照旧（C-301/C-253）；未设置上限时按 0 处理（不加轮、发异常），避免无限循环。
- 测试：domain 契约测试；`pnpm --filter @cardigan/domain test:types`。

### B3a 系统汇总完成申请

- 改动点：`flow_version ≥ 5` 时作者不再提交完成申请；所有必需验证项对当前产出交付通过后，system 生成 `card_completion` 交付（内容：各产出交付编号与完整 SHA、作者交付里的人话概述 `plain_summary`、代码审核 Review 里的验收标准对照、已知遗留）；模板有完成审核者时请求它，没有时直接 `completion_review_passed`（`merge.ts:445`）进入合并阶段。交付前置校验仍在 `delivery.ts:66` `inspect()`，包括不变量 29 的风险卡硬门（`:199-220`）。完成提醒（`route.ts:643-677`）对新版卡不再发。
- 验收：生成的申请绑定当前交付；任一必需项未过不生成；风险卡缺独立复核项时不生成并给 PM Ops 异常；`reviewer=human` 模板仍由人验收（不变量 28）。
- 测试：domain 契约测试；`pnpm --filter @cardigan/domain test:types`。

### B3b 内置模板 `dev@2`、`product@1`

- 改动点：`packages/domain/src/templates.ts:39-68` 旁新增：`dev@2`（开发 + 代码审核，无 `pm_acceptance`；代码审核的完成标准写明“逐条对照验收标准；测试范围为本地相关测试 + 远程预检通过”）；`product@1`（开发 + 代码审核 + PM 验收，用于产品卡和界面卡；界面卡另按现有规则加设计验收）。版本按 `templates.ts:152-160` `cardTemplate` 精确选取；内置不可修改（`commands/templates.ts:186-190`）。`dev@1` 保留，旧卡不变。
- 验收：建卡可选新模板；旧卡读取 `dev@1` 不变；`dev@2` 卡没有 PM 验收工作项，完成后直接进入系统合并。
- 测试：domain 模板契约测试；`pnpm --filter @cardigan/domain test:types`。

### C1 系统调度收口

- 改动点：新版卡验证项的自动指派不再看 `system_auto_assign_verifiers` 开关（`packages/domain/src/commands/system-rules.ts:82/112`，`apps/server/src/system-rules.ts:30-31`），始终由 system 指派，失败才通知 PM Ops；`card_merged` 给 PM Ops 的通知（`route.ts:1700`）对新版卡改为只写时间线；PM Ops 只收异常：没有合格员工、执行器不可达、加轮达上限、D6 加标签后缺复核项、产出方失活。
- 验收：一张 `dev@2` 新版卡从交付到合并，PM Ops 的 Run 数为 0（假执行器端到端测试）；异常各有一条通知。
- 测试：router、system-rules 测试；端到端假执行器测试；`pnpm --filter @cardigan/domain test:types`。

### C2a 角色包改写一：测试分层与作者闭环工具用法（合并交人，Q-279）

- 改动点：`packages/roles/src/role-pack.ts`：
  - 所有角色共用的本地自测规则（`:562`，当前写“全量检查交给合并检查”）和 design_director 段（`:427`）改为两层测试：本地只跑增量构建、lint、deps、相关单测（`vitest related` 或 `--changed`），改 `packages/domain` 加跑 `pnpm --filter @cardigan/domain test:types`；本地不跑全量测试和 e2e；全量和 e2e 以远程预检、合并检查为准；本地结果是自报，不作为审核或合并依据；worker 上限由主机强制（L1 后为 4）。
  - coder 段（`:321-337`）：交付前先 `request_check`，预检通过再交付；失败时用 `get_check_log` 读日志、在原会话修复后再预检；只有判断与本卡无关时才 `request_recheck`，并写明理由；作者会话的 subagent 自检只是建议，不能代替正式审核。
  - reviewer 段（`:338-354`）、独立复核员段：审核只针对已有通过预检的 SHA；需要复现时本地只跑相关检查，全量结果看远程 run。
  - PM 建卡规则：卡片“测试范围”写成“本地相关测试 + 远程预检通过”，不再要求写全量 `pnpm test`。
  - PM 建卡规则（第 4 级系统合并的前提，所以放在这里而不是 C2b）：产品拍板在建卡或开工时以来源拍板问清；改部署监督器或数据库迁移的卡建卡时标敏感或打 `security`；风险标签在建卡时就打，不等合并前再补。
- 验收：`pm-lessons.test.ts` 等文字断言更新；角色正文按“流程版本 ≥3 / 旧卡”分别写明；合并后按 `cardigan role upgrade` 流程生效。
- 测试：roles 测试；文档一致性测试。

### C2b 角色包改写二：PM Ops 职责收窄、建卡规则、模板选择（合并交人，Q-279）

- 改动点：`packages/roles/src/role-pack.ts`：PM Ops 段（`:290-319`，常量 `:177-180`、`:191-194`）删掉已交系统的指派、催办、合并确认、检查失败处理、PM 验收指派；PM 建卡规则新增“工程卡选 `dev@2`，产品卡、界面卡选 `product@1`”；`PM_DECISION_RULES`（`:125`）把“数值和行为规则交人”收窄到影响用户、成本、权限、数据或发布边界的取值；reviewer 段：`dev@2` 卡逐条对照验收标准。
- 验收：同 C2a。
- 测试：roles 测试；文档一致性测试。

### C3（从 C-320 拆出）运行异常自动恢复、PM 待办排序

- 范围：C-320 原验收标准 A2（可机械判断的 `run_attention` 自动重试一次）和 C（PM 通知按紧急程度排序、同卡合并）原样迁入。
- 版本（Q-744，2026-11-16 人选 B1）：C3 另设为第六级，第五级的原定义不变。2026-11-16 核对：中心 main 的 `docs/plans/flow-v2.md`、`packages/domain/src/flow.ts`、`docs/adr/`，以及 Flow Lite 的 A、B 两个批次分支，都没有定义第六级，`FLOW_VERSION_MAX` 仍为 2。
- 恢复次数：同一根链跨准备、派发、真实退出、服务重启共用一次自动恢复，同时保留 C-56 和 C3 的终身预算。服务重启只免终身预算，不免根链上限。只有可信的退出证据才能触发恢复。
- 通知排序（N1）：只在第六级及以上卡的原有通知槽位之间按紧急程度排序。第五级及以下的卡、项目级顺序保持不变，不承诺混合队列的全局紧急优先。
- 完整合同以卡片验收标准和 attachment-3679（v2.1）的公共条款 + B + N1 为准。

## 7. 不变量和状态机的改写

### 7.1 §4.4 状态机

| 对象 | 改动 | 为什么不破坏安全 |
|---|---|---|
| Card | 不新增状态。新版卡检查失败复用 `awaiting_merge --request_changes--> in_progress`，Actor 为 system，`via=system_rule` | 只是更早、自动地执行人和 PM 已经能做的退回；退回不授予任何权限 |
| WorkItem（produce） | 不变；`request_recheck` 走普通的 `submit_delivery` 迁移 | 新交付仍绑定 SHA，审核沿用规则只放宽 A1 系统退回这一种代次 |
| WorkItem（verify） | 新版卡允许对已被另一方驳回、且没有更新交付的目标提交 Review | Review 仍绑定交付版本（不变量 14），不改变产出项状态，迟到的 pass 遇新交付照常失效 |
| Decision（merge_confirmation） | 新增 `decider: "system"`；system 只在 `pmMergeBlockers` 为空、未暂停、无强制交人条件时 `open → resolved(merge)` | 条件集合与 PM Ops 代确认相同，且发布前再查；强制交人条件仍转人 |
| Decision（review_limit） | 新版卡普通验证项不再创建 | 加轮只恢复审核，不跳过审核；有次数上限 |
| Delivery（card_completion） | 新版卡由 system 生成 | 内容取自已绑定的交付与审核，不是作者自报；风险卡硬门照旧 |
| 合并检查记录 | 增加 `kind=precheck` 的记录、`external_run`、`failure_excerpt`、`infra_flaky` | 预检记录不能作为合并依据；外部 run 必须通过绑定校验 |
| C-46/C-66/C-79/C-115 | 新版卡的失败检查由 system 退回，PM 处理入口对新版卡拒绝；C-115“敏感卡 PM 不能退回”改为“system 可以退回，PM 仍不能” | 退回只减少状态，合并仍按原规则交人 |

### 7.2 §4.5 不变量

| 条 | 改成什么 | 为什么不破坏安全 |
|---|---|---|
| 13 | “review 模板的 done 必须经过完成申请和审核”改为：必须经过完成申请；新版卡由系统汇总生成，模板设有完成审核者时仍须其通过；`done` 只经 `merge_succeeded`（需合并卡）或 `merge_not_required` 进入 | 完成申请仍是绑定 SHA 的记录；`done` 仍不能由规则直接设置，只能由合并成功事件推进 |
| 15、16 | 文字不改；补一句：作者会话的 subagent 自检只是建议，不能作为 Review 提交（同一 Token 提交审核本来就被 `submitReview` 以 `unauthorized` 拒绝）；系统生成完成申请不是验证方 | 正式审核仍要独立 Assignment 和员工 |
| 20 | 扩为：超时自动合并和系统合并都必须有当前项目的 human 偏好授权（前者 `auto_merge_after_minutes`，后者 `flow_version ≥ 4` 且 `auto_merge_paused=false`），条件在同一新鲜事务内校验，发布前再查；Agent 不能设置偏好 | 授权来源仍是人；暂停开关是人随时可用的刹车 |
| 21 | 不改。补充：`kind=precheck` 的通过记录、GitHub 执行器未通过绑定校验的结果都不能作为 merged 的依据；GitHub 执行器的通过记录必须带 `external_run` | 合并依据仍是“当前完成申请 + 实际候选树”的通过记录 |
| 23 | 新版卡：合并确认不再交 PM Ops；system 选 `merge` 的条件与原 PM Ops 条件相同（检查通过、所有未取消验证项通过、无未处理 must_fix、风险卡独立复核对当前交付编号和 SHA 通过、截图核对规则），另加“未暂停”“未命中发布路径”“D6 证据完整”；强制交人条件（D12 四类、`scope_change`、敏感、角色规则、`human_required_reason`）不变。旧卡沿用原文 | 新增的只是“谁来按按钮”，按钮的前置条件不放宽；强制交人的范围不缩小 |
| 27 | 不改；A1 退回发生在检查结束之后，不与“检查 running 时禁止撤回审核”冲突 | — |
| 29 | 不改；补充：system 按 `auto_security_paths` 只能加 `security`，不能删标签；加标签后缺复核项时完成申请仍被拒 | 自动加标签只会让卡更严 |
| 新增 30 | 检查失败的 system 退回只在当前完成申请的最新结果为 failed/timed_out 时执行，同一事务完成，不读日志文本做授权判断；对敏感卡和 D12 卡同样适用；退回不改变任何合并授权以外的权限 | 退回是减权操作 |
| 新增 31 | 预检只由产出项当前 active Assignment 发起，主机决定候选、命令和执行器，Agent 不能传命令、路径或执行器；预检通过只作交付门槛。Agent 在本地会话里跑的测试结果是自报，不能作为审核或合并依据；全量测试和 e2e 的可信结果只来自绑定 `run_id`、SHA 和候选树的远程 run | 与 C-298、§14“检查命令由主机可信配置决定”一致；把“作者说测过了”与“系统证明测过了”分开 |
| 新增 32 | 外部 CI 结果只认主机绑定的可信 run（workflow 路径、事件、分支、触发者、`run_attempt=1`、run-name、`head_sha` 在基线历史）；workflow 只从基线分支读取；候选对 `.github/` 的改动合并后才生效，且自动带 `security` | 候选代码不能改变判定它的流水线，也不能伪造结果来源 |
| 新增 33 | 卡片流程版本建卡固定；只有人能在安全边界升级；同一张卡任何时刻只适用一个版本的规则 | 避免新旧规则混用造成的漏判 |

## 8. 文档同步

### 8.1 开发方案（实现 PR 各自改正文；版本号和变更记录由 Claude 收尾时补）

| 章节 | 改什么 |
|---|---|
| §1.5 | “无授权的自动合并”改为：新版卡由人在项目偏好授权后系统合并，人可随时暂停 |
| §3.5 | 执行器类型（SSH、GitHub）；预检；A1 退回；“失败的同一棵树不能自动重试”的例外加上基础设施偶发 |
| §4.3 | `Card.flow_version`；偏好 `flow_version`、`auto_merge_paused`、`auto_security_paths`；合并检查记录新字段；Decision `decider: "system"` |
| §4.4 | 第 7.1 节各行；C-46/C-66/C-79/C-115 按版本区分 |
| §4.5 | 第 7.2 节各行 |
| §6.4 | `merge_check_finished`、`precheck_finished`、`merge_changes_requested`、`card_merged`、迟到 Review 的路由 |
| §7.1、§7.4 | PM Ops 职责收窄；合并确认不再是拍板；产品拍板前移 |
| §8.2 | Needs You：系统合并知会、暂停横幅、交人原因 |
| §9.2 | 新工具 `request_check`、`request_recheck`、`get_check_log` |
| §10.4 | PM、coder、reviewer 的职责 |
| §12.1 | 补一条：项目选用 GitHub 执行器时，主机在合并前把候选推到 `ci/` 分支供公开 CI 检出；仍只有主机持有凭据，Agent 不 push；原“合并前不推外部平台”对 SSH 执行器的项目不变 |
| §12.2、§12.5 | 候选分支命名、dispatch、run 绑定、清理 |
| §12.4 | 验证方可写构建目录（C-91）的用途改为只跑相关检查；全量结果看远程 run |
| §12.9 | 系统合并即自动部署的提示与暂停开关 |
| §13.4、§13.8 | C-168 员工测试上限缺省值改为 4；本地两层测试规则；员工环境禁跑 e2e |
| §14 | 新增行：GitHub 执行器（凭据、只读 workflow 权限、缓存只恢复、公开日志不含秘密、结果绑定）；Agent 读本卡日志的边界 |
| §15 | D15 结论：采用 GitHub 托管 runner 作为首选执行器（ADR 0010），Gitea 方案不采用；新增本 ADR 的决定条目 |
| §16 | 路线图加入 Flow v2 |
| ADR 0007 | 状态改为“未采纳，被 ADR 0010 取代”（随本计划的文档卡一起提交，是该卡唯一改动的既有 ADR） |

### 8.2 AGENTS.md（建议改法，需人确认）

- “分工”表的“合并 | Claude”一行与下方合并规则：改为“新版卡（流程版本 ≥4）由系统在全部门禁满足时合并（ADR 0010）；仍交人：与本卡合并内容相关的 D12 四类或需求范围变化、人标敏感、对外发布、角色规则改动（Q-279）。人可随时用项目偏好暂停自动合并。旧卡沿用原规则至完成。”
- “独立复核”一节：把“风险标签卡由 PM Ops 代确认合并须同时满足……”改写为“系统合并须同时满足……”（条件不变，去掉“提交 notice 知会”，改为系统生成知会）；补“交付改动命中 `.github/**` 等路径时系统自动加 `security`，PM 补复核项”和“改部署监督器或数据库迁移的卡建卡时标敏感或打 `security`”。保留三方隔离、不得拆卡规避、不得删标签等全部原文。
- “审核清单”第 7 条：把“PM 代确认”改为“系统合并”的条件。
- 新增一条：作者会话的 subagent 自检只作建议，不能代替代码审核或独立复核。
- “工作流程”第 3 条补一句：在 Cardigan 卡片里工作的 Agent，本地只跑与改动相关的检查（增量构建、lint、deps、相关单测，改 `packages/domain` 加 `test:types`），不跑全量测试和 e2e；全量测试和 e2e 以远程预检和合并检查为准，本地结果不作为审核或合并依据。
- 新增一条：公开仓库收到的外部 PR 不经 Cardigan 卡片流程，由 Claude 审核、人决定是否合并。

### 8.3 CLAUDE.md（建议改法，需人确认）

- “合并”一条改为：Cardigan 自举项目的新版卡由系统合并，Claude 不再逐卡合并；Claude 负责规划、审核计划与 ADR、处理交给主机操作员的事项、在需要时建议人打开暂停开关；外部 PR 和不经卡片的分支仍按原规则由 Claude 审核、人决定。
- “合并前检查分支是否还在 worktree 里检出”一句只适用于 Claude 手工合并的分支，系统合并不需要。

## 9. 在途卡和未决拍板的迁移

总原则：新旧规则不在同一张卡上同时生效。项目偏好 `flow_version` 只决定新卡；旧卡留在版本 1，直到人在安全边界升级；`awaiting_merge` 的卡按原版本走完。执行器切换（D7）对所有卡生效，因为它不改规则，只改检查在哪跑，且一个 attempt 只用一个执行器。

| 在途对象 | 处理 |
|---|---|
| C-298（进行中，已暂停） | 改范围为 A2a；保留已实现的调度、入库、日志与失败终态处理；风险卡自动触发和 PM 手动请求删掉。卡片本身按版本 1 完成（它是在旧流程下开发的），改范围后需要新交付，旧审核不沿用 |
| C-320（backlog，已暂停） | 改范围为 A3a，重写验收标准；原 A2、C 两部分迁到 C3 |
| C-308（增量复核，审核中） | 继续，不在本计划重复 |
| C-316（同项目并行检查，审核中） | 继续；D7 建议在它之后 |
| C-311（来源拍板类别不传染） | 继续；新旧版本共用 `mergeNeedsHuman`，它减少新版卡的交人 |
| C-312（淡化 PM 处理的合并确认） | A3 上线后基本不再需要，建议 PM 评估后取消或降级 |
| C-313（hc 升级） | 继续；workflow 从 `deploy/install-agent.py` 读版本，自动跟随 |
| C-321（公开前清理） | 继续；D 的前置 |
| C-78、C-224（Gitea 评估与实测） | **已决定（2026-11-15）**：取消，理由引用 ADR 0010；ADR 0007 状态改为“未采纳，被 ADR 0010 取代”，随本计划的文档卡一起提交 |
| C-241（系统规则一周数据） | 扩大为本计划第 10 节的观测卡 |
| P2b 系列 | 不受影响；多机和私有项目继续用 SSH 执行器 |
| 旧卡上 open 的合并确认 | 按原规则处理（PM Ops 或人），不批量改写 |
| 旧卡上 open 的 `review_limit` 拍板 | 按原规则；卡片升级到 ≥5 时按 F0 验收第 5 条处理 |
| 产品拍板、D12 拍板、人工待办 | 不动 |
| 已暂停的卡（用户“等流程简化方案”指示） | 本计划拍板后由 PM 逐卡写恢复通知，恢复时核对版本、基线和审核资格；是否升级流程版本由人按卡决定 |

## 10. 上线后的观测

由 C-241 扩展后统一出数。每项都同时报“新版卡”和“同期旧卡”，并与基线窗口（2026-11-12 至 11-15，72 小时）对比；窗口长度、按合并时间选卡、回溯整卡生命周期的口径与基线评审一致。开工前等待（基线占整卡生命周期 68%）单列，不并入流程指标。按风险标签卡、界面卡、普通卡分组。

| 指标 | 口径 | 基线 |
|---|---|---|
| 失败到作者开始修复 | 检查 failed/timed_out 的 `merge_check_finished` → 原产出 Assignment 下一个 `run_started`（kind=fix） | 失败到重新入队平均 43.4 分钟，其中约 28.7 分钟无活动 |
| 失败到合并 | 同上起点 → `card_merged`，P50/P90 | 中位 70 分钟、平均 121 分钟 |
| 首个 Run 到合并 | 本卡首个工作项 Run 开始 → `card_merged`，P50/P90 | 中位约 1.5 小时（风险卡 2.3、普通卡 1.0）；P90 由 C-241 用同口径补算 |
| 每卡角色交接次数 | 本卡相关 Run（含触达本卡的 PM Ops Run）按开始时间排序，相邻两次 Assignment 不同计一次 | 工作项 Run 每卡均值 10.6、P90 19；PM Ops 约占全部 Run 41% |
| 每卡完整检查次数 | 合并检查实际启动次数、预检次数分开报 | 合并检查启动 377 次，约 2.3 次/卡；58 次失败；首次通过后又通过 128 次 |
| 人工点击数 | human 解决的 Decision + human 完成的 HumanAction + human 亲自确认的合并，按天；再分产品层面和流程层面 | 3 天约 204 次，产品层面约 35 次；合并确认占新发起拍板 68% |
| PM Ops 负载 | PM Ops `run_started` 数、通知等待中位/P90 | 见 C-320 卡片基线 |
| 漏审与回滚 | 合并后 7 天内引用该卡的回滚卡或修复卡数、自动部署回滚次数、独立复核抽查发现数；自动重跑后仍失败的比例 | 切换前两周先按同口径采集 |
| GitHub 执行器 | 排队时长、run 时长（分步骤）、并发峰值、REST 请求数、`executor_unreachable` 次数 | 双跑期与 SSH 执行器对照 |

## 11. 风险和回退

| 风险 | 缓解 | 回退 |
|---|---|---|
| 自动合并即自动部署（C-201） | 暂停开关；部署监督器、数据库迁移卡建卡时标敏感或 `security`；风险卡独立复核；最终候选树检查；§12.9 备份与回滚 | 打开 `auto_merge_paused`；项目 `flow_version` 改回 3 以下（只影响新卡）；已发布的问题开回滚卡 |
| 不再逐卡做合并前分类确认（ADR 0008 条件 16），漏标风险 | D6 路径自动加标签（`.github/**` 固定，迁移目录和部署监督器文件为默认，人可增删）；角色规则改动由主机清单识别；抽查已合并卡 | 同上；补充 `auto_security_paths` |
| 人在评论里说“先别合”，系统不识别（用户 2026-11-15 已接受） | 时间线评论不阻止系统合并；要阻止须用暂停开关、对系统持有的确认选 hold，或给卡片标敏感；Needs You 和 CLI 的提示里写明这一点 | — |
| GitHub 不可用或限额 | `executor_unreachable` 不退回作者；主机退避；可配置并发和请求预算 | 人或主机运维把项目切回 SSH 执行器 |
| 候选代码在合并前公开 | 仓库本来就公开；开启 secret 推送保护；CI 无 secret；Agent 已有出网能力，不新增外传通道 | 删除对应 `ci/` 分支 |
| 公开 CI 日志 | 测试只用合成数据；CI 环境没有凭据；Agent 读到的是主机再脱敏的副本 | — |
| 缓存投毒、流水线篡改 | 候选 job 缓存只恢复；workflow 只从 main 读；`.github/` 改动自动 `security`；main 只允许主机推送 | 删除缓存、回滚 workflow |
| 偶发判定掩盖真实失败 | 只按主机完整日志和人审过的特征清单判定；每份申请只重跑一次 | 清空特征清单即关闭 |
| `request_recheck` 被滥用 | 每组 SHA 一次；只限 A1 系统退回；仍跑完整检查 | 工具权限可从角色移除 |
| 新旧规则混用 | 卡片固定流程版本；升级只在安全边界 | 不需要数据迁移，旧卡不受影响 |
| 预检拖慢交付 | GitHub 并发远高于现有 SSH 检查机；合并检查优先 | 项目 `flow_version` 改回 2（只影响新卡） |
| 4 vCPU 下检查变慢 | 全量 test 在 12 worker 上约 168 秒、e2e 约 67 秒，4 vCPU 上会更慢；双跑期分步骤测量，必要时另开卡用 `--shard` 拆成多个 job（并发容量够用） | 切回 SSH 执行器 |

回退时历史记录全部保留：系统退回、系统合并、自动加标签和预检都是普通事件，不需要回滚业务数据。

## 12. 已拍板记录（用户 2026-11-15）

| # | 事项 | 结论 |
|---|---|---|
| 1 | 主机的 GitHub 凭据 | 用 GitHub App，不用 PAT。App 已建好并核对：只装在本仓库，权限 `actions:write`、`contents:write`、`metadata:read`，无 webhook。主机私有配置提供 `app_id`、`installation_id` 和私钥文件路径，主机用 JWT 换 installation token，令牌只在内存中用、不落盘。workflow 的可信触发者是该 App 的机器人身份 `<app-slug>[bot]`（由配置提供）。具体 ID 和路径不进仓库 |
| 2 | 数值 | 轮询 20 秒、双跑 20 次结果一致后切换，作为确定的默认值；其余本计划写的数值（REST 预算、等待开始上限、日志长度、分支保留期）同样作为默认值。全部仍是配置项，相关卡标 `numeric_rule` |
| 3 | 自动加 `security` 的路径 | `.github/**` 固定；默认另含 `packages/store/migrations/**`、`packages/host/src/deployment*`、`apps/cli/src/self-deploy.ts`，人可增删 |
| 4 | 评论里说“先别合” | 接受不阻止系统合并；阻止手段是暂停开关、hold 或敏感标记 |
| 5 | Gitea 方案 | 取消 C-78、C-224；ADR 0007 状态改为“未采纳，被 ADR 0010 取代” |
| 6 | 开卡 | 同意；文档卡先合入，波次 0 的卡可与文档卡并行开工，卡片附本计划 |
| — | hc 版本 | workflow 从 `deploy/install-agent.py` 读取版本和 sha256，C-313 升级后自动跟随 |
