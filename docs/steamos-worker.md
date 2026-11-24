# 接入 SteamOS 设备（Steam Deck，实验支持）

Steam Deck 等 SteamOS 3 设备按**实验支持**接入：基础接入（配对、一次性初始化、九项检查）和体检报告要求跑通；工具装在 `/home` 下，模拟器、GPU 工具能跑通就登记，跑不通记为限制。本文只写与普通 Linux 不同的地方，其余以 [Linux worker 手册](linux-worker.md) 为准。下文 `example`、`cg_example`、`steamdeck` 都是示例。

## SteamOS 与普通 Linux 的差异

| 项 | SteamOS 的情况 | 接入时的做法 |
|---|---|---|
| 根分区 | `/`（含 `/usr`、`/opt`、`/srv`）只读，系统更新整体替换 | 工作根放 `/home/cardigan-workers/<项目>`，发行文件放 `/home/cardigan-release`，工具放 `/home/cardigan-tools`；配对时自动识别（设备上报根分区只读或系统名含 SteamOS） |
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

**Tailscale。** SteamOS 不自带 Tailscale。按 Tailscale 对 SteamOS 的说明把它装在不受系统更新影响的位置并登录 tailnet；每次系统更新后用 `tailscale status` 核对它仍在运行。tailnet 访问规则要放行两个方向：

- 控制主机 → 设备的 TCP 22（向导经 SSH 检查和启动 Run）；
- 设备 → 控制主机 Serve 端口（MCP，写法见 [Linux 手册第 4 节](linux-worker.md#4-worker资源与-mcp)）。

## 2. 配对、初始化和体检报告

步骤与 [Linux 手册的快速接入](linux-worker.md#快速接入配对和一次性初始化) 相同：

1. 设备上运行 `curl -fsS https://<Workbench>/pair-device.py | python3 - https://<Workbench>`。它会显示配对码、二维码，以及控制主机 `worker-known-hosts` 需要的一行 `steamdeck ssh-ed25519 <公钥>`；sshd 没启用、在用电池时会给出提示，但不会因此停下。
2. 把这一行（在向导里改了机器编号时，把开头换成新编号）加到控制主机私有的 `worker-known-hosts`（0600）。这一行是在设备自己的屏幕上读到的，相当于第 1 节要求的“从可信渠道取得主机公钥”。
3. 在 Workbench 机器页点“新设备接入（配对码）”或扫码，确认项目和名额（保持 1），预览后“确认写入配置”。
4. 回到设备终端，核对列出的初始化操作，输入 `yes`，再输入 `deck` 的密码。`sudo` 验证不过时不会做任何改动，也不会报告失败；设好密码后按回车重试即可，不用重新配对。
5. 初始化成功后向导自动复查。检查停在“工具”或“helper”时，按下一节在设备上准备，再点“继续检查”。全部通过后显示体检报告，远程派发仍在最后一步单独打开。

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

**Android SDK 和模拟器（按需）。** SDK 解到 `/home/cardigan-tools/android-sdk`，把 `platform-tools`、`emulator` 加进绑定的 `path`；AVD 放在专用账号可写的 `/home/cg_example/.local/share/android/avd`，用绑定的 `env.ANDROID_AVD_HOME` 指定（见 Linux 手册第 1 节）。硬件加速要专用账号能读写 `/dev/kvm`：先看 `ls -l /dev/kvm`，不是所有人可读写时，需要管理员决定是否把专用账号加入 `kvm` 组。初始化脚本不给账号加组；不加时只能软件加速，速度很慢，按限制记录。

## 4. 资源与系统更新

- 名额保持 1。CPU、内存上限照 Linux 手册第 4 节配置 `user-<UID>.slice`（写在 `/etc`，系统更新后保留）；Steam Deck 的内存与显存共用，`MemoryMax` 留出余量。
- 每次 SteamOS 更新后，在 Workbench 机器页点“立即检查”，再核对 `tailscale status`。`/etc` 和 `/home` 按 SteamOS 的设计会保留，检查失败时按失败步骤处理。
- 接入失败只影响这台设备：已接入的机器和它们的派发不受影响。

## 已知限制（实验支持）

- 后台自动升级 helper（Linux 手册“一次接入，之后由后台升级 helper”）要往 `/opt` 安装入口，SteamOS 上不可用；helper 升级按 Linux 手册的人工步骤，把 `/opt/cardigan` 换成 `/home/cardigan-release`。
- 没有 AMD GPU 能力项；需要 GPU 的工作项不会自动选到这台设备。
- 模拟器的硬件加速取决于 `/dev/kvm` 权限，见上一节。
- 设备休眠、断电或系统更新重启期间，进行中的 Run 会失联，按普通失联流程处理。
