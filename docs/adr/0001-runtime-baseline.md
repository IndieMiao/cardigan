# ADR 0001：运行时基线采用 herdr-core，Herdr 0.9.x 作为回退

- 状态：已接受；2026-11-05 按回退条件复核，维持（见文末"复核记录"）
- 日期：2026-11-04
- 对应决策：开发方案 §15 D9
- 依据：`docs/research/0.3-herdr-machine.md`、`docs/research/0.5a-herdr-projects.md`

## 背景

开发方案最初以 Herdr 0.9.x 作为 Agent 运行时和人工接管层（§2、§11）。Phase 0 发现 Herdr 正在换代：

- 官方在 2026-10-16 新建了 `herdr-core`（无界面的运行时，命令为 `hc`）和 `herdr-app`（桌面客户端），当前为 0.1.x 预览版。
- 它们和 Herdr 0.9.x 是并行的两条产品线，配置、session、Agent 都不互通，也没有迁移指南；0.9.x 没有宣布停止维护，最新版是 0.9.5。
- 0.5a 评估的 herdr-projects 已经迁移到新一代上。

Cardigan 的控制面只通过 §11.1 的 7 个接口使用运行时，所以这个决定只影响 Runtime Adapter 的实现，不影响 domain 和其他服务。

## 决策

Phase 1 的 Runtime Adapter 以 **herdr-core 0.1.21** 为当前软件基线并锁定版本（C-313）；**Herdr 0.9.5** 作为回退实现。

M1（领域模型、存储、Card MCP）不依赖运行时。M2 开工前，按下面的回退条件复核一次再定。

## 理由

1. **状态由程序上报，不靠看画面**：herdr-core 只认程序主动上报的状态（OSC 7501）。§6.8 列出的最大风险，就是 0.9.x 靠画面识别状态可能误判。
2. **有事件推送**：herdr-core 提供事件订阅（快照、增量事件、心跳、单调序号）。0.9.x 只能轮询，心跳超时判断和门铃去重都更难做。
3. **API 有兼容承诺**：herdr-core 的 API 用 OpenRPC 和 JSON Schema 描述，承诺只增不减，破坏性改动要换协议代号。0.9.x 是面向人的终端工具，没有对第三方程序的兼容承诺。
4. **不碰 Git**：herdr-core 没有 worktree 命令，和 §12"所有 Git 操作由主机的 Git 服务负责"一致。0.9.x 的 `worktree create` 会把一部分 Git 职责分给运行时。
5. **多机模型更整齐**：一个本地 core 聚合所有机器，`run`、`send`、`read`、`wait`、`exec`、`file` 都能指定机器，远程事件进同一条事件流。

## 代价

- **Claude Code 和 Codex 不会主动上报状态**（D3 选的正是这两个）。第一版依靠 Agent 通过 MCP 调用 `finish_run`、`heartbeat` 报告；需要时在 Launch Profile 里加一个状态转换层。业务状态本来就以 MCP 为准（§6.8），所以影响有限。
- **herdr-core 是预览版**，升级节奏快，需要锁版本，并持续关注变更。
- herdr-core 不追踪 Agent 的会话 ID，由控制面记录（D5）。
- 用户日常使用的 Herdr 0.9.x 和 herdr-core 不共享状态，过渡期会同时存在两套运行时。人工接管 Cardigan 管理的 Agent 时，用 `hc attach` 或 herdr-app。

## 回退条件

M2 开工前复核。出现以下任一情况，就改用 Herdr 0.9.5（锁版本），Runtime Adapter 的状态实现改为"画面识别 + 兜底规则"：

- herdr-core 出现影响 `run`、`send`、`events` 的破坏性变更，或者长时间停止更新；
- 用户要求 Claude Code、Codex 的状态识别不做任何改造即可使用；
- herdr-core 在目标机器（macOS arm64 主机、Linux x86_64 工作机）之间的多机连接不可用。

## 影响

- 开发方案 §11 按"接口 + 两种实现"重写；§3、§13、§14、§18 相应修订。
- M2 的任务计划按 herdr-core 编写，并为 Runtime Adapter 写契约测试，保证两种实现都能通过同一套测试。
- Herdr 0.9.x 的多机实测结果（0.3 的 B 部分）保留，作为回退实现的依据。

## 复核记录（2026-11-05，M2 开工前）

按"回退条件"逐条检查，三条都不成立，**维持 herdr-core，锁定 0.1.18**。

| 回退条件 | 结果 | 依据 |
|---|---|---|
| `run`、`send`、`events` 出现破坏性变更，或长时间停止更新 | 不成立 | 0.1.17（2026-11-02）→ 0.1.18（2026-11-04），协议代号仍为 1；两版 `schema/hc.openrpc.json` 的差异全部是新增：`terminal.run` 增加可选参数 `display`、`size`，终端记录增加可选字段 `first_message`，新增能力标记 `automatic_input`。没有删除或改变已有方法、参数。两天内 39 个提交，仍在活跃更新 |
| 用户要求 Claude Code、Codex 的状态识别不做任何改造即可使用 | 不成立 | 用户没有提出；业务状态以 MCP 为准（§6.8） |
| macOS arm64 主机与 Linux x86_64 工作机之间的多机连接不可用 | 部分验证，不成立 | 见下 |

多机实测（独立 session `d9`，测完已清理）：

- 安装：Linux 用发布清单里的 sha256 校验后装到 `~/.local/bin`；macmini（macOS 26.5.2，arm64）用官方 `distribution/install.sh`（v0.1.18，读过全文），它会校验 sha256 和 Apple 签名，装成 `Herdr Core.app`。从 Linux 执行 `hc machine add --install` 不能替 macOS 安装（报 `install_failed`：没有可下载的版本），要在 Mac 上自己装。
- **Linux 上的 core 管理 macOS 工作机：通过。** `hc machine add macmini --session d9` 后状态 `connected`；`hc exec --on macmini`、`hc run --bg --on macmini`、`hc send`、`hc read`、按标签过滤 `hc ls --label` 都正常；远程假 Agent 按 OSC 7501 上报 working → blocked → idle，`hc get` 读到的状态一致；远程终端的 `created`、`foreground`、`status`、`turn` 事件进入本地同一条 `hc events` 流，`seq` 单调递增，并有心跳。
- **macOS 上的 core 管理 Linux 工作机：未完成。** 网络双向可达（macmini 到 Linux 的 22 端口通），但 0.5b 留下的测试账号 `cardigan-agent` 已不接受那把测试密钥，没有 sudo 无法重新授权。按 §13.1，Phase 1 是单机部署，M2 只做 `machine=local`，所以这一项挪到 Phase 2 开工前补测。
- 注意事项：
  - `hc run` 的选项必须写在程序名前面，否则会被当成程序的参数（实测把 `--json` 传给了 bash）。
  - `hc run` 没有传环境变量的选项；终端名限制为 1–32 个 `a-z 0-9 - _`。
  - 0.1.18 起 macOS 上的 core 是独立的 App，第一次访问局域网时系统会弹窗请求权限，无界面的 Mac 主机需要有人在屏幕前确认一次。

## P2b-06 worker 软件证据（2026-11-14）

C-280 仅补齐通用 worker 安装、能力/路径预检、原生锁/进程身份及小制品校验，不改变 hc 0.1.18 的运行时基线，也不把历史个人账号的连接记录当专用项目账号的通过证据。

- Linux：真实子进程验证锁竞争、嵌套拒绝、父进程退出/SIGKILL 及继承 FD 的释放；真实 Git 目录与小制品验证路径和哈希/回读。测试只使用自己的合成目录和进程，不读取真实凭据。
- macOS：libproc、桌面/TCC/Keychain 状态和安装账号/ACL 反例在 Linux 上用合成夹具覆盖；这不是 Mac 实机通过。
- 尚未取得：实际专用 macOS arm64 账号的双进程锁/崩溃释放与原生身份结果，签名 App/首次局域网/无 PTY 非交互，以及 Linux 控制主机到该账号的 exec/run/send/read/events/wait、重启和锁屏后分项证据。由操作员按卡 02 的可信目标合同和现场安排补齐；失败保持原生 worker/B1 阻塞，不换个人账号或 Linux VM。MCP HTTPS/小附件上传联调归卡 08。
- 软件可以按前置合并顺序独立审核交付；远程启用仍须上述现场证据和后续接线，不在 C-280 中启动。03/05 尚未落地的持久化只明确 WorkerCheckpoint 合同，不声称已有落库或恢复实测。

## C-313 升级复核（2026-11-15，软件阶段）

按用户升级要求把当前默认基线、安装器完整性锁及 worker 能力校验升至 0.1.21。上文 0.1.18 和任务计划中的旧版本保留为历史证据，不代表当前安装要求；旧版 Linux→Mac 记录也不作为新版远程验收。

逐条兼容结论见开发方案 §11.7，来源、实测环境和可执行升级/回退步骤见 [部署说明](../../deploy/README.md#hc-0121-升级与回退c-313)。本次不改变 Runtime 接口、治理参数、权限或角色规则，不采用未发布的文档订阅选项。草稿等待、脱离进程清理及换环境重启的生产取舍尚须人决定，软件交付不能直接作为生产放行。

隔离 Linux 二进制升级和强制回退均保留原终端与程序 PID；普通重启保持旧环境，换环境重启只影响新终端。终端删除后主动脱离的进程仍可能存活，不能把终端消失当成全体进程退出证明。现场升级、Mac 签名/TCC、真实 SSH 与 30 分钟/10 自然并发观察仍未验收。
