# 接入一台安卓真机（USB）

真机在 Cardigan 里是能力 `android.device`：机器检查列出 adb 能看到的 USB 真机，每台已授权的真机是一个名额为 1 的资源。要求 `android.device` 的工作项只派到有这台真机的机器，派发时独占一台，Run 结束后释放。设计见 [C-813 计划](plans/C-813.md)。

## 前提

- 机器已按 [macOS](macos-worker.md) 或 [Linux](linux-worker.md) 接入，`android.sdk`（adb）已验证。
- 控制主机的 `run-capacity.yaml` 里，这台机器已配置 `adb_slots`（[C-679](plans/C-679.md)）。真机只交给 Run 自己的 adb 服务，Run 结束时系统关闭这个服务，真机才会空出来；没有 `adb_slots` 的机器不派真机。

## 1. 接上并授权（在机器旁边，所有者或现场人员）

1. 平板打开“开发者选项 → USB 调试”，用 USB 线接到机器。
2. 授权按**账号**区分：adb 用账号自己的密钥（`~/.android/adbkey`）。用项目的专用账号（例如 sensen 用 `cg_sensen`）在机器上执行一次：

   ```sh
   adb -P 15999 start-server   # 临时端口，不碰正在用的服务
   adb -P 15999 devices -l     # 平板弹出“允许 USB 调试吗？”时勾选“始终允许”并确认
   adb -P 15999 kill-server
   ```

   哪个项目要用这台真机，就在哪个项目的专用账号下授权一次。机器检查以项目账号运行，只把该账号已授权的真机算作这个项目可用的设备。
3. 同一台真机同一时间只能被一个 adb 服务占用。不要在机器上留常驻的 adb 服务（例如以前写死的固定端口服务）；`adb_slots` 的 `legacy_adb_ports` 写了旧端口时，巡检会在没有旧 Run 时关闭它，也可以手动 `adb -P <旧端口> kill-server`。

## 2. 控制主机：名额（主机运维）

在这台机器的条目里把 `android.device` 加进 `resources` 和 `adb_slots.resources`（示例，不是生产配置）：

```yaml
machines:
  mac-mini:
    resources: { android.emulator: 1, android.device: 1 }
    adb_slots:
      resources: [android.emulator, android.device]
      adb_port_base: 15100
      emulator_port_base: 5600
```

`android.device` 的名额一般等于接入的真机数；名额和模拟器各算各的。配置后重启控制面。这台机器上不持有真机的 Run（只要模拟器、godot 等）启动时带 `ADB_USB=0`，它们的 adb 服务不会去抢 USB 真机。

## 3. 检查

```sh
cardigan machine check mac-mini --project sensen
```

输出的 `health.android_devices` 列出每台真机的序列号、型号、Android 版本和状态：

| 状态 | 含义 |
|---|---|
| `authorized` | 已授权，可派发 |
| `in_use` | 某个 Run 正在独占（它的 adb 服务占着设备，检查时看不到，保留上次的信息） |
| `unauthorized` | 平板上还没确认这个账号的授权 |
| `offline` | 连接异常，重插或重启平板 |
| `no_permission` | Linux 上账号没有 USB 设备权限（udev 规则） |

拔掉后再检查，这台真机从列表里消失，机器也不再有对应能力。已授权的真机会给机器登记能力 `android.device`、`android.device.serial.<序列号>`、`android.device.model.<型号>`（小写，其它字符换成 `-`）。机器每 30 分钟自动检查一次。

## 4. 工作项怎么要真机

- 任意一台：`requirements.capabilities` 写 `android.device`。
- 指定型号：`android.device.model.mrr-w39`；指定某一台：`android.device.serial.wgc6r21609003324`。
- 同时要模拟器：再加 `android.emulator`。

Run 拿到真机时的环境：

| 情况 | `ANDROID_SERIAL` | 其它 |
|---|---|---|
| 只有模拟器 | `emulator-<端口>` | `CARDIGAN_EMULATOR_PORT`（与以前相同） |
| 只有真机 | 真机序列号 | `CARDIGAN_DEVICE_SERIAL` |
| 两者都有 | 模拟器（`emulator-<端口>`） | `CARDIGAN_EMULATOR_SERIAL`、`CARDIGAN_DEVICE_SERIAL`；操作真机写 `adb -s $CARDIGAN_DEVICE_SERIAL` |

持有真机的 Run 第一条 adb 命令前先执行 `adb --one-device $CARDIGAN_DEVICE_SERIAL start-server`，只占用分到的那一台（同一机器接了多台真机时，不加这一步会把其它真机也占住）。角色提示里已写明。

## 排障

- 工作项一直排队，原因“真机：没有空闲的已授权真机”：真机被别的 Run 占着，或最近一次检查里没有已授权的真机。看 `cardigan machine show <机器>` 的 `adb_slots`（哪个 Run 持有哪台 `device`）和 `health.android_devices`，授权或重插后重新 `machine check`。
- 原因“真机：本机 adb_slots 未包含 android.device”：按第 2 节补配置。
- 真机在使用中被拔掉：本次 Run 的 adb 会找不到设备；Run 结束后下一次机器检查把它从列表中去掉。
