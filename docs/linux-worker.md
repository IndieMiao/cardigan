# 接入一台 Linux worker

在已运行 Cardigan 的 Linux 控制主机上使用 `cardigan worker add/check/status`。向导读取主机私有 YAML，登记机器、生成配置草案，并检查 SSH、账号、目录、工具、资源限制和 HTTPS MCP。需要管理员权限的准备工作由人在 worker 上执行；向导只用 `sudo -n -l` 查询当前账号的授权，不执行特权命令、不请求密码、不安装软件、不签发 Token。

支持 Linux x64/arm64。下文的 `example`、`worker-a`、`cg_example`、域名及目录都是示例，请在私有配置中替换。每个项目使用不同的 UID、主组、HOME 和工作根；不要复用 CI 账号。控制主机与 worker 都准备同一版本的 Cardigan 发行文件，worker 的 root 持有源码目录以下用 `/opt/cardigan` 表示。

## 1. 控制主机：预览与私有配置

CLI 安装见 [部署说明](../deploy/README.md#安装-cardigan-命令)。使用人类终端，不设置 `CARDIGAN_TOKEN`、`MCP_TOKEN` 或 `--token-file`。项目需已存在：

```sh
cardigan project create example
cardigan worker add --project example --machine worker-a --host worker.invalid --dry-run
```

项目已存在时不用重复创建。`--dry-run` 不读配置、不打开数据库、不创建子进程、不写文件、不联网；它只列出步骤，实际检查使用 `check`。

配置目录默认为 `~/.config/cardigan`，可用 `CARDIGAN_CONFIG_DIR` 指定。目录必须由运行 CLI 的人持有、权限 0700，所有祖先都不能是符号链接或可被其它普通账号改写的目录：

```sh
export CARDIGAN_CONFIG_DIR="$HOME/.config/cardigan"
install -d -m 0700 "$CARDIGAN_CONFIG_DIR"
umask 077
ssh-keygen -t ed25519 -N '' -f "$CARDIGAN_CONFIG_DIR/worker-key"
```

这是控制主机专用的免交互 SSH 密钥；已有专用密钥时复用它，不覆盖。只将 `.pub` 公钥交给 worker 管理员。通过可信渠道从 worker 控制台取得 `/etc/ssh/ssh_host_ed25519_key.pub` 和指纹，核对后在私有 `worker-known-hosts` 文件中填写一行 `worker-a ssh-ed25519 <公钥>`，并设为 0600。`worker-a` 是后面的 `host_key_alias`。不将未经核对的 `ssh-keyscan` 输出直接当作信任依据。

创建 `$CARDIGAN_CONFIG_DIR/worker-worker-a-example.yaml`（0600）：

```yaml
version: 1
uid: 2201
home: /home/cg_example
mcp_url: https://control.example.ts.net/mcp
# 可选；默认取当前发行文件 deploy/hc-version.json 的固定版本
hc_version: 0.1.21
# 每次探测的总超时；默认 15000，可选 1000–60000 毫秒
timeout_ms: 15000
runtime:
  version: 1
  machines:
    - id: worker-a
      os: linux
      arch: x64 # arm64 机器填 arm64
      host: worker.invalid
      port: 22
      identity_file: /absolute/private/worker-key
      known_hosts_file: /absolute/private/worker-known-hosts
      host_key_alias: worker-a
      projects:
        - project_id: example
          user: cg_example
          gid: 2201
          alias: example-worker-a
          session: example-worker-a
          root: /srv/cardigan-workers/example
          path: /home/cg_example/.local/bin:/usr/local/bin:/usr/bin:/bin
          generation: initial
          mcp_url: https://control.example.ts.net/mcp
          mcp_timeout_ms: 10000
          publication:
            header_max_bytes: 65536
            file_max_bytes: 1048576
            batch_max_bytes: 8388608
            timeout_ms: 30000
          python: /usr/bin/python3
          file_helper: /srv/cardigan-workers/example/libexec/worker-files.py
          git_helper: /srv/cardigan-workers/example/libexec/worker-git.py
```

将 `identity_file` 和 `known_hosts_file` 改为上一步文件的**绝对路径**；YAML 不展开 `$HOME`、`~` 或其它变量。`host` 是 DNS 名或地址，不接受 `user@host`、SSH 配置别名的隐式设置或命令；账号、端口、身份文件和 host key 都显式填写。`--host` 如有提供，必须与 YAML 一致。默认文件名按 `worker-<机器>-<项目>.yaml` 查找，也可显式传 `--config <文件>`。

发布限额必须显式填写。上述试点建议为：头部 64 KiB、单文件 1 MiB、批次 8 MiB、发布超时 30 秒；它们只限制启动材料发布，不是附件大小或测试输出上限。按实际启动材料调整，向导不修改全局默认值。`mcp_timeout_ms` 是 RW-2 的启动鉴权超时，默认 10 秒；向导自身的 `timeout_ms` 默认 15 秒。两处 `mcp_url` 必须一致；项目绑定中省略时，草案会使用顶层地址补齐。

试点普通 Agent Run 并发上限设为 1。在控制主机私有 `$CARDIGAN_CONFIG_DIR/run-capacity.yaml` 中合入：

```yaml
machines:
  worker-a:
    limit: 1
    max_limit: 1
```

`machines.<机器>.limit` 是默认值，`max_limit` 是数据库覆盖值也不能超过的配置上界；因此两项一起设为 1。重载控制主机配置后，用 `cardigan machine show worker-a --project example` 核对返回的有效 `max_assignments`。该限制不改变常驻角色和人手显式启动的既有例外，不代替 worker 的 cgroup 限额，也不修改 CI 并发。

推荐账号命名 `cg_<项目短码>`，工作根 `/srv/cardigan-workers/<项目短码>`，每台物理机器固定一个机器编号；示例采用 `cg_example` 和 `/srv/cardigan-workers/example`。代码要求独立账号、组及互不重叠的根，不强制这一前缀。已有合法命名无需迁移。

## 2. worker：专用账号和安装布局

先核实示例 UID/GID 空闲、实际磁盘和资源预算。以下只适用于新建账号和新工作根；存在冲突时停下核对，不接管旧账号或递归修改旧数据。

```sh
sudo groupadd --gid 2201 cg_example
sudo useradd --uid 2201 --gid 2201 --home-dir /home/cg_example --no-create-home --shell /bin/sh cg_example
sudo install -d -o root -g cg_example -m 0750 /home/cg_example
sudo install -d -o root -g root -m 0755 /srv/cardigan-workers
sudo install -d -o root -g cg_example -m 0750 /srv/cardigan-workers/example
sudo install -d -o root -g cg_example -m 0750 /home/cg_example/.ssh /home/cg_example/.local /home/cg_example/.local/bin
sudo install -d -o cg_example -g cg_example -m 0700 /home/cg_example/.config /home/cg_example/.cache /home/cg_example/.local/state /home/cg_example/.local/share
```

将控制主机的公钥安装到该账号的 `.ssh/authorized_keys`，属主 root、组 cg_example、权限 0640；建议加 `restrict` 选项。确保 sshd 允许此账号公钥登录，账号不属于 sudo、docker、管理员或 CI 的组，sudoers 没有对其授权。不要给 worker 私钥或控制主机登录权限。

每次 add/check/resume 都重新查询该账号的 sudo 策略；只有明确的拒绝结果才能通过。直接授权、命令级授权、要求密码、sudo 缺失、查询超时或无法判定均阻塞，由管理员核对，不尝试执行任何获授权命令。目录检查同时覆盖 HOME 下 `.local`、`.local/bin`、`.ssh`、`authorized_keys` 和四个私有目录，拒绝访问/default ACL、符号链接、不符的属主或权限；ACL 无法读取也不会记为通过。

按现有 [项目账号安装合同](plans/C-281.md#操作员配置合同) 创建认领标记和安装器配置。以下脚本只写三个**新文件**；若文件已存在会停止，已有环境应先核对内容，保留原文件：

```sh
sudo install -d -m 0700 /etc/cardigan
sudo python3 - <<'PY'
import json, os
root = '/srv/cardigan-workers/example'
def create(path, value, mode):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    os.fchmod(fd, mode)
    with os.fdopen(fd, 'w') as out:
        json.dump(value, out)
create('/home/cg_example/.cardigan-project', {'project': 'example', 'uid': 2201}, 0o644)
create(root + '/.cardigan-worker', {'project': 'example', 'uid': 2201, 'home': '/home/cg_example'}, 0o600)
create('/etc/cardigan/worker.json', {
    'account': 'cg_example', 'uid': 2201, 'project': 'example', 'root': root,
    'mount': '/', 'volume': str(os.statvfs('/').f_fsid),
    'minimum_free_bytes': {'root': 1073741824, 'work': 1073741824},
    'timeout_ms': 15000
}, 0o600)
PY
sudo python3 /opt/cardigan/deploy/install-linux-worker.py --config /etc/cardigan/worker.json --check
sudo python3 /opt/cardigan/deploy/install-linux-worker.py --config /etc/cardigan/worker.json --apply
```

示例假设工作根位于根文件系统；若使用独立挂载，将 `mount` 和 `volume` 改为实际挂载点及其 `os.statvfs(...).f_fsid`。空间下限应按工作量配置。安装器检查账号、组、sudo 拒绝、ACL、挂载及现有文件冲突，再创建项目目录、锁及基础 helper；重复执行不会替换已有锁 inode。不要使用旧 `install-agent.py` 的整机安装入口来接管每项目账号。

## 3. worker：工具和 helper

准备 Python 3、Git、Node 24 及 pnpm 11（例如安装好 Node 后运行 `sudo npm install --global pnpm@11.7.0`），确认它们在 YAML 的 `path` 中。使用系统发行渠道或各工具官方固定版本；向导不代下载“最新版”。

hc 使用当前发行清单的 Linux 归档，复用现有下载和 SHA-256 校验函数。以下由操作员执行，只创建缺失的 hc 文件；与已有二进制不一致时停止：

```sh
sudo python3 - <<'PY'
import os, pathlib, platform, runpy
installer = runpy.run_path('/opt/cardigan/deploy/install-agent.py')
binary = installer['payload'](None, platform.machine())
for name in ('hc', 'herdr-core'):
    path = pathlib.Path('/home/cg_example/.local/bin') / name
    if path.exists():
        assert not path.is_symlink() and path.read_bytes() == binary
        continue
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o750)
    with os.fdopen(fd, 'wb') as out:
        out.write(binary)
        os.fchown(out.fileno(), 0, 2201)
        os.fchmod(out.fileno(), 0o750)
PY
sudo install -o root -g cg_example -m 0750 /opt/cardigan/deploy/worker-files.py /srv/cardigan-workers/example/libexec/worker-files.py
sudo install -o root -g cg_example -m 0750 /opt/cardigan/deploy/worker-git.py /srv/cardigan-workers/example/libexec/worker-git.py
```

基础 `worker-primitives.py` 由安装器安装。向导核验三个 helper 与控制主机发行文件的摘要、属主和权限，因此两边版本要一致。模型 CLI 和模型账号登录使用既有启动配置与凭据流程；它们不由接入向导复制，`worker check` 也不表示模型登录已经完成。

`file_helper`、`git_helper` 与固定的 `<工作根>/libexec/worker-primitives.py` 必须是三个不同路径；复用路径会在读取配置时拒绝，不能用同一个 helper 代替其它协议。

## 4. worker：资源与 MCP

使用 cgroup v2/systemd，为 worker 账号所在的 user slice 配置预算，CI 保留自己的账号和预算。例如核实余量后：

```sh
sudo systemctl edit user-2201.slice
```

填写经本机资源盘点确认的值，例如：

```ini
[Slice]
CPUQuota=100%
MemoryMax=4G
TasksMax=256
```

```sh
sudo systemctl daemon-reload
```

重新登录该 worker 账号后再检查。向导检查实际 SSH 探测进程及其 cgroup 祖先存在有限的 CPU、内存、任务数上限；它不配置限额，也不验证整个 CI 的资源隔离。hc 和实际 Run 的 cgroup 归属、CI 共存表现仍需现场核验。

worker 和控制主机需在同一 tailnet。控制主机管理员按 RW-2 的部署说明将 `/mcp` 通过 Tailscale Serve 代理到 Cardigan MCP 监听端口，保持服务只对 tailnet 可见；先用 `tailscale serve status` 核对现有路由，避免覆盖已有转发。将对应 `https://<主机>.<tailnet>.ts.net/mcp` 填入私有 YAML。只接受 HTTPS `/mcp`，不接受账号密码、查询参数或重定向。

向导从 worker 发送**不带 Token**的请求，TLS 验证开启，必须得到 401；200、403、404、重定向、证书错误、超时均阻塞。此步骤证明可达及未鉴权拒绝。RW-2 的运行目标 Token 鉴权检查负责真实启动鉴权；本向导不会签发测试 Token。RW-2 尚未部署时，先完成该部署再验证 MCP。

## 5. 控制主机：add、续跑、check 和 status

```sh
cardigan worker add --project example --machine worker-a --host worker.invalid
cardigan worker status --project example --machine worker-a
# 根据失败步骤的命令在 worker 上修复，然后继续：
cardigan worker resume --project example --machine worker-a
# 以后主动重新检查：
cardigan worker check --project example --machine worker-a
```

`add` 复用机器登记入口，新机器为 offline。它不会覆盖既有状态、容量、标签或运行时身份；登记冲突直接停止。每步打印 `passed` 或 `blocked`、固定原因码及下一操作。`resume` 和重复 `add` 都会重新核验所有事实，不凭旧 passed 跳过；成功的登记不会重复创建。

`check` 不登记机器、不创建配置草案、不改变启用状态，只做探测并更新接入记录。`status` 只读最后记录及其时间，不联网；记录中的 passed 不是实时健康状态。默认每个探测最多 15 秒，整个向导按步骤串行执行。

私有目录结构：

```text
$CARDIGAN_CONFIG_DIR/worker-onboarding/                 0700
  owner.lock                                           0600
  worker-a/                                            0700
    machine.binding                                    0600
    example.json                                       0600
    example.runtime-workers.yaml                       0600
```

machine.binding 只保存物理目标的身份/端点摘要，在登记前持久化，防止中断后被其它项目或编号重复认领。journal 只含版本、身份、配置摘要、操作编号、时间与步骤状态，没有 Token、配置正文、命令输出或 stderr。草案单独保存非秘密运行目标配置。写 journal 使用原子替换和 fsync，草案只允许首次创建；链接、异常权限、截断 journal 或并发运行均拒绝。已有草案也参与物理机器/项目配置冲突检查。

草案位于上述路径；向导**不修改**正式 `runtime-workers.yaml`。人核对后将草案中的机器/项目条目合入正式私有配置，保留其它机器和项目，文件权限 0600。草案包含 RW-2 的项目级 `mcp_url` 和显式发布限额；向导与 RW-2 作为同一版本部署，共用正式配置校验。已有远程条目缺少 MCP 地址时先由人迁移配置；向导不会忽略缺失或非法字段。生成的草案就是完整 `runtime-workers.yaml` 示例，顶层仅为 `version`、`machines`，不要把向导的 `uid/home/timeout_ms` 外层字段复制进去。机器启用、hc 注册及真实远程启动按远程启动功能的门禁执行，接入检查通过不会自动放行派发。

## 6. 常见阻塞

| 原因码 | 处理 |
|---|---|
| `worker_busy` | 另一向导持有配置锁；等其退出后再运行。进程退出自动释放锁，不删除锁文件 |
| `worker_config_invalid` / `worker_private_file_invalid` | 核对字段、绝对路径、0600 文件及 0700 私有目录；不从日志寻找原始配置 |
| `worker_identity_conflict` / `worker_config_conflict` | 参数与配置、既有登记/草案冲突；核对物理机器，保留旧绑定 |
| `worker_config_changed` | 输入与 journal 摘要不同；恢复原输入续跑。确需更换配置时，由人确认无活跃 Run、将该机器目录移至向导目录以外的私有归档目录，再重新 add；旧 Assignment 不改绑 |
| `worker_operation_failed` / `worker_journal_invalid` | 核对文件权限、链接及 journal 完整性；保留原记录供检查 |
| `worker_<步骤>_blocked` | 按该步骤的下一操作修复，再 resume；不会自动执行特权安装或降低检查要求 |

现场账号、SSH、TLS、hc/Run 与 CI 共存尚未验证时，应明确保留“未现场验证”；合成测试通过不能替代这些事实。
