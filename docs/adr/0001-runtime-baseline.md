# ADR 0001：运行时基线采用 herdr-core，Herdr 0.9.x 作为回退

- 状态：已接受（暂定，M2 开工前复核）
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

Phase 1 的 Runtime Adapter 以 **herdr-core 0.1.x** 为基线并锁定版本；**Herdr 0.9.5** 作为回退实现。

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
