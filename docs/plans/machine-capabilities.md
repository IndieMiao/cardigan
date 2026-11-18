# 机器能力标签与自动选机方案（草稿，2026-11-18，张良）

用户要求：先做机器配置/能力标签方案（blender、gpu、安卓模拟器、iOS 开发等），以及按这些配置/标签自动选择机器的机制。服务两个目标：sensen-godot 要用 Godot/Blender/模拟器；开源单人多机用户希望“加了机器就能自动用上”。开发方案原把“按能力标签和负载自动分配机器”放在 Phase 3（docs/development-plan.md:3302、3017），本方案按用户要求提前。

## 1. 现状（main d75cadbb）

| 项 | 现状 | 出处 |
|---|---|---|
| 机器登记 | Machine{id,label,os,arch,tags[],max_assignments,status}；只有人能 register/update/drain；tags 自由文本，人工维护 | domain/entities.ts:1088；commands/machines.ts:55-140 |
| 选机 | selectMachine 按 status、os、arch、required_tags 过滤；**恰好 1 台才通过**，多台报错要求指定、0 台报缺能力；不排序、不看负载 | commands/machines.ts:10-48 |
| 需求来源 | 只有 Role.required_machine_tags（项目级）和单次 assign 的 required_tags（不落库）；WorkItem/Card/模板没有需求字段 | entities.ts:89、381；assign-work-item.ts:178 |
| 系统自动指派 | 不传机器条件；候选≠1 时 system_assignment_deferred 交 PM | system-rules.ts:142-280 |
| 能力证据 | C-280 的 WorkerManifest（installed/configured/version/last_verified）只在启动前预检比对，不落库，与 tags 无关 | runtime-herdr/worker-capabilities.ts、worker-preflight.ts |
| 健康 | Machine.status 只由人写；machine check 结果不回写 | workflow.ts:732；machines.ts:137 |
| 容量 | 按物理机器计数，Assignment.machine_id 创建后不可改，Run 不跨机挪 | run-capacity.ts；不变量 development-plan.md:555 |
| 独占设备 | 无租约；C-285（设备/资源租约）暂缓 | p2b-multi-machine.md §4.8 |

## 2. 设计

### 2.1 两类标签
- **能力（capability）**：固定目录里的键，由系统探测验证，带版本和最后验证时间。例：`blender`、`godot`、`gpu.nvidia`、`gpu.apple`、`android.sdk`、`android.emulator`、`xcode`、`ios.simulator`、`docker`、`node`、`python`。人可以“声明期望”，但只有验证通过才算具备。
- **标签（tag）**：人自由填写，表达探测不了的属性（如 `fast-disk`、`office`、`sensen-only`）。保留现有 tags 字段与校验。

### 2.2 能力目录与探测
- 能力目录 = **内置常用项**（写在代码里）+ **主机私有配置里的自定义项**（人可随时加，不改代码）。
  - 内置：blender、godot、gpu.nvidia、gpu.apple、android.sdk、android.emulator、xcode、ios.simulator、docker、node、python、browser.chromium（前端/设计角色的无头浏览器依赖）等。每项：键、适用 OS、检查命令、版本解析。
  - 自定义（例，lark-cli 这类“装在机器上且要登录”的 CLI）：
    ```yaml
    capabilities:
      lark-cli:
        check: ["lark-cli", "auth", "status"]   # 退出码 0 即具备
        version: ["lark-cli", "--version"]
    ```
  - 分类原则：Cardigan 启动时注入的 MCP/工具本身不需要登记，但其依赖的机器程序（如 Playwright 用的 Chromium）算能力；需要在机器上安装/登录的 CLI 算能力（检查“已安装 + 已登录”，登录凭据属“凭据和账号”，由人配置，系统只检查）；纯远程服务（只走网络 API）不算机器能力。
- 主机侧定期（每 30 分钟；接入、worker check、machine check 时立即）经 agent-ssh 以项目 worker 账号运行检查，结果写入新表 machine_capabilities(project, machine, key, version, verified_at, evidence_ref)。检查失败或超过 24 小时未刷新视为不具备。同时记录机器健康快照（最近一次 machine check 的结果和时间）作为“当前可用”信号；Machine.status 仍是人设定的管理状态。
- 写入者只有主机/系统；Agent Token 不能写。

### 2.3 需求声明
- WorkItem 新增持久字段 requirements：{os?, arch?, capabilities?: ["godot>=4.7", "xcode"], tags?: [...]}。
- 卡片模板的每个工作项可带默认 requirements；PM 和人可在建卡/改工作项时设置（MCP、CLI、Web）；Role.required_machine_tags 保留；**角色可带默认能力需求**（新增 Role.required_capabilities，例：frontend_engineer 默认需要 browser.chromium，用飞书的角色默认需要 lark-cli），与工作项 requirements 取并集；卡级要求不能放宽角色要求。

### 2.4 自动选机（selectMachine 改为“过滤 + 排序”）
指派时未显式给 machine_id（系统自动指派、PM/人 assign 不填机器）：
1. 过滤：项目已登记；Machine.status 为 online/degraded（draining/offline 排除）；远程机器需 allow_remote_launch 已开、最近一次健康检查通过且未过期；满足 os/arch/tags；requirements 里的能力都已验证且未过期、版本满足。
2. 排序（建议，见决定 D2）：①亲和：同一卡的产出项已在某机器上有 worktree/分支时，该卡后续产出项优先同机；验证项（审核）默认优先控制主机，除非需求要求特定能力；②剩余容量比例高者优先（limit − 占用）/limit；③项目偏好顺序（可配，例如“先用远程 worker”）；④机器编号稳定排序。
3. 结果：选中一台并写事件 machine_selected，附候选列表、每台被排除或排序的原因，执行视图和工作项上可见；0 候选时写明缺什么能力并交 PM（沿用 system_assignment_deferred）。
显式给了 machine_id 时行为不变：只校验，不改选。
指派后 machine_id 仍不可变（保留不变量）；选错靠释放重派（C-430 的人确认机制适用于失联场景）。

### 2.5 资源并发上限（用户 11-18 定：资源 × 机器上限）
- 不再区分“独占型/非独占型”，改为**每台机器、每种资源各自一个并发上限**，在控制主机私有配置里声明（沿用 run-capacity.yaml 的风格，例如）：
  ```yaml
  machines:
    mac-mini:
      limit: 3            # 该机器 Agent Run 总上限（现有）
      max_limit: 3
      resources:
        ios.simulator: 1
        android.emulator: 1
        blender: 2
        godot: 2
  ```
- 计数：工作项 requirements 里声明了某资源的 Run，在该机器上占用该资源 1 个名额（dispatched/acked/running/启动停止中都算，和现有 Run 名额口径一致）。未声明的资源不计数；未配置上限的资源默认不限（只受机器总上限约束）。
- 派发：机器总名额和所需每种资源名额都有空位才派发；否则排队（同机器排队，不跨机器挪，不抢占）。自动选机排序时把“所需资源的剩余名额”纳入剩余容量计算，资源已满的机器排在后面或跳过（见 D2）。
- 资源上限只能由人在主机私有配置里改（和机器总上限一样，Workbench 可做受 max 约束的覆盖，后续再加）；Agent Token 不能改。
- 这套计数取代原 C-285 的“独占租约”需求的大部分场景；需要绑定到具体设备实例（例如指定某个模拟器 UDID、某块 GPU）时再做 C-285 的实例级租约。

### 2.6 界面
- 执行视图/机器详情：显示每台机器的能力（已验证的带版本和验证时间；声明未验证的灰显）、标签、健康、容量。
- 工作项：显示 requirements 和选机结果及原因。
- 机器能力由向导和巡检自动刷新，不需要人改 tags。

## 3. 分阶段（拟拆卡）

| # | 卡 | 内容 |
|---|---|---|
| MC-1 | 能力目录与探测落库 | 目录常量、Linux/macOS 探测实现、machine_capabilities 表、健康快照、巡检与 worker check 触发、CLI `machine show` 展示 |
| MC-2 | 工作项需求字段 | WorkItem.requirements、模板默认值、MCP/CLI/Web 编辑、与 Role 要求取并集；domain 契约测试 |
| MC-3 | 自动选机 | selectMachine 过滤+排序、亲和、容量、偏好；系统自动指派与未指定机器的人工/PM 指派都走它；machine_selected 事件与原因；0 候选交 PM |
| MC-4 | 资源并发上限 | 主机配置 machines.<id>.resources 上限；按 requirements 计数；派发与排队按机器总名额 + 资源名额；执行视图显示资源占用 |
| MC-5 | 界面 | 执行视图机器能力/健康/容量、工作项需求与选机原因（走 C-444 的界面卡模板） |
依赖：MC-1 → MC-3；MC-2 → MC-3；MC-4 依赖 MC-1；MC-5 依赖 MC-1～3。都改 domain/host，高危路径，需独立复核。

## 4. 用户拍板（11-18）
- D1：两层（能力 + 自由标签）；能力目录 = 内置常用项 + 主机私有配置的自定义项；角色可带默认能力需求。
- D2：排序 = 同卡亲和 → 剩余容量比例（含所需资源名额）→ 项目偏好（可配，默认不偏向）→ 机器编号。
- D3：验证项（审核）默认放控制主机，需求要求特定能力时例外。
- D4：资源 × 机器并发上限（例 mac-mini：ios.simulator 1、android.emulator 1、blender 2）。
- D5：每 30 分钟巡检，24 小时过期，接入/worker check/machine check 时立即刷新。
