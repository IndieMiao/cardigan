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
launchd:
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
          session: example-worker-a
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

在控制主机私有 `$CARDIGAN_CONFIG_DIR/run-capacity.yaml` 合入并设文件权限 0600：

```yaml
machines:
  worker-a:
    limit: 1
    max_limit: 1
```

两项必须显式设置为正整数且 `limit <= max_limit`，向导不会接受其它机器条目或默认值代替。`max_limit` 约束数据库覆盖；示例为 1，可按实际预算调整。重载控制主机配置，再用 `cardigan machine show worker-a --project example` 核对有效 `max_assignments`。向导只能核对配置文件，不能证明运行中的控制主机已重载；常驻角色和人手显式启动的既有容量例外不变。

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
# APFS 的 /Users 位于 Data 卷；按实际 stat/挂载结果填写，不照搬其它 Mac。
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
codesign --verify --deep --strict -R 'anchor apple generic and identifier "dev.herdr.core"' '/Applications/Herdr Core.app'
# 仅创建缺失链接；已存在时先核对，ln 不加 -f
sudo ln -s '/Applications/Herdr Core.app/Contents/MacOS/herdr-core' /System/Volumes/Data/Users/cg_example/.local/bin/hc
sudo ln -s '/Applications/Herdr Core.app/Contents/MacOS/herdr-core' /System/Volumes/Data/Users/cg_example/.local/bin/herdr-core
sudo install -o root -g cg_example -m 0750 /opt/cardigan/deploy/worker-files.py /System/Volumes/Data/Users/cardigan-workers/example/libexec/worker-files.py
sudo install -o root -g cg_example -m 0750 /opt/cardigan/deploy/worker-git.py /System/Volumes/Data/Users/cardigan-workers/example/libexec/worker-git.py
```

`worker-primitives.py` 由安装器安装，三个 helper 必须为不同路径且与控制主机发行文件摘要一致。App 首装及首次局域网许可必须由人在**专用账号**的现场会话完成；允许局域网访问后再验证无头服务。原因码 `worker_macos_app_setup_required` / `worker_macos_local_network_required` 指向这一步。向导不点击许可、不关闭 Gatekeeper/SIP、不申请无关的录屏或辅助功能权限；检查通过不表示模型账号已登录。

## 4. worker：资源、launchd 与 MCP

固定采用 **系统 LaunchDaemon + UserName**：专用账号无需保持桌面登录。`hc serve` 为本发行固定 hc 的前台入口，直接运行签名 App 内的二进制；不要用会退出的 `hc server start` 配 KeepAlive。首次安装/许可仍需现场，之后是否锁屏/注销/重启可用须实测。

管理员创建 `/Library/LaunchDaemons/dev.cardigan.example.plist`（root:wheel、0644），替换身份和 PATH 后用 `plutil -lint` 检查：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.cardigan.example</string>
  <key>ProgramArguments</key><array>
    <string>/Applications/Herdr Core.app/Contents/MacOS/herdr-core</string><string>serve</string>
  </array>
  <key>UserName</key><string>cg_example</string>
  <key>InitGroups</key><false/>
  <key>WorkingDirectory</key><string>/System/Volumes/Data/Users/cg_example</string>
  <key>EnvironmentVariables</key><dict>
    <key>HOME</key><string>/System/Volumes/Data/Users/cg_example</string>
    <key>PATH</key><string>/System/Volumes/Data/Users/cg_example/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
</dict></plist>
```

```sh
plutil -lint /Library/LaunchDaemons/dev.cardigan.example.plist
# 首次载入；已有服务先核对，不盲目卸载或重启活跃 worker
sudo launchctl bootstrap system /Library/LaunchDaemons/dev.cardigan.example.plist
launchctl print system/dev.cardigan.example
```

向导对照磁盘 plist 和已加载服务的参数、账号、目录、环境，并用 libproc 核实 hc 进程路径、有效/真实/保存 UID 与 GID 均等于专用账号/组，以及稳定启动身份；仅有 plist 或其它账号已启动 hc 均不通过。不自动 bootstrap/kickstart。配置不匹配、无法读取或进程身份/主组凭据变化均 blocked。磁盘 plist 已修正也不能代替旧 hc 进程实际凭据；管理员须在无活跃任务时按正常流程重载服务，再检查。

macOS 没有 Linux cgroup 的 CPU/内存硬隔离。Run 并发上限及 Background 优先级只表达各自限制，不保证共用 CI 隔离；需要硬隔离的共享模式不在支持范围。每 Run 测试并发按主机限流配置执行，不用压测验证。

MCP 与 [Linux worker](linux-worker.md#4-worker资源与-mcp) 相同：worker 与控制主机加入同一 tailnet，管理员核对 Tailscale Serve 的 HTTPS `/mcp` 转发及来源权限。向导从 worker 发无 Token 请求，要求 TLS 验证成功且返回 401；启动时另做真实鉴权。200/403/重定向/证书错误/超时都不能算通过，不降低为 HTTP。首次局域网许可失败请现场处理，不把 401 等同于 GUI/TCC 已验收。

## 5. 控制主机：add、续跑、check 和 status

```sh
cardigan worker add --project example --machine worker-a --host worker.invalid
cardigan worker status --project example --machine worker-a
cardigan worker resume --project example --machine worker-a
cardigan worker check --project example --machine worker-a
```

新机器登记为 offline；已有身份/状态/容量/标签保持原值。`resume`、重复 `add` 和 `check` 都重新核验事实，`status` 只显示 journal 历史。配置摘要改变会拒绝续跑，不能用旧 passed 代替现场事实。`check` 不登记、不发布草案、不启用远程派发。

journal 与草案在 `$CARDIGAN_CONFIG_DIR/worker-onboarding/worker-a/`，目录 0700、文件 0600，沿用 [Linux 向导的恢复合同](linux-worker.md#5-控制主机add续跑check-和-status)。管理员核对草案后才合入 `runtime-workers.yaml`，保留其它机器/项目；`allow_remote_launch` 仍须按远程启动门禁显式启用。检查通过不会自动启用机器或改变 Assignment。

## 6. 常见阻塞与现场跟进

| 原因码 | 处理 |
|---|---|
| `worker_macos_arm64_required` | Intel Mac 不支持；不要用 Rosetta |
| `worker_launchd_config_invalid` | 核对 launchd label、hc_path 和显式 Homebrew PATH |
| `worker_account_blocked` / `worker_directories_blocked` | 核对目录服务、实际 UID/GID/组、sudo 拒绝、父链/ACL 和安装布局 |
| `worker_tools_blocked` / `worker_macos_app_setup_required` | 核对原生二进制、固定版本签名 App、链接和现场许可 |
| `worker_resources_blocked` / `worker_macos_launchd_or_capacity_required` | 核对显式 Run 容量、重载状态、系统 LaunchDaemon 和 hc 进程归属 |
| `worker_mcp_blocked` / `worker_macos_local_network_required` | 核对 HTTPS/TLS、tailnet、现场局域网许可和未鉴权拒绝 |
| `worker_config_changed` / `worker_config_conflict` | 人工核对旧绑定；保留记录，不覆盖或改绑活跃 Assignment |

本卡自动测试均为合成夹具，**未现场验证 Mac**。合并后由 human_action 跟进：专用账号安装/许可、无桌面登录及锁屏/重启后的服务、add/check/resume、空 Run、真实开发 commit/回传/同 SHA 预检、失联后准确退出证明。现场结果分别记录；未知退出保留占用，不建第二个 Run，不把本向导当作接管授权。
