# Agent 专用账号（M2.7）

Linux 安装前先阅读 [ADR 0002](../docs/adr/0002-agent-account-isolation.md)。脚本会配置 agent 账号、专用组/SSH 密钥、hc 0.1.21 和私有/共享目录。它不会修改 `~/.ssh/config` 或 sshd 全局配置。

```sh
python3 deploy/install-agent.py --host-user <主机用户名> \
  --data-dir /srv/cardigan/data --agent-root /srv/cardigan-agent --dry-run

sudo python3 deploy/install-agent.py --host-user <主机用户名> \
  --data-dir /srv/cardigan/data --agent-root /srv/cardigan-agent --check

sudo python3 deploy/install-agent.py --host-user <主机用户名> \
  --data-dir /srv/cardigan/data --agent-root /srv/cardigan-agent
```

前置条件：Python 3、sudo、openssh-server、ssh-keygen、ACL 工具（setfacl）、useradd/groupadd/usermod/passwd/runuser/install；主机 home 必须禁止其他用户遍历。共享组使用 `cardigan-share`，避免与已有测试账号的主组重名。脚本不安装缺失的系统包，不替用户放宽或改写 SSH 认证策略。不匹配的现有 agent 账号会被拒绝，避免误接管。

`--dry-run` 只打印计划；`--check` 用 sudo 执行完整的只读前置检查（含组成员/主组占用、sshd 策略和主机公钥、home 权限、命令可用性、路径和归档校验），通过后退出，不创建账号、目录或密钥。正式安装执行同一套检查，全部通过后才开始首次写操作。

网络不可用时可提供 `--archive <hc归档路径>`，摘要仍必须匹配固定版本。校验不通过不安装二进制。

完成后，主机重新登录以取得共享组身份，启动 server 前执行脚本打印的 runtime.env 加载命令；Cardigan CLI 推荐用下文的安装脚本安装，由生成的命令加载配置。模型 CLI 需另装到 agent 可执行的目录，模型凭据通过启动配置按需注入；不要复制主机的整个 HOME 或 SSH 目录。

重复执行时保留专用私钥、复用托管账号和组，重设托管目录/授权文件的权限并验证 hc。工作区内容不会被递归清理。前置检查失败不做安装改动；真正执行系统命令时的 IO 失败或新建账号后的复核失败仍可能留下部分托管状态，可修正原因后用相同参数重跑。

本 PR 不执行 sudo。用户安装后再验证：agent 无 sudo、不能访问主机 home 和 Cardigan data；专用密钥可从 localhost 登录，其他密钥不能登录；agent-ssh 启动的终端 UID 为 agent；token/secrets 只由主机和 agent 读取并在启动后删除。


## 安装 cardigan 命令

在主机用户的 Cardigan 仓库中构建 CLI，再运行无需 sudo 的安装脚本：

```sh
pnpm exec tsc -b apps/cli
deploy/install-cli.sh --dry-run
deploy/install-cli.sh
export PATH="$HOME/.local/bin:$PATH"
cardigan --help
```

脚本默认在 `~/.local/bin/cardigan` 写入可执行包装命令，调用脚本所在仓库的 `apps/cli/dist/bin.js`；主机 PATH 中需要有 Node.js 24。将安装目录加入 shell 的 PATH 后，Workbench 复制的命令即可直接使用。脚本不会修改 shell 配置；仓库更新后重新构建 CLI，仓库移动后重新安装。

可用 `--bin-dir <目录>` 更改安装目录、`--repo <已构建的仓库>` 指定仓库、`--runtime-env <文件>` 指定配置。默认配置为 Agent 安装器生成的 `~/.config/cardigan/agent-ssh/runtime.env`；相对路径在安装时解析。`--dry-run` 检查目标并打印生成内容，不创建或覆盖文件。生成命令第二行固定为 `# cardigan: managed by deploy/install-cli.sh`；已有普通文件仅在第二行以 `# cardigan:` 开头时才覆盖，其他文件和符号链接会被拒绝。

每次执行时，包装命令先加载并导出存在的 runtime.env；文件缺失时跳过，不会因缺少该文件报错。`agent-ssh` 模式下，如果当前进程尚无 `cardigan-share` 组身份，使用 `sg cardigan-share -c` 运行 CLI，每个参数与入口路径分别做 shell 引用，保留空格、引号和特殊字符。已有组身份或使用 local 模式时直接运行 CLI。该脚本不创建组或添加成员；共享组由 Agent 安装器配置，`sg` 失败会直接返回错误。

## 使用隔离模式启动 Assignment

安装并重新登录后，在启动 server 的主机终端加载 Agent 安装器生成的 runtime.env（按安装器打印的路径；用 `set -a` / `. <runtime.env>` / `set +a` 导出）。CLI 使用上文安装的 `cardigan` 命令，自动加载同一配置。随后沿用已登记的项目、Role 和 launch.yaml：

```sh
pnpm --filter @cardigan/server exec cardigan-server
# 另一主机终端：
cardigan assignment start A-1 --project p-demo
cardigan assignment attach A-1 --project p-demo
cardigan assignment stop A-1 --project p-demo
```

`cardigan assign W-1 --role coder --start` 同样使用该模式。CLI 版本在 agent 账号下查询；模型 CLI 必须已经装到该账号的 PATH 中，不会回退主机版本。运行目录是 agent-root/runs/project/assignment，Git 路径使用 agent-root/repos/project 和 worktrees/project/assignment。主机私有源仓库通过只读 bundle 提供基线，无需让 agent 进入主机 home。

启动失败会撤销新 Token、取消 Run、尝试释放已知终端，并清理 token/secrets.env；stop 也清理凭据，worktree 保留。共享文件权限为 0660、目录 2770、脚本 0770，父层 2750。成功启动后包装脚本读取凭据即删除文件，输出不打印 Token 或模型密钥。若清理报错，按提示人工检查；没有得到终端引用的 provision 超时不能证明没有创建终端，仍需按标签核查。

`CARDIGAN_RUNTIME_MODE=local` 保留开发用途，使用当前账号及 data/runs，server 会明确提示没有隔离。请勿把它作为隔离模式失败时的自动回退。

## 界面验收使用合成数据（C-288）

去敏快照方案已撤销，不再生成或发布生产数据副本。界面验收改用合成数据生成器（C-287 另卡交付）；生成器交付前继续使用已有合成夹具，不把新入口称为已可用。验收结论必须标明数据来源和规模，已有夹具须标明“非生产规模数据”，不能据此声称已验证生产规模性能。

Agent 不得读取生产库、生产附件目录或生产副本。验收沿用主机为当前交付准备的可写构建目录，只起自己的本地 Web，不跑派发、合并等后台循环，结束前停止自己启动的服务；截图证据与旧截图门禁不变，详见开发方案 §10.4、§14。

本次撤销软件入口不清理真实数据或既有用户文件。主机空发布目录及私有部署说明由外接主机操作员在合并后另行清理。

## 外部通知（飞书）

总开关和渠道开关默认关闭。开启后，系统把新的 Needs You 事项发到配置的飞书群；仅含项目、卡号、事项类型、白话标题和工作台链接。敏感事项仅显示项目、“有 1 条敏感事项待处理”和链接。不会发送操作正文、评论、附件、日志或人话概述。

由人在飞书目标群的设置中添加“自定义机器人”，保存机器人 webhook，并在安全设置中开启签名校验、保存签名密钥。若另设关键词校验，可使用消息固定前缀 `Cardigan`。确认该群成员适合接收上述信息后，在运行 server 的主机账号下保存配置；本仓库的开发与测试只用合成凭据及本地假 HTTP 服务，不创建或试发真实机器人。

配置文件为 `~/.config/cardigan/ext-message.yaml`（可由 `CARDIGAN_CONFIG_DIR` 或 `XDG_CONFIG_HOME` 指定私有配置目录）：

```yaml
enabled: false
workbench_url: https://workbench.example.invalid
channels:
  lark:
    enabled: false
    credential_file: feishu.secret.json
policy:
  timeout_ms: 10000
  max_attempts: 3
  retry_delays_ms: [30000, 60000]
  title_limit: 120
  digest_limit: 20
quiet_hours:
  enabled: false
  timezone: Asia/Shanghai
  start: '22:00'
  end: '08:00'
```

`feishu.secret.json` 相对配置目录解析，也可使用绝对路径。内容格式如下；尖括号为占位说明，需要替换为人在飞书创建的值，不可把真实文件加入仓库：

```json
{"webhook":"<飞书自定义机器人的 HTTPS webhook>","secret":"<签名密钥>"}
```

也支持渠道的 `credential` 字段直接保存上述 JSON 字符串，与 `credential_file` 二选一；建议使用单独秘密文件。`secret` 可省略，表示机器人未启用签名校验。配置及秘密文件必须是主机用户拥有的普通文件，权限严格为 `0600`，不接受符号链接；关闭渠道时不读取秘密文件。只接受 `open.feishu.cn` 下的标准自定义机器人 HTTPS webhook，无用户名、查询参数、片段或额外端口；发送禁止跟随重定向，凭据不进入数据库或错误输出。

将两个 `enabled` 都设为 `true` 并按部署流程重启 server 后生效。`cardigan ext-message status` 查看最近加载状态与固定错误分类；由人在本机执行 `cardigan ext-message test --channel lark` 可显式发送固定测试消息（遵守总开关和渠道开关，单次测试不受免打扰时段影响）。Agent Token 无权执行这两条命令，系统不提供发送消息的 MCP 或 HTTP 入口。

免打扰默认关闭；开启时必须显式提供时区和不同的起止时间，起点包含、终点不包含，支持跨午夜并使用所选时区的夏令时规则。时段内只入队，结束后的下一轮按项目和渠道合成一条汇总。重启保留队列，发送前剔除已处理事项并重读敏感标记；最多列 20 条，其余可从汇总末尾的 Needs You 总入口查看。标题按 Unicode 码点限制为 120 字，链接另列；这两个上限可配置。

每次外发先持久化尝试次数；默认每次 10 秒、总共 3 次，失败后分别等待 30／60 秒。限流、临时服务器错误、网络中断和结果不明会占用同一预算重试；签名、内容、地址等永久错误立即停止。HTTP 408、429、5xx 及飞书业务码 11232、99991400、99991500 可重试；其他非零业务码和重定向不可重试，格式不明的成功响应按未知送达重试。发件箱同一事项每渠道只有一条，已确认成功不再发送；汇总中的每个事项仍沿用自己的预算，最终失败每个事项仅留一条工作台知会且不再外发该知会。远端成功但本地提交失败时可能重复提醒，不能保证远端恰好一次送达。

## hc 0.1.21 升级与回退（C-313）

本节是软件阶段的操作材料，**尚未执行生产升级**。Q-550 已批准专用隔离配置草稿等待为零、可信退出安全门、普通重启不加 fresh。兼容措施须以新完整 SHA 经过代码审核和独立复核，再由 PM 建立正式主机待办。新版终端关闭后可残留脱离进程，hc 不提供全体退出证明，因此软件现在保留未知范围的工作区/构建、原目标和停止栅栏；这意味着自动清理、停止收尾和旧会话替换会等待获授权处理。启动失败补偿的未知范围也会持久保留原 Run 的目标和容量，不自动撤销其凭据或创建后继；启动请求结果不确定、尚未取得终端引用时，保留准确启动意图而不虚构终端，使用相同安全门；人工事项完成只是记录核实结果，不能解除软件退出栅栏。常驻 PM 暂停仍先持久化暂停和撤销旧 Token，阻止继续派发；未知退出时保留原引用及凭据文件，不擦除目录或创建后继。不得直接运行以下命令来替代这些前置条件。

### 专用配置迁移与退出核实（Q-550）

运行时为主机核心使用 `<dataDir>/hc-config/<session>`；远端 `--via` 固定入口按执行账号的账号数据库解析 `<账号home>/.config/cardigan-hc/<session>`（安装器托管的 agent 为 `/var/lib/cardigan-agent/.config/cardigan-hc/<session>`），不使用继承的 HOME，也不在主机所有的 2750 agentRoot 下创建配置。均是 `XDG_CONFIG_HOME`，实际文件为其下的 `herdr-core/config.toml`，只允许 `draft_wait = 0`。主机配置由运行时安全创建；远端入口先安全创建/校验配置，再无额外输出地 exec hc，核心内固定 helper 再检查实际环境。文件要求账号所有、0600、单个普通文件；拒绝链接、非预期内容或外来可写祖先。不得把这些目录指到用户的共享配置，也不要复制整个用户环境。

对安装器托管账号，在上述已核实空闲的维护窗口，操作员先按本页开头流程执行新版安装器的 `--dry-run`、`--check`，核对计划中的 `agent_config_root`，通过后才执行安装。它把 `.config/cardigan-hc` 预置为 agent 所有、0700、无访问/默认 ACL；共享 agentRoot 仍由主机所有，不改其权限。会话叶目录及配置文件由固定 SSH 入口以执行账号身份创建。其他已登记执行账号须由获授权操作员预置相同的账号私有根，逐级拒绝链接和外来可写祖先；不得把配置根软链回共享目录。不要直接复制旧的共享配置或修改账号的通用 `herdr-core/config.toml`。已存在的配置内容或权限异常时先保留并查明，不自动覆盖。

审核构建目录也是退出门的一部分：CLI 复用和 Dispatcher 唤醒前，退出未知、存活或身份变化会保留旧 build 与登记并停止准备/门铃；当前 hc 返回 unknown，因此不能依赖复用会话自动重建目录。人工核实事项完成也不会解除此门。

软件不会迁移正在使用共享配置的旧核心：即使 CLI 环境正确，核心启动环境不匹配仍拒绝操作。旧的 hc machine alias 若缺专用配置环境也会拒绝改绑，不能在活跃终端尚未处理时自动覆盖。操作员必须先核实记录中的目标、启动代次和所有脱离进程已退出，原工作区已备份，停止新启动/检查，确认无运行程序后，才可在维护窗口为这个**已空闲专用核心**实施配置迁移。普通 `server restart` 仍不加 fresh，不能假定它会更新保留的环境。不得为绕过门禁对活跃核心执行 stop/start 或 fresh。

就绪材料应给出该账号的实际 `hc_live`、`hc_socket`、`hc_config_home`（上述专用目录）及已核实的空闲/退出记录。在原账号下先停止这个已核实空闲的专用核心，确认原核心退出，再以正确专用配置启动；此步骤需在正式主机待办中经获授权操作员核对，不由 Agent 运行。若无法证明退出，保留原目录/引用并停止迁移。

```sh
: "${hc_live:?}" "${hc_socket:?}" "${hc_config_home:?}"
HC_SESSION=cardigan HC_SOCKET="$hc_socket" "$hc_live" server stop --json
XDG_CONFIG_HOME="$hc_config_home" HC_SESSION=cardigan HC_SOCKET="$hc_socket" "$hc_live" server start --json
XDG_CONFIG_HOME="$hc_config_home" HC_SESSION=cardigan HC_SOCKET="$hc_socket" "$hc_live" server status --json
```

迁移后先通过 Cardigan 的配置核验和带草稿门铃定向检查，再恢复原派发。SSH alias 的旧记录须在无活跃远端程序的同一维护窗口由操作员删除后按新专用入口重新登记，不能重用指向旧配置的 alias。现场 SSH/Mac 配置消费和上述维护步骤仍须操作员实测，Linux 本地隔离证据不能代替它。失败回退时先暂停派发，按下文恢复二进制/旧 Cardigan 构建及备份的精确目标配置；不删用户配置、不清未知进程、不把人工事项“完成”当成退出证据。

### 来源与环境证据

上游发布清单为 `https://releases.herdr.dev/core/0.1.21/manifest.json`，变更逐项评估见开发方案 §11.7。固定归档 SHA256 如下，安装器下载/离线安装共用相同锁，不以 `hc update --version 0.1.21` 充当精确锁（该参数表示“至少此版”）。

| 平台归档 | SHA256 | 本次证据 |
|---|---|---|
| linux-x86_64 | `78424755c10a40dde38a0bdb55c20ac19706e9ae05ed68fc2acf1fcff0d941c1` | 下载并实际校验、独立运行 |
| linux-aarch64 | `e844a2bfab48a226097679d076bc83042fe57fccef5387ef802e5b24e78b529a` | 核对官方清单；未在该架构运行 |
| macos-aarch64 | `1ab38dd9270f63a8f794d6d60e8702eb0d1c85a72bda85d735e5eea43f05ffed` | 核对官方清单；签名/TCC/实机未运行 |

| 环境 | CLI / 核心版本 | 已运行 / 未运行 |
|---|---|---|
| 单元假执行器、内存 Runtime | 夹具断言 0.1.21，不是真实核心 | 版本拒绝、安装安全检查、注册、主机/CLI 调用方；不得算生产通过 |
| 当前 Linux x86_64 隔离目录 | 独立已验 SHA 的 0.1.21 / 0.1.21 | runtime-herdr 契约与验收；server M2/M3/M4、CLI 启动/attach；假 Agent，不调用模型 |
| 隔离升级探针 | 0.1.18 → 0.1.21 → 0.1.18，逐步检查核心版本 | 更新/回退保留原程序 PID、普通/fresh 环境、TERM、PTY observe/草稿、setsid 残留；结束清理自建终端与核心 |
| cardigan-ci 合并检查账号 | 未读取，待操作员回填实际 CLI 和核心版本 | 全量与 e2e/appendix-a 未运行；不得用跳过真实 hc 用例的绿色结果放行 |
| 主机账号的 Cardigan 专用核心 | 未读取，待操作员确认 | 真实升级、事件/门铃/attach、30 分钟/10 自然并发未验收 |
| agent 账号及远程 Mac worker | 未读取，待操作员确认 | agent 的 root-owned 二进制、SSH 注册、Mac App/签名/登录权限未现场验收 |

### 定向复验

本次结果：runtime-herdr 221 通过/1 跳过（内存实现不执行真实命名冲突用例），server M2/M3/M4 175 通过，CLI/host/清理调用方 151 通过。真实核心用例未因版本缺失跳过；探针报告的残留行为已按 Q-550 通过保留原目标/目录与拒绝未知退出来保护；它仍不是全体进程退出证明。该数字是上一阶段记录，新交付结果见交付测试报告。

依赖安装后，构建受影响的运行时和调用方：`pnpm exec tsc -b packages/runtime-herdr packages/host apps/cli apps/server`。准备独立已校验二进制，让隔离 `PATH` 首项中的 `hc` 指向该文件，并设置 `CARDIGAN_TEST_HC` 为同一绝对路径；使用新建的私有 `XDG_RUNTIME_DIR/XDG_STATE_HOME/XDG_CONFIG_HOME/XDG_DATA_HOME`。测试自建非 `cardigan` 会话和 socket，不能沿用生产会话。每次只有一个 Vitest worker，不改主机限流。

```sh
pnpm exec vitest run --maxWorkers=1 packages/runtime-herdr
pnpm exec vitest run --maxWorkers=1 apps/server/src/m2-assignment.acceptance.test.ts apps/server/src/m3-*.acceptance.test.ts apps/server/src/m4-*.acceptance.test.ts
pnpm exec vitest run --maxWorkers=1 apps/cli/src/assignment.test.ts apps/cli/src/assignment-attach.test.ts apps/cli/src/m2-start.acceptance.test.ts apps/cli/src/runtime-check.test.ts packages/host/src/claude-config.test.ts packages/host/src/runtime-targets.test.ts packages/host/src/closed-card-runs.test.ts packages/host/src/run-capacity.test.ts packages/host/src/wake-preparation.test.ts packages/host/src/exit-confirmation-text.test.ts apps/server/src/cleanup-resources.test.ts apps/server/src/hc-cleanup.test.ts
python3 packages/runtime-herdr/test-support/upgrade-probe.py --old "$hc_old_verified" --new "$hc_new_verified"
```

探针的两个参数必须是预先按各自发布清单校验的独立 Linux 二进制路径（`hc_old_verified`、`hc_new_verified`），不是生产 `hc`。探针只更新自己复制的旧二进制，使用随机临时目录、清空继承环境；草稿 0 仅写入自己的测试配置。它明确验证脱离进程**会存活**，不把这一结果误报为清理安全。少量 shell/cat/sleep 是行为夹具，不制造 CPU 负载。首次临时 PTY 草稿试验曾在 attach 就绪前输入而未复现等待；探针在交互接入尺寸确认后再输入，采用可复查的等待断言。

### 操作员执行顺序和就绪条件

1. 顺序固定为 **cardigan-ci → 主机账号的 Cardigan 专用核心 → agent 账号的 hc**。Mac worker 如已接入，单独按签名 App 和可信目标清单核对；不能用 Linux 包替代。各阶段失败即停止后续操作。
2. 人确认行为取舍、独立复核通过，并确认合并检查和 Agent 启动空闲后进入维护窗口。操作员使用既有主机维护流程暂停新派发/检查/自动清理，等待在途调用结束；这里不新增暂停接口或并发参数。先准备与回退二进制匹配的 Cardigan 旧构建，避免软件版本门与核心混用。升级后可保留存活终端，但旧 holder 不会自动获得新终端的全部行为。
3. 逐账号记录实际 `hc` 解析路径、所有者、是否软链/独立副本、CLI 版本；按可信运行时配置记录 Cardigan 的 session、socket、XDG 目录、核心 PID/版本和终端 address/程序 PID。记录只进私有主机待办，不把主机名、个人路径、凭据或环境值复制进仓库。主机目标必须是 `HC_SESSION=cardigan` **且**使用既有精确 `HC_SOCKET`；只改 session 不足以排除继承的错误 socket。不能对用户默认 Herdr 核心操作。
4. 保存旧二进制到该账号的 `~/.local/share/herdr-core/0.1.18/`，保留已有该目录；确认旧版本为 0.1.18 并记录 SHA256。按既有备份流程保存专用 hc 状态和配置，确保可恢复；上游提示 saved state 只向前演进，隔离回退成功不保证所有生产状态都可降级。不要在线覆盖状态目录。
5. CI 切换后，由主机在候选代码上运行已配置的全量与 `pnpm test:e2e`，记录 CLI/核心都为 0.1.21 且真实用例没有因版本不符跳过。之后才进入主机核心和 agent 的步骤；只读探测版本与安装成功不能替代这些检查。

### Linux 下载与完整性准备

以下只准备文件，不启动核心。由操作员在目标账号可写的私有暂存目录执行；新建目录权限由 `umask` 保护。x86_64 与 aarch64 均精确固定，下载失败/哈希不符立即停止。

```sh
set -eu
umask 077
hc_stage=$(mktemp -d)
hc_arch=$(uname -m)
case "$hc_arch" in
  x86_64) hc_sha=78424755c10a40dde38a0bdb55c20ac19706e9ae05ed68fc2acf1fcff0d941c1 ;;
  aarch64) hc_sha=e844a2bfab48a226097679d076bc83042fe57fccef5387ef802e5b24e78b529a ;;
  *) exit 1 ;;
esac
curl -fSL "https://releases.herdr.dev/core/0.1.21/herdr-core-linux-$hc_arch.tar.gz" -o "$hc_stage/release.tar.gz"
printf '%s  %s\n' "$hc_sha" "$hc_stage/release.tar.gz" | sha256sum -c -
python3 - "$hc_stage" <<'PY'
import pathlib, sys, tarfile
root = pathlib.Path(sys.argv[1])
with tarfile.open(root / 'release.tar.gz') as archive:
    entry = archive.getmember('herdr-core')
    assert entry.isfile(), 'expected a regular executable'
    target = root / 'herdr-core'
    target.write_bytes(archive.extractfile(entry).read())
    target.chmod(0o700)
PY
"$hc_stage/herdr-core" --version
```

结果必须严格为 `hc 0.1.21`。若暂存挂载禁止执行，在该账号受控可执行目录暂存，重新核对同一归档与版本；不更改挂载策略。安装器的离线 `payload()` 路径已用真实 x86_64 归档校验；**不要为升级重跑整个账号安装器**，它会重设托管账号、授权文件和目录权限。

### 更新、核心确认和回退

操作员先从私有清单填入 `hc_live`（实际可执行文件绝对路径）、`hc_socket`（既有专用 socket）、`hc_old_verified`（保留的 0.1.18 可执行文件）并保留该账号原 XDG 路径。以下是自有可写二进制的精确更新命令，`--from` 指向上一步已校验内容：

```sh
: "${hc_live:?}" "${hc_socket:?}" "${hc_old_verified:?}" "${hc_stage:?}"
HC_SESSION=cardigan HC_SOCKET="$hc_socket" "$hc_live" update --from "$hc_stage/herdr-core" --json
"$hc_live" --version
HC_SESSION=cardigan HC_SOCKET="$hc_socket" "$hc_live" server status --json
HC_SESSION=cardigan HC_SOCKET="$hc_socket" "$hc_live" ls --all --json
```

`update --from` 自身已重启核心，无需再 stop/start。核对 CLI 和核心均为 0.1.21、原终端 address/程序 PID 仍相同且 live，再执行一次门铃、状态/事件订阅和 `attach --observe` 的业务验收。事件快照/seq 要持续正常；观察接入不能改变尺寸。不要把 `server status` 里的新字段或注销警告当成授权调整系统账号。

agent 的安装器产物为 root-owned 的 `hc` 和 `herdr-core` 两份普通文件，agent 自更新会被拒绝。操作员从私有清单填写两条绝对路径 `hc_agent_hc`、`hc_agent_core`，确认父目录由 root 控制且 agent 不可写。以下命令保持原属组及 0750 权限，在同目录原子替换，不改账号或凭据；它们只经语法核对，未在 Agent Run 中执行 sudo：

```sh
: "${hc_agent_hc:?}" "${hc_agent_core:?}" "${hc_stage:?}"
for hc_target in "$hc_agent_hc" "$hc_agent_core"; do
  test ! -L "$hc_target" && test -f "$hc_target"
  test "$(stat -c %u "$hc_target")" = 0
  test "$(stat -c %a "$hc_target")" = 750
  hc_group=$(stat -c %g "$hc_target")
  hc_staged=$(sudo mktemp "$hc_target.c313.XXXXXX")
  sudo install -o 0 -g "$hc_group" -m 0750 "$hc_stage/herdr-core" "$hc_staged"
  test "$(sudo "$hc_staged" --version)" = 'hc 0.1.21'
  sudo mv -f "$hc_staged" "$hc_target"
done
```

两份文件之间不具有事务原子性，因此任一步失败保持维护暂停，并按保留的旧内容撤回已替换部分。如果 agent 有正在服务该目标的远程核心，在原账号/原 session/socket 下执行 `hc server restart --json` 并复核注册版本；不要猜测 socket 或从 root 会话启动 agent 核心。主机持有旧远程注册时，在维护窗口内核对更新后的连接后才能恢复派发。

普通重启保留核心启动环境。只有人批准换环境时，操作员才从 **Herdr 外部、已核对的主机环境** 执行 `HC_SESSION=cardigan HC_SOCKET="$hc_socket" "$hc_live" server restart --fresh --json`；它改变以后新终端的环境，已运行程序不会更新。不要导出或记录整个环境，也不要从 Agent 终端执行生产 fresh。草稿配置按 Q-550 只使用下述专用目录；仅设置 session 不会把账号共享的 `config.toml` 隔离。

失败时保持派发/清理暂停，保留现场与新版目录。对自有二进制使用已验证的旧文件：

```sh
HC_SESSION=cardigan HC_SOCKET="$hc_socket" "$hc_live" update --from "$hc_old_verified" --force --json
"$hc_live" --version
HC_SESSION=cardigan HC_SOCKET="$hc_socket" "$hc_live" server status --json
HC_SESSION=cardigan HC_SOCKET="$hc_socket" "$hc_live" ls --all --json
```

root-owned 两份文件由操作员按上述循环还原：将 `install` 的输入换成经完整性核验的 `$hc_old_verified`，版本断言换成 `hc 0.1.18`，再在原账号重启专用核心。旧包校验清单为 `https://releases.herdr.dev/core/0.1.18/manifest.json`；x86_64 归档 SHA256 为 `5b2f97cb4b2a9d7a6b2cc5942628203ed9fbb7cc0c2b4b09ad8a6f5648e246b7`，aarch64 为 `cf33393cf950bb763734dc3e16610ab9daf8492391a4ef0de56026cd7f752853`，保留文件也须与可信旧包内容核对，不能只看版本字符串。按 agent → 主机 → CI 的逆序撤回已切换部分，恢复匹配 0.1.18 的旧 Cardigan 构建。只在版本、注册和终端全部确认后恢复派发；若状态无法读取，保持停用，由操作员按备份恢复流程处理，不能强删状态或终端。旧目录一直保留，回退并不保证新版 holder 立即变回旧终端行为。

最后由操作员在自然业务负载下记录连续 30 分钟核心 CPU、RSS、实际 Run 并发数与采样时间，以及门铃/启动/attach/事件结果和用户 Herdr 未受影响的核对。10 并发达不到时记录“未满足原验收目标”；不造任务、压测或改系统上限，不能把 8 并发/短采样当通过。全部现场证据收齐后才申请整卡完成。
