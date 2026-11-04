# ADR 0002：本机 Agent 使用独立账号和专用 SSH 入口

- 状态：M2.7 实现方案，待审核及用户安装后验证
- 日期：2026-11-05
- 依据：开发方案 §13.4、§14；M2 计划 v2 M2.7；用户要求由实现方确定设计

## 目标和边界

`local` 模式保留开发用途，server 必须醒目提示没有账号隔离。`agent-ssh` 模式中，领域层 machine_id 仍为 local，Runtime 将它映射到唯一配置的 hc machine；该 machine 只通过专用 SSH 私钥连接 agent@localhost。不开放任意远程机器。

主机持有数据库、附件、Git 网络凭据、模型配置和专用 SSH 私钥。Agent 不继承主机的 SSH agent、环境或私钥。模型凭据仅按一次启动所需范围写入运行目录，和 MCP token 一样由包装脚本读取后删除。

这属于系统用户隔离，不是容器或网络沙箱。同一 agent UID 下的 Assignment 仍可相互访问其账号资源；隔离不同 Agent 属于后续阶段。世界可读的系统文件不在私有文件保护范围内。

## 账号与安装

提供 Linux 安装器 `deploy/install-agent.py`。先 dry-run，再由用户用 sudo 执行；实现 Agent 不执行安装步骤。

1. 检查绝对路径和互不嵌套的数据/工作根目录；检查 Linux、主机用户和工具依赖。下载固定 hc 0.1.18 归档，使用代码中固定的官方 sha256 校验，只提取 regular file `herdr-core`。支持传入离线归档，仍校验摘要。
2. 新建系统用户 agent、锁定密码；已有账号必须有 root 持有的安装标记且配置匹配，否则拒绝接管。拒绝 sudo 权限和额外组成员。专用组 cardigan-agent 只能包含主机用户和 agent，两者加入该组。
3. 检查 agent 无法遍历主机 home；若现有权限允许访问则拒绝，由用户先处理，不替用户修改 home 权限。读取 sshd 的有效配置，拒绝外部授权命令、CA、hostbased、交互或 GSSAPI 等替代认证来源，不改 sshd 配置。
4. agent home、`.ssh` 和 hc 二进制目录由 root 持有，agent 不能替换 authorized_keys 或添加第二个授权入口；`.config`、`.cache` 和 `.local/state` 等目录归 agent。hc/herdr-core 安装到该账号的 `.local/bin`，校验安装后的版本。
5. 在主机用户的 `.config/cardigan/agent-ssh/`（0700）生成专用 ed25519 私钥（0600）；重复运行复用同一把密钥，拒绝错误属主/权限。只写这把公钥到 agent 的 authorized_keys，限制来源为 loopback，禁止 forwarding、PTY、user rc 等 SSH 扩展。
6. 从本机 sshd 的 ed25519 公钥生成专用 known_hosts（0600）。SSH 使用 `-F /dev/null`、`IdentitiesOnly=yes`、`IdentityAgent=none`、`ForwardAgent=no`、严格 host key 校验和专用文件；不使用/修改用户的 SSH config，也不启用 trust-on-first-use。
7. 数据目录归主机用户，0700，并清除额外 ACL；工作根及 runs/repos/worktrees 根归主机和共享组，2750。父目录仅主机可改名，agent 可遍历；默认 ACL 使新 Git 工作文件可由共享组读写。重复运行只管理这些明确路径，不递归改用户其他目录。
8. 写主机独占的 runtime.env，包含模式、路径、共享 GID、SSH key/known_hosts 的路径，不包含密钥内容。主机需重新登录以刷新附加组，再加载配置。

安装器不安装模型 CLI、不复制用户模型认证或 SSH 私钥，不改用户全局配置。需要现有 openssh-server、Python 3、ACL 工具，以及常规 Linux 账号工具。

## 路径和文件权限

| 内容 | local | agent-ssh |
|---|---|---|
| 数据库/附件 | CARDIGAN_DATA_DIR，0700 | 同左，agent 无权访问 |
| 运行目录 | data/runs/project/assignment | agent-root/runs/project/assignment |
| 基础 clone | data/agent/repos/project | agent-root/repos/project |
| worktree | data/agent/worktrees/project/assignment | agent-root/worktrees/project/assignment |
| 运行目录/文件 | 0700 / 0600；脚本 0700 | 2770 / 0660；脚本 0770，共享组仅两个账号 |

project_id/assignment_id 在参与路径构造前验证。agent-root 必须在 data 及主机私有 home 之外。运行目录父层由主机控制；文件写入必须防范已有 Agent 放置的软链接/硬链接，不能直接追随共享目录中的链接覆盖主机文件。token/secrets 文件仅放必要的启动材料，包装脚本读取后删除。

## Runtime 路由

hc 0.1.18 的 run/exec 支持 `--on <machine>`，get/send/events/interrupt/kill/rm 则使用 `<machine>/<terminal>` 地址；向这些命令添加不存在的 --on 参数会失败。适配器在两种语法下都只能选择配置的隔离 machine；其他 machine 引用直接拒绝。

host 侧 hc core 仍负责控制面聚合，Agent 终端及远端 hc 在 agent 账号运行。注册通过 `hc machine add agent@localhost --via <专用 ssh 命令> --name <配置名> --session <专用远端 session>`，不执行 --install，也不替其他机器配置 SSH。读状态前继续检查 host core socket；实际连接和完整启动需用户安装后验收。

## 分批交付和验证

为满足约 800 行的 PR 限制，安装器与设计、Runtime 模式/路由、路径及文件权限接线分批交付。自动测试覆盖 dry-run 无副作用、归档校验、配置拒绝、命令参数、权限计算和共享文件安全写入。真实 sudo 安装、SSH 授权及隔离账号端到端由用户安装后，Claude 实测；自动检查不能替代这一项。
