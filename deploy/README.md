# Agent 专用账号（M2.7）

hc 当前安装目标及兼容边界见 [版本清单](hc-version.json)；历史版本号可查 Git 历史。

P2b 的每项目账号与 Linux/macOS 私有 worker 安装入口见 [C-281](../docs/plans/C-281.md) 和 [ADR 0012](../docs/adr/0012-project-worker-isolation.md)。下述安装器保留旧单项目本地布局，不能将同一账号或共享组复用于其它项目或 CI。完成安装不等于通过双向隔离验收，也不启用远程启动。

Linux 安装前先阅读 [ADR 0002](../docs/adr/0002-agent-account-isolation.md)。脚本会配置 agent 账号、专用组/SSH 密钥、hc 基线版本 和私有/共享目录。它不会修改 `~/.ssh/config` 或 sshd 全局配置。

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


## Agent 附件助手（C-595）

`agent-tools/` 下的 `download-attachment.mjs`、`upload-evidence.mjs` 是只依赖 Node 内置模块的预构建单文件。受管 worker 上装在 `<工作根>/libexec/agent-tools/`（root 所有、项目组只读），由 worker 向导首装，并随人工升级和 `cardigan-helper-v2` 签名升级与 helper 一起更新。员工启动时通过 `CARDIGAN_AGENT_TOOLS` 找到它们。不要手改，修改源码后运行 `pnpm --filter @cardigan/mcp-server build:agent-tools` 重建。

`cardigan machine check` 的 `agent.attachment_tools` 能力项会核对两个文件存在、可执行且与当前发布一致；不一致时只报原因和期望 SHA-256，不生成命令。在 C-595 之前登记签名升级的机器不会自动装上助手（自动补装另卡处理），这时按下面的固定步骤手动补装：

```sh
# 1. 目标机，管理员：新建只属于本次补装的暂存目录，记下路径
stage=$(mktemp -d) && echo "$stage"

# 2. 控制主机，主机账号：从当前已部署的发行目录拷两个文件进暂存目录
scp <发行目录>/deploy/agent-tools/download-attachment.mjs \
    <发行目录>/deploy/agent-tools/upload-evidence.mjs \
    <管理员>@<目标机>:<暂存目录>/

# 3. 目标机，管理员：与 machine check 报出的期望 SHA-256 逐一核对，不一致就停止
cd "$stage" && sha256sum download-attachment.mjs upload-evidence.mjs   # macOS：shasum -a 256

# 4. 安装到固定路径（Run 账号需要读和执行，与向导一致用 root:项目组 0750），再核对一次
sudo test ! -L <工作根>/libexec/agent-tools
sudo install -d -o root -g <项目组> -m 0750 <工作根>/libexec/agent-tools
sudo install -o root -g <项目组> -m 0750 download-attachment.mjs upload-evidence.mjs <工作根>/libexec/agent-tools/
sudo sha256sum <工作根>/libexec/agent-tools/download-attachment.mjs <工作根>/libexec/agent-tools/upload-evidence.mjs

# 5. 只删除本次的暂存目录，然后重跑 machine check 确认
cd / && rm -r "$stage"
```

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

## GitHub 未绑定运行的恢复（C-334）

此处说明主机侧恢复边界，不是生产启用步骤。D3 及本修复仅用假 API、假 Git、合成凭据和可控时钟验证；生产启用还须落实 D4 统一预算、轮询和本卡审核，不能因旧 D3 通过而跳过。代码已接入 D4 共享客户端和持久预算；生产配置未启用，正式切换仍由运维流程授权。

dispatch 响应丢失时保留持久意图和同卡占位，重启按原 attempt 恢复。查找固定时间范围，遇过滤查询 1000 条平台上限就拆小窗口；跨页、跨窗按运行编号去重，父窗口已看到的身份也须一致并在完整叶集合重现，不能因拆窗而丢弃歧义证据；全部窗口完整且精确名称全局唯一、精确编号重读身份一致后才能绑定。`recovery_incomplete` 表示未能证明完整（包括单秒密集、缺页、计数变化或取消），`security` 表示身份或分页链接不可信，`api` 表示请求失败；这些诊断不表示远端运行已经结束。限额由共享请求入口控制，不能通过加页数、换凭据或放宽预算绕过。

未绑定或未知时不要删意图、手动解除占位或再发 dispatch。未绑定且意图已持久化时，服务端保留原排队 attempt，按既有退避恢复查找，重启也不生成新的派发 attempt；已绑定则重读原运行编号；只有可信远端终态确认才能按既有规则释放占位。平台单秒饱和、历史运行被删除或查询可见性不足仍可能无法恢复，需保留现场交由获授权操作员核实，不能记录为通过。本次没有验证真实 GitHub 或切换生产配置。

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

将总开关和渠道的 `enabled` 都设为 `true` 后，后台在下一发送轮次重载 YAML，无需重启。`cardigan ext-message status` 可查看加载状态；人在本机可用 `cardigan ext-message test --channel lark` 发送固定测试消息。Workbench 的人员登录会话也可向已配置的群或本人绑定的应用私聊发送测试消息；同一请求重试不会重发。测试遵守渠道开关，不受免打扰时段影响。Agent 和 PM Token 无权调用，不提供发送消息的 MCP 工具。

免打扰默认关闭；开启时必须显式提供时区和不同的起止时间，起点包含、终点不包含，支持跨午夜并使用所选时区的夏令时规则。时段内只入队，结束后的下一轮按项目和渠道合成一条汇总。重启保留队列，发送前剔除已处理事项并重读敏感标记；最多列 20 条，其余可从汇总末尾的 Needs You 总入口查看。标题按 Unicode 码点限制为 120 字，链接另列；这两个上限可配置。

每次外发先持久化尝试次数；默认每次 10 秒、总共 3 次，失败后分别等待 30／60 秒。限流、临时服务器错误、网络中断和结果不明会占用同一预算重试；签名、内容、地址等永久错误立即停止。HTTP 408、429、5xx 及飞书业务码 11232、99991400、99991500 可重试；其他非零业务码和重定向不可重试，格式不明的成功响应按未知送达重试。发件箱同一事项每渠道只有一条，已确认成功不再发送；汇总中的每个事项仍沿用自己的预算，最终失败每个事项仅留一条工作台知会且不再外发该知会。远端成功但本地提交失败时可能重复提醒，不能保证远端恰好一次送达。

移动端本地签名是独立、默认关闭的服务，见 [隔离签名与逐件授权](mobile-signing/README.md)；worker 安装不会启用它。
