# 机器能力检查

能力由控制主机检查，以项目和机器分别保存；不使用人工标签作为验证证据。
后台启动立即检查，之后每 30 分钟巡检一次。`worker add/resume/check` 和
`machine check` 立即刷新；`machine show` 只读最近结果。检查不安装工具、不登录账号、
不修改机器管理状态，也不启用远程派发。

```sh
cardigan machine check <机器> --project <项目>
cardigan machine show <机器> --project <项目>
```

输出的 `capabilities` 包含能力键、版本、验证时间、证据引用和 `available`。
证据引用指向同次持久化的机器检查记录，并以能力键区分；不引用原始命令日志。
验证失败撤销上一轮能力；成功记录超过 24 小时后 `available=false`，未来时间也无效。
`health` 保存最近一次检查的结果、时间、阻断原因和启动开关；健康与能力分别显示。
健康检查失败或过期时不可视为可用，人工设置的 `status` 保持不变。
健康检查失败时跳过后续工具探测，并撤销之前的能力验证。
后台和 CLI 重叠检查时只有最新发起的一轮可以写回，检查中的旧能力立即失效。

内置能力有 Blender、Godot、NVIDIA/Apple GPU、Android SDK/模拟器、Xcode、
iOS 模拟器、Docker、Node、Python、Chromium 和三种启动器：`harness.codex`（`codex`）、
`harness.claude-code`（`claude`）、`harness.pi`（`pi`）。工具须在 worker 配置的 PATH 中；
Chromium 也支持常见 Chrome 与 Playwright 缓存位置。GPU/Xcode/iOS 按适用系统检查。
Docker 检查服务端可达；版本只保存数字版本段，原始横幅、账号信息和检查输出不落库。

自定义项写在控制主机配置目录的 `machine-capabilities.yaml` 中，目录与
`runtime-workers.yaml` 相同。目录须由主机账号持有，文件权限为 `0600`，不得为
符号链接或硬链接；不存在时使用内置目录，配置错误不会回退为成功。文件示例：

```yaml
version: 1
capabilities:
  lark-cli:
    os: [linux, darwin]              # 可省略，默认这两个系统
    check: [lark-cli, auth, status]
    version: [lark-cli, --version]  # 可省略，版本显示 null
```

键不可覆盖内置项，最多 64 个自定义项。命令是参数数组，不自动经 shell 展开。
检查命令退出码为 0 才通过；配置了版本命令时，该命令也须成功且输出可解析的数字版本。
命令由受信主机配置指定，不接受卡片、Token 或项目文件中的命令。
每个命令最多运行 10 秒、返回 16 KiB，超限视为失败；控制端另设 SSH 超时。
命令以项目 worker 账号经固定主机密钥的 SSH 执行，本机也沿已配置的执行账号运行；
传统 local 模式使用实际运行账号。只保留 PATH、账号 HOME 与固定语言环境，不传递主机 Token。
需要登录的 CLI 由人先在对应 worker 账号完成配置，检查不会创建凭据。

## 就绪巡检与自愈

同一轮检查还以 worker 账号跑固定的就绪巡检，结果写进 `health.readiness`，机器设置页的
“就绪巡检”表按项目显示。除 Card MCP 不可达外，所有发现都只告警，不停派：

- `disk`：`agentRoot` 所在卷的可用空间。低于水位时先自动清理：已释放超过 24 小时、
  无未结束 Run 和打开待办的指派目录下的 `cache`、`generations`、`temporary`（保留 `sessions`）；
  该项目在这台机器上没有在跑任务时，再清账号的 Xcode DerivedData、npm `_cacache`、pip、uv 缓存。
  只删属于该账号且不是符号链接的目录，释放量记在时间线。
- `network`：到控制主机的 TCP 往返（3 次取中位数）和经 SSH 下发的下行吞吐，超阈值报“链路慢”。
  启动检查遇到 MCP 超时或不可达时，后台会立即补跑一轮（同机 10 分钟一次）。
- `mcp`：沿用启动前的 Card MCP 检查，失败时不向该机器派发，并附带链路情况。
- `helper`：协议号相同而摘要不一致的 helper 按兼容处理，只告警并照常派发；已接入升级入口的机器
  在巡检或启动前自动升级（启动前触发同机 10 分钟一次），失败 6 小时后自动重试；
  只有正在写入 helper 时暂停派发。协议号落后仍停派，直到升级完成。
- `agent_tools`：附件助手存在且与当前发布一致。
- `avd:<名>`、`simulator:<名>`：项目声明的 AVD 配置和镜像可读（外接盘被系统隐私权限拒绝时报
  无法读取），iOS 模拟器设备可用；不会真正开机。

新出现的告警发给主机运维（不挡任何工作项），同一项持续告警不重复发；每次结果变化记一条时间线。
阈值与声明在控制主机配置目录的 `machine-readiness.yaml` 中（与 `runtime-workers.yaml` 同目录、
同样要求 `0600`）；不存在时使用默认值，配置错误时按默认值检查并报 `config` 告警：

```yaml
version: 1
disk_min_free_gib: 20          # 默认 20
network:
  min_throughput_mb_s: 2       # 默认 2 MB/s
  max_rtt_ms: 500              # 默认 500 ms
  payload_mib: 4               # 测速下发量，0 表示不测吞吐
projects:
  sensen-godot:
    android_avds: [Pixel_7_API_34]
    ios_simulators: ["iPhone 15"]
```

## 自动选机和首发失败恢复

未指定机器时，远程候选必须具备员工实际启动配置所需的启动器；员工未覆盖配置时取该角色固定版本的启动配置。机器缺少版本证据、证据过期或启动配置未知时，查看 `machine_selected` 的排除原因；所有候选都不可用时，查看交给 PM 的缺项说明。工作机更换账号、绑定代次、操作系统或处理器架构后，旧记录即使没过期也不能证明新目标装有启动器；请重新运行 `machine check`。旧版本的记录若缺少绑定或探测平台，也须重新检查。

本机不要求额外的启动器证据，但仍须满足角色和工作项已有的能力要求。前端工程师和设计总监的默认角色包都要求 `browser.chromium`。

若旧指派已经误派，先核实同卡的系统 `bell_delivery_failed` 原因是 `snapshot_unavailable`，且从未创建 Run、终端或工作区。PM Ops 可调用 `release_assignment` 释放该指派，再对**原工作项**调用 `assign`，保留原角色，不传 `machine_id` 或 `recovery_source`。系统避开上次失败的机器重新选机；没有候选时先补足能力证据，再重试。新身份继续原工作项，验证目标不变；若旧指派原本从已确认的备份接管，新身份沿用同一备份提交。进行中的工作项不必退回待办；PM 可用原工作项指令让新指派继续。已经运行过或发生失联的指派不能用这个方式换机。

总体方案见
[机器能力标签与自动选机方案](plans/machine-capabilities.md)。
