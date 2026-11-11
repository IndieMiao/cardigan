# P2a-12 合并检查派到远程 CI 机器执行

- 对应：`docs/plans/phase-2.md` §2 P2a 表新增一行 P2a-12（本计划新增，指向本文件）；背景是 P2a-1 合并闸门（`docs/plans/p2a-1-merge-gate.md`）落地后，合并前的 install/build/test/lint/deps/e2e 检查和开发 Agent 的 Run 抢主机 主机 的 CPU（P2a-9 试行发现 35 的同一类负载问题，只是这次主角换成合并检查而不是并发 Run）。
- 拍板（用户 2026-11-11）：在另一台 Windows 11 专业版 PC 上建一台 Hyper-V Ubuntu Server 24.04 虚拟机（12 vCPU、24GB 固定内存，常开，Hyper-V 默认交换机 NAT + VM 内装 Tailscale，主机名 `cardigan-ci`），专门跑合并检查；开发 Agent 的 Run 仍留在 主机，不搬。Windows/Hyper-V 侧的建机、分配资源、装 Tailscale 由用户自己做，不在本计划范围。
- 开发方案要改的章节（本计划只做拆分，不改正文；实现 PR 合并后由 Claude 按各 PR 描述统一回填）：§12.2（布局与命名，新增远程执行目标的目录约定）、§12.5（合并检查小节，补执行目标选择）、§12.6（清理与对账，补远程目录的扫描方式和 C-67 的跨机器适配）、§13.1（配置文件，`merge-gate.yaml` 新增 `executors`/`executor` 字段）、§14（安全模型表，新增"远程检查机"一行）、新增一小节到 §12 说明"检查执行目标"与"Agent 工作机"是两件不同的事。
- 前提：P2a-1 合并闸门已合并（326d209 之前的历史提交已落地，`packages/host/src/temporary-checkout.ts`、`apps/server/src/merge-checks.ts` 已存在）；P2a-9 全机并发上限已合并（`packages/host/src/run-capacity.ts`、`run-capacity-config.ts` 已存在）。本计划不依赖 P2a-10（主机运维角色）。

## 代码现状核实（2026-11-11 调查，带文件:行号）

1. **SSH 目的地硬编码**：`packages/runtime-herdr/src/agent-ssh.ts:9-32` 的 `sshArguments()` 固定拼出 `-o HostKeyAlias=cardigan-agent-local` 和目标 `agent@localhost`；`ExecutionConfig` 的 `agent-ssh` 模式（`packages/runtime-herdr/src/execution.ts:29-39`）完全没有 `host`/`port` 字段，`resolveExecutionConfig()`（同文件 :52-96）从环境变量 `CARDIGAN_AGENT_ROOT`/`CARDIGAN_AGENT_GID`/`CARDIGAN_AGENT_MACHINE`/`CARDIGAN_AGENT_IDENTITY`/`CARDIGAN_AGENT_KNOWN_HOSTS` 读取，产出**唯一一份**执行配置。换句话说，今天的 `agent-ssh` 模式是"SSH 到同一台机器上的隔离账号 `agent`"，不是真正的多机——它解决的是账号隔离，不是算力隔离。
2. **合并检查和开发 Agent 的 Run 共用这一份配置**：`apps/server/src/server.ts:96-101` 解析出唯一的 `execution`，之后同时传给 `ServerGit`（:130，给开发 Agent 的 worktree 同步、交付验证用）和 `startControlPlane` 的 `mergeGate: { configuration: mergeGate, execution }`（:195，给合并检查用）；`apps/server/src/merge-checks.ts:61-64` 的 `MergeCheckOptions.execution: ExecutionConfig` 是单值，不按项目区分。这正是用户要切的那条耦合：目前没有"合并检查单独用另一份执行配置"的入口。
3. **候选怎么到执行目标**：`apps/server/src/git.ts:354-391` 的 `distribute()` 把中心仓库的候选 ref 同步到 `execution` 对应的基础 clone；agent-ssh 模式下调用 `this.transport.pushBaseline(source, repository, agentReceivePack(execution, repository))`（:378-382），receive-pack 入口固定走 `packages/runtime-herdr/src/agent-ssh.ts:122-148` 的 `agentPack()`，同样绑定同一份 `execution`。候选 ref 前缀是 `refs/cardigan/candidates/<assignment_id>/<subject>`（`apps/server/src/git.ts:433`，`apps/server/src/m4-reconcile.acceptance.test.ts:85` 的测试同样印证）。`transfer()` 里有一条关键注释（`apps/server/src/git.ts:375-379`）：**"已接受的 Git 投递已经有一个基础 clone；如果它消失，这次尝试直接失败，主机永不以自己的身份重建 Agent 仓库"**——意味着远程机器上每个项目的基础 clone 必须由操作员预先手动建好（`git init --bare`），主机不会自动创建。
4. **合并检查占用并发名额，但账本写死 `'local'`**：`packages/host/src/run-capacity.ts:19-20` 定义 `MERGE_CHECK_RUN_SLOTS = 2`，`:74-79` 把运行中的检查数乘 2 累加到 `occupied.set("local", ...)`；底层 `packages/host/src/merge-check-capacity.ts:44`、`:61` 的 SQL 把 `machine_id` 写死成字符串 `'local'`。`packages/host/src/run-capacity-config.ts` 的 `run-capacity.yaml` 已经支持按机器名配额（`machines` 映射，§P2a-9），但那是给开发 Agent 的 Run 用的，和合并检查的 `'local'` 硬编码账本是两套互不相干的东西。
5. **对账扫描是本机文件系统调用，不是 SSH**：`packages/git-service/src/index.ts:126`（`readdir`）和 `:502-544`（`checksRoot` 扫描）直接用 Node 的 `readdir` 读 `<agentRoot>/checks/<project>/` 目录。今天能这样做，是因为 agent-ssh 模式下 `agent` 账号和主机账号在**同一台机器、同一块磁盘**上，靠共享组权限（§12.2 的 2750/2770/0660/0770）互相可读；换成真正独立的远程虚拟机后，主机进程读不到对方磁盘，这里必须改成经 SSH 执行列目录命令，是一处确认存在但代码里还没有的缺口。
6. **C-67 对账的 queued/running 保护**（`docs/development-plan.md:1606`）：按项目和 attempt 的精确路径识别合并检查目录，`queued`/`running` 不报孤儿或失效登记；结束后等 `CARDIGAN_CHECK_CLEANUP_GRACE_MS`（默认 600000ms）才报残留。这条逻辑由 Store 里的事件驱动，不依赖目录扫描方式，远程化后不用改这部分判断，只需要改"怎么拿到目录列表"这一步（见第 5 点）。
7. **检查日志的"取回"其实已经是流式的**：`packages/host/src/checkout-worker.ts` 里的 `emit()`（文件开头 `emit = value => process.stdout.write(...)`）把结果通过 SSH 会话的 stdout 实时传回调用方；主机侧消费这条流并落盘（`apps/server/src/merge-checks.ts` 的 `onOutput`）。这意味着"日志怎么从远程取回"不需要新机制——SSH 本身就是传输通道，换成真正远程主机后行为不变，只是网络延迟变大。

## 1. 目标

1. 新增一个独立于"开发 Agent 执行目标"的"合并检查执行目标"配置维度：缺省仍是今天的本机/本机隔离账号行为，向后完全兼容；项目可以显式指定把合并检查送到 `cardigan-ci` 这台远程机器。
2. 候选代码和检查命令的传输方式沿用现有"主机发起 SSH"的原则（§12.1），不让远程机器反向访问中心仓库或持有任何 Git 凭据。
3. 远程机器的并发占用单独计费，不挤占 主机 给开发 Agent 的 Run 预留的并发名额（P2a-9）。
4. 远程机器离线或网络故障时，合并检查排队等待而不是静默回退到本机抢 CPU（具体退避策略见 §2.6，含一个需要用户拍板的点）。
5. 对账（C-67）在远程目标下依然成立：不会把一个正在远程机器上跑的检查误报成孤儿。

## 2. 关键设计

### 2.1 配置：`merge-gate.yaml` 新增 `executors`

- 顶层新增一个可选的 `executors` 映射（`packages/host/src/merge-gate-config.ts` 的顶层 `only(raw, ["projects"])` 需要放宽成 `["projects", "executors"]`），每个执行目标是一个具名条目：

  ```yaml
  executors:
    cardigan-ci:
      host: cardigan-ci          # 必填，SSH 目标主机名（Tailscale 名或内网名，不写公网 IP）
      port: 22                   # 可选，默认 22
      user: agent                # 可选，默认 agent
      identity_file: ssh/cardigan-ci.key        # 必填，相对数据目录，复用 merge-push-config.ts 的路径安全校验（§12.7 同款：绝对路径拒绝、越出数据目录拒绝、文件须主机独占 0600）
      known_hosts_file: ssh/cardigan-ci.known_hosts  # 必填，同上
      host_key_alias: cardigan-ci   # 可选，默认等于 host；写进 known_hosts 的别名，防止换绑 IP 后悄悄换机器
      agent_root: /srv/cardigan-agent   # 远程机器上的执行根（基础 clone、worktree、checks 目录的父目录）
      max_concurrent: 1          # 可选，默认 1；该执行目标自己的并发上限（见 §2.5）
  projects:
    cardigan:
      executor: cardigan-ci      # 可选；缺省值 "local"，即今天的行为（不读 executors，直接用服务启动时解析的 execution）
      checks: [...]
  ```

- `executor: "local"`（或不写）精确对应现状：`ProjectMergeGate` 不携带任何执行目标信息，`MergeChecks` 用服务启动时解析的那一份 `execution`（第 2 点的现状）。`executor` 引用一个不存在的 `executors` 条目时整项目闸门判为 `invalid`（走现有 `projectConfig` 的 `invalid()` 路径），不是静默回退本机——静默回退会让用户以为检查已经搬走，实际还在 主机 抢 CPU。
- `ProjectMergeGate` 的 `enabled` 分支新增可选字段 `executor?: ExecutionConfig`（已解析好的，不是字符串名字），由 `loadMergeGateConfig` 统一解析 `executors` 块一次、校验失败的目标名在校验阶段报告，不在运行时才发现。
- 不新建 `agent-machines.yaml` 或类似的第二份配置文件：执行目标和"用哪些检查"本来就是合并闸门自己的配置范畴，放一起改动面最小，也避免和 P2a-9 的 `run-capacity.yaml`（管开发 Agent 的 Run 并发，语义不同）混在一起。

### 2.2 `agent-ssh` 去掉 localhost 假设

- `packages/runtime-herdr/src/execution.ts` 的 `agent-ssh` 分支新增可选字段 `host?: string`、`port?: number`、`user?: string`、`hostKeyAlias?: string`；四者都不传时，默认值分别是 `"localhost"`、`22`、`"agent"`、`"cardigan-agent-local"`——和今天**逐字节一致**，`resolveExecutionConfig(env)` 解析出的开发 Agent 执行配置完全不变，不读这几个新字段（环境变量侧暂不开放，只有 merge-gate 的 `executors` 配置会填它们）。
- `packages/runtime-herdr/src/agent-ssh.ts` 的 `sshArguments()` 把硬编码的 `"HostKeyAlias=cardigan-agent-local"` 和 `"agent@localhost"` 换成 `` `HostKeyAlias=${config.hostKeyAlias ?? "cardigan-agent-local"}` `` 和 `` `${config.user ?? "agent"}@${config.host ?? "localhost"}` ``，并在构造 ssh 命令数组时按需插入 `-p`/`-o Port=`。`StrictHostKeyChecking=yes`、`IdentitiesOnly=yes`、`BatchMode=yes` 等现有安全参数原样保留，不因为是"真远程"就放宽。
- `checkAgentFiles()`（同文件）校验身份文件/known_hosts 文件权限的逻辑不用改——合并闸门侧传进来的 `identityFile`/`knownHostsFile` 走同一套 `lstat` 校验。
- 这一步做完之后，`agentSshCommand`/`agentProcessCommand`/`agentReceivePack`/`agentUploadPack` 对"目标是 localhost 的隔离账号"还是"目标是 `cardigan-ci`"完全无感——这是本设计刻意保持的性质：**不新造一套远程执行通道，只是把现成的 agent-ssh 通道的目标从硬编码变成可配置**。

### 2.3 候选代码怎么到远程机器

- 不新增传输机制：`apps/server/src/git.ts` 的 `distribute()`/`transfer()` 已经是"用传进来的 `execution` 决定基础 clone在哪里、receive-pack 入口怎么调"；本计划让它能接受一个**调用方指定的 `execution` 覆盖**（新增可选参数，默认仍用 `ServerGit` 构造时的那一份，开发 Agent 路径不受影响），`MergeChecks` 在要跑某个项目的检查前，用该项目 `ProjectMergeGate.executor`（有则用它，没有则用默认）调用 `distribute(project, executorOverride)`。
- 候选 ref 前缀不变，仍是 `refs/cardigan/candidates/<assignment_id>/<subject>`；远程机器上的基础 clone 路径规则和本机一致：`<agent_root>/repos/<project>`。
- 远程机器**不持有任何 Git 凭据、不能反向访问中心仓库**：主机到远程的 SSH 是单向的（主机发起 upload-pack/receive-pack），remote 账号的 `~/.ssh` 下不放任何指向主机或 GitHub 的密钥；§12.7 的外部推送（deploy key）继续只在主机数据目录，不同步到远程。
- 和 §12.1"所有 Git 网络操作由主机发起"完全一致，只是把"发起到哪"从 localhost 换成 `cardigan-ci`，原则不变。

### 2.4 远程机器的目录布局、依赖缓存、清理和对账

- 目录布局照抄现有 agent-ssh 约定（§12.2），只是物理上搬到另一台机器：基础 clone `<agent_root>/repos/<project>`、检查容器 `<agent_root>/checks/<project>/<attempt>`。`CHECKOUT_WORKER`（`packages/host/src/checkout-worker.ts`）是作为内联脚本通过 SSH 会话 `node -e` 执行的（`packages/host/src/temporary-checkout.ts:92-100` 的 `worker`/`command` 构造），这段代码**目标无感**：SSH 连到哪台机器，它就在哪台机器上跑、在哪台机器上清理自己的 attempt 目录，§2.2 做完之后这部分不用改一行。
- 依赖缓存（pnpm store）、Playwright 浏览器缓存：和现状一样，放在执行账号自己的配置目录下（`~agent/.local/share/pnpm`、`~agent/.cache/ms-playwright` 之类），**不随每次检查的临时容器一起清理**，只在初始化时装一次（见 §3）；本计划不改变"缓存属于账号持久状态"这条约定。
- 清理：检查结束（通过/失败/超时/取消）照常由 `CHECKOUT_WORKER` 自己删除 attempt 目录，和本机场景一样"用后就地清理"，不依赖对账。
- 对账（C-67）**需要改的部分**：`packages/git-service/src/index.ts` 扫描 `checksRoot` 目前是直接 `readdir` 本机目录（现状第 5 点）。远程目标下主机进程读不到对方磁盘，必须把这一步换成"通过该执行目标的 SSH 通道跑一次只读列目录命令"（例如 `find <agent_root>/checks -mindepth 2 -maxdepth 2 -type d`），结果按现有逻辑继续和 Store 里的 queued/started/finished 事件比对，`CARDIGAN_CHECK_CLEANUP_GRACE_MS` 的宽限期判定不变。这是本计划里**对现有热路径改动最大的一块**，单独拆一张卡（见 §4 PR C），且要覆盖"远程不可达时对账怎么表现"（不应该把"连不上"报成"孤儿"或"失效登记"，应该是独立的第三种诊断，见 §2.6）。
- 不强求统一本机扫描也走 SSH：本机/本机隔离账号场景保留现有 `readdir` 路径（避免引入不必要的性能回归和风险），只有配置了非 `local` executor 的项目才走新的 SSH 列目录分支。

### 2.5 并发名额：按机器分开计，不占 主机 的名额

- `packages/host/src/merge-check-capacity.ts` 的 `machine_id` 从硬编码 `'local'` 改成按实际执行目标传入（`'local'` 或 executor 名字，如 `'cardigan-ci'`），`executionOwner()` 的 PID/启动时间核对逻辑不变（远程目标下这个 PID 是**主机侧 ssh 客户端进程**的 PID，不是远程机器上实际跑检查的进程——这一点和今天 agent-ssh 模式完全一样，`executionOwner` 本来就只认本机的 ssh 客户端进程，不需要改）。
- `packages/host/src/run-capacity.ts` 的 `runCapacitySnapshot()` 不再把所有正在跑的合并检查都累加到 `occupied.set("local", ...)`，改成按各自的 `machine_id` 分别累加；`MERGE_CHECK_RUN_SLOTS = 2` 的含义（"一次检查按 2 个名额算"）对远程目标同样适用，但它计入的是远程目标**自己的**配额桶，不混进 主机 的 `run-capacity.yaml` `machines` 配额（那份配置管的是开发 Agent 的 Run，语义上不该被合并检查抢）。
- 远程目标自己的并发上限来自 §2.1 `executors.<name>.max_concurrent`（默认 1——12 vCPU 的机器先保守，一次只跑一个检查，避免一次 e2e 就把 CPU 吃满导致下一个排队的检查也变慢；用户如果实测 12 vCPU 够跑 2 个可以调大，不是本计划预设的硬限制）。
- 不做"多台 CI 机器之间调度"：`executors` 是一个映射，天然支持以后加第二个远程目标，但本计划只配一个 `cardigan-ci`；`MergeChecks` 选执行目标的逻辑是"项目→executor 名字"的静态映射，不做负载均衡，不设计抢占，接口形状不堵死未来加调度，但调度本身不在本计划范围。

### 2.6 失败和不可达

- SSH 连接失败（网络不通、远程机器关机、host key 不匹配等）时，**不回退到本机执行**：回退会悄悄引入"合并检查又在和开发 Agent 抢 CPU"的旧问题，而且用户当下不会知道这次检查其实没有被隔离。检查记录进入一个新的终止状态（建议命名 `executor_unreachable`，区别于 `failed`/`timed_out`，因为它不是代码问题，不该被当成"这棵候选树有问题"而卷入 §12.5 "同树重算复用通过/失败记录"的判断逻辑）。
- 具体行为建议（**标为拍板点，见 §7**）：连接失败时先按 §12.7 已有的网络退避节奏（1、2、4、8、16、30 分钟，上限 30 分钟）重试连接；候选继续停在 `queued`，不消耗排队位次之外的东西；超过某个阈值（建议 30–60 分钟，复用 §12.7"连续失败超过两小时建一条未决事项"的思路但缩短，因为合并检查卡住会直接堵住后续要合并的卡片）后，创建一条不阻塞工作项的项目级 Needs You 事项，提示"远程检查机 `cardigan-ci` 不可达，合并检查排队等待中"；恢复后自动继续，不需要人手动重排。
- 拍板点本身：是否允许人在 Needs You 里手动选择"这次临时回退本机跑"作为应急开关？本计划倾向于**不提供**这个开关（一旦存在，迟早在远程机器临时离线时被当成默认选项用，隔离语义名存实亡），但这是产品取舍，列进 §7 等用户确认。
- 事件：新增一条项目级事件记录"executor_unreachable 开始/恢复"，复用 §12.7 现成的"创建不阻塞工作项的 HumanAction"模式，不新造一套通知机制。

### 2.7 安全

- 远程机器只运行候选代码：`agent` 账号没有 sudo、没有 Git 凭据（§12.1 原则不变，只是执行主体换了物理机器）、不能访问 主机 的数据目录（SSH 是主机→远程单向，没有反向路径）。
- Tailscale 访问控制建议（操作建议，不是代码变更）：给 `cardigan-ci` 配 Tailscale ACL，只允许 主机的 tailnet 节点连它的 22 端口；其余端口不对外，远程机器不需要开任何入站端口给其他设备。
- 检查日志：如现状第 7 点，SSH 会话本身就是传输通道，不需要新的"取回"步骤；日志落盘仍在主机数据目录，和本机场景一样走脱敏（`packages/host/src/check-environment.ts` 的白名单环境不变）。

## 3. 远程机器初始化清单（主机操作员 Claude 通过 SSH 执行）

Windows/Hyper-V 侧的建机、分配 vCPU/内存、装 Tailscale 由用户自己做；以下是虚拟机装好、Tailscale 能连通之后，在 Ubuntu Server 24.04 内部要做的事：

1. 建隔离账号：`useradd -m agent`（或项目既有约定的账号名），按 §12.2/§14 的权限方案建好共享组和目录权限（2750/2770/0660/0770），和本机 agent-ssh 账号的权限模型保持一致，以便复用 `checkAgentFiles`/`secureDataDirectory` 现有校验不用改。
2. SSH 授权：只把主机的公钥加进 `~agent/.ssh/authorized_keys`；不接受密码登录、不接受其他来源的公钥；远程机器自己不持有能连回主机或 GitHub 的任何密钥。
3. Node/pnpm 版本：用 corepack/nvm 固定版本号，和主机当前使用的版本对齐（写进 `cardigan-deploy` 的机器清单，不写进 `cardigan` 仓库——按 §20 仓库规划，环境相关内容本来就该放那边）。
4. Playwright 依赖：在 `agent` 账号下跑一次 `pnpm exec playwright install --with-deps`（如果项目的 e2e 检查用到浏览器），缓存落在账号自己的目录，长期复用。
5. 基础 clone：对每个要跑在这台机器上的项目，在 `agent` 账号下 `git init --bare <agent_root>/repos/<project>`——现有代码明确拒绝主机以自己的身份重建 Agent 仓库（§"代码现状核实"第 3 点），这一步必须手动做，漏了会导致第一次 `distribute()` 直接失败。
6. 磁盘清理定时任务：`<agent_root>/checks/` 下的 attempt 目录理论上用后即删（§2.4），但给一条保底的 `crontab`（例如每天凌晨删除 mtime 超过 3 天且不在当前 Store 登记里的残留目录）防止异常退出积累垃圾；这条是运维保底，不替代 C-67 对账。
7. 实测：从主机手动跑一次 `ssh -F /dev/null -i <identity> -o StrictHostKeyChecking=yes -o UserKnownHostsFile=<known_hosts> -o HostKeyAlias=cardigan-ci agent@cardigan-ci whoami`，确认 host key 固定、身份正确，再把 `known_hosts_file` 配进 `merge-gate.yaml`。

## 4. 拆卡（按顺序）

| PR | 分支 | 内容 | 依赖 | 预估规模 |
|---|---|---|---|---|
| A | `feat/p2a-12a-agent-ssh-remote-target` | `packages/runtime-herdr` 的 `ExecutionConfig`/`agent-ssh.ts` 去掉 localhost 假设（§2.2）；只改底层通道，不接入 merge-gate；单元测试覆盖"不传新字段时生成的 ssh 参数和今天逐字节一致"与"传了 host/port/user/hostKeyAlias 时参数正确" | — | 小，~100 行 |
| B | `feat/p2a-12b-merge-gate-executors` | `merge-gate.yaml` 新增 `executors`/`executor` 字段（§2.1）：`packages/host/src/merge-gate-config.ts` 解析与校验，复用 `merge-push-config.ts` 的凭据路径安全校验模式；只做配置解析，暂不接入运行时 | A | 中，~150-200 行 |
| C | `feat/p2a-12c-merge-checks-remote-dispatch` | `apps/server/src/git.ts` 的 `distribute()` 支持执行目标覆盖；`apps/server/src/merge-checks.ts` 按项目选执行目标（§2.3）；`packages/git-service` 的对账目录扫描改为按执行目标走 SSH 列目录或本机 `readdir`（§2.4）——这是改动面最大的一张，如果超长按"分发逻辑"和"对账扫描"再拆成两张 | B | 大，视情况拆分 |
| D | `feat/p2a-12d-remote-capacity` | 并发名额按机器分桶（§2.5）：`merge-check-capacity.ts`/`run-capacity.ts` 去掉 `'local'` 硬编码 | C | 小，~80-120 行 |
| E | `feat/p2a-12e-remote-unreachable` | 不可达处理（§2.6）：新终止状态 `executor_unreachable`、退避重试、Needs You 事项 | C、D | 中 |

每张卡控制在几百行以内；PR C 如果明显超长，先落地"分发到指定执行目标"，对账扫描单独开一张卡。

## 5. 测试清单

- 单元/契约测试：
  - A：agent-ssh 参数生成的向后兼容性（不传新字段 = 今天的硬编码值）；传入远程 host/port/user/hostKeyAlias 时参数正确、`StrictHostKeyChecking=yes` 等安全参数不受影响。
  - B：`merge-gate.yaml` 的 `executors` 块校验——缺字段、路径越出数据目录、`identity_file` 权限不对、`executor` 引用不存在的名字，均判为 `invalid` 而不是静默回退 `local`；不配置 `executors`/`executor` 时解析结果和改动前完全一致（回归）。
  - C：`distribute()` 传入执行目标覆盖时推送到对应的基础 clone 路径，不影响默认（开发 Agent 用的）那份 `execution`；对账扫描在"本机 executor"下仍用 `readdir`（回归），"非本机 executor"下用模拟的 SSH 列目录结果，正确区分孤儿/失效登记/不可达三种情况。
  - D：同一台机器多个项目共享一个 executor 时并发计数正确；不同 executor 的占用互不影响；主机 的 `run-capacity.yaml` `machines` 配额不被合并检查消耗。
  - E：模拟 SSH 连接失败 → 进入 `executor_unreachable` → 退避重试 → 恢复后继续检查；长时间不可达触发 Needs You 事项；事项在恢复后能被观察到自动失效（参照 §12.7 网络失败恢复后取消未决事项的现成模式）。
- 验收测试（不依赖真实远程机器）：用本机第二个 SSH 目标模拟"远程"——复用现有 agent-ssh 测试基建里"本机再建一个账号/目标"的方式（参照 `packages/runtime-herdr/src/agent-ssh.test.ts`、`packages/host/src/temporary-checkout.test.ts` 已有的 agent-ssh 测试夹具，只是把目标名字和端口换成第二个假执行目标，不需要容器或虚拟机）；验收场景：候选推到"远程" executor 的基础 clone → 检查在该 executor 下跑完 → 对账能正确识别 queued/running 的远程检查不是孤儿 → 主机 的并发名额不受影响。
- 改了 `packages/domain`（包括测试文件）照常跑 `pnpm --filter @cardigan/domain test:types`；本计划大部分改动在 `packages/host`/`packages/runtime-herdr`/`apps/server`，预计不碰 `packages/domain`，如果某张卡确实touch 到（例如新事件类型落进 domain 的事件 schema），该卡要补这一步。

## 6. 上线步骤（Claude 负责）和回退

1. PR A-E 按顺序合并，期间 `cardigan` 项目的 `merge-gate.yaml` 不配置 `executors`/`executor`，行为和今天完全一样（每张卡落地后都应该能独立验证"不配置就是现状"）。
2. 用户在 Windows/Hyper-V 侧建好 `cardigan-ci` 虚拟机、装好 Tailscale 后，Claude 按 §3 清单通过 SSH 完成初始化。
3. Claude 在主机数据目录下放好 `identity_file`/`known_hosts_file`（0600，和现有 agent-ssh 凭据同等保护级别），跑一次 §3 第 7 步的手动校验。
4. 先给 `cardigan` 项目本身的合并闸门配置 `executor: cardigan-ci`（自举：用 Cardigan 验证 Cardigan 的合并检查搬去远程机器），观察几次真实合并检查，确认通过/失败/超时都能正确回传、主机 负载确实下降。
5. 观察期内如果远程机器不稳定（频繁 `executor_unreachable`、检查明显比本机慢很多倍），回退办法：把该项目 `merge-gate.yaml` 的 `executor` 字段删掉或改回 `local`，下一轮合并检查立即回到本机执行，不需要重启服务、不需要动代码；这是本设计特意保留的"配置降级"路径。
6. 每一步更新 memory 和开发方案对应章节（§12.2/§12.5/§12.6/§13.1/§14）。

## 7. 需要用户拍板的点

1. **远程不可达时是否提供"临时回退本机"的人工开关**（§2.6）：本计划建议不提供，倾向于"宁可排队等待也不悄悄抢 CPU"；如果用户认为"合并被完全卡住"比"偶尔抢一下 CPU"更糟，需要明确要这个开关，并接受它可能被习惯性使用从而削弱隔离效果。
2. **不可达升级为 Needs You 的阈值**（§2.6 建议 30–60 分钟）：这个数字影响"用户多久会被打断一次"，建议用户确认或调整。
3. **远程机器的默认并发上限 `max_concurrent: 1`**（§2.5）：12 vCPU 是否足够同时跑 2 个检查需要实测后再放宽，本计划先保守设默认值，用户如果有更明确的预期可以直接拍板一个不同的默认值。
4. **是否现在就把 `cardigan` 项目自身的合并检查切过去**（§6 步骤 4）：这是"自举"的一部分，涉及"拿正式项目的合并流程做实验"，按 AGENTS.md 的合并授权，常规 PR 合并 Claude 可以自行决定，但"把生产合并检查切到一台新机器上"属于范围变化/风险取舍，列进拍板点稳妥一些。


**用户 2026-11-11 拍板结果**：
1. 远程不可达：排队等待并退避重试，**不自动回退本机，也不提供临时回退开关**；连不上超过 **30 分钟**升级到 Needs You。
2. 远程机器默认并发上限 **1**，实测单次检查的耗时和内存峰值后再调。
3. 验收通过后**马上把 cardigan 项目自己的合并检查切到 CI 虚拟机**：先用一张卡试跑对比结果，一致就切换；回退方式是把配置改回 local。
4. CI 虚拟机：Windows 11 专业版上的 Hyper-V Ubuntu Server 24.04，12 vCPU、24GB 固定内存、常开，默认交换机 NAT，虚拟机内装 Tailscale。

## 8. 已知风险

- 对账扫描从本机 `readdir` 改成按执行目标走 SSH 列目录（§2.4、PR C），是现有热路径里改动面最大、也最容易引入"误报孤儿/误删正在跑的检查"风险的一块；需要在实现卡里补充"SSH 列目录失败时的行为"（应该和检查本身的不可达一样处理，不能被误判为"目录真的不存在"）。
- 远程机器的网络延迟会拉长 SSH 往返，`checkAgentFiles`、候选分发、检查完成后的收尾都可能比本机慢；§2.1 的超时字段（`total_timeout_minutes`）大概率需要给远程 executor 单独调大默认值，本计划没有预设具体数字，留给实现时按实测调整。
- 首次在远程机器上建基础 clone（§3 第 5 步）是纯手工步骤，漏做或项目增删时忘记同步会导致该项目的合并检查一直 `executor_unreachable` 式失败（严格说是"基础 clone 缺失"，和真正的网络不可达是两种不同原因，§2.6 的终止状态设计需要把两者区分清楚，不能都归成一类，否则排查时无法分辨是网络问题还是没建仓库）。
- `executors` 配置复用 `merge-push-config.ts` 的凭据路径安全校验模式，但那套校验是为"外部推送的 deploy key"设计的，字段含义和威胁模型略有差异（推送密钥是写权限、这里的 identity_file 是登录远程执行账号），复用时要重新过一遍 §14 的安全表，不能想当然照搬。
