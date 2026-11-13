# ADR 0007：合并检查执行层和自举部署是否改用本地 Gitea Actions

- 状态：**待决**（交邵杰拍板；本 ADR 只做评估，不改产品代码、不在任何机器上安装软件）
- 依据：开发方案 §3.5、§12（尤其 §12.1、§12.2、§12.5、§12.7）、§13.1、§14、§15 D1；ADR 0004（合并批次）；P2a-1、P2a-12、P2a-13 计划；C-201 分支 `agent/C-201/W-598` 中的 §12.9 草稿
- 卡片：C-218（相关 C-201、C-118）
- 来源：邵杰 2026-11-13 对话：“我感觉我们在重复造轮子, 在重新搭了一套ci 为什么不直接本地部署一个gitea 使用gitea的ci 或者 使用github的selfhost”。张良给出 A／B／C 三个选项，邵杰选 A（C-201 照常收尾，另开本评估卡）。

> 记法：机器名按 AGENTS.md 不写进仓库。下文“检查机”指 `merge-gate.yaml` 中名为 `cardigan-ci` 的执行目标；“目标主机”指运行 Cardigan server 和 Agent 的主机。具体机器见私有的 `cardigan-deploy`。
>
> 文中所有“待实测”“待核实”都是本 ADR 写作时没有在真实环境验证过的点，不能当结论用。本文**不给任何性能数字**；行数来自 2026-11-13 `wc -l`（main 为 `c2f975e`，C-201 取其分支当时的版本），只作量级参考。

## 1. 背景：现在自研了哪些东西

合并检查和自动部署里的代码可以分成两类。

**通用 CI/CD 部分**（市面上的 CI 系统都有）：

- 把候选代码送到检查机：`apps/server/src/git.ts` 的 `distribute`／`transfer`（约 80 行）经专用 SSH 推送到检查机基础 clone；
- 在隔离账号下检出、逐条执行 install/build/test/lint/deps/e2e、超时杀进程组、收尾清理：`packages/host/src/temporary-checkout.ts`（460）、`checkout-worker.ts`（312，远端监督进程脚本，含 nonce/HMAC 防伪造）、`checkout-deadline.ts`（67）；
- 执行位和并发：`merge-check-capacity.ts`（94）、`merge-gate-executors.ts`（239，`executors.<name>.max_concurrent`、槽位锁 `merge-check-<i>.lock`）；
- 孤儿进程清理：`checkout-orphans.ts`（124，C-164）；
- 检查机不可达诊断：`executor-failure.ts`（19）、`apps/server/src/merge-checks.ts` 中的 executor 分支，以及 domain `commands/merge-executor.ts`（148，超过 30 分钟建 HumanAction）、`reconcile-loop.ts` 中的远端目录对账；
- 日志：`merge-gate-log.ts`（301，脱敏、截断、保留最近 50 个）、`apps/server/src/web/merge-check-log.ts`（112，Workbench 读日志）；
- 自动部署的“触发—构建—切换”骨架（C-201，未合入）：`packages/host/src/deployment-node.ts`（697）里检出、`pnpm install/build`、停旧起新、ready 加双端口、回滚的部分。

以上非测试代码合计约 2,000 行量级，对应测试约 3,000 行量级（`temporary-checkout.test.ts` 1310、`checkout-worker.test.ts` 437、`merge-gate-executors.test.ts` 442、`checkout-orphans.test.ts` 165，以及 `apps/server/src/merge-checks.test.ts` 2001 行中的执行相关部分）。

**Cardigan 独有的规则和编排**（任何 CI 系统都不提供）：

- 审核绑定交付 SHA、完成申请、合并确认（人／PM 代确认／超时代批）、交人边界、D12 四类拍板、Q 拍板；
- 检查记录绑定 `(completion_id, tree_sha)` 或批次 `(batch_id, tree_sha, 完成申请集合)`（不变量 21、ADR 0004），C-116 超时自动重跑一次、`recheckMerge` 权限、noop 收尾；
- 中心 bare 仓库内 `merge-tree` + `commit-tree` 构造合并、`update-ref` 比较更新、发布锁（§12.5）；外部推送只推合并循环产生的提交（§12.7，C-94）；
- 风险标签、独立复核三方隔离（ADR 0006）；
- 变更范围 `docs_only／affected／full`（`change-scope.ts` 229）；
- C-201 中的部署证据核验（每段都要有 `card_merged` 和同 tree 的 passed 检查）、角色升级手改保护、PM Ops 轮换、停服前 Run 快照审计、`host_ops_read_diagnostics` 部署投影、`host_deployment_capacity` 与合并检查互斥。

这部分在 domain 的 merge 相关命令（非测试近 3,000 行）、`merge-loop.ts`（360）、`merge-checks.ts` 的编排部分、`merge-push-loop.ts`（212）、`packages/git-transport/src/central.ts`（672）以及 C-201 的 `deployment-roles.ts`、`deployment-audit.ts`、`pm-rotation.ts`、domain `commands/deployment.ts` 等。**三个方案都必须保留这部分。**

## 2. 三个方案

### 方案①：维持现状（自研执行层 + C-201）

- **删除／简化**：无。
- **Cardigan 保留**：全部，见第 1 节两类。
- **新增运维负担**：无新服务。已有负担继续存在：检查机的 agent 账号、SSH 身份和 known_hosts、基础 clone 初始化（P2a-12 §3 清单）、`merge-gate.yaml`、`self-deploy.yaml`、监督器的主机服务配置。
- **失败模式和诊断**：
  - 检查机不可达：主机侧分类为 `executor_unreachable`，排队重试，超过 30 分钟建项目级 HumanAction（§12.7、P2a-12 E）；
  - 检查失败／超时：脱敏日志在 Workbench 查看，失败摘要写进事件；C-116 只超时时自动重跑一次；
  - 残留进程：C-164 握手孤儿清理，清不掉时保留目录并标记人工处理；
  - 部署失败：C-201 回滚、`host_deployment_recorded` 审计、HumanAction、host_ops 只读诊断。
- **代价**：执行层是我们自己维护的“小型 CI”。P2a-13 D 组（缓存、分片、识别不稳定测试）等后续需求还要继续自研；矩阵并行、缓存这类现成 CI 早有的能力，我们要逐项补。

### 方案②：本地 Gitea + act_runner（runner 放检查机，部署 job 放目标主机）

- **组成**：Gitea（MIT，单个可执行文件 + SQLite／Postgres）作为本地代码托管和 Actions 调度；act_runner（MIT）注册在检查机上执行检查 job；按卡片设想，另一个 runner 放目标主机执行部署 job（本 ADR 不推荐这一点，见 §4.4）。
- **能删除或简化的代码**（以采用 §4 推荐的“镜像模式 + 可信流水线仓库”为前提）：

  | 文件 | 行数 | 处理 |
  |---|---|---|
  | `packages/host/src/temporary-checkout.ts` | 460 | 删除（当前只有 `merge-checks.ts` 调用；开发方案 §20.2 写验证方构建也复用，但 2026-11-13 grep 未见其他调用方） |
  | `packages/host/src/checkout-worker.ts` | 312 | 删除 |
  | `packages/host/src/checkout-orphans.ts` | 124 | 删除（容器模式下由 runner 回收；主机模式能否回收干净待实测） |
  | `packages/host/src/checkout-deadline.ts` | 67 | 删除，改用 job 的 `timeout-minutes` |
  | `packages/host/src/merge-check-capacity.ts` | 94 | 删除，并发交给 runner 的 `capacity` |
  | `packages/host/src/merge-gate-executors.ts` | 239 | 大部分删除，换成 Gitea 地址、仓库和流水线配置 |
  | `packages/host/src/executor-failure.ts` | 19 | 改为 Gitea API 失败分类 |
  | `packages/host/src/merge-gate-log.ts` | 301 | 简化：日志留在 Gitea，Cardigan 只存摘要和链接；若保留 C-116，仍需拉日志判定只超时 |
  | `packages/host/src/merge-gate-config.ts` | 334 | 简化：检查步骤移到流水线仓库，保留项目开关、外部推送、`affected` 设置 |
  | `apps/server/src/merge-checks.ts` | 1025 | 重写执行部分（`execute`／`slot`／`capacity`／`sweep`，约 300–400 行），换成“推候选—触发—轮询结果”；编排、权限和记录保留 |
  | `apps/server/src/git.ts` `distribute` | 约 80 | 改为向 Gitea 推候选分支 |
  | `apps/server/src/web/merge-check-log.ts` | 112 | 改为跳转 Gitea 或代理日志 |
  | `apps/server/src/reconcile-loop.ts`、`packages/git-service/src/reconcile.ts` 中远端 checks 目录对账 | 数十行 | 删除 |
  | domain `commands/merge-executor.ts` | 148 | 保留，“不可达”的含义改为 Gitea 不可达或 runner 长时间未领取 |

  净删除估计为非测试 1,300–1,800 行、测试 2,000–2,500 行量级；同时新增 Gitea 客户端（推送、触发、查询状态、Webhook 或轮询）、流水线仓库和测试替身，估计 400–700 行量级（**待实测**，以拆卡后的实现为准）。

  **重要前提**：上述删除只在“Cardigan 产品要求所有启用合并闸门的项目都接 Gitea”时成立。如果产品仍要支持没有 Gitea 的项目，自研执行层必须保留为另一种执行器，代码只增不减，见 §6 拍板事项 4。
- **Cardigan 保留**：第 1 节全部规则和编排；变更范围计算（作为流水线输入传入）；中心仓库与合并发布；外部推送；C-201 的证据核验、角色升级、PM 轮换、审计（详见 §4.4）。
- **新增运维负担**：
  - 服务：Gitea 服务进程（含 Web、SSH 或 HTTP Git、数据库）；每台 runner 机器一个 act_runner 服务；若用容器模式还需容器运行时（检查机是否已有、是否允许安装，**待实测**）。
  - 备份：Gitea 数据目录（仓库、附件、Actions 日志和产物）和数据库；镜像模式下仓库可从中心重建，但 Actions 历史和 Gitea 配置要另行备份。
  - 升级：Gitea、act_runner 跟随上游安全公告升级；Actions 的 YAML 兼容性随版本变化（例如 `workflow_dispatch` API、`concurrency`、按 job 的 token 权限在哪个版本可用，**均待核实**）。
  - 凭据：Gitea 管理员账号；Cardigan 主机专用的 Gitea 机器人账号 Token（推送镜像、触发、查询）；runner 注册令牌和 runner 本地的 `.runner` 凭据文件；Webhook 签名密钥（若用 Webhook）；若 Gitea 非回环监听，还要 TLS 或只在 tailnet 内开放。以上都只能放主机或私有 `cardigan-deploy`，不进仓库。
  - 网络：检查机上的 runner 要能访问 Gitea（局域网或 tailnet）；Actions 默认从 github.com 拉取 `uses:` 引用的 action，必须改为不使用外部 action 或配置本地镜像，否则又回到外网依赖。
- **失败模式和诊断**：
  - Gitea 宕机或 API 不可达：Cardigan 无法触发和取回结果，归入现有 `executor_unreachable`（排队、30 分钟后 HumanAction）。
  - runner 离线：job 停在排队，Gitea 不会主动报错。Cardigan 需按“排队超过 N 分钟未开始”判定（N 待人定），并可查询 runner 状态 API（接口和权限**待实测**）。
  - job 失败／超时：结果在 Gitea 的 commit status 和运行页；Cardigan 记录结论、摘要和链接。日志脱敏：Gitea 只遮罩登记为 secret 的值，不会自动遮罩 `merge-gate.yaml` 那样的配置 env；检查本来不需要凭据，所以要求流水线不注入任何 secret。
  - 结果回传丢失：Webhook 可能丢，必须保留按 SHA 轮询作为兜底。
  - 新增攻击面：见 §3.2，流水线定义和 job token 是主要风险。

### 方案③：GitHub self-hosted runner（仓库为私有）

- **组成**：代码已在 GitHub 私有仓库（§12.7 外部推送目标）。在检查机注册 GitHub Actions self-hosted runner，候选推到 GitHub 触发检查。
- **能删除或简化的代码**：执行层与方案②同一批文件，量级相同；不需要运维 Gitea。
- **Cardigan 保留**：同方案②。另外 Cardigan 要持有 GitHub 上有推送候选分支和读取 Actions 结果权限的凭据（现在只有 §12.7 外部推送的专用 SSH 密钥，只推合并后的 main，权限更窄）。
- **新增运维负担**：
  - 服务：检查机上的 runner 服务，需长期以 HTTPS 长轮询连接 GitHub；runner 版本过旧会被 GitHub 拒绝，需按时升级。
  - 凭据：GitHub 上的 runner 注册、Cardigan 主机用于推候选和读结果的 Token 或 GitHub App；仓库的 `GITHUB_TOKEN` 默认权限需改为只读。
  - 费用：私有仓库使用 self-hosted runner 是否收平台费，GitHub 曾宣布过相关计费调整并有变动，**现状待核实**；如需付费，属于 D12 的 `spending` 类，必须由人拍板。
- **网络依赖**：目标主机访问 GitHub 要走代理（2026-11-13 晚已出现过问题），检查机的出网情况**待实测**。方案③下 GitHub 或代理任何一环中断，合并闸门整体停摆（不能检查就不能合并）；而现在外网中断只影响 §12.7 的事后推送，合并照常。这是方案③最大的可用性退步。
- **失败模式和诊断**：GitHub 不可达、代理故障、runner 掉线、Actions 服务事故都会让检查排队；诊断依赖 GitHub 的状态页和运行页，日志在 GitHub 上。
- **原则冲突**：候选代码在合并前就离开本地，违反 §12.1“合并前不推外部”，详见 §3。

## 3. 对照原则

### 3.1 §12 Worktree 与 Git 服务

| 原则 | ① 维持现状 | ② Gitea（镜像模式） | ② Gitea（取代中心仓库） | ③ GitHub runner |
|---|---|---|---|---|
| 所有 Git 网络操作由主机发起（§12.1） | 符合：主机推候选到检查机基础 clone | **部分不符**：主机推到 Gitea 是主机发起；但 runner 从 Gitea 拉候选是工作机发起的网络 Git 操作。可改为沿用主机推送到检查机基础 clone、流水线只在本地检出（保持字面符合，但少了一半简化） | 不符：合并、推送都经 Gitea | 不符：runner 从 GitHub 拉取 |
| 合并前不推外部平台（§12.1、M4） | 符合 | 符合：Gitea 在自己的机器上，不是外部平台（前提是只在局域网／tailnet 内开放） | 符合（同左） | **不符**：候选在合并前就推到 GitHub |
| 中心仓库是主机数据目录下独占的 bare 仓库（§12.1） | 符合 | 符合：中心仍是权威，Gitea 只是下游镜像 | **不符**：权威仓库移到 Gitea 数据目录，§12.5 的 `merge-tree`／`update-ref` 比较更新、发布锁、§12.7 的推送范围核对都要重做 | 符合（GitHub 只作执行入口） |
| 工作机和 Agent 不持有 Git 凭据、不能 push（§12.1、§14） | 符合 | 有条件：Agent 不建 Gitea 账号；main 和镜像分支设保护，只允许主机机器人账号推送；job token 能否限制为只读**待实测**（若不能，候选代码在 job 里拿到写权限，等同 Agent 可推送，必须否决） | 同左 | 有条件：仓库 `GITHUB_TOKEN` 默认改为只读；分支保护 |

需要改的原则（由人决定）：采用②镜像模式且让 runner 自己拉代码时，§12.1 第一条要改为“工作机不持有**写**凭据；CI runner 可凭按 job 签发的只读令牌，从本地 Gitea 镜像拉取候选”。采用 Gitea 取代中心仓库，要整体改写 §12.1、§12.5、§12.7。采用③，要改“合并前不推外部”。

### 3.2 §14 安全模型

| 要求 | ① | ② | ③ |
|---|---|---|---|
| Agent 没有推送权限 | 符合 | 见上表，取决于 job token 和分支保护 | 同② |
| Token 不进仓库 | 符合（检查配置在主机 `merge-gate.yaml`） | 符合，前提是流水线不用 secret；Gitea 机器人 Token、runner 凭据只放主机 | 同② |
| 检查命令由主机可信配置决定 | 符合：步骤列表在主机配置里；不过各步骤调用的 `package.json` 脚本本来就由候选控制 | **新风险**：Actions 默认从被测提交的 `.gitea/workflows/` 读流水线，Agent 可以在交付里改流水线（删步骤、改 `runs-on` 选到部署 runner）。必须用“可信流水线仓库”：流水线放在只有主机能写的独立仓库，用 `workflow_dispatch` 带 SHA 输入触发，再检出候选（可行性**待实测**） | 同②；GitHub 的组织级强制流水线是否适用本仓库套餐**待核实** |
| runner 能拿到哪些凭据 | 检查在 agent 账号下执行，白名单环境不含任何凭据；监督进程用 nonce + HMAC 防止检查进程伪造结果 | job token（默认权限**待实测**）；主机模式下 job 与 runner 进程同账号，可能读到 runner 的 `.runner` 凭据，冒充 runner 领取同范围的其他 job，因此要么用容器模式，要么给检查 runner 单独账号、单独作用域；结果由 Gitea 记录，job 无法伪造另一个 job 的状态，但能写自己的 commit status（权限**待实测**） | job 的 `GITHUB_TOKEN`；同样建议单独账号、临时（ephemeral）runner |
| 部署能力不交给 Agent（C-201） | 符合：监督器独立于 server，任何 Agent 无部署入口 | **主要风险**：目标主机上的部署 runner 能停起 server。只要任何候选流水线能选中它的标签，就等于候选代码可在合并前到目标主机执行。若采用部署 job，部署 runner 必须注册到只有主机能推的独立仓库，且仓库内只有主机维护的部署流水线 | 同② |

### 3.3 §15 D1（不依赖外部看板）

D1 的三条理由逐条看：

1. **数据只在控制面一处**：②③只把 Gitea／GitHub 当执行器，Card、Delivery、Review、检查记录仍只在 Cardigan，不需要同步层。符合。若 Gitea 取代中心仓库，Git 数据的权威位置移出控制面，但卡片数据不受影响，仍不算违背 D1 的字面，只是 §12 要改。
2. **端到端测试不依赖外部服务**：Cardigan 自己的单元／e2e 测试必须用测试替身替代 Gitea 客户端（端口放 domain 或 host，按 §20.2），不能要求测试环境起 Gitea。按这个设计可以符合；但**产品运行**多了一个外部依赖，这一点 D1 没有覆盖，由人决定是否接受。
3. **商业化不受上游约束**：Gitea、act_runner 都是 MIT，符合。GitHub 方案涉及平台服务条款和可能的计费，商业化时由用户自己的仓库承担，不随 Cardigan 分发。

结论：只用 Gitea 做 CI（和镜像托管）**不违背 D1 的理由**，D1 本身不必修改；但应在 §15 另记一条“CI 执行层是否依赖 Gitea”的决策（本 ADR 对应 D15，待决）。

## 4. 方案②的集成设计

### 4.1 权威仓库：中心 bare 仓库仍是权威，Gitea 是下游镜像

推荐镜像模式。理由：§12.5 的合并构造与比较更新、§12.7 的推送范围核对、C-201 的部署证据都以中心仓库为准，已有大量不变量和测试；Gitea 取代中心仓库等于重写这些部分，收益只是少一个仓库副本。

- 主机用 Gitea 机器人账号，在合并发布后把中心 `main` 推到 Gitea（复用 §12.7 的推送机制，Gitea 作为第二个推送目标或独立队列）；Gitea 的 `main` 设分支保护，只允许机器人账号推送，禁止强推。
- 候选分支用 `cardigan-candidate/<attempt_id>` 这样的普通分支名（Gitea 的推送事件只对分支和标签触发，`refs/cardigan/*` 自定义引用不触发也不一定能在 UI 显示，**待实测**），同样只有机器人账号能推；检查结束后由主机删除。
- Agent 没有 Gitea 账号，也不经 Gitea 交付；交付仍走 §12.3。

### 4.2 触发流水线和回传结果

- **触发**：推荐“推候选分支 + API 触发”。主机先推候选分支，再调用 `workflow_dispatch` API 触发**可信流水线仓库**里的检查流水线，输入 `attempt_id`、候选 SHA、tree SHA、范围（`docs_only／affected／full` 和受影响包）。流水线按输入的 SHA 检出候选并核对 tree，不读取候选里的 `.gitea/workflows/`。不推荐只靠候选分支的推送事件触发，因为那样用的是候选自带的流水线（见 §3.2）。`workflow_dispatch` API 的版本要求和跨仓库检出的认证方式**待实测**。
- **回传**：以“按 SHA 和 attempt 轮询”为准，Webhook 只用来提前唤醒轮询。可选的查询面：流水线运行和 job 的 Actions API，或流水线完成时用机器人账号给候选 SHA 写的 commit status（context 带 attempt_id）。具体用哪个，取决于 Gitea 当前版本 API 的完整度（**待实测**）。Cardigan 仍由 system 调用 `recordMergeCheck` 记录 queued → running → passed／failed／timed_out／interrupted，不变量 21 不变；Gitea 的结论只是输入，tree 仍由主机从候选提交读取并核对。
- **对应关系**：

  | Cardigan 概念 | Gitea 侧 |
  |---|---|
  | 检查 attempt（`attempt_id`） | 一次 `workflow_dispatch` 运行；输入里带 `attempt_id`，运行名也写它，便于反查 |
  | 执行位（`max_concurrent`、槽位锁） | runner 的 `capacity`；Cardigan 侧仍按 attempt 排队，只在“已派发未结束”数低于上限时派发，避免在 Gitea 里积压 |
  | 卡级检查（ADR 0004 `level=card`） | 同一流水线，输入 `level=card`，跳过 e2e 和不受影响的测试 |
  | 批次全量检查（`level=batch`，MB-n） | 主机在中心仓库叠加出批次最终提交，推为候选分支后触发 `level=batch`；二分探测是多个并行派发，每个前缀一个 attempt |
  | 单步／总超时 | 流水线的步骤和 job `timeout-minutes`，取值由主机生成或固定在流水线仓库；Cardigan 另设一个比它略长的兜底超时，超时后取消运行并记 `timed_out` |
  | C-116 只超时自动重跑一次 | 保留在 Cardigan：取回失败步骤日志，继续用 `merge-check-timeout.ts` 判定；取不到日志时不自动重跑 |
  | 日志链接 | 检查记录的 `log_ref` 改存 Gitea 运行页链接；Workbench 直接链接（需要人另外登录 Gitea）或由 server 代理拉取（需要机器人 Token 有读日志权限）。现有“日志仅主机可读”的要求要改写为“日志在 Gitea，按 Gitea 权限控制” |
  | 检查机不可达 | Gitea API 失败，或派发后在 N 分钟内没有进入 running（runner 离线），都按 `executor_unreachable` 处理，沿用 30 分钟 HumanAction |
  | 中断（server 重启） | 现在 server 重启会中断检查；改用 Gitea 后检查独立于 server 运行，重启后按 attempt 继续轮询即可，不再需要 interrupted 后重排 |

### 4.3 合并闸门的并存方式

在 `merge-gate.yaml` 的项目配置里增加执行器类型（例如 `executor: gitea`），与现有 `local`／`agent-ssh` 执行目标并列。按项目切换，切回只改配置并重启 server，见 §5。

### 4.4 自动部署：C-201 的能力怎么分

| C-201 能力 | 交给 Gitea deploy job？ | 说明 |
|---|---|---|
| 触发（main 前进后开始部署） | 可以 | 但必须核验证据，见下一行 |
| 证据核验（每段都有 `card_merged` 和同 tree 的 passed 检查，只接受快进） | **保留为 Cardigan CLI 步骤** | 依赖 Cardigan 数据库和中心仓库，Gitea 不知道这些规则 |
| 隔离 release 目录检出、`pnpm install --frozen-lockfile`、`pnpm build` | 可以 | 这是 job 最擅长的部分 |
| 构建先于停服（构建失败不停服） | 可以，用 job 步骤顺序表达 | |
| 停旧 server（核对 PID、boot/start ticks、UID、可执行文件、cwd） | **保留为 Cardigan CLI 步骤** | 精确进程身份核对是安全要求，不能交给通用脚本 |
| `packages/store` 变化时 `VACUUM INTO` 备份 | 保留为 CLI 步骤 | |
| ready 消息 + 两个回环端口核对、失败回滚 | 保留为 CLI 步骤 | job 只能调用 CLI；回滚依赖持久的已部署构建记录 |
| 角色升级手改保护、非扩权自动升级 | **保留在 Cardigan** | 规则独有 |
| PM Ops 轮换 | 保留在 Cardigan | |
| 停服前 Run 快照审计、`host_deployment_recorded`、HumanAction、通知 | 保留在 Cardigan | 审计必须写进时间线 |
| 部署与合并检查互斥（`host_deployment_capacity`） | 可以简化 | 互斥的原因是 server 重启会打断检查；检查改由 Gitea 执行后不会被打断，互斥可以去掉或只保留“不在批次发布中途停服” |
| 部署诊断（host_ops 只读投影） | 保留在 Cardigan，可附 Gitea 运行链接 | |

结论：deploy job 真正能替代的只有“触发 + 两条构建命令 + 步骤顺序”，其余都要写成 job 里调用的 Cardigan CLI 步骤，代码量基本不变；而目标主机上多一个能停起 server 的 runner，是 §3.2 列出的最大安全风险。**本 ADR 建议部署继续用 C-201 监督器，不迁到 Gitea job**；如果以后要用，部署 runner 必须注册到只有主机能写的独立仓库。

## 5. 迁移方案（以采用方案②镜像模式、部署不迁移为前提）

| 阶段 | 内容 | 回退方法 | 预计卡片 |
|---|---|---|---|
| 0 实测 | 在不影响正式环境的位置装 Gitea 和 act_runner，逐项验证本文所有“待实测”：job token 权限、`workflow_dispatch` API、跨仓库检出、commit status／Actions API、runner 离线识别、容器或独立账号隔离、`uses:` 外网依赖关闭、Gitea 版本选择 | 停掉并删除测试实例，不影响合并闸门 | 1 张，以文档和实测记录为主，不改产品代码；需要人确认安装位置 |
| 1 镜像 | 主机把中心 `main` 和候选分支推到 Gitea（机器人账号、分支保护）；新增 Gitea 客户端端口和测试替身 | 关闭镜像推送配置；Gitea 中的数据可以直接丢弃，中心仓库不受影响 | 1 张，中等（几百行加测试） |
| 2 双跑 | 现有执行器仍是唯一的合并依据；同一 attempt 另派发一次 Gitea 检查，只记录对比结果（结论是否一致、耗时），不写进 `recordMergeCheck`，在 Workbench 或诊断里展示差异 | 关闭双跑开关 | 1 张，中等。双跑会让检查机负载翻倍，需要按检查机容量限流，或只抽样部分 attempt |
| 3 切换 | 按项目把 `executor` 改为 `gitea`，结果写进 `recordMergeCheck`；旧执行器代码保留，可随时切回 | 改回旧执行目标、重启 server；进行中的 Gitea attempt 记为 interrupted 后按旧执行器重排 | 1–2 张，中等，含批次检查和二分探测的派发 |
| 4 清理 | 连续稳定运行一段时间（时长待人定）后删除第 1 节列出的执行层代码，同步改写 §12.2、§14 | 回退要靠 revert 提交恢复代码，代价较大，所以必须在阶段 3 稳定后再做 | 1 张，删除为主（删除量大，但新增少） |

合计约 5–6 张卡。阶段 0 结论不理想时停在阶段 0，退回方案①，已投入的只是实测时间。

与 C-201 的关系：C-201 按原计划收尾，不受影响。阶段 3 之后可另开一张小卡，按 §4.4 去掉或缩小 `host_deployment_capacity` 的互斥。

方案③如被采用，阶段相同，但阶段 0 必须先验证目标主机和检查机经代理访问 GitHub 的稳定性，并给出“GitHub 不可达时合并闸门怎么办”的降级方案（例如自动切回自研执行器），否则外网每次故障都会停掉合并。这个降级方案意味着自研执行层不能删除，方案③的主要收益随之消失。

## 6. 结论

### 推荐

**近期维持方案①，同时做方案②的阶段 0 实测（1 张卡）；部署无论如何继续用 C-201，不迁到 Gitea job；不采用方案③。**

理由：

1. Cardigan 的大部分合并代码是规则和编排，三个方案都要保留；通用执行层大约 2,000 行非测试代码，而且已经写完并在运行。换成 Gitea 的净删除量（§2 估计）不小，但同时要新增 Gitea 客户端、可信流水线仓库和一个需要备份、升级、保管凭据的服务。
2. 自研执行层里最复杂的部分（隔离账号、nonce/HMAC 防伪造、精确进程清理）是为满足 §14 写的。Gitea 的默认用法（流水线来自被测提交、job token、主机模式 runner）反而在这几处更弱，要靠可信流水线仓库、只读 token、容器或独立账号补回来，而这些能否成立正是“待实测”项。在实测前就决定迁移，等于用不确定的安全性换确定的代码删除。
3. 方案③让合并依赖外网和代理，且违反“合并前不推外部”，还可能涉及费用；可用性和原则上的代价都比②大。
4. 部署 job 能替代的只有触发和两条构建命令，却要在目标主机放一个能停起 server 的 runner，得不偿失。
5. 如果阶段 0 实测通过，方案②在后续需求上有真实收益（缓存、矩阵分片、成熟的日志界面，对应 P2a-13 D 组），届时按第 5 节阶段 1–4 推进。建议在拍板之前，P2a-13 D 组的缓存和分片暂不在自研执行层上开工，避免拍板后白做。

### 需要邵杰拍板的事项

1. **是否引入 Gitea**：是否同意先做阶段 0 实测（在哪台机器装、装完是否保留）；实测通过后是否进入阶段 1–4。
2. **权威仓库放哪**：中心 bare 仓库继续作为权威、Gitea 作为镜像（推荐），还是让 Gitea 取代中心仓库（需重写 §12.1／§12.5／§12.7）。
3. **是否修改 §12 的原则**：若允许 runner 自己从 Gitea 拉候选，§12.1“所有 Git 网络操作由主机发起”需改为“工作机不持有写凭据，可凭只读 job 令牌从本地镜像拉取”；或者保持原则，继续由主机推候选到检查机（简化幅度变小）。
4. **产品层面**：Cardigan 是否要求所有启用合并闸门的项目都接 Gitea。若仍要支持没有 Gitea 的项目，自研执行层不能删除，方案②只增加一种执行器，代码量和维护面都会增加。
5. **D1**：本 ADR 认为只用 Gitea 做 CI 不违背 D1，D1 不需修改；请确认，并确认在 §15 记为 D15（待决）。
6. **部署**：确认部署继续由 C-201 监督器执行，不迁到 Gitea／GitHub job。
7. 若仍考虑方案③：是否接受合并闸门依赖外网和代理、候选在合并前推到 GitHub，以及可能的 runner 费用（`spending` 类）。

### 待实测／待核实清单

- Gitea Actions 的 job token 默认权限、能否限制为只读；能否写 commit status。
- `workflow_dispatch` API 在所选 Gitea 版本是否可用；流水线放独立仓库、跨仓库检出候选的认证方式。
- Actions 运行／job 查询 API、`workflow_run` 类 Webhook 是否可用；日志下载 API。
- runner 离线识别方式和所需权限。
- act_runner 主机模式下 job 能否读到 runner 凭据；检查机能否用容器模式；容器模式下 pnpm 缓存、e2e 浏览器依赖如何准备。
- 关闭 `uses:` 默认外网拉取的配置方式。
- 推送 `refs/cardigan/*` 自定义引用到 Gitea 的行为。
- 检查机经代理访问 GitHub 的稳定性；GitHub 私有仓库 self-hosted runner 的计费现状；组织级强制流水线是否适用。
- 双跑期间的检查耗时对比（本 ADR 不给任何数字）。
