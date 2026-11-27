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
3. 不要在机器上留常驻的 adb 服务（例如以前写死的固定端口服务，mac-mini 上 `cg_sensen` 的 5137）：它会一直占着真机。`adb_slots` 的 `legacy_adb_ports` 写了旧端口时，巡检会在没有旧 Run 时关闭它，也可以手动 `adb -P <旧端口> kill-server`。

## 2. 控制主机：名额（主机运维）

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

## 3. 检查

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

拔掉后再检查，这台真机从列表里消失，机器也不再有对应能力。可用的真机给机器登记能力 `android.device`、`android.device:<序列号>`、`android.device.model.<型号>`。机器每 30 分钟自动检查一次。`cardigan machine show <机器>` 的 `device_leases` 显示哪个 Run 正持有哪台设备。

## 4. 工作项怎么要真机

- 任意一台：`requirements.capabilities` 写 `android.device`。
- 指定型号：`android.device.model.mrr-w39`；指定某一台：`android.device:WGC6R21609003324`。
- 同时要模拟器：再加 `android.emulator`。

Run 拿到设备时的环境：

| 情况 | `ANDROID_SERIAL` | 其它 |
|---|---|---|
| 只有模拟器 | `emulator-<端口>` | `CARDIGAN_EMULATOR_PORT`（与以前相同）；机器配了真机时加 `ADB_USB=0` |
| 只有真机 | 真机序列号 | `CARDIGAN_DEVICE_SERIAL` |
| 两者都有 | 模拟器（`emulator-<端口>`） | `CARDIGAN_EMULATOR_SERIAL`、`CARDIGAN_DEVICE_SERIAL`；操作真机写 `adb -s $CARDIGAN_DEVICE_SERIAL` |

持有真机的 Run 第一条 adb 命令前先执行 `adb --one-device $CARDIGAN_DEVICE_SERIAL start-server`，只占用分到的那一台（同一机器接了多台真机时，不加这一步会把其它真机也占住）。角色提示里已写明。

## 排障

- 工作项一直排队，原因“安卓真机：没有空闲的可用设备”：真机被别的 Run 占着、被其它项目预约，或最近一次检查里没有可用的真机。看 `cardigan machine show <机器>` 的 `device_leases` 和 `health.devices`，授权或重插后重新 `machine check`。
- 原因“安卓真机：本机 adb_slots 未包含 android.device”：按第 2 节补配置。
- 真机在使用中被拔掉：本次 Run 的 adb 会找不到设备；Run 结束后下一次机器检查把它从列表中去掉。
