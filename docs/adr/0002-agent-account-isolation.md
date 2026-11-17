# ADR 0002：Agent 独立账号和专用 SSH 入口

- 状态：M2.7 实现方案，待审核及用户安装后验证
- 日期：2026-11-05
- 依据：开发方案 §13.4、§14；M2 计划 v2 M2.7；用户要求由实现方确定设计
- P2b 修订：每项目、每机器账号边界见 [ADR 0012](0012-project-worker-isolation.md)；下文 M2.7 安装步骤保留旧单项目兼容。

## 目标和边界

`local` 执行模式保留开发用途，server 必须醒目提示没有账号隔离。领域编号 `local` 仍合法，生产执行使用隔离账号。`agent-ssh` 由控制主机受信的 project+machine 映射解析账号、SSH 授权和 hc alias/session，允许已登记的本机或远程 worker；卡片和 ref 不能自报连接参数。未配置多机映射时保留旧单项目 agent@localhost 路径，不批量重写历史目标或目录。

主机持有数据库、附件、Git 网络凭据、模型配置和专用 SSH 私钥。Agent 不继承主机的 SSH agent、环境或私钥。模型凭据仅按一次启动所需范围写入运行目录，和 MCP token 一样由包装脚本读取后删除。

这属于系统用户隔离，不是容器或网络沙箱。同项目同 UID 的 Assignment 仍可相互访问其账号资源；跨项目必须使用不同 UID，不能共享可写根、缓存、认证目录或 hc socket。世界可读系统文件和全部进程名不在隐藏承诺内。主机的数据库、中心仓库、Git 与 SSH 凭据仍不向 Agent 开放。

## 账号与安装

提供 Linux 安装器 `deploy/install-agent.py`。先 dry-run，再由用户用 sudo 执行 `--check`，通过后正式安装；实现 Agent 不执行 sudo。`--check` 和正式安装共用只读 preflight，所有不依赖新账号存在的检查在第一次写入之前完成，前置检查失败不做安装改动。

1. 只读检查绝对路径、目录占用及互不嵌套的数据/工作根；检查 Linux、主机用户、sudo 可用性和所有工具依赖。提前检查共享组是否含其他成员或被其他用户用作主组，已有 agent 是否托管、无 sudo/额外组；直接检查主机 home 的 other-x 位与计划加入组的访问权限。读取 sshd 有效配置，验证授权来源和 ed25519 主机公钥；校验已有专用密钥权限。最后下载并校验固定 hc 0.1.18 归档，只取 regular file `herdr-core`，也支持离线归档。上述检查均不写配置或创建账号。
2. 检查全部通过后，新建系统用户 agent、锁定密码；专用组 cardigan-share 只能包含主机用户和 agent，两者加入该组。不接管不匹配的现有账号，不使用旧测试账号的 cardigan-agent 主组。
3. 新账号/组就绪后复核 sudo 和实际 home 访问能力。不替用户修改 home 权限或 sshd 配置；实际系统命令失败不等同于前置检查失败，部分托管状态允许修正后重跑。
4. agent home、`.ssh` 和 hc 二进制目录由 root 持有，agent 不能替换 authorized_keys 或添加第二个授权入口；`.config`、`.cache` 和 `.local/state` 等目录归 agent。hc/herdr-core 安装到该账号的 `.local/bin`，校验安装后的版本。
5. 在主机用户的 `.config/cardigan/agent-ssh/`（0700）生成专用 ed25519 私钥（0600）；重复运行复用同一把密钥，拒绝错误属主/权限。只写这把公钥到 agent 的 authorized_keys，限制来源为 loopback，禁止 forwarding、PTY、user rc 等 SSH 扩展。
6. 从本机 sshd 的 ed25519 公钥生成专用 known_hosts（0600）。SSH 使用 `-F /dev/null`、`IdentitiesOnly=yes`、`IdentityAgent=none`、`ForwardAgent=no`、严格 host key 校验和专用文件；不使用/修改用户的 SSH config，也不启用 trust-on-first-use。
7. 数据目录归主机用户，0700，并清除额外 ACL；工作根及 runs/repos/worktrees 根归主机和共享组，2750。父目录仅主机可改名，agent 可遍历；默认 ACL 使新 Git 工作文件可由共享组读写。重复运行只管理这些明确路径，不递归改用户其他目录。
8. 写主机独占的 runtime.env，包含模式、路径、共享 GID、SSH key/known_hosts 的路径，不包含密钥内容。主机需重新登录以刷新附加组，再加载配置。

安装器不安装模型 CLI、不复制用户模型认证或 SSH 私钥，不改用户全局配置。需要现有 openssh-server、Python 3、ACL 工具，以及常规 Linux 账号工具。

sudo-rs 0.2.13 在无权限时可能返回 0（传统 sudo 返回非 0），因此两处权限检查统一以 `LC_ALL=C`、`LANG=C` 调用 `sudo -n -l -U agent`，仅在退出码非 0 或退出码为 0 且输出含 `is not allowed to run sudo` 时认定无权限，其余情况（包括空输出或无法识别的输出）均拒绝继续安装。

## 路径和文件权限

下表为旧单项目本地布局。Linux 共享组必须每项目独立，只含主机和该项目账号，不能跨项目或与 CI 共用。新 Linux/macOS worker 使用 ADR 0012 的 root 命名空间及 0700/0600 私有叶子；远程材料经固定 SSH helper 发布，不照搬共享磁盘权限。两种布局均检查额外 ACL，不能通过共享暂存目录绕过隔离。

| 内容 | local | agent-ssh |
|---|---|---|
| 数据库/附件 | CARDIGAN_DATA_DIR，0700 | 同左，agent 无权访问 |
| 运行目录 | data/runs/project/assignment | agent-root/runs/project/assignment |
| 基础 clone | data/agent/repos/project | agent-root/repos/project |
| worktree | data/agent/worktrees/project/assignment | agent-root/worktrees/project/assignment |
| 运行目录/文件 | 0700 / 0600；脚本 0700 | 2770 / 0660；脚本 0770，共享组仅两个账号 |

project_id/assignment_id 在参与路径构造前验证。agent-root 必须在 data 及主机私有 home 之外。运行目录父层由主机控制；文件写入必须防范已有 Agent 放置的软链接/硬链接，不能直接追随共享目录中的链接覆盖主机文件。token/secrets 文件仅放必要的启动材料，包装脚本读取后删除。

Linux 写入通过 O_NOFOLLOW 逐级打开并固定目录描述符，用 /proc/self/fd 下的相对路径操作；拒绝权限/属组不符的现有目录，不替它们放宽权限。编译文件先写独占临时文件，再通过描述符设置共享 GID 和权限，最后原子替换目标文件名（不修改原软链接或硬链接的目标）；token 最后写。失败清理只在同样固定的运行目录里 unlink token/secrets.env。server 在打开数据库前验证 agent-ssh 的数据目录已归主机且为 0700；local 模式创建或收紧为 0700。

## 共享 Git 的身份边界

共享仓库的 .git/config、过滤器和工作文件都可被 Agent 修改；主机即使只做 git status/fetch 也可能执行其中的程序。因此主机只在用户登记、且位于 agent-root 之外的可信源上执行 Git，导出 bundle 到主机独占临时目录，再发布为 inputs/project/source.bundle（0640）。来源绑定记录在主机独占的 source.path；不允许同项目静默换来源。Agent 执行入口从 bundle 创建和更新 clone，所有共享仓库查询和 worktree 创建都由 agent 执行。Git 仅允许 file 协议、禁 hooks，safe.directory 只放行该项目的指定路径；不向 Agent 交 Git 凭据。

主机预建共享叶子并持有命名空间父层，agent 不可用时拒绝而不回退主机执行。初始 clone 在独立叶子中由 agent 完成后再由主机发布。失败留下的非空临时 clone 只含源码，后续 M4 显式清理；主机不递归删除 Agent 可修改的树。真实不同 UID 和默认 ACL 的验证仍留给用户安装后的验收。

## Runtime 路由

hc 0.1.18 的 run/exec 支持 `--on <machine>`，get/send/events/interrupt/kill/rm 则使用 `<machine>/<terminal>` 地址；向这些命令添加不存在的 --on 参数会失败。适配器在两种语法下都只能选择配置的隔离 machine；其他 machine 引用直接拒绝。

host 侧 hc core 仍负责控制面聚合，各项目终端、worker hc core/socket/session 在各自项目账号运行。注册通过 `hc machine add --via <受信项目账号的专用 SSH 命令> --name <配置名> --session <专用远端 session>`，不执行 --install，也不替未授权机器配置 SSH。已有同名 machine 的连接参数或 session 不符时拒绝覆盖；主机和 worker 的 hc 版本都要匹配锁定版本。读状态前继续检查 host core socket；跨账号同名终端、实际连接和完整启动需操作员现场验收。

## 分批交付和验证

为满足约 800 行的 PR 限制，安装器与设计、Runtime 模式/路由、路径及文件权限接线分批交付。自动测试覆盖 dry-run 无副作用、归档校验、配置拒绝、命令参数、权限计算和共享文件安全写入。真实 sudo 安装、SSH 授权及隔离账号端到端由用户安装后，Claude 实测；自动检查不能替代这一项。
