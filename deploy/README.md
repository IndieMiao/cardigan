# Agent 专用账号（M2.7）

Linux 安装前先阅读 [ADR 0002](../docs/adr/0002-agent-account-isolation.md)。脚本会配置 agent 账号、专用组/SSH 密钥、hc 0.1.18 和私有/共享目录。它不会修改 `~/.ssh/config` 或 sshd 全局配置。

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

## 界面验收用的去敏快照（C-267）

Agent 只能读这份去敏快照，不能读生产库或生产附件目录。快照由人在主机上用自己的账号生成（主机账号需属于 `cardigan-share` 组，才能把文件属组设为该组）：

```sh
cardigan review-snapshot create --project cardigan \
  --out /srv/cardigan-agent/shared/review-snapshots
```

- 命令只能由人运行，Token 模式下拒绝；没有 MCP 或 HTTP 入口。先按需手动执行，以后可以交给主机运维定期执行，但仍须由人运行或经人授权。
- `--out` 也可用环境变量 `CARDIGAN_REVIEW_SNAPSHOT_DIR`；`--group` 默认 `cardigan-share`；`--data-dir` 默认同其它命令。
- 生产库只读打开，在 0700 私有临时目录里备份并去敏，结束后删除临时目录。去敏范围：凭据和可还原凭据的数据、指定项目以外的全部数据、敏感卡片的标题、正文、评论和附件（只留编号和状态骨架）、成员个人信息、主机路径、机器名、IP 和邮箱；附件文件不复制，只保留元数据。详细规则见开发方案 §14 的 C-267。
- 发布前强制扫描，任何命中都不发布，退出码非 0，并列出命中的规则和表 / rowid / 列位置（不输出原值）。
- 发布结果：`<out>/current/cardigan.db` 与 `<out>/current/manifest.json`，文件 0640、目录 0750、属组 `cardigan-share`。`current` 和 `previous` 是符号链接，指向 `<out>/snapshots/<时间戳>/`，每次发布原子替换 `current`，上一份保留为 `previous`，更早的删除；`current` 或 `previous` 是普通文件或目录时拒绝发布，不改动现有快照。需要回退时，把 `current` 链接改回 `previous` 的目标即可。
- 审核员使用时先复制到自己的临时目录再打开，例如 `cp <out>/current/cardigan.db "$TMPDIR/review.db"`；迁移在打开副本时自动执行。不要直接打开共享目录里的文件。
