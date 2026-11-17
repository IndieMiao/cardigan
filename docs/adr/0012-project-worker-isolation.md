# ADR 0012：每项目、每机器独立执行账号

- 状态：C-281 实现；Linux/macOS 双向现场验收未完成，远程启动保持关闭
- 依据：P2b §4.3、§4.7、卡 07；Q1=A
- 日期：2026-11-17

## 决定与边界

Linux/macOS 每个 `(project, machine)` 使用独立非管理员 UID。目录名、session 或单账号 ACL 不能隔离同 UID 的进程，不采用单账号强制沙箱。已有账号只能由操作员显式认领一个项目；不自动迁移目录归属、复制个人认证或接管旧终端。同项目多个 Assignment 共享 UID 是接受的边界，不保证隐藏世界可读系统文件或全部进程名。

控制主机独占数据库、中心仓库、Git 网络凭据及 SSH 私钥；Worker 无 SSH agent 转发、反向 SSH 凭据。账号隔离不等于网络沙箱，网络方向限制和 HTTPS 授权必须另外验收。CI 的一目标一项目账号规则不变；与 Agent 共用物理机时，检查根、缓存、SSH 凭据目录、hc 必须双向隔离。

## 可信映射与物理容量

控制主机私有 `runtime-workers.yaml` 唯一解析项目、物理机器到账号、SSH 入口及 hc alias/session。卡片和 RuntimeRef 不携带可自选的账号或路径。现有解析器拒绝重复账号、组、alias 和重叠根；loopback 的多种拼写也不能登记为多个机器。任意 DNS 别名代表同物理机的事实仍由操作员核实，不把不同主机名当新增容量授权。

现场核对目录服务实际 UID，包括同 UID 的其它用户名、主组占用及显式附加组；发现别名 UID、共享主组、其它成员或 admin/sudo/wheel 身份即拒绝。机器与 Run 容量仍按原物理 machine_id 计数。目标映射变化继续由既有目标指纹拒绝旧 ref，不修改历史目标。

实际执行链上的采样还核对进程真实/有效 UID、真实/有效 GID 和继承的附加组；只允许该项目 UID/主组，组查询失败即拒绝。Linux 使用进程组查询，macOS 使用原生 `getgroups`，避免 Python 重新查询目录服务的兼容行为。目录服务撤组不会撤销旧登录/hc 进程的权限，操作员须处理旧进程并从实际执行链重新采样，不能用一个新 SSH 登录的通过结果替代旧 hc 进程核验。

同 UID 别名/主组占用检查要求目录服务能完整枚举账号和组。现场应使用可完整枚举的本地账号；LDAP/NIS 等网络目录禁用枚举时，空的冲突列表不能证明隔离，须另取得完整 UID/GID 索引核对证据。无法确认枚举完整性时不得登记 B8 通过。

## 权限与安装

新项目使用 `install-linux-worker.py` / `install-macos-worker.py`，两者共用只读 preflight、dry-run 和幂等目录安装逻辑。账号、独立主组、home、工作根及授权入口由操作员预置；安装器不创建账号、不修改 SSH 策略、不自动认领账号。

- home 与工作根由 root 持有，项目主组可遍历，0750；其祖先不可由项目账号替换，不允许共享可写或 sticky 临时命名空间、symlink 或额外 ACL。
- home 中 root 持有的 `.cardigan-project` 为 0644，只包含 `{project, uid}`；工作根 `.cardigan-worker` 为 root 0600，绑定 `{project, uid, home}`。更换项目必须显式重新核对，不静默覆盖声明。
- `.ssh` 为 root:项目组 0750，`authorized_keys` 为 root:项目组 0640；自检只读元数据，不读取其内容。SSH 授权来源、无 sudo 与严格 host key 仍需操作员检查。
- `.local` 由 root 持有，`.config`、`.cache`、`.local/state`、`.local/share` 由项目 UID 持有，0700。每账号单独初始化 hc App、局域网/TCC 和 CLI 登录，不复制个人认证。
- 工作根的 runs/repos/worktrees/builds 命名空间由 root 持有，每个 `<项目>` 叶子归项目 UID，0700。cache/generated/evidence/temporary 归项目 UID，0700；普通材料 0600，可执行脚本 0700。helper 和锁 inode 由 root 持有。
- hc core/socket/session 按账号分开；socket 位于项目私有 hc 目录，必须为该 UID/GID 的 socket 且 group/other 无权限。同名终端不改变 Unix socket 的访问边界。
- 启动包装器覆盖 TMPDIR/TMP/TEMP、XDG_CACHE_HOME、npm cache 和 pnpm store 的环境默认值，使用 Assignment 私有目录。项目可以修改自己的状态，不得通过默认 ACL 或共享可写缓存获得其它项目的权限。

只读工具/SDK 可共用，认证、会话、缓存和构建写状态不可共用。因此每账号重复 CLI 授权、App 首启、缓存及磁盘预算是明确成本。旧 Linux 共享布局只保留既有单项目兼容；需要共享组的历史本地路径必须每项目一个主机/Agent 专用组，不与 CI 或其它项目共享。新 worker 入口使用私有布局，不自动转换历史安装。

## 检查与放行

`worker-primitives.py isolation` 在实际项目 UID 下采样账号、认领标记、home/授权命名空间、九类路径及 socket。Linux 检查 POSIX access/default ACL，macOS 使用原生 ACL 接口，无法观测时失败关闭。检查失败只返回固定类别，不输出路径、凭据或原生错误。

`worker-preflight.mjs` 将现场采样与可信控制主机登记的 B8 双向证据一起校验。证据绑定 UID、精确工具组合及隔离路径清单摘要；缺失、清单变化、错误项目/UID 或观测失败均产生 `project_isolation`，不能用单纯 mode 或 mock 放行。控制主机只能在操作员提交完整现场结论后登记证据引用，项目传来的 ready/verified 不可信。

本卡保留既有远程启动关闭状态。C-282 接入健康/启用时必须调用完整 preflight，并把目标指纹纳入组合摘要；安装成功或单独采样通过不授权远程启动。未配置 remote 的 local 行为不变，领域编号 `local` 合法；无账号隔离的执行模式只供开发。

现场步骤与未覆盖项目见 [C-281 交付说明](../plans/C-281.md)。双 OS 各至少两个合成项目双向测试，并在 Linux 共机现场加入 CI：读/枚举/写源码、clone、运行材料、缓存、会话、合成凭据及检查根均拒绝；hc 同名终端只能控制本账号；SSH/HTTP 越权、错误 host key 和转发均拒绝。缺项不得登记完整 B8 证据。本卡的自动测试不能替代这些结论。
