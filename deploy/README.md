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

完成后，主机重新登录以取得共享组身份，再执行脚本打印的 runtime.env 加载命令。模型 CLI 需另装到 agent 可执行的目录，模型凭据通过启动配置按需注入；不要复制主机的整个 HOME 或 SSH 目录。

重复执行时保留专用私钥、复用托管账号和组，重设托管目录/授权文件的权限并验证 hc。工作区内容不会被递归清理。前置检查失败不做安装改动；真正执行系统命令时的 IO 失败或新建账号后的复核失败仍可能留下部分托管状态，可修正原因后用相同参数重跑。

本 PR 不执行 sudo。用户安装后再验证：agent 无 sudo、不能访问主机 home 和 Cardigan data；专用密钥可从 localhost 登录，其他密钥不能登录；agent-ssh 启动的终端 UID 为 agent；token/secrets 只由主机和 agent 读取并在启动后删除。
