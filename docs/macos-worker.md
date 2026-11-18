# 接入一台 macOS worker

在已运行 Cardigan 的 **Linux 控制主机**上使用 `cardigan worker add/check/status/resume`，接入 Darwin arm64（Apple Silicon）worker。向导只读探测，不安装软件、不执行特权操作、不请求密码、不签发 Token。Intel Mac 返回 `worker_macos_arm64_required`；不使用 Rosetta。

以下 `example`、`worker-a`、`cg_example`、UID/GID、域名及目录都是示例，实际值写私有配置。每个项目使用独立非管理员账号、组、HOME、工作根和 hc 状态，不复用个人桌面或 CI 账号。控制主机与 worker 使用同一版本 Cardigan 发行文件；Mac 上 root 持有的发行目录以下为 `/opt/cardigan`。

## 1. 控制主机：预览与私有配置

CLI 安装见 [部署说明](../deploy/README.md#安装-cardigan-命令)。在人类终端运行，不设置 `CARDIGAN_TOKEN`、`MCP_TOKEN` 或 `--token-file`：

```sh
# 项目已存在时不重复创建
cardigan project create example
cardigan worker add --project example --machine worker-a --host worker.invalid --dry-run
export CARDIGAN_CONFIG_DIR="$HOME/.config/cardigan"
install -d -m 0700 "$CARDIGAN_CONFIG_DIR"
umask 077
# 已有专用密钥时复用，不覆盖
ssh-keygen -t ed25519 -N '' -f "$CARDIGAN_CONFIG_DIR/worker-key"
```

`--dry-run` 不读配置、不打开数据库、不建子进程、不写文件、不联网。真实探测用 `check`。配置目录及祖先不得为链接或允许其它普通账号改写。通过可信渠道从 Mac 控制台取得 `/etc/ssh/ssh_host_ed25519_key.pub` 与指纹，核对后将 `worker-a ssh-ed25519 <公钥>` 写入私有 `worker-known-hosts`（0600）。只将控制主机 SSH 公钥交给 Mac 管理员，不自动信任 `ssh-keyscan`。

创建 `$CARDIGAN_CONFIG_DIR/worker-worker-a-example.yaml`（0600）：

```yaml
version: 1
uid: 2201
home: /System/Volumes/Data/Users/cg_example
mcp_url: https://control.example.ts.net/mcp
hc_version: 0.1.21
# 默认 15000；范围 1000–60000 毫秒
timeout_ms: 15000
launchd: # 旧服务标识；仅用于确认它已撤下，不再安装 LaunchDaemon
  label: dev.cardigan.example
  hc_path: /System/Volumes/Data/Users/cg_example/.local/bin/hc
runtime:
  version: 1
  machines:
    - id: worker-a
      os: macos # 也接受既有 darwin；登记及草案统一写 darwin
      arch: arm64
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
          session: cg
          retired_launchd_label: dev.cardigan.example
          root: /System/Volumes/Data/Users/cardigan-workers/example
          path: /System/Volumes/Data/Users/cg_example/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
          generation: initial
          mcp_url: https://control.example.ts.net/mcp
          mcp_timeout_ms: 10000
          publication:
            header_max_bytes: 65536
            file_max_bytes: 1048576
            batch_max_bytes: 8388608
            timeout_ms: 30000
          python: /opt/homebrew/bin/python3
          file_helper: /System/Volumes/Data/Users/cardigan-workers/example/libexec/worker-files.py
          git_helper: /System/Volumes/Data/Users/cardigan-workers/example/libexec/worker-git.py
```

将身份文件改为真实绝对路径；YAML 不展开变量、`~` 或 shell rc。`--host` 必须与配置一致。PATH 必须显式包含 `/opt/homebrew/bin`；hc 与 herdr-core 都指向下一节安装的签名 App 可执行文件。发布限额仅约束启动材料，沿用 Linux 向导合同；两处 MCP 地址必须一致。

macOS 省略 `session` 时，向导在草案中填入短名 `cg`；每项目独立账号和 HOME 保证状态分离。显式会话名保留，不自动改名。固定版本 hc 在未配置路径覆盖时使用 `HOME/.local/state/herdr-core/<session>/<session>.sock`，holder 使用同目录的 `<session>.holder.<8 位十六进制标识>.sock`。两条完整路径按 UTF-8 字节计算，macOS 上限均为 **103 字节**；holder 比主 socket 多 16 字节，主 socket 未超限也可能被拒绝。向导在草案与资源检查中拒绝超限，原因码为 `worker_macos_socket_path_too_long`。优先缩短 `session`，并按第 5 节重新确认配置；HOME 本身过长则由管理员重新规划独立账号目录。连接入口清除外部 XDG/HC 环境，并把 `HC_SOCKET` 固定为上述默认路径，避免本地 shell 或 hc 配置文件重定向 socket。

在控制主机私有 `$CARDIGAN_CONFIG_DIR/run-capacity.yaml` 合入并设文件权限 0600：

```yaml
machines:
  worker-a:
    limit: 1
    max_limit: 1
```

两项必须显式设置为正整数且 `limit <= max_limit`，向导不会接受其它机器条目或默认值代替。`max_limit` 约束数据库覆盖；示例为 1，可按实际预算调整。重载控制主机配置，再用 `cardigan machine show worker-a --project example` 核对有效 `max_assignments`。向导只能核对配置文件，不能证明运行中的控制主机已重载；常驻角色和人手显式启动的既有容量例外不变。

若同一台机器还能同时运行几个任务，可由人在该机器配置下增加 `resources`，例如 `resources: { ios.simulator: 1, blender: 2 }`。键为能力名（不带版本），值为正整数；未列出的资源不限。资源在同一物理机上跨项目共用。一个工作项即使多次声明同一能力，也只占一个名额；所需资源有一个已满，整个 Run 就留在原机排队，不会先占其它资源。显式启动也不能越过资源上限。修改后重载控制主机；不会抢占已开始的 Run。

## 2. worker：专用账号和安装布局

管理员先安装 Apple Command Line Tools（提供 Git/lipo）、原生 arm64 Python 3.12 或更新版本、Node 24、pnpm 11，开启系统设置中的远程登录并授权专用账号。先核实示例 UID/GID 和账号名空闲；以下只创建新账号，已有账号不要照抄修改：

```sh
sudo dscl . -create /Groups/cg_example
sudo dscl . -create /Groups/cg_example PrimaryGroupID 2201
sudo dscl . -create /Users/cg_example
sudo dscl . -create /Users/cg_example UniqueID 2201
sudo dscl . -create /Users/cg_example PrimaryGroupID 2201
sudo dscl . -create /Users/cg_example NFSHomeDirectory /System/Volumes/Data/Users/cg_example
sudo dscl . -create /Users/cg_example UserShell /bin/sh
sudo install -d -o root -g cg_example -m 0750 /System/Volumes/Data/Users/cg_example
sudo install -d -o root -g wheel -m 0755 /System/Volumes/Data/Users/cardigan-workers
sudo install -d -o root -g cg_example -m 0750 /System/Volumes/Data/Users/cardigan-workers/example
sudo install -d -o root -g cg_example -m 0750 /System/Volumes/Data/Users/cg_example/.ssh /System/Volumes/Data/Users/cg_example/.local /System/Volumes/Data/Users/cg_example/.local/bin
sudo install -d -o cg_example -g cg_example -m 0700 /System/Volumes/Data/Users/cg_example/.config /System/Volumes/Data/Users/cg_example/.cache /System/Volumes/Data/Users/cg_example/.local/state /System/Volumes/Data/Users/cg_example/.local/share
```

账号使用独占主组；macOS 目录服务会自动附带 `everyone`（GID 12）、`localaccounts`（61）、`_lpoperator`（100）。`id -Gn` 出现这三组本身不会阻塞接入，无需删除系统默认成员关系。向导、安装器和运行时隔离检查共用规则：核对系统账号库及本地 `dscl` 记录的组名、GID，并用 `dsmemberutil getuuid -G` 交叉核对 UUID；`GroupMembership` 中显式列出账号（含别名）、`GroupMembers` / `NestedGroups` 中列出账号 UUID 都拒绝。组记录允许包含系统别名（如 everyone 的 BUILTIN\Everyone），但必须含预期组名。everyone/localaccounts 为隐式根组，不接受嵌套；_lpoperator 至少直接嵌套其中一个根组，其它嵌套组（如 _lpadmin→admin）用 `dsmemberutil checkmembership` 按 UUID 核查递归成员关系，只有明确确认账号不是成员才接受。目录服务不可读、必要身份字段缺失或身份不符时拒绝，不仅凭组名放行。Linux 仍只允许主组。

按 Q-870，另允许系统公共文件夹组 `com.apple.sharepoint.group.<数字>`，编号和 GID 可因机器而异。必须通过上述组名/GID/UUID 身份核验，无本账号名、别名或 UUID 的直接成员关系，且 `NestedGroups` 非空、仅直接引用已核验的 everyone/localaccounts。显式加入共享组、空或未知嵌套、混合其它组、循环、自定义递归或经过 _lpoperator 间接继承都拒绝；不自动修改共享配置。

账号不得属于 admin、wheel、staff、com.apple.access_ssh、其它项目组或有 sudo 授权；这些组即使嵌套 everyone 也不放行。SSH 远程登录策略如额外加入组会被检查拒绝，应由管理员调整授权方式，不能绕过专用组检查。将控制主机公钥安装为 `.ssh/authorized_keys`，root:cg_example、0640，建议加 `restrict`。账号登录、模型订阅登录由人在现场完成，不在命令行或项目中保存密码。

这些组表示系统默认的通用、本地账号、打印及公共文件夹共享成员关系，不是管理员授权；系统打印和公共共享访问能力仍然存在，不能视作“无任何系统权限”。它们不能用作项目私有目录的共享组或 ACL 授权依据。项目命名空间仍须独占主组、0750，私有目录仍须 0700 且无 ACL；不得给这些组增设 sudo、远程访问或其它特权授权。元数据检查不能证明整台机器无额外授权，现场仍须核对系统策略，并按既有 B8 流程以合成目录完成同机项目账号双向读、列举、写和 socket 拒绝实测；未实测不登记隔离通过。

`dscl` 与系统账号库、实际进程 UID/GID/组必须一致；sudo 只执行 `sudo -n -l` 查询，并要求明确拒绝。目录通过 stat/openat 和 Darwin ACL API 核验；不使用 Linux ACL 工具。HOME 与命名空间为 root 持有，私有状态/项目叶目录为专用 UID 持有。遇到 ACL 或父链冲突先核对，不递归改写已有个人目录。

创建安装器所需的新标记和配置；三个文件已有任意一个就停止并人工核对：

```sh
sudo install -d -o root -g wheel -m 0700 /Library/Cardigan
sudo /opt/homebrew/bin/python3 - <<'PY'
import json, os
root = '/System/Volumes/Data/Users/cardigan-workers/example'
def create(path, value, mode):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    os.fchmod(fd, mode)
    with os.fdopen(fd, 'w') as out:
        json.dump(value, out)
create('/System/Volumes/Data/Users/cg_example/.cardigan-project', {'project': 'example', 'uid': 2201}, 0o644)
create(root + '/.cardigan-worker', {'project': 'example', 'uid': 2201, 'home': '/System/Volumes/Data/Users/cg_example'}, 0o600)
# APFS 的 /Users 位于 Data 卷；mount 填实际挂载点，volume 取该挂载点的 f_fsid。
mount = '/System/Volumes/Data'
create('/Library/Cardigan/worker.json', {
    'account': 'cg_example', 'uid': 2201, 'project': 'example', 'root': root,
    'mount': mount, 'volume': str(os.statvfs(mount).f_fsid),
    'minimum_free_bytes': {'root': 1073741824, 'work': 1073741824},
    'timeout_ms': 15000
}, 0o600)
PY
sudo /opt/homebrew/bin/python3 /opt/cardigan/deploy/install-macos-worker.py --config /Library/Cardigan/worker.json --check
sudo /opt/homebrew/bin/python3 /opt/cardigan/deploy/install-macos-worker.py --config /Library/Cardigan/worker.json --apply
```

安装器核对挂载/卷、空间、账号、认领标记及文件冲突，创建项目目录、锁和基础 helper，重复执行不替换锁 inode。示例使用 Data 卷下的规范物理路径，避免 `/var`、`/etc` 符号链接及 `/Users/Shared` 的可写 sticky 父链；实际卷布局不同则同步调整 HOME、root、mount 和认领标记，不更改系统共享目录权限。

`mount` 必须是工作根实际所在卷的挂载点，可先用 `/sbin/mount` 核对；`volume` 填在本机对该挂载点读取的 `str(os.statvfs(mount).f_fsid)`，不要照搬其它机器或卷的值。APFS firmlink 下 `/`、`/System/Volumes/Data` 与 `/Users` 的 `st_dev` 可能相同，Python `os.path.ismount('/System/Volumes/Data')` 也可能返回假；安装器因此用系统 `statfs64` 的挂载点及 `f_fsid` 核验。Data 卷工作根应继续填写 `/System/Volumes/Data`，不能改填 `/` 和系统卷编号来绕过检查。外置卷须已挂载，工作根须位于声明的挂载点之下且属于同一卷；卷身份不符或根盘、工作盘任一空间不足都会停止。

## 3. worker：工具和 helper

在专用账号的显式 PATH 下核验 Node 24、pnpm 11、Git、Python、hc；向导先用 Apple `lipo` 核对 arm64，再运行版本检查。允许 arm64、Apple 原生 arm64e，以及包含这两类切片的 universal 二进制；拒绝 x86-only、未知脚本解释器或 Node 实际架构不符。不要从个人 shell rc 借 PATH。

由人在 Mac 现场安装固定签名 App。归档地址与 SHA-256 **只取当前发行的 `deploy/hc-version.json` 中 `macos-aarch64`**；不要使用 Intel 包或 `machine add --install` 代装：

```sh
# 在 Mac 的普通操作员终端下载到新目录，不覆盖已有文件
/opt/homebrew/bin/python3 - <<'PY'
import hashlib, json, pathlib, tarfile, tempfile, urllib.request
m = json.loads(pathlib.Path('/opt/cardigan/deploy/hc-version.json').read_text())
target = m['targets']['macos-aarch64']
root = pathlib.Path(tempfile.mkdtemp(prefix='cardigan-hc-'))
archive = root / 'hc.tar.gz'
request = urllib.request.Request(target['url'], headers={'User-Agent': m['download_user_agent']})
with urllib.request.urlopen(request, timeout=30) as source, archive.open('xb') as out:
    while chunk := source.read(65536): out.write(chunk)
assert hashlib.sha256(archive.read_bytes()).hexdigest() == target['sha256']
with tarfile.open(archive) as tar: tar.extractall(root / 'unpacked', filter='data')
print(root / 'unpacked' / 'Herdr Core.app')
PY
```

管理员先核对现有 `/Applications/Herdr Core.app`，未安装才将上述已验证的 App 安装到该位置（保留签名和目录结构，root 持有；不要覆盖其它人在用的版本）。用系统签名工具验证：

```sh
codesign --verify --deep --strict -R '=anchor apple generic and identifier "dev.herdr.core" and certificate leaf[subject.OU] = "2W9652Q7QR"' '/Applications/Herdr Core.app'
# 仅创建缺失链接；已存在时先核对，ln 不加 -f
sudo ln -s '/Applications/Herdr Core.app/Contents/MacOS/herdr-core' /System/Volumes/Data/Users/cg_example/.local/bin/hc
sudo ln -s '/Applications/Herdr Core.app/Contents/MacOS/herdr-core' /System/Volumes/Data/Users/cg_example/.local/bin/herdr-core
sudo install -o root -g cg_example -m 0750 /opt/cardigan/deploy/worker-files.py /System/Volumes/Data/Users/cardigan-workers/example/libexec/worker-files.py
sudo install -o root -g cg_example -m 0750 /opt/cardigan/deploy/worker-git.py /System/Volumes/Data/Users/cardigan-workers/example/libexec/worker-git.py
```

`worker-primitives.py` 由安装器安装，三个 helper 必须为不同路径且与控制主机发行文件摘要一致。App 首装及首次局域网许可必须由人在**专用账号**的现场会话完成；允许局域网访问后再验证无头服务。原因码 `worker_macos_app_setup_required` / `worker_macos_local_network_required` 指向这一步。向导不点击许可、不关闭 Gatekeeper/SIP、不申请无关的录屏或辅助功能权限；检查通过不表示模型账号已登录。

## 4. worker：核心所有权、资源与 MCP

固定采用 **hc 经 SSH 自管核心**，不再安装系统 LaunchDaemon。控制主机的 Darwin hc 注册入口只执行签名 App 内的 `connect --session <绑定会话>`，保留真实 `SSH_CONNECTION`，清理其它继承环境。hc 自己负责脱离 SSH 进程、会话锁和核心恢复；控制主机不另行 `serve`、删除 socket/lock 或接管旧进程。没有图形会话也不伪造一个图形登录。首装/许可、注销/重启后的实际可用性仍需现场核验。

hc **v0.1.21** 源码固定提交为 `1b0393f80c35b1dae34f37934d33d0144a8fc8d7`（Apache-2.0），核对结果如下：

| 机制 | 核对结果与源码 |
|---|---|
| connect | [cli.rs](https://github.com/herdrdev/herdr-core/blob/1b0393f80c35b1dae34f37934d33d0144a8fc8d7/crates/herdr-core/src/cli.rs#L700) 调用 connect_for_app；[macos_session.rs](https://github.com/herdrdev/herdr-core/blob/1b0393f80c35b1dae34f37934d33d0144a8fc8d7/crates/herdr-core/src/platform/macos_session.rs#L56) 在非 GUI 会话使用 connect_or_start。Unix 没有 no-autostart 参数/环境开关；HC_RUNTIME 不是禁止启动开关 |
| serve 与 GUI launchd | [macos_launchd.rs](https://github.com/herdrdev/herdr-core/blob/1b0393f80c35b1dae34f37934d33d0144a8fc8d7/crates/herdr-core/src/platform/macos_launchd.rs#L119) 在真实 SSH 环境跳过 GUI launchd；其它入口尝试 gui/UID，成功则当前进程退出，失败才直接运行。直接把 serve 放在 KeepAlive 下不能保证它永远前台常驻 |
| SSH 持久化 | [unix.rs](https://github.com/herdrdev/herdr-core/blob/1b0393f80c35b1dae34f37934d33d0144a8fc8d7/crates/herdr-core/src/platform/unix.rs#L201) spawn_detached 调用 setsid、stdin/stdout 接 /dev/null，stderr 写 core.log；[macos_launchd.rs](https://github.com/herdrdev/herdr-core/blob/1b0393f80c35b1dae34f37934d33d0144a8fc8d7/crates/herdr-core/src/platform/macos_launchd.rs#L148) 明确保留 SSH 启动的这一生命周期 |
| 锁与残留 socket | [client.rs](https://github.com/herdrdev/herdr-core/blob/1b0393f80c35b1dae34f37934d33d0144a8fc8d7/crates/herdr-core/src/client.rs#L85) 先连接，失败后核对其它 socket、等待 core.lock，再尝试启动；[server.rs](https://github.com/herdrdev/herdr-core/blob/1b0393f80c35b1dae34f37934d33d0144a8fc8d7/crates/herdr-core/src/server.rs#L43) 只有抢到锁的 serve 才绑定 socket，输家以 0 退出；[unix.rs](https://github.com/herdrdev/herdr-core/blob/1b0393f80c35b1dae34f37934d33d0144a8fc8d7/crates/herdr-core/src/platform/unix.rs#L91) 由胜者移除旧 socket 再绑定。不能人工删持有中的 core.lock，否则会破坏互斥 |
| 核心退出 | [holder.rs](https://github.com/herdrdev/herdr-core/blob/1b0393f80c35b1dae34f37934d33d0144a8fc8d7/crates/herdr-core/src/holder.rs#L436) 有终端时自带延迟恢复；无 holder 时下一次 connect 启动。故即便另写只连 socket 的代理，也不足以保证外部 LaunchDaemon 是唯一监管者 |

向导和每次新的 hc SSH 连接均只读检查旧服务：`/Library/LaunchDaemons/<label>.plist` 必须不存在（符号链接也拒绝），`launchctl print system/<label>` 必须返回 113，错误明确为 `Could not find service "<label>" in domain for system`。权限不足、超时、其它错误、服务仍加载或只停服务但保留 plist 均拒绝。此检查不自动卸载或删除服务。

`launchd.label` 现在表示需要撤下的旧服务，须与绑定 `retired_launchd_label` 相同；绑定未填时默认 `dev.cardigan.<项目编号>`。新机器也保留这一检查，防止以后误装旧示例。自定义旧服务须填写实际 label；其它同账号的外部 hc 启动服务也由操作员撤下。机器检查连接的是本项目独立账号和绑定 session；Linux 入口与已有 alias 原样保留。

### 从旧 LaunchDaemon 迁移（张良现场执行）

以下全部为示例值，替换成私有配置实际值。先在控制主机执行 `cardigan machine drain worker-a --project example`，等待本机全部活跃 Run/会话按正常流程结束；有未确认退出的会话时不要继续。停用远程派发，保存旧配置。迁移会改变 Darwin 目标指纹，不能把旧 runtime_ref 改绑到新会话。

在 Mac 管理员终端核对旧 label 后，卸载服务并把 plist 归档到 LaunchDaemons 目录以外（目标目录必须是本次新建的；已有目录时停下核对）：

```sh
sudo mkdir -m 0700 /var/root/cardigan-core-migration
sudo launchctl bootout system/dev.cardigan.example
sudo mv /Library/LaunchDaemons/dev.cardigan.example.plist /var/root/cardigan-core-migration/
launchctl print system/dev.cardigan.example
```

预期最后一条返回 113 且显示上述 service not found。若服务原本没有加载，先确认这一事实再归档文件，不用重启服务来凑流程。不要删除 hc 状态目录、终端数据或 core.lock。

在专用账号的真实 SSH 会话中，用与旧核心一致的 HOME/session/socket 执行 `hc server stop`（该命令对不存在的核心不自举）；核对旧核心退出。已经缩短 session 时也核对原会话，勿留下另一个 session 的活跃终端。运行配置与向导配置填写相同的新 session、retired_launchd_label 和新 generation，保持远程派发关闭，然后按第 5 节确认配置。

```sh
# 在专用账号 SSH 会话中；示例旧 session 为 cg，按实际旧值替换
HC_SESSION=cg HC_SOCKET="$HOME/.local/state/herdr-core/cg/cg.sock" \
  '/Applications/Herdr Core.app/Contents/MacOS/herdr-core' server stop
```

控制主机用**与服务相同的本地 hc 环境**查看 `hc machine ls --json`。旧 Darwin alias 的 target 与新入口不同，会故意报 `invalid_launch`，不会自动覆盖。确认该 alias 没有任何活跃引用后执行 `hc machine rm example-worker-a`（仅忘记连接登记，不停止远端终端），重载控制主机配置，再执行 `cardigan machine check worker-a --project example`，由新入口登记。不要执行 `hc machine update`，它会尝试安装/升级远端二进制；本卡没有更改 hc 版本。

### 现场验收与预期输出

1. `cardigan worker check --project example --machine worker-a`：九步均 passed；resources 不再要求常驻 LaunchDaemon。`launchctl print system/<旧 label>` 仍是明确的 113。保留失败原始日志供排查，不把任意非零当成服务不存在。
2. 完成远程启动原有前置并启用私有开关后，用 `cardigan machine update worker-a --project example --status online` 恢复接单，连续执行三次 `cardigan machine check worker-a --project example`：均 `launch_enabled=true`，不出现 runtime_timeout/runtime_unavailable。关闭所有管理 SSH 连接再检查一次；用专用账号 `ps -u <账号> -o pid,ppid,command` 核对该 session 只有一个 serve 核心（connect 可有多个，holder 不是重复核心），core.log 没有本次新增 GUI bootstrap 125。不同 session 不算同一核心。
3. 仅在无活跃终端时，用专用账号的同 HOME/session/socket 环境执行 `hc server stop`，再运行 machine check：恢复成功，新核心唯一。不要手工制造或删除生产 socket；残留 socket 与锁争用由确定性夹具覆盖。
4. 发起一个正常空 Run，确认模型凭据、MCP、工作目录和完成回报均正常；保留 run_id。待该 Run 完整退出后测试锁屏、注销和重启，再 machine check；重启后首次连接按需启动，不要求开机预先运行 hc。
5. 修改向导私有 YAML 的合法配置后先 resume：预期 worker_config_changed 和带新摘要的确认命令；核对后执行该命令，旧记录留档、所有步骤重查。错误摘要不能通过，物理机器/已应用配置冲突不能绕过。

现场结果须记录软件 SHA、hc 版本、命令/退出码、三次检查与断开 SSH/重启的结果；本卡本地的 Python/Unix socket 合成夹具不等于真实 Mac 实测通过。

macOS 没有 Linux cgroup 的 CPU/内存硬隔离。Run 并发上限及 Background 优先级只表达各自限制，不保证共用 CI 隔离；需要硬隔离的共享模式不在支持范围。每 Run 测试并发按主机限流配置执行，不用压测验证。

MCP 与 [Linux worker](linux-worker.md#4-worker资源与-mcp) 相同：worker 与控制主机加入同一 tailnet，管理员核对 Tailscale Serve 的 HTTPS `/mcp` 转发及来源权限。向导从 worker 发无 Token 请求，要求 TLS 验证成功且返回 401；启动时另做真实鉴权。200/403/重定向/证书错误/超时都不能算通过，不降低为 HTTP。首次局域网许可失败请现场处理，不把 401 等同于 GUI/TCC 已验收。

## 5. 控制主机：add、续跑、check 和 status

```sh
cardigan worker add --project example --machine worker-a --host worker.invalid
cardigan worker status --project example --machine worker-a
cardigan worker resume --project example --machine worker-a
cardigan worker check --project example --machine worker-a
```

新机器登记为 offline；已有身份/状态/容量/标签保持原值。`resume`、重复 `add` 和 `check` 都重新核验事实，`status` 只显示 journal 历史。配置摘要改变会拒绝续跑并给出 `worker resume --confirm-config <当前完整摘要>`。先核对新旧配置、确认没有旧目标的活跃引用；如已应用的 runtime-workers.yaml 与新配置冲突，先由操作员按停派发/清退旧会话流程核对并同步，确认参数不会绕过冲突。再执行打印的确认命令：旧 journal 与草案保存为新的 `*.history.json`，仅替换本项目草案，全部步骤重查；不能用旧 passed 代替现场事实。确认后的中途失败可 resume；若写草案前进程崩溃，重新执行同一确认命令。`check` 不登记、不发布草案、不启用远程派发。

journal 与草案在 `$CARDIGAN_CONFIG_DIR/worker-onboarding/worker-a/`，目录 0700、文件 0600，沿用 [Linux 向导的恢复合同](linux-worker.md#5-控制主机add续跑check-和-status)。管理员核对草案后才合入 `runtime-workers.yaml`，保留其它机器/项目；`allow_remote_launch` 仍须按远程启动门禁显式启用。检查通过不会自动启用机器或改变 Assignment。

## 6. 常见阻塞与现场跟进

| 原因码 | 处理 |
|---|---|
| `worker_macos_arm64_required` | Intel Mac 不支持；不要用 Rosetta |
| `worker_launchd_config_invalid` | 核对 launchd label、hc_path 和显式 Homebrew PATH |
| `worker_macos_socket_path_too_long` | 缩短绑定 session 并重新确认配置；按实际 HOME 核对 socket 与 holder 均不超过 103 字节 |
| `worker_account_blocked` / `worker_directories_blocked` | 核对目录服务、实际 UID/GID/组、sudo 拒绝、父链/ACL 和安装布局 |
| `worker_tools_blocked` / `worker_macos_app_setup_required` | 核对原生二进制、固定版本签名 App、链接和现场许可 |
| `worker_resources_blocked` / `worker_macos_core_owner_or_capacity_required` | 核对显式 Run 容量、重载状态与旧 LaunchDaemon 已卸载且 plist 已归档 |
| `worker_mcp_blocked` / `worker_macos_local_network_required` | 核对 HTTPS/TLS、tailnet、现场局域网许可和未鉴权拒绝 |
| `worker_config_changed` / `worker_config_confirmation_invalid` | 核对后使用错误提示中的当前摘要确认命令；旧记录保留，重跑全部检查 |
| `worker_config_conflict` | 核对物理身份、其它项目或已应用配置冲突；确认参数不能绕过，也不改绑活跃 Assignment |

本卡自动测试均为合成夹具，**未现场验证 Mac**。合并后由 human_action 跟进：专用账号安装/许可、无桌面登录及锁屏/重启后的核心、add/check/resume、空 Run、真实开发 commit/回传/同 SHA 预检、失联后准确退出证明。现场结果分别记录；未知退出保留占用，不建第二个 Run，不把本向导当作接管授权。
