# 设备提供方：怎么新增一种外接测试设备

外接测试设备（安卓真机，以后的 iOS 真机、Steam Deck、手柄等）在 Cardigan 里是可调度资源：机器检查列出每台机器上的设备，工作项按类型（可按编号或型号）要求设备，派发时独占一台，Run 结束后释放。每种设备由一个**提供方**负责，框架部分对所有提供方相同。设计见 [C-813 计划](plans/C-813.md)，安卓真机的接入见[接入一台安卓真机](android-device.md)。

## 框架已经做好的

- **资源命名**：每台设备是名额为 1 的资源 `<类型>:<设备编号>`（例如 `android.device:WGC6R21609003324`），汇总成类型级能力（`android.device`），并按型号登记 `<类型>.model.<型号>`（小写，其它字符换成 `-`）。
- **机器检查**：前置能力（如 `android.sdk`）验证通过后调用提供方列出设备，只保留通过严格格式校验的字段（编号、型号、系统版本、状态），每种最多 16 台；状态为 `available`（可用）、`unauthorized`（未授权）、`offline`（离线）、`unavailable`（其它不可用）、`in_use`（被某个 Run 独占，列不到时沿用上次信息）。可用和 `in_use` 的设备登记成能力。列表失败只记在 `capability_failures`，不影响机器健康。
- **派发**：工作项写类型、`<类型>:<编号>` 或 `<类型>.model.<型号>`，都同时占一个类型名额。领取时在本项目对这台机器当前有效的检查结果里，按编号顺序选第一台：可用（或 `in_use` 但已无持有者）、没有被未释放租约持有、没被其它项目预约、满足全部编号/型号条件。没有时排队。数据库唯一索引保证同一台设备同一时刻只有一个未释放的租约（跨项目）。
- **名额和预约**：沿用 `run-capacity.yaml` 的 `resources`（类型名额，例如 `android.device: 1`；要预约某一台时把 `<类型>:<编号>: 1` 也写进去）和 `cardigan machine reserve`。
- **释放**：Run 结束、没有进行中的启动、并且它的 adb 槽位（如有）已经关闭后释放租约。
- **发现和启用（C-817）**：机器检查第一次看到某台可用设备时，登记为“待启用”，并在 Needs You 提示“<机器> 发现 <型号>，给 <项目> 用？”；一台设备只有一条提示，多个项目共用的机器在提示里勾选项目（C-832）。人启用后，下一次机器检查执行提供方声明的初始化步骤，成功后设备才可派发，而且只派给人指定的项目。失败时提示原因，可以重试。也可以用 `cardigan machine device list|enable|disable|assign`。设计见 [C-817 计划](plans/C-817.md)。
- **会话**：Run 启动时，框架把提供方给出的环境变量（只允许 `ANDROID_SERIAL` 或 `CARDIGAN_*`，值只能是编号类的普通字符）和一句提示规则交给会话。

## 多选一的要求（`android.any`）

“安卓设备任一”是一个多选一的能力（domain `CAPABILITY_ALTERNATIVES`）：选项是 `android.emulator` 和 `android.device`。机器检查在任一选项验证通过后登记它；派发前和领取时（同样的输入得到同样的结果）按顺序选第一个空闲的选项，没有空闲的就等机器具备的第一个，下一次派发再重新选。Run 同时占 `android.any` 和选中的选项，名额、adb 槽位和设备租约都按选项处理。新增一种设备提供方时，如果它也能替代某类设备，把它加进对应多选一的选项即可。见 [C-815 计划](plans/C-815.md)。

## 新增一个提供方要做的

1. 在 `packages/host/src/` 新建 `<名字>-device-provider.ts`，导出一个 `HostDeviceProvider`（定义在 `device-provider-host.ts`，实现 domain 的 `DeviceProviderPort`）：
   - `type`：类型键，小写，例如 `ios.device`；`label`：显示名；`os`：能列出设备的平台。
   - `requires_capability`（可选）：列设备前必须已验证的机器能力，例如 `xcode`。
   - `list(target)`：用 `target.probe` 在工作机上以项目账号运行**主机自带**的命令（不是项目文件），返回原始设备行 `{id, state, model?, version?}`；失败返回 `undefined`。不要输出凭据、账号名或主机私有路径。
   - `sessionEnv(device, context)`：分到这台设备的 Run 拿到的环境变量。
   - `sessionRule(device, context)`：一句给会话的使用规则。
   - `setup_steps`：首次接入时人要做的步骤（只展示，系统不执行）。
   - `init_steps` 和 `initialize(target, device)`（可选）：人启用设备后系统执行的固定步骤。`initialize` 用 `target.probe` 运行主机自带的固定命令（设备编号作为参数传入），返回 `{result: "ok", resolution?, version?}`、`{result: "failed", step: <init_steps 的 key>}`、`{result: "unauthorized"}` 或 `{result: "not_found"}`。其它输出一律丢弃，原因文案由框架生成。不能恢复出厂，不能装卸应用。没有这两项的提供方，启用后直接可派发。
   - 设备要通过 Run 自己的 adb 服务使用时设 `needs_adb_slot: true`（机器的 `adb_slots.resources` 必须包含该类型）。
2. 加进 `packages/host/src/device-providers.ts` 的 `DEVICE_PROVIDERS`。
3. 测试：列表解析（含异常输出）、`list` 走 `probe`、`sessionEnv`/`sessionRule`，有初始化时加上脚本只做声明的步骤；参照 `android-device-provider.test.ts`。框架部分的契约测试在 `packages/domain/src/device-provider.contract.test.ts`，不用重复写。
4. 文档：在 `docs/` 写这种设备的接入步骤，并在本页列出。

## 已有的提供方

| 类型 | 说明 | 接入 |
|---|---|---|
| `android.device` | adb 能看到的 USB 安卓真机 | [接入一台安卓真机](android-device.md) |
