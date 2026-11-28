# 接入 SteamOS 设备（Steam Deck，实验支持）

Steam Deck 等 SteamOS 3 设备按**实验支持**接入：基础接入（配对、一次性初始化、九项检查）和体检报告要求跑通；工具装在 `/home` 下，模拟器、GPU 工具能跑通就登记，跑不通记为限制。本文只写与普通 Linux 不同的地方，其余以 [Linux worker 手册](linux-worker.md) 为准。下文 `example`、`cg_example`、`steamdeck` 都是示例。

## SteamOS 与普通 Linux 的差异

| 项 | SteamOS 的情况 | 接入时的做法 |
|---|---|---|
| 根分区 | `/`（含 `/usr`、`/opt`、`/srv`）只读，系统更新整体替换 | 工作根放 `/home/cardigan-workers/<项目>`，发行文件放 `/home/cardigan-release`，工具放 `/home/cardigan-tools`；配对时自动识别（设备上报根分区只读或系统名含 SteamOS）。初始化不检查 `/` 的空间：工作根和 HOME 所在分区（`/home`）要留 1 GiB，`/etc` 和 `/etc/sudoers.d` 留 16 MiB 即可 |
| `/etc` | 可写，系统更新后保留 | 专用账号、`/etc/cardigan`、sudoers 片段、sshd 启用状态都在这里 |
| `/home` | 大容量可写分区 | 专用账号 HOME 照常是 `/home/cg_<项目>` |
| 软件包 | 用 `steamos-readonly disable` 后 `pacman` 装的软件会被下次系统更新抹掉 | 不往 `/usr` 装任何东西 |
| SSH 服务 | 默认关闭 | 手动启用 sshd |
| `deck` 账号 | 默认没有密码，`sudo` 用不了 | 先用 `passwd` 设密码 |
| 休眠 | 空闲后自动休眠，休眠期间 SSH 和 Run 全部中断 | 插电并关闭自动休眠 |

## 1. 设备上的准备

在设备上切到桌面模式（电源菜单 → 切换到桌面），打开 Konsole，用 `deck` 账号执行：

```sh
passwd                                # 设一个 sudo 用的密码
sudo systemctl enable --now sshd      # 启用 SSH；首次启动时生成主机密钥
```

**电源与休眠。** worker 要一直在线：

- 接上电源（官方底座或充电器）。`pair-device.py` 发现在用电池时会提示。
- 桌面模式：系统设置 → 电源管理，把“交流供电”下的自动挂起关掉；熄屏可以保留，不影响 Run。
- 游戏模式：设置里把插电时的自动休眠设为“从不”。
- 仍会休眠时，可由管理员彻底禁止（写在 `/etc`，系统更新后保留；撤销用 `unmask`）：

  ```sh
  sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
  ```

- 按电源键会让设备休眠，接入后不要按；长期插电对电池有损耗，系统设置里有充电上限选项时可以开启。

**Tailscale。** SteamOS 不自带 Tailscale。按 Tailscale 对 SteamOS 的说明把它装在不受系统更新影响的位置并登录 tailnet；每次系统更新后用 `tailscale status` 核对它仍在运行。控制主机经 Tailscale 连设备（worker 地址填 `<设备>.<tailnet>.ts.net`），不走局域网地址；局域网直连只用来排除 sshd 本身的问题（C-709、C-828 实测：Deck 起初 Tailscale 的 22 端口不通、只有局域网能连，原因是下面的访问规则没放行，补上后 SSH 检查通过）。tailnet 访问规则要放行两个方向：

- 控制主机 → 设备的 TCP 22（向导经 SSH 检查和启动 Run）；
- 设备 → 控制主机 Serve 端口（MCP，写法见 [Linux 手册第 4 节](linux-worker.md#4-worker资源与-mcp)）。

tailnet 访问规则是按设备逐条放行的：**每接一台新设备，都要在 Tailscale 后台单独加一条“控制主机 → 该设备:22”**，已有设备的规则不会自动覆盖新设备。漏了这条时，配对、确认和初始化都能走完（它们只用 HTTPS 连 Workbench），检查却停在 SSH（`worker_ssh_blocked`，10 秒超时）。排查：在设备上看 tailscaled 日志，

```sh
sudo journalctl -u tailscaled --since -10min | grep 'no rules matched'
```

出现 `Drop: TCP{<控制主机地址> > <设备地址>:22} no rules matched` 就是这条规则没放行；在后台加上后点“继续检查”即可，设备上不用改动。Tailscale 的服务名不是 `tailscaled` 时，换成 `systemctl list-units | grep -i tailscale` 看到的服务名。

**MagicDNS。** SteamOS 用 systemd-resolved 解析域名（`/etc/nsswitch.conf` 里 `resolve` 排在 `dns` 前面），而 tailscaled 在这里直接改写 `/etc/resolv.conf`，不给 `tailscale0` 配 DNS，于是 `*.ts.net` 解析不了，配对命令第一步的 `curl` 就连不上。先核对：

```sh
getent hosts <Workbench 主机名>     # 例如 host.<tailnet>.ts.net；没有输出就是这个问题
```

修法是让 tailscaled 每次启动后把 MagicDNS 交给 resolved。drop-in 写在 `/etc`，重启和系统更新后都保留。`<tailnet>.ts.net` 换成 Workbench 主机名去掉第一段后的部分（也可用 `tailscale status --json | grep MagicDNSSuffix` 查）：

```sh
sudo install -d -m 0755 /etc/systemd/system/tailscaled.service.d
printf '%s\n' '[Service]' \
  'ExecStartPost=-/usr/bin/resolvectl dns tailscale0 100.100.100.100' \
  'ExecStartPost=-/usr/bin/resolvectl domain tailscale0 ~<tailnet>.ts.net' |
  sudo tee /etc/systemd/system/tailscaled.service.d/cardigan-magicdns.conf >/dev/null
sudo systemctl daemon-reload
sudo systemctl restart tailscaled
resolvectl status tailscale0       # 应看到 DNS Servers: 100.100.100.100
getent hosts <Workbench 主机名>     # 应解析出 100.x 的地址
```

Tailscale 的服务名不是 `tailscaled` 时，目录名换成 `systemctl list-units | grep -i tailscale` 看到的服务名。只想临时用一次，可以只执行这两条 `sudo resolvectl …`，重启后失效。撤销：删掉这个文件，`daemon-reload` 后重启 tailscaled。

## 2. 配对、初始化和体检报告

步骤与 [Linux 手册的快速上手](linux-worker.md#快速上手一行命令配对接入) 相同：

1. 设备上运行 `curl -fsS https://<Workbench>/pair-device.py | python3 - https://<Workbench>`。它会显示配对码、二维码，以及控制主机 `worker-known-hosts` 需要的一行 `steamdeck ssh-ed25519 <公钥>`；sshd 没启用、在用电池时会给出提示，但不会因此停下。
2. 把这一行（在向导里改了机器编号时，把开头换成新编号）加到控制主机私有的 `worker-known-hosts`（0600）。这一行是在设备自己的屏幕上读到的，相当于第 1 节要求的“从可信渠道取得主机公钥”。
3. 在 Workbench 机器页点“新设备接入（配对码）”或扫码，确认项目和名额（保持 1），预览后“确认写入配置”。这时不要在设备上手动建账号或运行 `install-linux-worker.py`：账号、目录和安装配置都由下一步的初始化脚本完成，手动做了反而会让初始化因账号已存在而停下。设备初始化完成、且检查停在需要在设备上操作的步骤之前，向导不显示“目标机命令”。
4. 回到设备终端，核对列出的初始化操作，输入 `yes`，再输入 `deck` 的密码。`sudo` 验证不过时不会做任何改动，也不会报告失败；设好密码后按回车重试即可，不用重新配对。
5. 初始化成功后向导自动复查。检查停在“工具”或“helper”时，按下一节在设备上准备，再点“继续检查”。全部通过后显示体检报告，远程派发仍在最后一步单独打开。之后再开时在机器详情点“开启远程派发”，沿用配对时写入的 `/home/cardigan-workers/<项目>` 布局（C-846）；重新进入“添加 worker”填写同一台机器时，也保留已写入草稿的 /home 布局。

## 3. 工具与 helper（都装在 /home）

向导的“目标机命令”在只读根分区设备上会读 `/home/cardigan-release/deploy`，而不是 `/opt/cardigan/deploy`。准备方法与 Linux 手册第 3 节相同，只是换了位置：

```sh
sudo install -d -o root -g root -m 0755 /home/cardigan-release /home/cardigan-tools
# 把与控制主机同一版本的发行文件解包到 /home/cardigan-release（保留 deploy/ 层级），然后：
sudo chmod -R go-w /home/cardigan-release/deploy
```

之后按向导“目标机命令”里的 `tools`（hc）和 `helpers`（`worker-files.py`、`worker-git.py`、附件工具）逐条复制执行。

**Node 24 和 pnpm。** 不能 `npm install --global` 到 `/usr`。用 Node 官方的 Linux x64 归档，按官方 `SHASUMS256.txt` 核对后解到 `/home/cardigan-tools`，再在专用账号的 `.local/bin` 建链接（`<版本>` 换成实际版本）：

```sh
sudo tar --no-same-owner -xJf node-v<版本>-linux-x64.tar.xz -C /home/cardigan-tools
node=/home/cardigan-tools/node-v<版本>-linux-x64/bin
sudo env PATH="$node:$PATH" npm install --global --prefix /home/cardigan-tools/pnpm pnpm@11.7.0
for tool in "$node/node" "$node/npm" "$node/npx" /home/cardigan-tools/pnpm/bin/pnpm; do
  sudo ln -s "$tool" /home/cg_example/.local/bin/
done
```

Python 3 是系统自带的 `/usr/bin/python3`。Git 以体检报告和“工具”检查的结果为准。

**Blender（按需）。** 官方 Linux 归档解到 `/home/cardigan-tools`，把其中的 `blender` 链接到 `/home/cg_example/.local/bin/blender`，在机器页“立即检查”。能力目录只有 `gpu.nvidia` 和 `gpu.apple`，Steam Deck 的 AMD GPU 不会登记为 GPU 能力；体检报告里的 GPU 一行只是设备自报。

**Android SDK 和模拟器（按需）。** SDK 解到 `/home/cardigan-tools/android-sdk`，把 `platform-tools`、`emulator` 加进绑定的 `path`；AVD 放在专用账号可写的 `/home/cg_example/.local/share/android/avd`，用绑定的 `env.ANDROID_AVD_HOME` 指定（见 Linux 手册第 1 节）。硬件加速要专用账号能读写 `/dev/kvm`：先看 `ls -l /dev/kvm`，不是所有人可读写时，需要管理员决定是否把专用账号加入 `kvm` 组。初始化脚本不给账号加组；不加时只能软件加速，速度很慢，按限制记录。Steam Deck 作安卓模拟器机器的完整步骤见第 5 节。

## 4. 资源与系统更新

- 名额保持 1。CPU、内存上限照 Linux 手册第 4 节配置 `user-<UID>.slice`（写在 `/etc`，系统更新后保留）；Steam Deck 的内存与显存共用，`MemoryMax` 留出余量。
- 每次 SteamOS 更新后，在 Workbench 机器页点“立即检查”，再核对 `tailscale status`。`/etc` 和 `/home` 按 SteamOS 的设计会保留，检查失败时按失败步骤处理。
- 接入失败只影响这台设备：已接入的机器和它们的派发不受影响。

## 5. Steam Deck 作安卓模拟器机器

2026-11 把一台 Steam Deck（SteamOS 3.8、AMD VanGogh 核显、8 线程、约 14.5 GiB 内存）接成 sensen-godot 的安卓模拟器机器，替代长期关闭的 cardigan-ci 模拟器（C-709、C-828）。本节按那次接入整理；`sensen-godot`、`cg_sensen_godot`、`steamdeck` 是现场的项目、专用账号和机器编号，接其它项目时替换。路径中标“示例”的按实际安装位置填写。

### 结论

| 项 | 结论 | 依据 |
|---|---|---|
| 控制主机怎么连 | 走 Tailscale，不走局域网：worker 地址填 `<设备>.<tailnet>.ts.net`、端口 22，MCP 回连也走 tailnet；每台设备单独放行“控制主机 → 设备:22” | 起初 22 端口不通，是 tailnet 策略缺这条规则（tailscaled 日志 `Drop … no rules matched`），所有者补一条 accept 规则后通过。局域网直连只用来排除 sshd 本身的问题，不用于正式配置（见第 1 节） |
| 运行账号 | 用初始化脚本建的专用账号 `cg_sensen_godot`（按项目隔离，UID/GID 2000），不用 `deck` | `deck` 在 wheel 组、能 sudo，家目录是所有者个人的；专用账号也能用上显卡：`/dev/kvm` 和 `/dev/dri/renderD128` 在 Deck 上都是 `rw-rw-rw-`，不用加 `render`、`video`、`kvm` 组，硬件渲染靠借 `deck` 的桌面（见第 4 步） |
| 模拟器参数 | `-gpu host -no-window -no-snapshot-save -no-audio -no-boot-anim`，**不带 `-feature -Vulkan`** | Vulkan 必须开着，见下文“模拟器启动参数” |
| 并发 | 当前配置 1 个，2 个未实测 | 现场 `run-capacity.yaml`，见下文 |

### 接入步骤

1. **基础接入。** 按第 1～4 节完成准备、配对、初始化和体检报告，包括第 1 节的 tailnet 规则和 MagicDNS drop-in。资源上限按“名额 1、主要跑模拟器”配置，现场用的是：

   ```ini
   # /etc/systemd/system/user-<UID>.slice.d/50-cardigan-worker.conf
   [Slice]
   CPUQuota=600%
   MemoryMax=10G
   TasksMax=4096
   ```

   Linux 手册的示例值（100% / 4G / 256）只给一个核，模拟器跑不动。

2. **工具目录 `/home/cardigan-tools`。** 由管理员安装，root 持有、`go-w`，专用账号只读。现场组成：

   | 工具 | 说明 |
   |---|---|
   | hc、Node 24、pnpm 11 | 第 3 节，基础接入就要 |
   | JDK 17 | Android 构建和 SDK 工具用 |
   | Android SDK（示例 `/home/cardigan-tools/android-sdk`） | `platform-tools`、`emulator`、`system-images;android-34;google_apis;x86_64`。这个 x86_64 镜像自带 ndk_translation，能跑 arm64 包 |
   | Godot | 项目需要时装，版本按项目要求 |

3. **专用账号的家目录。** 初始化建的家目录归 root，模拟器和 Gradle 要写的位置先用 sudo 建好，属主为专用账号：

   ```sh
   h=/home/cg_sensen_godot
   sudo install -d -o cg_sensen_godot -g cg_sensen_godot -m 0700 "$h/.android" "$h/.gradle"
   sudo install -o cg_sensen_godot -g cg_sensen_godot -m 0600 /dev/null "$h/.emulator_console_auth_token"
   ls -l /dev/kvm /dev/dri/renderD128   # Deck 上为 rw-rw-rw-，不用给账号加组
   ```

   `ANDROID_USER_HOME`、`GRADLE_USER_HOME` 和 AVD 放到专用账号自己可写的 `~/.local/share` 下（第 5 步的 `env`），AVD 名字按项目要求建。设备权限不是所有人可读写时，由管理员决定是否把专用账号加入 `kvm`、`render` 组（初始化脚本不加组）。

4. **借桌面用显卡。** 专用账号要借 `deck` 的 X 桌面才能用硬件 GPU，不借就只能软件渲染：
   - Deck 默认进桌面模式（以 `deck` 执行一次）：`steamosctl set-default-login-mode desktop`；
   - `deck` 登录桌面时自动放行专用账号连这个显示。现场用自启动项 `~/.config/autostart/cardigan-worker-xhost.desktop`（`deck` 的家目录下）：

     ```ini
     [Desktop Entry]
     Type=Application
     Name=cardigan-worker-xhost
     Exec=xhost +SI:localuser:cg_sensen_godot
     ```

   - 绑定 `env` 设 `DISPLAY: ":0"`（第 5 步）。

   这条授权只给本机这一个账号，但它能连上 `deck` 的整个 X 显示（包括屏幕和输入）。切回游戏模式或桌面没登录时，Run 退回软件渲染。

5. **控制主机：`runtime-workers.yaml`。** 先确认这台机器没有在跑的 Run，备份后在向导写入的绑定上补 `path` 和 `env`，其它字段保持向导生成的值（`root`、helper 都在 `/home/cardigan-workers/<项目>` 下）：

   ```yaml
   - project_id: sensen-godot
     user: cg_sensen_godot
     root: /home/cardigan-workers/sensen-godot
     # 示例：SDK 的 platform-tools 和 emulator 加进 path
     path: /home/cg_sensen_godot/.local/bin:/home/cardigan-tools/android-sdk/platform-tools:/home/cardigan-tools/android-sdk/emulator:/usr/bin:/bin
     env:
       ANDROID_HOME: /home/cardigan-tools/android-sdk
       ANDROID_USER_HOME: /home/cg_sensen_godot/.local/share/android      # 示例
       ANDROID_AVD_HOME: /home/cg_sensen_godot/.local/share/android/avd   # 示例
       GRADLE_USER_HOME: /home/cg_sensen_godot/.local/share/gradle        # 示例
       DISPLAY: ":0"
       SENSEN_EMULATOR_GPU: host
   ```

   - 不写 `ANDROID_ADB_SERVER_PORT`，adb 端口由下一步的 `adb_slots` 按 Run 分配（[Linux 手册第 1 节](linux-worker.md#1-控制主机预览与私有配置)）。
   - `SENSEN_EMULATOR_GPU=host` 由 sensen 自己的模拟器脚本读取，用来打开 `-gpu host`；Cardigan 不解释它。项目自定义变量不要用 `CARDIGAN_` 开头，这个前缀系统保留，绑定校验会拒绝。
   - 没拿到模拟器的 Run 不会得到 `ANDROID_AVD_HOME`，`path` 里的 `emulator` 目录也会被去掉（C-844），打包不受影响。
   - 改了 `env` 或 `path`，这台机器的工作树准备证据会变成“待重新验证”，下一次真实准备成功后自动续期；机器上没有在用的 Assignment 时，要显式指派一次（C-784）。

6. **控制主机：`run-capacity.yaml`。** 现场配置：

   ```yaml
   machines:
     steamdeck:
       limit: 1
       max_limit: 1
       resources:
         android.emulator: 1
         godot: 1
       adb_slots:
         resources: [android.emulator]
         adb_port_base: 15100
         emulator_port_base: 5600
   ```

   `emulator_port_base` 取 5586～5682 之间的偶数，规则见 [C-679 计划](plans/C-679.md)。配置生效后执行 `cardigan machine check steamdeck --project sensen-godot`，确认 `android.emulator` 已验证；再由所有者在机器详情点“开启远程派发”（C-846），挑项目没有活跃 Run 的时候开。

7. **实测。** 派一个要求 `android.emulator`（或 `android.any`）的工作项到这台机器，核对：
   - Run 环境里有本次槽位的 `ANDROID_ADB_SERVER_PORT`、`ANDROID_SERIAL`、`CARDIGAN_EMULATOR_PORT`，模拟器序列号是 `emulator-<5600 + 2×槽位>`；
   - 按下文参数起模拟器，能装包、截图；
   - 在用显卡：Godot 日志显示 Vulkan 1.3.0、Forward Mobile 渲染器，设备为 `Goldfish GFXStream (RADV VANGOGH)`。看不到 RADV 就是软件渲染，回到第 3、4 步查设备权限和借桌面。

   C-828 的参考读数：冷启动到 `boot_completed` 19.6 秒；x86_64 测试包稳定段 30 秒 60 fps、丢帧 0；qemu 约 180% CPU、RSS 约 4.5 GB；收尾时模拟器收到 TERM 正常退出。第一次真实 Run 成功后，工作树准备证据自动登记。

### 模拟器启动参数

实测用的是 `-gpu host -no-window -no-snapshot-save -no-audio -no-boot-anim`：

- **不要加 `-feature -Vulkan`。** Vulkan 必须开着：sensen 的 Godot 用 Mobile 渲染器，依赖 Vulkan。建卡时依据的早期笔记写过“不关 Vulkan，Godot 会卡在 `Couldn't present to Vulkan queue (VkResult error 5)`，必须关”，已被 C-828 实测推翻，以实测为准。
- `-gpu host`：用 Deck 的 AMD 核显，前提是第 4 步借到了桌面。预研对比 cardigan-ci 那样的软件渲染（swangle）：游戏首屏 2.4 秒对 5.0 秒，30 秒帧数 22 对 6，卡顿 18% 对 100%，中位帧时间 18 ms 对 300 ms。
- 端口和序列号用 Run 环境里槽位分配的值（`CARDIGAN_EMULATOR_PORT`、`ANDROID_SERIAL`、`ANDROID_ADB_SERVER_PORT`），不要写死，也不要手写 adb 的 `-P`。

### 并发：当前配置 1 个，2 个未实测

现场名额是 1，经派发同时跑 2 个模拟器没有在 Deck 上实测过。要试 2 个时：

- `limit`、`max_limit`、`resources.android.emulator` 一起改成 2；adb 槽位数默认等于名额之和，不用另配；
- 单个模拟器 qemu 约 180% CPU、RSS 约 4.5 GB，Deck 可用内存约 14.8 GB：`user-<UID>.slice` 的 `MemoryMax` 要容得下两个 qemu 再加构建，先实测再定。

### Deck 特有的注意事项

- 系统更新后 `/etc`、`/home` 保留，但要在机器页“立即检查”，再核对 `tailscale status`、第 1 节的 MagicDNS drop-in 和第 4 步的默认进桌面仍生效。
- 一直插电、关掉自动休眠（第 1 节）；休眠或按电源键会让进行中的 Run 失联。
- 内存与显存共用：模拟器、Godot 和构建一起跑时内存最紧，`MemoryMax` 不要按整机内存填。
- Deck 的 AMD 核显不会登记成 GPU 能力；模拟器工作项靠 `android.emulator` 选机，不受影响。

## 已知限制（实验支持）

- 后台自动升级 helper（Linux 手册“一次接入，之后由后台升级 helper”）要往 `/opt` 安装入口，SteamOS 上不可用；helper 升级按 Linux 手册的人工步骤，把 `/opt/cardigan` 换成 `/home/cardigan-release`。
- 没有 AMD GPU 能力项；需要 GPU 的工作项不会自动选到这台设备。
- 模拟器的硬件加速取决于 `/dev/kvm`、显卡设备的权限，以及专用账号能否借到桌面（见第 5 节）；Steam Deck 上 C-828 实测专用账号可用。
- 设备休眠、断电或系统更新重启期间，进行中的 Run 会失联，按普通失联流程处理。
