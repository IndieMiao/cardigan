# 接入一台 Linux worker

新设备按下面的“快速上手”接入：在设备上跑一行命令，在 Workbench 确认，设备自己完成初始化，检查通过后上线，用到哪个工具再装哪个。后面的“进阶/排障：手工接入”是原来的逐步手工路径，用于不走配对的接入、核对现场或排障。

支持 Linux x64/arm64。下文的 `example`、`worker-a`、`cg_example`、域名及目录都是示例，请在私有配置中替换。每个项目使用不同的 UID、主组、HOME 和工作根；不要复用 CI 账号。控制主机与 worker 都准备同一版本的 Cardigan 发行文件，worker 的 root 持有源码目录以下用 `/opt/cardigan` 表示。快速上手里的 `<Workbench>`、`<机器>`、`<项目>` 换成自己的 Workbench 地址、机器编号和项目编号。

Steam Deck 等根分区只读的设备另见 [SteamOS 设备接入](steamos-worker.md)；Mac 见 [macOS worker](macos-worker.md)。

## 快速上手：一行命令配对接入

| 步骤 | 在哪里 | 做什么 | 要 sudo |
|---|---|---|---|
| 0 | 控制主机、设备 | 一次性准备 | 设备上启用 SSH 服务要 |
| 1 | 设备 | 运行配对命令 | 不要 |
| 2 | 控制主机 | 登记设备的 SSH 主机公钥 | 不要 |
| 3 | Workbench | 确认接入、确认写入配置 | 不要 |
| 4 | 设备 | 运行一次性初始化脚本 | **要**（输入一次密码） |
| 5 | 设备 | 准备 hc、helper、基础工具和资源限额 | **要** |
| 6 | Workbench、控制主机 | 检查通过、开启远程派发、上线 | 不要 |
| 7 | Workbench、设备 | 按需装工具 | 见第 7 步 |

### 0. 准备（一次性）

控制主机（运行 Cardigan 的机器）：

- Workbench 经 Tailscale Serve 在 tailnet 内可以访问，下文写作 `https://<Workbench>`；MCP 地址同样对 tailnet 可见（见[第 4 节](#4-worker资源与-mcp)）。
- 配置目录（默认 `~/.config/cardigan`）里有控制主机专用的 SSH 密钥 `worker-key` 及公钥 `worker-key.pub`，必须是 Ed25519。还没有时按[第 1 节](#1-控制主机预览与私有配置)的 `ssh-keygen` 命令生成，不需要 sudo。

设备：

- 有 `python3` 和 `curl`。
- 装好 Tailscale 并登录同一个 tailnet。tailnet 访问规则放行两个方向：控制主机 → 设备的 TCP 22，设备 → 控制主机的 Serve 端口（写法见[第 4 节](#4-worker资源与-mcp)）。
- tailnet 访问规则按设备逐条放行：**每接一台新设备，都要在 Tailscale 后台单独加一条“控制主机 → 该设备:22”**，已有设备的规则不会覆盖新设备。漏了这条时，配对、确认和初始化都能走完，检查却停在 SSH（`worker_ssh_blocked`）。排查：设备上执行 `sudo journalctl -u tailscaled --since -10min | grep 'no rules matched'`，出现 `Drop: TCP{<控制主机地址> > <设备地址>:22} no rules matched` 就是这条规则没放行；加上后点“继续检查”，设备上不用改动（C-709 Steam Deck 实测）。
- SSH 服务已启用（**要 sudo**），例如 `sudo systemctl enable --now ssh`，有的发行版服务名是 `sshd`。
- 你在设备上的账号能用 sudo（第 4、5 步用）。

### 1. 设备：运行配对命令（不要 sudo）

用普通账号运行，不要加 sudo：

```sh
curl -fsS https://<Workbench>/pair-device.py | python3 - https://<Workbench>
```

命令上报主机名、系统、架构、tailnet 地址、一个空闲的账号编号和硬件概况，然后显示：

- 二维码和配对码（`XXXX-XXXX`，10 分钟内有效，只能用一次）；浅色背景的终端加 `--light`；
- 确认页链接；
- 控制主机 `worker-known-hosts` 需要的一行 `<机器> ssh-ed25519 <公钥>`；
- 提示：本机 22 端口没有 SSH 服务、正在用电池。只提示，不会停下。

之后命令在设备上等待确认。没装或没登录 Tailscale 时给出指引后退出；也可以用 `--address <地址>` 指定控制主机连这台设备用的地址。配对这一步不改动设备。

配对只经 HTTPS 连 Workbench，不检验“控制主机 → 本机:22”。新设备先按第 0 步在 Tailscale 后台加上这台设备的放行规则；之后检查停在 SSH 时，用第 0 步的 tailscaled 日志方法排查。

### 2. 控制主机：登记设备的 SSH 主机公钥（不要 sudo）

把上一步显示的那一行追加到控制主机配置目录里的 `worker-known-hosts`（权限 0600）。在向导里改了机器编号时，把开头换成新编号。这一行是在设备自己的屏幕上读到的，相当于[第 1 节](#1-控制主机预览与私有配置)要求的“经可信渠道取得主机公钥”；不要用 `ssh-keyscan` 的输出代替。

### 3. Workbench：确认接入（不要 sudo）

1. 用手机扫二维码或打开确认页链接；也可以在“设置 → 机器”点“新设备接入（配对码）”，手动输入配对码。
2. 选项目和名额（这台机器同时跑几个 Agent，默认 1），点“确认接入”。一个配对码只接入一个项目；其它项目在接入完成后用“添加 worker”追加。
3. 核对生成的配置预览，点“确认写入配置”。

只有所有者的人类登录会话能确认。不确认就离开不会写入任何东西，配对码到期自动作废。

确认后不要在设备上手动建账号或运行 `install-linux-worker.py`，第 4 步的初始化脚本会完成这些。向导在设备初始化完成、且检查停在需要在设备上操作的步骤之前，不显示“目标机命令”。

### 4. 设备：一次性初始化（要 sudo）

确认写入配置后，设备上的命令自动取得为这份配置生成的初始化脚本，先列出将做的操作。核对后输入 `yes`，再输入你的 sudo 密码；脚本用 `sudo python3 -IB -` 从标准输入运行，不写入磁盘。sudo 验证没通过时不做任何改动，按回车可以重试。跑完后结果报给 Workbench，向导自动开始九项检查。

脚本具体做什么、遇到冲突怎么办，见下文“初始化脚本做什么”。

### 5. 设备：hc、helper、基础工具和资源限额（要 sudo）

初始化脚本只建账号和目录，不装软件。下面几项由设备管理员准备：

- Python 3、Git、Node 24、pnpm 11，以及与控制主机同一版本的 hc 和三个 helper：见[第 3 节](#3-worker工具和-helper)（**要 sudo**）；
- 专用账号的 CPU、内存、任务数上限：见[第 4 节](#4-worker资源与-mcp)（**要 sudo**）。

Workbench 向导的“目标机命令”列出这台机器要执行的命令，可以逐条复制。检查停在工具、helper 这几步时页面每 15 秒自动复查，做完会自动往下走；停在其它步骤时点“继续检查”。

### 6. 检查通过、开启远程派发、上线（不要 sudo）

九项检查全部通过后，向导显示体检报告：设备自报的系统、CPU、内存、磁盘、GPU，已验证的能力，以及建议安装的工具。然后：

1. 在向导最后一步“开启远程派发”：点“预览开启”，核对只给这台机器的绑定开启远程派发，勾选确认后开启。也可以先不开，直接点“完成”。
2. 新登记的机器状态是离线。在控制主机的人类终端把它设为在线，再检查一次：

   ```sh
   cardigan machine update <机器> --project <项目> --status online
   cardigan machine check <机器> --project <项目>
   ```

   检查通过后，这台机器按名额接收派发。之后在 Workbench 机器详情里可以“立即检查”“排空/恢复”和修改名额。

先不开、之后再开（或向导进度丢了）时，不用重走向导：在“设置 → 机器”打开这台机器，所有者点“开启远程派发”。系统按已写入的接入配置重新跑九项检查，通过后同样“预览开启”、勾选确认后开启，并把离线的机器设为在线（C-846）。接入配置被手改过、与向导生成的不一致时会拒绝，请在控制主机核对。

### 7. 按需装工具

在“设置 → 机器”打开这台机器，“能力”表列出主机能力目录里适用于它的能力及状态（已验证、已过期、未验证）。`node`、`godot`、`blender`、`android.sdk`、`android.emulator`、`browser.chromium` 未验证时，行末有“安装”：

1. 点“安装”，选系统（Linux / SteamOS），点“复制命令”。
2. 在设备上执行复制的命令。命令写的是专用账号用户目录下的位置（`~/.local`、`~/Android/Sdk`），需要管理员的步骤（系统运行库、`kvm` 组、Playwright 系统库）以注释给出，**要 sudo**。
3. 回到对话框点“复查”；验证通过后该行的“安装”按钮消失。

一次性初始化建的账号里，HOME、`~/.local` 和 `~/.local/bin` 由 root 持有（0750），专用账号自己写不进去，所以对话框里往这几处写的命令目前会因权限失败。在这一点修好之前，按[第 3 节](#3-worker工具和-helper)由管理员（**要 sudo**）把工具装到 root 持有的位置，再链接进 `~/.local/bin` 或加进绑定的 `path`，然后点“复查”。某个工具检测不到只是不登记这项能力，不影响机器健康和其它派发。

接 USB 安卓真机见[接入一台安卓真机](android-device.md)；其它外接设备的框架见[设备提供方](device-providers.md)。

### 初始化脚本做什么

初始化脚本只做以下操作（HOME 为 `/home/cg_<项目>`，工作根为 `/srv/cardigan-workers/<项目>`；根分区只读的设备（如 SteamOS）工作根改为 `/home/cardigan-workers/<项目>`，发行文件和工具也放在 `/home` 下，见 [SteamOS 设备接入](steamos-worker.md)。）：

- 建专用组和账号（向导给定的 UID/GID，无密码、shell `/bin/sh`、不加入其它组）；
- 建 HOME、工作根及固定的私有目录，属主和权限同[第 2 节](#2-worker专用账号和安装布局进阶排障手工命令)；
- 把控制主机公钥写成 `.ssh/authorized_keys`（root:项目组 0640，带 `restrict`）；
- 写认领标记和安装配置，用随附的安装器先 `--check` 再 `--apply`（私有目录、锁文件和 `worker-primitives.py`）；
- 只有专用账号执行 `sudo -n -l` 被要求输入密码时，才写入 `cardigan-worker-<账号>`，内容仅 `Defaults:<账号> listpw=never`（经 `visudo -cf` 校验，不授予任何命令）。

账号、组、UID/GID、目录或文件已存在时，它列出冲突后停下，不做任何改动，也不接管已有账号。中途失败时列出已创建的内容和删除命令，不自动撤销。它不装其它软件、不改 `/etc/sudoers`、不含凭据；hc、helper、Node 等工具和资源配置仍按第 3、4 节准备。只想配对、不在设备上初始化时，给 `pair-device.py` 加 `--no-init`。

## 进阶/排障：手工接入

在已运行 Cardigan 的 Linux 控制主机上使用 `cardigan worker add/check/status`。向导读取主机私有 YAML，登记机器、生成配置草案，并检查 SSH、账号、目录、工具、资源限制和 HTTPS MCP。需要管理员权限的准备工作由人在 worker 上执行；向导只用 `sudo -n -l` 查询当前账号的授权，不执行特权命令、不请求密码、不安装软件、不签发 Token。

### 1. 控制主机：预览与私有配置

CLI 安装见 [部署说明](../deploy/README.md#安装-cardigan-命令)。使用人类终端，不设置 `CARDIGAN_TOKEN`、`MCP_TOKEN` 或 `--token-file`。项目需已存在：

```sh
cardigan project create example --code EXA
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

Android 项目可在私有 `runtime-workers.yaml` 对应的 `machines[].projects[]` 条目中加 `env`（与 `path` 同级；使用向导时也在输入的同一绑定中填写）：

```yaml
env:
  ANDROID_HOME: /home/cg_example/Android/Sdk
  ANDROID_AVD_HOME: /home/cg_example/.android/avd
```

不要在这里写 `ANDROID_ADB_SERVER_PORT`：同一台机器上的多个 Run 会共用一个 adb 服务，一个 Run 关掉 adb 会断开别人的模拟器。改在 `run-capacity.yaml` 的机器条目里配置 `adb_slots`，系统给每个 Run 分配自己的 adb 端口和模拟器端口，Run 结束后关闭（见 [C-679 计划](plans/C-679.md)）。机器配了 `adb_slots` 而绑定仍写着这一项时，启动时忽略它，控制面启动日志会给出警告。

`env` 只传给该项目在该机器上新启动的 Run 和能力检查命令，不修改账号的登录环境，也不分配端口或设备。用工具的绝对路径；如需按名称找到 `adb`，把 SDK 的 `platform-tools` 目录加到绑定的 `path`，不要设置 `env.PATH`。变更前先清退使用旧绑定的会话，再重新检查机器能力。省略 `env` 或填写 `{}` 保持原行为。

每个绑定最多 32 项。键以大写英文字母开头，后续限大写字母、数字、下划线，总长不超过 64。不得使用凭据名（含 `TOKEN`、`SECRET`、`KEY`、`PASSWORD`，或 `MYSQL_PWD` 这类密码名），也不得覆盖账号、启动器、加载器或资源策略变量（如 `HOME`、`PATH`、`LD_*`、`OPENSSL_*`、`EDITOR`、`CARDIGAN_*`、`ADB_SERVER_SOCKET`）。值必须是无控制字符的字符串，每值最多 1024 个 UTF-8 字节，合计最多 8192 字节。端口等数字要加引号；不会展开 `$HOME` 或执行 shell。**不要在这里放凭据**：值会进入启动材料，校验变量名不能判断值是否保密。


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

### 2. worker：专用账号和安装布局（进阶/排障：手工命令）

以下是一次性初始化脚本所做操作的手工版本，用于不走配对的接入、核对现场或排障。

**同机第二个项目**沿用机器编号，不复用第一个项目的账号、UID、主组、HOME、工作根或认领标记。逐项替换下例的 `example`、`cg_example` 和 UID/GID，在 `/etc/cardigan/worker-<项目>.json` 建 root 所有、0600 的新文件；文件名中的项目必须和正文、两份认领标记一致。同机已有 `worker.json` 的绑定原样保留，不复制为同项目的新文件，不覆盖它的内容。

安装前可用 `sudo /usr/bin/python3 -IB /opt/cardigan/deploy/install-linux-worker.py --check` 逐项只读检查：每个配置单独输出，任一失败总退出码非零。修复时用 `--project <项目> --check` 和 `--project <项目> --apply` 明确选中一项；同名冲突拒绝操作，其它绑定仍可检查。旧 `--config` 命令继续有效。控制主机为每个（项目、机器）保留各自的向导配置，在同一机器登记下添加项目绑定，不替换其它项目。

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

Ubuntu 24.04 自带的 sudo 1.9.15 对不在 sudoers 的账号执行 `sudo -n -l` 时，也可能返回 `sudo: a password is required`，使向导的账号检查判为 blocked。此时由管理员在 worker 上用 `visudo` 编辑该账号的查询设置（下文 `cg_example` 替换为实际专用账号）：

```sh
sudo visudo -f /etc/sudoers.d/cardigan-worker-cg_example
```

文件中加入以下一行；若文件已存在，先核对并保留原内容：

```sudoers
Defaults:cg_example listpw=never
```

它只免去 `sudo -l` 查询的密码验证，不授予任何命令执行权限。保存后核对属主、权限和完整 sudoers 语法，再以专用账号查询：

```sh
sudo chown root:root /etc/sudoers.d/cardigan-worker-cg_example
sudo chmod 0440 /etc/sudoers.d/cardigan-worker-cg_example
sudo visudo -c
sudo -u cg_example env LC_ALL=C sudo -n -l
```

`visudo -c` 必须通过；最后一条命令应以非零状态退出，并输出 `Sorry, user cg_example may not run sudo on <主机>.`，这是预期的明确拒绝。若仍要求密码或列出任何授权，先核对策略，不继续接入。

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
create('/etc/cardigan/worker-example.json', {
    'account': 'cg_example', 'uid': 2201, 'project': 'example', 'root': root,
    'mount': '/', 'volume': str(os.statvfs('/').f_fsid),
    'minimum_free_bytes': {'root': 1073741824, 'work': 1073741824},
    'timeout_ms': 15000
}, 0o600)
PY
sudo python3 /opt/cardigan/deploy/install-linux-worker.py --project example --check
sudo python3 /opt/cardigan/deploy/install-linux-worker.py --project example --apply
```

示例假设工作根位于根文件系统；若使用独立挂载，将 `mount` 和 `volume` 改为实际挂载点及其 `os.statvfs(...).f_fsid`。空间下限应按工作量配置。安装器检查账号、组、sudo 拒绝、ACL、挂载及现有文件冲突，再创建项目目录、锁及基础 helper；重复执行不会替换已有锁 inode。不要使用旧 `install-agent.py` 的整机安装入口来接管每项目账号。

### 3. worker：工具和 helper

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
```

安装文件和 Git helper：

```sh
sudo install -o root -g cg_example -m 0750 /opt/cardigan/deploy/worker-files.py /srv/cardigan-workers/example/libexec/worker-files.py
sudo install -o root -g cg_example -m 0750 /opt/cardigan/deploy/worker-git.py /srv/cardigan-workers/example/libexec/worker-git.py
```

基础 `worker-primitives.py` 由安装器安装。向导核验三个 helper 与控制主机发行文件的摘要、属主和权限，因此两边版本要一致。模型 CLI 和模型账号登录使用既有启动配置与凭据流程；它们不由接入向导复制，`worker check` 也不表示模型登录已经完成。

`file_helper`、`git_helper` 与固定的 `<工作根>/libexec/worker-primitives.py` 必须是三个不同路径；复用路径会在读取配置时拒绝，不能用同一个 helper 代替其它协议。

#### 升级已接入 worker 的 helper

部署新版本后，控制主机后台会立即巡检已登记机器；后续巡检和启动前检查仍核对发布协议及三个 helper 的 SHA-256。版本落后或文件不同的机器不能启动，运维待办附当前发行版预期摘要。例外（C-666）：仍装着协议 2 那一版原样 helper 的机器照常启动，只是不做目录占用统计，机器详情的“目录占用”显示“helper 过旧，未统计”；已接入自动升级的机器照常升级，其余由管理员安装当前发行版。主机运维可在 `host_ops_read_diagnostics` 的 `worker_maintenance` 里按待办编号读取升级步骤或冷却原因。不要通过工作树分发或以 worker 自身权限覆盖 helper。

默认连续 3 次远程启动准备失败会让自动指派跳过该项目绑定 30 分钟；冷却到期或该绑定实际启动成功后自动解除。私有 `runtime-workers.yaml` 的项目绑定可设 `preparation_cooldown: { failures: 3, duration_ms: 1800000 }`。等待、审核目标变化及启动租约失效不算作机器故障。冷却不撤回已派任务、不解除其它就绪门禁。

暂停向这台 worker 派发新 Run，在执行视图确认没有仍在运行的 Run。在 worker 上，由管理员将与控制主机同版本的可信发行包解包到仅 root 可写的 `/opt/cardigan` 下，再去掉 `deploy` 目录及其文件的组和其他用户写权限：`git archive` 打包的文件和目录通常为 0664/0775，不符合安装器要求。不要对项目工作根执行此命令。

```sh
sudo chmod -R go-w /opt/cardigan/deploy
```

如果新版 `worker-primitives.py` 的内容有变化，安装器的 `layout()` 会拒绝覆盖旧文件，报 `worker_preflight_failed`。先把已安装的旧文件移到 `/root` 下的独立备份目录；内容相同时跳过这一步：

```sh
backup=$(sudo mktemp -d /root/cardigan-helper.XXXXXXXX) &&
  sudo mv /srv/cardigan-workers/example/libexec/worker-primitives.py "$backup/" &&
  printf '旧 helper 备份在 %s\n' "$backup"
```

用原安装配置先检查，通过后再安装基础 helper：

```sh
sudo python3 /opt/cardigan/deploy/install-linux-worker.py --project example --check &&
  sudo python3 /opt/cardigan/deploy/install-linux-worker.py --project example --apply
```

若安装器只打印 `worker_preflight_failed`，可在 worker 上直接运行同一 Linux 检查入口，查看异常栈定位失败的检查；此命令不执行安装：

```sh
sudo python3 -I -c 'import runpy, sys; p="/opt/cardigan/deploy/install-macos-worker.py"; sys.argv=[p,"--project","example","--check"]; runpy.run_path(p)["main"]("Linux")'
```

`--apply` 成功后，执行上方两条 `sudo install` 命令更新 `worker-files.py` 和 `worker-git.py`。最后在**控制主机**重新检查，确认检查通过（其中 `helpers` 为 `passed`）后再恢复派发；失败时保留备份，先排查再重试。

```sh
cardigan worker check --project example --machine worker-a
```

### 4. worker：资源与 MCP

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

如果 tailnet 访问规则只允许部分设备访问控制主机，`tailscale ping` 仍可能成功，但 worker 到控制主机的 TCP 连接会超时，MCP 检查因此判为 blocked。在 Tailscale 后台访问规则中，只添加 **worker → 控制主机的 TCP Serve 端口**。以下两种写法选一种，将规则条目合入已有的 `grants` 或 `acls` 数组，保留其它规则；不要用整段示例替换现有策略。

将 `<worker-tailscale-ip>`、`<control-tailscale-ip>` 替换为对应设备的 Tailscale 地址，`<serve-port>` 替换为 `tailscale serve status` 显示的 HTTPS 端口（通常为 443），不要填后端 MCP 回环监听端口。

`grants` 写法：

```json
{
  "grants": [
    {
      "src": ["<worker-tailscale-ip>"],
      "dst": ["<control-tailscale-ip>"],
      "ip": ["tcp:<serve-port>"]
    }
  ]
}
```

`acls` 写法：

```json
{
  "acls": [
    {
      "action": "accept",
      "src": ["<worker-tailscale-ip>"],
      "dst": ["<control-tailscale-ip>:<serve-port>"],
      "proto": "tcp"
    }
  ]
}
```

通过后台策略校验并保存后，从 worker 使用私有 YAML 中的 MCP 地址验证；非默认端口须在 URL 中显式写出。替换下面的占位符，不带 Token，保留 TLS 证书验证，预期打印 `401`：

```sh
curl --connect-timeout 10 --max-time 15 --silent --show-error --output /dev/null --write-out '%{http_code}\n' 'https://<主机>.<tailnet>.ts.net:<serve-port>/mcp'
```

向导从 worker 发送**不带 Token**的请求，TLS 验证开启，必须得到 401；200、403、404、重定向、证书错误、超时均阻塞。此步骤证明可达及未鉴权拒绝。RW-2 的运行目标 Token 鉴权检查负责真实启动鉴权；本向导不会签发测试 Token。RW-2 尚未部署时，先完成该部署再验证 MCP。

### 5. 控制主机：add、续跑、check 和 status

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

#### 检查浏览器能力

运行 `cardigan machine check worker-a --project example` 刷新，`cardigan machine show worker-a --project example` 查看上次结果。`browser.chromium` 优先在控制主机 `launch.yaml` 的 `browser.browsers_path` 中查找 Playwright 安装的 Chromium 或无头浏览器。目录名指 **Run 所在机器**的路径；该账号能执行浏览器并读到版本号即可，不需要向缓存建链接。CLI 只查服务已接受的配置目录；配置无法读取、尚未生效，或候选程序超时、没有返回可解析版本时，继续检查后续位置，不影响其它能力。再查 Run 的 `PATH` 中的 `chromium`、`chromium-browser`、`google-chrome`，最后查该账号的 `$HOME/.cache/ms-playwright`。

本机采用 `agent-ssh` 时以本机 Agent 账号检查，远程以项目 worker 账号检查；只有 Run 本身采用 `local` 模式才用当前运行账号。未验证浏览器时，`health.capability_failures` 只列出能确认尝试过的范围（配置键、命令名和账号缓存），不会回显私有目录或命令报错。`search_incomplete: true` 表示未能完成或确认本次检查，可再运行 `machine check`。若机器健康检查本身失败，先处理 `health.blockers`，能力探测此时尚未执行。

### 5a. 用 Workbench 向导接入

不想在终端里逐条运行时，可以在 Workbench 的“设置 → 机器”点“添加 worker”。它和第 5 节的 `worker add/resume` 用同一个接入引擎和同一套私有文件，只限当前所有者的人类登录会话；Agent Token 和其它成员不能调用。

1. **准备。** 先完成第 1 节的密钥和主机指纹：向导使用控制主机配置目录中已有的 `worker-key` 与 `worker-known-hosts`，页面不上传、不显示密钥。
2. **填写并预览。** 抽屉顶部的步骤条显示整个流程（填写 → 预览确认 → 9 项检查 → 目标机命令 → 开启远程派发）和当前所在步骤；每个字段下方写明含义和数据来源，UID/GID 下给出在目标机查已占用编号的命令。SSH 端口预填 22，专用账号按项目名推荐 `cg_<项目>`，MCP 地址预填控制主机已接入 worker 使用的地址；还没有时，取控制主机显式配置且符合远程 worker 要求的 `CARDIGAN_MCP_URL`，再没有才按经 Tailscale Serve 打开的 Workbench 地址推断；预填值都可修改，填错的字段在旁边提示原因。填机器编号、名称、系统（Linux）、架构（x64/arm64）、主机地址、SSH 端口（默认 22）、专用账号（`cg_` 开头）、UID/GID（≥ 501）和 MCP 地址，点“预览配置”。页面列出将写入 `worker-<机器>-<项目>.yaml` 的字段差异；地址、路径、账号等私有值显示为“已隐藏”。预览 15 分钟内有效。
3. **确认写入。** 只有点“确认写入配置”才写文件：保留原字节的 0600 备份并原子替换；文件已被他人改动或身份冲突时拒绝，不猜测覆盖。
4. **检查九步。** 点“开始检查”，页面依次显示配置核对、1 登记 → 2 草稿 → 3 SSH → 4 账号 → 5 目录 → 6 工具 → 7 helper → 8 资源 → 9 MCP、能力刷新的状态和耗时。失败的步骤原位显示原因码和修复建议。
5. **人工命令与复查。** “目标机命令”列出建账号、目录、工具和 helper 的命令，可逐条“复制”，由 worker 管理员按第 2～3 节核对后在 worker 上执行。检查停在 SSH（首次接入时专用账号还没建好，SSH 会先失败）、账号、目录、工具或 helper 这几步时，页面每 15 秒自动复查一次（同一步最多 20 次），管理员执行完命令后会自动进入下一步；自动复查只接着本页看到的那次失败，其它页面已经继续或通过时只重新读取进度，不另起检查；自动复查停止后或停在其它步骤时，点“继续检查”。已通过的步骤不重做；全部通过后可随时“复查”。
6. **离开与续办。** 关闭抽屉或离开页面不会丢进度，页面会提示可稍后继续；回来后点“继续添加 worker”，从当前步骤接着做。向导会话在同一 Web 进程中保留 24 小时；服务重启或超时后需重新填写和预览。
7. **远程派发单独确认。** 检查通过后远程派发仍为关闭。确需开启时，在“需谨慎”分组点“预览开启”，核对 `runtime-workers.yaml` 中只增加该绑定且 `allow_remote_launch` 由 false 改为 true，勾选确认后点“开启远程派发”；服务端会再次核验检查结果和登记。可以不开启，直接点“完成”。

页面上的“机器”详情还可以对单台机器“立即检查”（进行中按钮显示“检查中…”，不能重复启动，结束后刷新列表和详情）、“排空/恢复”（点击即提交，不重启或移动运行中的任务），并在“资源上限”里即时保存 Agent 并发上限（原“并发与容量”入口跳到这里）。这些操作与向导一样只对人类登录会话显示，由服务端按当前所有者授权。

### 6. 常见阻塞

| 原因码 | 处理 |
|---|---|
| `worker_busy` | 另一向导持有配置锁；等其退出后再运行。进程退出自动释放锁，不删除锁文件 |
| `worker_config_invalid` / `worker_private_file_invalid` | 核对字段、绝对路径、0600 文件及 0700 私有目录；不从日志寻找原始配置 |
| `worker_identity_conflict` / `worker_config_conflict` | 参数与配置、既有登记/草案冲突；核对物理机器，保留旧绑定 |
| `worker_config_changed` | 输入与 journal 摘要不同；恢复原输入续跑。确需更换配置时，由人确认无活跃 Run、将该机器目录移至向导目录以外的私有归档目录，再重新 add；旧 Assignment 不改绑 |
| `worker_operation_failed` / `worker_journal_invalid` | 核对文件权限、链接及 journal 完整性；保留原记录供检查 |
| `worker_<步骤>_blocked` | 按该步骤的下一操作修复，再 resume；不会自动执行特权安装或降低检查要求 |

现场账号、SSH、TLS、hc/Run 与 CI 共存尚未验证时，应明确保留“未现场验证”；合成测试通过不能替代这些事实。

#### 可选：一次接入，之后由后台升级 helper

旧安装器只可用向导维护唯一且能核实的 `worker.json`。出现命名配置时先核验并更新安装器，不要手改命令指向旧绑定。人工升级复用已匹配的共享发行目录；不同版本只作原子交换，不支持则停止。若有中断留下的备份或暂存目录，保留现场，按 `docs/plans/C-551.md` 核对。

**每个新项目分别接入。** 下例针对命名配置。先在控制主机 prepare，再在 worker 安装专属零参数入口及公钥，核对指纹和唯一 sudo 规则后才 activate。不要用某个项目的接入材料替另一个项目授权。已有 `worker.json` 的旧接入不用重跑、不迁移密钥；若该旧绑定尚未接入，两端沿用无 `--project-config`、无 `--project` 的旧命令，账号为 `cardigan_updater`，入口和备份仍在 `/opt/cardigan-helper-upgrade`。旧版 bootstrap 不会自动更新。

默认关闭，未接入时仍走上面的人工流程。前置：标准的三个 `libexec` 路径、已登记且一致的向导配置、已有独立 worker 账号、开启主机自部署。以下在维护窗口运行；先确认没有活跃任务、备份私有配置，不停旧会话、不改调度开关。控制主机用 **server 服务账号**，worker 用自己的管理员终端；两端都从管理员已核验的发行版运行，不能从项目工作树或上传的临时目录运行脚本。

1. 在控制主机已部署发行版根目录准备本绑定专用的 SSH 身份和**独立的发行签名密钥**；下例将机器、项目替换为实际登记值。私钥留在 0700 的 `CARDIGAN_CONFIG_DIR` 中（文件 0600），不进入 Run、Agent、MCP 或仓库。

   ```sh
   sh deploy/enroll-helper-controller.sh prepare example worker-a --project-config
   ```

2. worker 管理员确认 `/etc/cardigan/worker-example.json` 属于本项目。使用本轮新建的 root 私有发行目录，不更新或执行旧 `/opt/cardigan/deploy`。管理员从控制主机**实际部署并已审核**的提交打包 `deploy` 下的接入脚本、两台的入口和固定检查器，包内保留 `deploy/` 层级；通过独立可信通道核对包的 SHA-256。以 `BUNDLE` 指向收到的包，`EXPECTED` 为独立核对的整包 SHA-256。每条以 `&&` 相连，失败停止；`KIT` 始终使用本次创建的确切目录，不用通配符。不要对已存在的安装路径覆盖或补权限。

   ```sh
   KIT=$(sudo mktemp -d /opt/cardigan-enroll.XXXXXXXX) &&
     sudo install -m 0400 "$BUNDLE" "$KIT/release.tar" &&
     got=$(sudo sha256sum "$KIT/release.tar") && [ "${got%% *}" = "$EXPECTED" ] &&
     sudo tar --no-same-owner -xf "$KIT/release.tar" -C "$KIT"
   ```

   root 运行 tar 默认沿用归档里的所有者和权限位。包由 server 等非 root 账号打成时，不加 `--no-same-owner` 解出的文件归该账号；`git archive` 默认 `tar.umask=0002`，成员组可写。两种情况都会让接入脚本在授权前报 `unsafe bootstrap permissions` 退出。打包时带上 `deploy` 目录条目并去掉组和其它账号的写权限，例如在发行版根目录运行 `tar --owner=0 --group=0 --numeric-owner --mode=go-w --no-recursion -cf "$OUT/enroll.tar" deploy deploy/<各文件>`，或改用 `git -c tar.umask=0022 archive`。遇到该报错不要改解出文件的归属或权限，重新打包并在新的 `KIT` 解包。

   包内 `deploy/` 及其中的文件须为 root 持有、不可被其它账号写入，接入脚本在安装授权前还会检查祖先目录、扩展 ACL 和实际安装结果。执行下列命令，从控制主机终端粘贴上一步标准输出的**公钥两段**（SSH 一行及完整 PEM），按 Ctrl-D；核对两端显示的指纹。不要发送私钥。脚本创建无密码凭据的专用系统账号，root 持有 HOME、公钥和强制 SSH 命令；sudoers 仅允许固定入口、零参数，不授予 shell 和额外 sudo。

   ```sh
   sudo /bin/sh "${KIT:?}/deploy/enroll-helper-worker.sh" --project example
   tag=$(/usr/bin/python3 -IB -c 'import hashlib; print(hashlib.sha256(b"example").hexdigest()[:20])')
   sudo -n -l -U "cgu_$tag"
   ```

3. 确认输出中只有 `/opt/cardigan-helper-upgrade-<tag>/upgrade ""`，系统 SSH 只允许该账号用已安装受限公钥认证（无其它可信 CA、键或认证入口）。核对 worker 账号与升级账号不共组，不额外授予图形登录。若不符，保持未激活，不通过修改权限绕过检查。在控制主机原目录激活：

   ```sh
   sh deploy/enroll-helper-controller.sh activate example worker-a --project-config
   cardigan worker check --project example --machine worker-a
   cardigan machine check worker-a --project example
   ```

   激活本身不重启机器、不使检查变绿。已有摘要不符时，等下一次后台巡检，再执行这两条只读复查。首次和后续巡检均不从工作树取文件：只签发当前进程与部署记录一致的已部署提交中的三个 blob；root 只接收限长的标准输入，独立验签、核对文件名与 SHA-256，并拒绝旧请求。旧文件保存在 root 私有的 `/opt/cardigan-helper-upgrade-<tag>/state/backup-<毫秒时间戳>`。安装器检查代码与基础实现固定在首次安装的 root 目录中，绝不执行上传的代码。bootstrap 本身的升级仍须管理员审核安装。

升级失败会保持停派：同一绑定、同一组摘要不会再自动安装。按运维待办查出失败阶段；部分替换时按备份整体还原或人工安装当前可信版本，然后顺序执行上面两条检查。仅 worker check 成功不能解锁；同一绑定的 machine check 也须通过，且不覆盖人工 drain 或关闭派发。未完成的初始化不原地重跑：保留已有账号、文件和备份，让管理员检查冲突。撤销接入时先停用该专用身份，再由管理员移除对应受限授权，勿改 worker 的既有连接。

撤销接入并遇到新部署或绑定变更时，下一轮巡检将旧停派记录转到当前版本，不执行安装，不沿用旧检查证据。按当前发行版人工修复后，在同一绑定依次运行 `worker check`、`machine check`；以两项检查正式完成的结果为准。新的 worker 检查一旦开始，之前的 worker 通过结果即失效。

`machine check` 失败时查看 `health.blockers`：`invalid_launch` 旁的 `target_mismatch` 表示登记与执行目标不匹配，`target_changed` 表示检查期间绑定发生了变化，`worker_configuration_incomplete` 表示缺少远程启动配置。`target_invalid` 是没有可公开原因时的回退，不是进程退出证明。

改同一绑定的 `path` 或工具环境后，可运行 `cardigan worker apply-config --project <项目> --machine <机器>`。命令等待旧 Run 排空，然后按顺序执行 worker 和机器检查；不会启用派发或解除已有停派。控制主机的日常巡检会重新检查绑定，新启动也须通过实时检查。旧会话按原环境核对；撤权、删绑、更换账号、SSH 信任目标或绑定代次立即拒绝旧通道。主机没有记录旧环境时不猜测。

失联宽限结束时，主机比对原进程的启动回执。缺回执、身份无法核实或 helper 配置错误不是退出证据。失联待办支持 `human-action done --conclusion exited|false_alarm|unconfirmed`：误报保留原 Run 和资格；无法确认只记录结果，待办保持未结。主机重新核实同一进程存活时自动撤销待办。

已结算且指派已释放的原进程不再交给人结束。系统核实精确归属和稳定句柄后，在中心库 `refs/cardigan/backups/orphans/<指派>/<启动代次>` 保存工作树（含未忽略的新文件），第一父提交是原 HEAD，第二父提交保存暂存树。两次备份相同不代表还能安全停止。只对存储侧已原地封存至进程退出的专用 Linux 工作区，在核实内核写保护和中心备份后发一次 TERM；普通可写目录只观察，不发强制信号。旧 helper、不支持 pidfd 的机器（含 macOS）、子模块或无法核实的工作区都保留进程并记录原因。已发信号但未证实退出时只观察，不重复终止。
