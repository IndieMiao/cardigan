# 接入一台安卓真机（USB）

安卓真机是第一个[设备提供方](device-providers.md)，类型 `android.device`：机器检查列出 adb 能看到的 USB 真机，每台可用的真机是名额为 1 的资源 `android.device:<序列号>`。要求 `android.device` 的工作项只派到有空闲真机的机器，派发时独占一台，Run 结束后释放。设计见 [C-813 计划](plans/C-813.md)。

## 谁占着真机

USB 真机同一时刻只能被一个 adb 服务占用。Cardigan 的做法：

- 真机只交给持有它的 Run **自己的** adb 服务（[C-679](plans/C-679.md) 的 adb 槽位，`ANDROID_ADB_SERVER_PORT`）。
- 同一台机器上不持有真机的槽位 Run（只要模拟器、godot 等）启动时带 `ADB_USB=0`，它们的 adb 服务不会去抢 USB 设备。
- Run 结束后，系统关闭它的 adb 服务（释放 USB），之后才释放真机租约给下一个 Run。
- 机器检查用一个临时 adb 服务（随机端口，查完即关）列设备，不碰任何已有的 adb 服务，也抢不走正被占用的设备。

## 前提

- 机器已按 [macOS](macos-worker.md) 或 [Linux](linux-worker.md) 接入，`android.sdk`（adb）已验证。
- 控制主机的 `run-capacity.yaml` 里，这台机器已配置 `adb_slots`，且 `adb_slots.resources` 包含 `android.device`。没有的机器不派真机。

## 1. 接上并授权（在机器旁边，所有者或现场人员）

1. 平板打开“开发者选项 → USB 调试”，用 USB 线接到机器。
2. 授权按**账号**区分：adb 用账号自己的密钥（`~/.android/adbkey`）。用项目的专用账号（例如 sensen 用 `cg_sensen`）在机器上执行一次：

   ```sh
   adb -P 15999 start-server   # 临时端口，不碰正在用的服务
   adb -P 15999 devices -l     # 平板弹出“允许 USB 调试吗？”时勾选“始终允许”并确认
   adb -P 15999 kill-server
   ```

   哪个项目要用这台真机，就在哪个项目的专用账号下授权一次。机器检查以项目账号运行，只把该账号已授权的真机算作这个项目可用的设备。
3. 不要在机器上留常驻的 adb 服务（例如以前写死的固定端口服务，mac-mini 上 `cg_sensen` 的 5137）：它会一直占着真机。`adb_slots` 的 `legacy_adb_ports` 写了旧端口时，巡检会在没有旧 Run 时关闭它；还有旧 Run 可能在用时，巡检发现它占着 USB 真机就以 `ADB_USB=0` 重启它（模拟器按原序列号重新连上，但这个服务上的 `adb forward` / `adb reverse` 规则会丢失，见 [C-833](plans/C-833.md)）。也可以手动 `adb -P <旧端口> kill-server`。

   启用或初始化时看不到真机、而它被机器上别的 adb 服务占着时，失败原因会写明占用的端口和会话。

## 2. 在 Needs You 启用（所有者）

机器检查（每 30 分钟一次，也可以在设置页或 CLI 手动检查）看到这台新真机后，Needs You 会出现“<机器> 发现安卓真机 <型号>（<序列号>），给 <项目> 用？”。机器只给一个项目用时已经选好项目，点“启用，给 <项目> 用”即可；给多个项目用时，在这条提示里勾选一个或几个项目再点“启用”。一台设备只出一条提示，出现在登记这台机器的项目里最早建的那个项目的 Needs You（Workbench 默认打开的项目）。

启用后系统在一分钟内自动初始化：插电常亮、关闭动画（三项缩放）、关闭锁屏，并记录分辨率和系统版本。不恢复出厂，不装卸其它应用。成功后这条待办自动结项，真机开始接活；失败时待办里写明原因（例如设备设了锁屏密码，要先在设备上把锁屏方式改为“无”），处理后点“重试”。不想给 Cardigan 用就点“不启用”。

同样的操作也可以在控制主机上用 CLI 完成，CLI 当场执行初始化：

```sh
cardigan machine device list mac-mini
cardigan machine device enable mac-mini android.device:WGC6R21609003324 --projects sensen
cardigan machine device assign mac-mini android.device:WGC6R21609003324 --projects sensen,cardigan
cardigan machine device disable mac-mini android.device:WGC6R21609003324
```

停用或改项目不会打断正在用它的 Run，那个 Run 结束后才不再派给它。

## 3. 控制主机：名额（主机运维）

在这台机器的条目里把 `android.device` 加进 `resources` 和 `adb_slots.resources`（示例，不是生产配置）：

```yaml
machines:
  mac-mini:
    resources:
      android.emulator: 1
      android.device: 1
      # android.device:WGC6R21609003324: 1   # 需要预约这一台时再加
    adb_slots:
      resources: [android.emulator, android.device]
      adb_port_base: 15100
      emulator_port_base: 5600
```

`android.device` 的名额一般等于接入的真机数；名额和模拟器各算各的。配置后重启控制面。

## 4. 检查

```sh
cardigan machine check mac-mini --project sensen
```

输出的 `health.devices` 列出每台设备的类型、编号（序列号）、型号、Android 版本和状态：

| 状态 | 含义 |
|---|---|
| `available` | 可用，可派发 |
| `in_use` | 某个 Run 正在独占（它的 adb 服务占着设备，检查时看不到，保留上次的信息） |
| `unauthorized` | 平板上还没确认这个账号的授权 |
| `offline` | 连接异常，重插或重启平板 |
| `unavailable` | 其它情况，例如 Linux 上账号没有 USB 设备权限（udev 规则） |

拔掉后再检查，这台真机从列表里消失，机器也不再有对应能力。已启用、给了本项目的可用真机，才给机器登记能力 `android.device`、`android.device:<序列号>`、`android.device.model.<型号>`。机器每 30 分钟自动检查一次；两次检查之间，每分钟对已启用、没被 Run 占着的真机做一次在场检查（只起一个 `--one-device <序列号>` 的临时 adb 服务，不碰其它设备和端口），拔线或掉授权后一两分钟内就不再派给新的 Run，`android.any` 改用模拟器（[C-841](plans/C-841.md)）。在场检查要求 adb 支持 `--one-device`（platform-tools 35 起）；不支持时只靠 30 分钟的机器检查。`cardigan machine show <机器>` 的 `device_leases` 显示哪个 Run 正持有哪台设备。

## 5. 工作项怎么要真机

- 任意一台：`requirements.capabilities` 写 `android.device`。
- 指定型号：`android.device.model.mrr-w39`；指定某一台：`android.device:WGC6R21609003324`。
- 同时要模拟器：再加 `android.emulator`。

Run 拿到设备时的环境：

| 情况 | `ANDROID_SERIAL` | 其它 |
|---|---|---|
| 只有模拟器 | `emulator-<端口>` | `CARDIGAN_EMULATOR_PORT`（与以前相同）；机器配了真机时加 `ADB_USB=0` |
| 只有真机 | 真机序列号 | `CARDIGAN_DEVICE_SERIAL` |
| 两者都有 | 模拟器（`emulator-<端口>`） | `CARDIGAN_EMULATOR_SERIAL`、`CARDIGAN_DEVICE_SERIAL`；操作真机写 `adb -s $CARDIGAN_DEVICE_SERIAL` |

模拟器序列号一律看 `ANDROID_SERIAL`；`CARDIGAN_EMULATOR_SERIAL` 只在“两者都有”时设置（与 `ANDROID_SERIAL` 相同），只有模拟器时没有这个变量。

### 安卓设备任一（`android.any`，C-815）

不在乎模拟器还是真机的工作（tester、实测和取证类工作项默认如此）写 `android.any`：

- 机器上验证过模拟器（`android.emulator`）或有可用真机（`android.device`）就具备 `android.any`。
- 派发时哪个空闲用哪个：都空闲时先用真机，把模拟器留给只能用模拟器的工作；没有空闲真机时用模拟器，不为等真机排队；两类都忙时排队，哪个先空出来用哪个（[C-850](plans/C-850.md)）。独占、释放、名额、预约都和直接要求那一类相同，Run 的 `resource_keys` 记 `android.any` 加实际分到的那一类，`resource_choices` 和 `run_dispatched` 事件记选了哪类、为什么。
- 选机时（工作项指派到机器），有空闲真机的机器优先，其次有空闲模拟器的；机器上限、项目额度、名额和其它项目的预约仍排在前面。`machine_selected` 事件的候选里 `free_option` 记每台机器能马上给的那类，`alternative` 记最终选择和理由。
- 分到哪一类看 `ANDROID_SERIAL`：`emulator-` 开头是模拟器，否则是真机（也在 `CARDIGAN_DEVICE_SERIAL`）。环境与上表“只有模拟器”“只有真机”相同。
- 只有明确需要模拟器（快照、冷启动、指定手机分辨率）才写 `android.emulator`，明确需要真机才写 `android.device`；写了具体类型的工作项不受 `android.any` 影响。
- `run-capacity.yaml` 不用为 `android.any` 单独配名额（也可以配，作为两类合计的上限）；`adb_slots.resources` 照常列 `android.emulator`、`android.device`。

真机和模拟器的差异（Run 的能力说明里自带，项目可以用 `cardigan capability guide set` 写自己的 `android.any` 说明替换）：

| | 模拟器 | 真机（mac-mini 上的华为 MRR-W39 平板） |
|---|---|---|
| 系统 | 原生安卓镜像 | HarmonyOS 4.2（兼容 Android 12，API 31），厂商系统界面和权限弹窗 |
| 架构 | 镜像决定（可有 x86_64） | arm64-v8a |
| 分辨率 | 按镜像配置（手机分辨率） | 1600x2560、400dpi |
| 快照、冷启动 | 有 | 没有；回到干净状态只能卸载重装或 `adb shell pm clear <包名>` |
| 启动和关闭 | Run 用 `-port $CARDIGAN_EMULATOR_PORT` 启动，Run 结束时系统关闭 | 一直开着、插电不熄屏；不要重启、关机或改系统设置、锁屏、USB 授权 |
| 访问主机 | `10.0.2.2` | 没有这个地址 |

持有真机的 Run 第一条 adb 命令前先执行 `adb --one-device $CARDIGAN_DEVICE_SERIAL start-server`，只占用分到的那一台（同一机器接了多台真机时，不加这一步会把其它真机也占住）。角色提示里已写明。

## 排障

- 工作项一直排队，原因“安卓真机：没有空闲的可用设备”：真机还没在 Needs You 启用或没给这个项目，被别的 Run 占着，被其它项目预约，或者最近一次检查里没有可用的真机。用 `cardigan machine device list` 看启用状态。看 `cardigan machine show <机器>` 的 `device_leases` 和 `health.devices`，授权或重插后重新 `machine check`。
- 原因“安卓真机：本机 adb_slots 未包含 android.device”：按第 3 节补配置。
- 已启用的真机拔掉、掉授权或离线时，只有排队中的工作在等它，才会在 Needs You 出现提醒（在场检查后一两分钟内出现）。重新接好或授权后，下一次在场检查或机器检查会自动结项。
- 真机在使用中被拔掉：本次 Run 的 adb 会找不到设备；Run 结束、租约释放后，下一次在场检查把它从列表中去掉。
- 容量页或 `cardigan machine show` 出现“未登记的模拟器”：项目账号下有不属于任何 Run 槽位的模拟器进程（通常是没拿到模拟器的 Run 自己起的）。机器的模拟器被别的项目预约关闭或超出名额时，巡检（`sweep_minutes`）按进程停掉它，并在认得出的 Run 的卡上说明；没拿到模拟器的 Run 启动环境里本来就没有可用的 AVD（[C-844](plans/C-844.md)）。
