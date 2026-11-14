# C-216 server 周期任务 slow tick 调查（测量与第一轮修复）

> 卡片 C-216 / 工作项 W-664。第一阶段只加测量、不改业务逻辑（PM 口径 C-216#12）；第二阶段按 PM 拍板 Q-343 只修 A、B 两项（C-216#21），修前修后用本文同一方法各测一次，见 §5。

## 1. 背景

张良在 C-203#29 报告：生产 server 日志全天大量 `slow tick`。dispatcher 中位约 6.6 秒、最大 20 秒，且从早上的约 4.3 秒逐渐上涨；cleanup 平均 33 秒、最大 67 秒；backup、reconcile 也有 10～18 秒。数据库是同步的 `node:sqlite`，怀疑 tick 阻塞事件循环，拖慢 Workbench 的 HTTP/SSE 和 Agent 的 MCP。

## 2. 测量手段（已提交，默认关闭）

### 2.1 运行时测量开关

- `CARDIGAN_TICK_PROFILE=1` 打开；其它值或不设都关闭（`apps/server/src/tick-profile.ts` 的 `tickProfileEnabled`）。关闭时 `profileTick`/`profileSpan` 是直接调用，不创建计时器和事件循环监视器。
- 打开后：
  - 所有经 `loop.ts` 跑的周期任务（cleanup、reconcile、backup、merge 等）和 dispatcher 每次 tick 输出一行 `tick_profile`：`wall_ms`（总耗时）、`uow_ms`/`uow_count`/`uow_max_ms`（同步 SQLite UnitOfWork 耗时与次数）、`state_build_ms`/`state_builds`（命令状态重建）、`outside_uow_ms`（UnitOfWork 之外：Git/子进程、文件、运行时调用及其间的同步代码）、`event_loop_utilization`（1.0 表示 tick 期间事件循环没机会处理任何定时器或 socket）。
  - dispatcher 另有分段 `spans`：`host_ops`、`route`（逐项目路由事件、生成候选）、`inactive`、`deliver`（逐候选认领并派发）。
  - 每 60 秒输出 `event_loop_delay`（`perf_hooks.monitorEventLoopDelay` 的 p50/p99/max）和按渠道（web、mcp）的 `request_latency`，分“与 tick 重叠”和“空闲”两组。
- 输出只有循环名、分段名和数字，不含 SQL、卡片正文、提示词、Token 或请求体。单元测试 `apps/server/src/tick-profile.test.ts` 覆盖开关的开和关、输出字段只含数字、失败 tick 仍记录、请求分组与窗口重置。

### 2.2 合成数据重放

- `apps/server/src/slow-tick.replay.test.ts`：默认跳过，`CARDIGAN_TICK_REPLAY=1` 时运行。用 M4 夹具在临时目录里合成一个项目：`REPLAY_CARDS` 张卡，其中 `REPLAY_OPEN_CARDS`（10）张未完成、其余走完合并检查；每卡 20 条评论。然后起完整 server，连续跑 `REPLAY_TICKS` 次 dispatcher tick（间隔 1 秒，与生产一致），同时用开环客户端每 100 毫秒探测一次 Workbench 卡片列表和 MCP `get_updates`，延迟从“应发时刻”算起，所以包含排在被阻塞事件循环后面的等待。
- 可选 `REPLAY_PROFILE=<file>` 记录 tick 期间的 V8 CPU profile，用来把耗时归到函数。
- **数据来源：等量合成数据重放（本机），未使用生产数据库副本，未在生产 server 上做任何实验。** 合成数据的卡片、事件、Run 比例按夹具生成，不保证与生产分布一致；结论看增长形状和热点，不直接对标生产的绝对秒数。

命令：

```sh
CARDIGAN_TICK_REPLAY=1 REPLAY_CARDS=240 REPLAY_TICKS=4 \
  REPLAY_OUT=/tmp/r240.json REPLAY_PROFILE=/tmp/r240.cpuprofile \
  pnpm --filter @cardigan/server exec vitest run src/slow-tick.replay.test.ts --testTimeout=900000
```

## 3. 结果（2026-11-13，本机，合成数据）

### 3.1 规模与 dispatcher tick 耗时（修前基线）

> 更正：第一阶段在卡上贴的数字（C-216#18）不是干净基线——server 测试从 `dist` 引用 store/host，当时的 `dist` 已编进了 B。下表是 R-3288 从修前源码（`80f7ba7~1`）重新 `tsc -b` 后重测的结果，取代原数字。

| 卡数 | 事件 | Run | 首次 tick | 稳态 tick（第 2～4 次） | ELU | 事件循环延迟 max |
|---:|---:|---:|---:|---:|---:|---:|
| 40 | 1,590 | 120 | 0.99 s | 0.59～0.65 s | 1.0 | 1.0 s |
| 120 | 5,190 | 440 | 10.0 s | 8.4～9.1 s | 1.0 | 10.1 s |
| 240 | 10,590 | 920 | 57.6 s | 33.9～35.9 s | 1.0 | 57.7 s |

- 卡数翻倍（120→240），稳态 tick 约涨 4 倍，是**超线性增长**（约 n^2）。单次 UnitOfWork 越来越慢（max 0.47 s→2.4 s），说明每次认领里做的是“全量读、全量算”。
- 分段：`deliver` 占 tick 的 71%～86%，`route` 占 14%～29%，`host_ops`、`inactive` 可忽略；`uow_ms` 占 wall 的 90% 以上，即绝大部分是同步 SQLite 读加解码和其中的纯计算。首次 tick 多出的部分是状态重建，之后命中缓存。

### 3.2 tick 是否阻塞事件循环

**是，而且是整段阻塞。** 三档规模的 `event_loop_utilization` 都是 1.0；事件循环延迟最大值等于最长 tick 的耗时（240 卡 57.7 s）。tick 期间事件循环一次都没让出，HTTP、SSE、MCP 请求全部排队到 tick 结束。

### 3.3 对 Workbench 接口和 MCP 的影响（开环探测，修前）

| 卡数 | Web 卡片列表 空闲 p50 / p95 | Web tick 期间 p50 / max | MCP get_updates 空闲 p50 / p95 | MCP tick 期间 p50 / max |
|---:|---:|---:|---:|---:|
| 40 | 9 / 15 ms | 0.65 / 1.0 s | 14 / 21 ms | 0.65 / 1.0 s |
| 120 | 68 / 120 ms | 10.2 / 10.2 s | 69 / 121 ms | 8.9 / 9.1 s |
| 240 | 269 / 425 ms | 36.1 / 58.0 s | 275 / 445 ms | 36.1 / 58.0 s |

- tick 期间两条渠道的延迟几乎一样，等于“剩余 tick 时间 + 自身耗时”，与请求本身多重无关——瓶颈是事件循环被占满，不是接口自己慢。
- 空闲时 MCP 自身只要几毫秒（服务端计时），Web 卡片列表自身随规模涨到约 270 ms（这部分属于 C-203 的读模型范围，本卡不处理）。
- 生产 dispatcher 中位 6.6 s，意味着 Agent 的 MCP 调用和 Workbench 请求若落在 tick 内会多等数秒；按 1 秒间隔连跑，事件循环大部分时间都在 tick 里。

### 3.4 最慢的是哪一段（240 卡 CPU profile，4 次 tick 共约 131 s 采样；包含关系，数字有重叠）

> 本节 profile 采自第一阶段（`dist` 状态见 §3.1 更正），绝对秒数偏低，只用来看热点排名；修前修后对比以 §5 为准。

| 位置 | 包含耗时 | 占比 | 说明 |
|---|---:|---:|---|
| `Dispatcher.deliver` → `claim` | 89.5 s | 68% | 每个候选认领一次，每次在事务里做以下全量工作 |
| ├ `listNotifications`（store `inbox`） | 36.0 s | 27% | 每次认领读出并 JSON 解码**项目全部通知历史**，再在内存里按 id 过滤；其中 `decode` 自身 17.7 s |
| ├ `hasRunTarget`（domain） | 24.4 s | 19% | 每个 Assignment 对全部 deliveries × 全部 work_items 线性扫描，调用次数又随 Assignment 增长，是超线性的主要来源 |
| ├ `runCapacitySnapshot`（host） | 18.5 s | 14% | 每次认领对每张卡 `events.listAfter(…, 0)` 重读、重解析全部事件，再算 `pendingHostOpsActions`（11.4 s） |
| └ `queueRun` 互斥检查 | 12.8 s | 10% | 与上面的 hasRunTarget 部分重叠 |
| `Dispatcher.project`（route） | 27.2 s | 21% | 路由事件、重派检查（`retryDispatchedRuns` 10.8 s） |

### 3.5 为什么随时间变慢

CPU profile 里 SQLite 执行本身（`all`/`prepare`）只占约 19%，主要耗时在 JS 侧：慢在“取出全部历史再在 JS 里解码和过滤”。通知、事件、交付、Run 只增不减，认领路径每次都全量处理它们，候选数又随活跃 Assignment 增长，于是每个 tick 的成本按“历史量 × 候选数”增长。这与生产 dispatcher 从早上约 4.3 s 涨到傍晚约 6.6 s 的形状一致。

### 3.6 未覆盖

- cleanup、backup、reconcile 的 tick 已被同一开关覆盖（`loop.ts`），但本次合成重放只驱动 dispatcher，没有为它们生成 worktree、备份文件等外部负载，因此**没有这三者的分段数字**。生产里 cleanup 平均 33 s，需要在本机生产库副本上打开 `CARDIGAN_TICK_PROFILE=1` 跑一段时间才能拿到（需要人提供脱敏副本，或决定不做）。
- 合成数据比例与生产不同，绝对秒数不可直接对比；增长形状和热点排名可作为第二阶段依据。

## 4. 第二阶段修复建议（PM 已在 Q-343 选 A+B）

按收益和风险排序，均不改调度语义（派发顺序、优先级、合并检查互斥不变），不涉及数据库结构变化：

1. **认领时只取被请求且仍为 pending 的通知**：`listNotifications` 增加 `ids` 条件，在 SQL 里按主键过滤，结果顺序仍按 `seq, id`。预期去掉约 27% 的 tick 时间。
2. **容量快照复用 Store 已有的按流事件缓存**（`events.listStreams`，C-126/C-131 已有），不再每次认领重读全部事件；没有该端口的后端保持原路径。预期去掉约 10%～14%。
3. （可选，面较大）`hasRunTarget` 先按卡建索引再查，改的是 `packages/domain`，需要附契约测试；或拆卡。
4. 把长 tick 分片让出事件循环、把 cleanup/backup 移到 worker：改动面大、涉及并发，建议在 1、2 之后重测再定，必要时另开卡。

修复后用本文 §2.2 同一命令、同样规模（40/120/240）复测，修前修后数字写进 PR 和本文。

## 5. 第二阶段：A+B 修复与复测（提交 80f7ba7）

### 5.1 改了什么

- **A**：`NotificationQuery` 增加可选的 `ids`（`packages/store/src/inbox.ts`），在 SQL 里用 `id IN (SELECT value FROM json_each(?))` 走主键 `(project_id, id)` 查找；空列表直接返回空。dispatcher 认领（`apps/server/src/dispatch.ts`）改为只取被请求且仍为 `pending` 的通知，过滤条件（owner、covered、决策跟进阻塞）与原来一致，结果顺序仍是 `seq, id`。
- **B**：`runCapacitySnapshot`（`packages/host/src/run-capacity.ts`）在事务提供 `events.listStreams` 时复用 Store 的按流事件缓存（C-126/C-131），流的集合和顺序与原来一致（项目流在前，再按 `cards.list` 顺序）；没有该端口的后端保持原来逐流 `listAfter` 的路径。
- 不改调度语义、不改表结构、不改 `packages/domain`，没有新增数值配置。
- 测试：`inbox.test.ts` 断言 `ids` 过滤与“全量读再内存过滤”结果和顺序完全一致（含重复 id、未知 id、空列表、他项目）；`host-ops.test.ts` 断言缓存路径和回退路径的容量占用一致。

### 5.2 修前修后（同一命令、同样规模，`REPLAY_TICKS=4`，本机合成数据）

| 卡数 | 稳态 tick 修前 → 修后 | 首次 tick 修前 → 修后 | `deliver` 稳态 修前 → 修后 | 事件循环延迟 max 修前 → 修后 |
|---:|---:|---:|---:|---:|
| 40 | 0.59～0.65 → 0.23～0.26 s | 0.99 → 0.59 s | 0.47～0.55 → 0.12～0.13 s | 1.0 → 0.61 s |
| 120 | 8.4～9.1 → 2.1～2.7 s | 10.0 → 4.4 s | 7.3～7.7 → 1.3～1.7 s | 10.1 → 4.5 s |
| 240 | 33.9～35.9 → 17.0～18.2 s | 57.6 → 37.2 s | 28.5～29.9 → 10.5～11.0 s | 57.7 → 37.2 s |

| 卡数 | Web tick 期间 p50 / max 修前 → 修后 | MCP tick 期间 p50 / max 修前 → 修后 | Web / MCP 空闲 p50 修后 |
|---:|---:|---:|---:|
| 40 | 0.65 / 1.0 → 0.25 / 0.60 s | 0.65 / 1.0 → 0.26 / 0.60 s | 8 / 12 ms |
| 120 | 10.2 / 10.2 → 2.7 / 4.5 s | 8.9 / 9.1 → 2.7 / 4.5 s | 49 / 52 ms |
| 240 | 36.1 / 58.0 → 18.4 / 37.5 s | 36.1 / 58.0 → 18.4 / 37.5 s | 217 / 217 ms |

结论：稳态 tick 在 120 卡降约 72%，240 卡降约 50%；`deliver` 段降 60%～80%。tick 仍整段阻塞事件循环（ELU 仍为 1.0），240 卡时剩余耗时以 `route`（6～8 s）和认领里的 `hasRunTarget` 线性扫描为主，增长仍是超线性。是否继续做 C（`hasRunTarget` 建索引，改 domain）或分片让出事件循环，由 PM 按这组数字决定本卡追加还是另开卡。

## 6. C-221：route 段与 hasRunTarget（第三轮修复与测量）

> 卡片 C-221 / 工作项 W-680。只改查找方式，不改调度语义和表结构，也不新增数值或行为规则；分片只评估、不实现。

### 6.1 测量方法更正与新增分段

- **不要在 replay 时设 `CARDIGAN_TICK_PROFILE=1`**：replay 自己装了一个 profiler，而 server 看到这个变量会再装一个，把前者顶掉，于是所有 `spans`、`uow_ms` 都是 0，只剩 `wall_ms`。本节数字都是不设该变量、用 §2.2 的命令测的（`REPLAY_TICKS=4`）。replay 文件头已写明这一点。
- `route` 拆成子分段（`apps/server/src/dispatch.ts`）：`route.patrol_host_ops`、`route.decision_followups`、`route.route_events`（两次路由合计）、`route.unreadable`、`route.ack_inbox`、`route.bell_attempts`、`route.retry_dispatched`、`route.maintenance`、`route.candidates`。同步步骤用新增的 `profileSpanSync`，不增加 `await`，步骤顺序和交错与原来一致；`retry_dispatched` 原本就是 await 的，沿用 `profileSpan`。
- cleanup、reconcile、backup 也加了分段（见 §6.5）。
- 修前基线是在本分支上只加分段、`packages/domain` 的 `dist` 仍是 main 构建时测的；修后是 `tsc -b` 之后测的。同一台机器、同一份合成数据。240 卡基线比 §5.2 的“修后”略快（14.7～17.3 s 对 17.0～18.2 s），是机器负载波动，比较以本节同批数字为准。

### 6.2 修前 route 段里最慢的是什么（240 卡 CPU profile，4 次 tick 合计，包含关系）

| 位置 | 包含耗时 | 说明 |
|---|---:|---|
| `Dispatcher.project`（route 合计） | 27.6 s | 每 tick 约 6.9 s |
| ├ `hasRunTarget`（domain） | 8.9 s | 候选、重派检查里每个 Assignment 都对 deliveries × work_items 线性扫描 |
| ├ `retryDispatchedRuns` | 10.6 s | 其中 `hasRunTarget` 5.1 s、`hostOpsPending` 2.8 s（每个候选 Run 都重扫全部事件求待执行的主机操作） |
| ├ `maintenance` | 7.0 s | `obsoleteDispatchAttention` 4.2 s、`escalatePmMergeStalls` 2.4 s：每条通知都 `state.events.find` 按 id 找事件，是“通知数 × 事件数” |
| ├ `candidates`（`add` 与排序） | 5.7 s | `hasRunTarget`，以及排序比较函数里每次比较都两次按 id 线性找事件 |
| └ `routeProjectEvents` | 2.9 s | 路由新事件；只在有新事件时重，稳态很小 |

deliver 段（认领）里 `hasRunTarget` 另占 13.7 s。

### 6.3 改了什么

1. **`hasRunTarget` 按键查找**（`packages/domain/src/run-target.ts`）：按 `(deliveries 数组, work_items 数组)` 的对象身份缓存一个索引（`WeakMap`）：工作项按 id（取第一个，与 `find` 一致）、有效非完成交付按目标工作项 id 记它所在的卡、有效完成申请按被请求的验证项 id 记卡。查一次是 O(1)，索引每个状态快照只建一次。判定规则逐条与原实现相同（未替代、同卡、目标交付不是完成申请、完成申请必须点名本验证项）。
2. **事件按 id 查找**（新增 `packages/domain/src/event-index.ts` 的 `eventById`，同样按事件数组身份缓存，取第一个匹配）：用在 `obsoleteDispatchAttention`、`unreadableCommentTrigger`（domain）、`escalatePmMergeStalls` 和 dispatcher 候选的触发事件与排序比较（server）。
3. **`hostOpsPending` 按快照记忆**（`packages/domain/src/host-ops.ts`）：每个事件数组只算一次“有待执行主机操作的 Assignment 集合”，之后按 id 查。

**为什么缓存不会读到旧值**：命令状态的各集合都是不可变快照。Store 的快照缓存在有改动时生成新数组（`command-snapshots.ts` 的 `[...entities.values()]`，事件流合并后新建排序数组）；命令草稿 `CommandDraft` 只把改动记在 `changes`，`d.state` 本身不变，`d.list()` 每次返回新数组；测试夹具的 `apply` 也是复制。写事务内追加事件或改交付后，下一次 `loadState` 拿到的是新数组，索引随之重建；事务回滚后读到的是旧数组，对应的也是旧数组自己的索引，二者一致。非测试代码里没有对这些数组原地 `push`/`splice` 的地方（已检索）。`WeakMap` 不阻止旧快照被回收。

契约测试：`run-target-index.contract.test.ts` 用 600 组随机状态（含重复 id、跨卡、各种交付状态和种类、目标缺失）逐个 Assignment 对比新旧实现，并覆盖新快照重建、回滚后旧快照答案不变；`event-index.contract.test.ts` 对 `eventById`、`hostOpsPending` 做同样的随机对比和快照测试。原有 `run-target.contract.test.ts`（不变量 11、14）不改、仍通过。

### 6.4 修前修后（本机合成数据，`REPLAY_TICKS=4`）

| 卡数 | 稳态 tick 修前 → 修后 | 首次 tick 修前 → 修后 | `route` 稳态 修前 → 修后 | `deliver` 稳态 修前 → 修后 | 事件循环延迟 max 修前 → 修后 |
|---:|---:|---:|---:|---:|---:|
| 40 | 0.17～0.24 → 0.12～0.14 s | 0.43 → 0.44 s | 0.08～0.11 → 0.04～0.05 s | 0.09～0.12 → 0.08～0.09 s | 0.55 → 0.57 s |
| 120 | 2.50～4.15 → 1.14～1.47 s | 5.35 → 3.31 s | 0.88～2.03 → 0.23～0.27 s | 1.54～2.12 → 0.91～1.21 s | 5.5 → 3.5 s |
| 240 | 14.7～17.3 → 5.7～6.4 s | 28.0 → 21.4 s | 5.3～7.9 → 0.75～0.95 s | 8.6～11.1 → 5.0～5.4 s | 28.1 → 21.5 s |

route 子分段稳态（修前 → 修后）：

| 卡数 | `retry_dispatched` | `maintenance` | `candidates` | `ack_inbox` | `route_events` | `unreadable` |
|---:|---:|---:|---:|---:|---:|---:|
| 40 | 20～40 → 10 ms | 30～40 → 10 ms | 10 → 10 ms | 10～20 → 10 ms | 0～10 → 0～10 ms | <5 ms |
| 120 | 0.38～0.84 → 0.07～0.08 s | 0.29～0.65 → 0.05～0.06 s | 0.14～0.34 → 0.04～0.07 s | 0.04～0.13 → 0.04～0.05 s | 0.01～0.05 → 0.01～0.02 s | 10～20 → 10 ms |
| 240 | 2.78～3.94 → 0.18～0.24 s | 1.37～2.16 → 0.18～0.29 s | 1.06～1.60 → 0.25～0.27 s | 0.09～0.12 → 0.10～0.11 s | 0.02～0.05 → 0.02～0.04 s | 20～30 ms |

| 卡数 | Web tick 期间 p50 / max 修前 → 修后 | MCP tick 期间 p50 / max 修前 → 修后 | Web / MCP 空闲 p50 修后 |
|---:|---:|---:|---:|
| 40 | 0.24 / 0.55 → 0.14 / 0.56 s | 0.24 / 0.55 → 0.15 / 0.57 s | 7 / 10 ms |
| 120 | 4.3 / 5.5 → 1.5 / 3.5 s | 4.3 / 5.5 → 1.5 / 3.5 s | 46 / 50 ms |
| 240 | 17.5 / 28.3 → 6.5 / 6.6 s | 17.5 / 28.3 → 6.6 / 21.7 s | 198 / 202 ms |

结论：240 卡稳态 tick 降约 62%，`route` 段降约 85%（6～8 s → 不到 1 s），`hasRunTarget` 已从 profile 热点里消失。tick 仍整段阻塞事件循环（ELU 1.0）。首次 tick 仍有 21 s：它包含首次路由（`route_events` 2.4 s）和对全部积压候选的认领，属于 deliver。

### 6.5 剩下的大头（修复面大，建议另开卡）

修后 240 卡 CPU profile（4 次 tick 共 44 s 采样）里，`deliver` → `claim` 占 31.6 s：

- `runCapacitySnapshot` → `queueSnapshot`（host/domain）12.8 s：每次认领都对全部 Run 重算容量队列。要改成跨认领复用，需要处理认领之间的写入，面较大。
- `queueRun` 的互斥检查 `exclusive`（`packages/domain/src/commands/launch.ts`）10.0 s：对每个未结束 Run 调 `d.get("assignments", …)`，而 `CommandDraft.get` 每次都 `list()` 重建整张 Map，是“未结束 Run 数 × Assignment 数”。改 `CommandDraft` 的查找会影响所有命令，应单独开卡并补契约测试。
- 这两项都在 deliver 段，不在本卡的 route 范围内，本卡不修。

### 6.6 cleanup、backup、reconcile 分段测量

新增分段（都只计时，不改行为；关闭测量时与原来完全相同）：

- cleanup：`cleanup.release_closed`（同步，释放已结束卡的 Assignment）、`cleanup.state`、`cleanup.revoke_and_release`（每个已释放 Assignment：撤 Token 加终端 `status`/`release`，内含 `cleanup.revoke_tokens`）、`cleanup.settle`（读状态、`exists`、Git `removeWorktree`、必要时发清理决策）、`cleanup.idle_builds`（构建检出列举和删除）。
- reconcile：`reconcile.state`、`reconcile.git`（文件系统和 Git 扫描，**包含**嵌套的 `reconcile.checks`）、`reconcile.checks`（对每张卡从 seq 0 读全部事件找合并检查记录）、`reconcile.repair`、`reconcile.record`（写发现和事件）。
  - C-231 补齐：`reconcile.repair` 修好固定引用后会重读状态、再扫一遍；这次重读计入 `reconcile.state`，第二次扫描（连同其中的 `reconcile.checks`）计入 `reconcile.git`，两段都是多次累加。因此走修复路径时 `reconcile.git` 仍然包含全部 `reconcile.checks`，Git 扫描时间不再低报。`apps/server/src/reconcile-loop.test.ts` 用虚拟计时复现了修复路径：修前 `git` 只计第一遍（110），修后为两遍之和（220），`checks` 两遍共 20、都在 `git` 之内。
- backup：`backup.fetch`（即整个 tick）。

replay 新增 `REPLAY_LOOPS=1`（配 `REPLAY_LOOP_TICKS`，默认 2）：dispatcher tick 之后用同一个库、桩 Git 和桩终端各跑几次三个执行器。结果（稳态第 2 次）：

| 卡数 | cleanup | reconcile（checks / record） | backup |
|---:|---:|---:|---:|
| 120 | 0.9 ms | 49 ms（15 / 34 ms） | 0.1 ms |
| 240 | 1.1 ms | 90 ms（28 / 62 ms） | 0.1 ms |

**合成重放测不出这三个任务的真实耗时**，原因：

- 合成夹具里没有“已释放、带终端和 worktree”的 Assignment，`cleanup.revoke_and_release` 和 `cleanup.settle` 根本没跑到；生产 cleanup 平均 25 秒、最长 208 秒（C-221#5），按代码看来自对每个已释放 Assignment 串行 await 的终端 `status`/`release`、`access`、`git worktree remove`，这些是外部 IO，合成数据无法模拟其耗时。已释放 Assignment 只增不减，每轮都会重走一遍（进程内 `cleaned` 集合只记录已删掉或已不存在的 worktree，重启即清空）。
- reconcile 的数据库部分（含从 seq 0 重放事件）在 240 卡只有约 0.1 s，与生产平均 9 秒、最长 65 秒差两个数量级，生产耗时应主要在 `reconcile.git` 的文件系统和 Git 扫描；但这只有生产数据才能确认。
- backup 是一次 `git fetch`，合成数据无意义。

**缺的数据**：生产上打开 `CARDIGAN_TICK_PROFILE=1` 一段时间（本卡部署后，至少覆盖几轮 cleanup 和 1～2 轮 reconcile、backup）得到的 `tick_profile` 行（只含循环名、分段名和数字），再加每轮 cleanup 时已释放 Assignment 的个数（可从库里数）。这比提供脱敏库副本更直接，也不涉及数据外传；已开人工待办（不阻塞合并）。

### 6.7 分片或让出事件循环：只评估、不实现

- **收益**：修后 240 卡稳态 tick 仍约 6 s、ELU 1.0，期间 HTTP、SSE、MCP 全部排队。如果每处理完一个项目、一个候选认领或一批通知就 `await setImmediate()` 让出一次，单次阻塞上限会从“整个 tick”降到“一次认领”（240 卡约几十到 200 ms），Workbench 和 MCP 的 tick 期间延迟会接近空闲水平。总耗时不变，甚至略增。
- **并发风险**：
  - 让出后其它请求（MCP 写命令、Web 操作、其它周期任务）会插到 tick 中间写库。现在每次认领、ACK、停止都在独立事务里重新 `loadState` 并复查（`dispatchStateLoader` 每次按版本号重查），这一层仍然成立；但 `project()` 里跨步骤复用的局部值（`candidates` 里的 `state`、排好序的 `candidates` 列表、`claimed` 集合）会过期：可能按旧优先级顺序派发，或者对刚被别处处理掉的通知再走一遍（事务内复查会挡住重复派发，但顺序语义会变）。
  - `Dispatcher.serial`、各执行器的 `serial` 只保证同一实例内串行，不防止让出期间 MCP 命令改写同一 Assignment；需要逐个确认“读快照 → await → 写”的路径都在写事务里复查。
  - cleanup 的串行 await 本身已经会让出事件循环（外部 IO），它慢主要是串行 IO，不是阻塞；分片对它帮助不大，并行化反而要处理同一仓库的 Git 锁。
- **要改的边界**：`Dispatcher.tick` 的 route/deliver 循环（让出点、让出后候选列表是否重算）、`retryDispatchedRuns` 的候选循环、`maintenance` 内单个大事务（要先拆成多个事务才能让出，涉及“同一事务内看到一致状态”的假设）；派发顺序和合并检查互斥的契约测试要补“让出期间有并发写”的用例。
- 建议：先做 §6.5 的两项，把稳态 tick 再降一截，再按数字决定要不要分片；要做的话属于并发行为变化，交人另行决定。

## 7. C-230：deliver 段的容量队列与 CommandDraft 查找（第四轮修复与测量）

> 卡片 C-230 / 工作项 W-708。只改查找和复用方式，不改调度语义，不改表结构，也没有新增数值或行为规则。测量方法同 §6.1（不设 `CARDIGAN_TICK_PROFILE`，`REPLAY_TICKS=4`），修前是本卡起点 main（74cba167）构建后测的，修后是同一台机器、同一份合成数据 `tsc -b` 之后测的。

### 7.1 修前热点（240 卡 CPU profile，4 次 tick 共 41.7 s 采样，包含关系）

| 位置 | 包含耗时 | 说明 |
|---|---:|---|
| `claim` | 29.5 s | deliver 段的逐候选认领 |
| ├ `runCapacitySnapshot` | 14.4 s | 其中 `queueSnapshot` 11.9 s：每次认领都对全部 Run 行做 `json_extract` 扫描、关联 Assignment/事件/工作项/卡片、逐行 JSON 解码后排序；`pendingHostOpsActions` 每次把全部事件拼起来重算 |
| └ `queueRun` → `exclusive` | 9.9 s | 对每个未结束 Run 调 `d.get("assignments", …)`，而 `CommandDraft.get` 每次都 `list()` 重建整张 Map（`get` 8.8 s，`keyOf` 2.5 s） |

### 7.2 改了什么

1. **`CommandDraft.get` 按键查找**（`packages/domain/src/commands/core.ts`）：先倒序查本草稿的 `changes`（`put` 保证同键只有一条，倒序等价于“后写覆盖”），没有再查按状态数组身份缓存的索引（`WeakMap`，同键取最后一条，与 `list()` 里 `new Map` 的覆盖规则一致）。找不到时报同样的 `not_found` 错误。`list()`、`put()` 不变。
2. **容量队列跨认领复用**（`packages/host/src/run-capacity.ts` 的 `queueSnapshot`）：不再对 runs 表做 SQL 扫描，改为用事务里已缓存的 Run、Assignment、WorkItem、Card 列表在内存里筛选，条件与原 JOIN 一致（`queued` 且 `queue_reason=concurrency_limit`、Owner `active` 且不是 standing PM、触发事件存在；卡片取 Owner 工作项的卡，没有则取触发事件的卡，优先级取该卡）。排好序的候选按“所有项目的这四个列表是否仍是同一批数组”复用，每个 Store 只留一份。未结束的 BellAttempt 不在快照里，**每次调用都重新读并过滤**；对稳定排序的结果做过滤，顺序与对过滤后的行重新排序相同，最后仍交给 `runQueuePositions` 算 `ahead`。触发事件按 Run 对象缓存（事件只追加，只缓存查到的）。
3. **待执行主机操作按快照复用**（同文件 `runCapacitySnapshot`）：有按流事件缓存时，按“事件流 Map + 卡片列表”两者的身份复用 `pendingHostOpsActions` 的结果；没有该端口的后端走原路径。

**为什么不会读到旧值**（与 §6.3 同一约定，本卡新增的三处缓存都依赖它）：命令状态和 Store 快照里的数组都不原地修改。Store 的快照缓存（`command-snapshots.ts`）按 `command_versions` 版本号复用，写入（包括同一事务里更早的写入，触发器会更新版本号）会生成新数组；事务回滚丢弃事务内的新数组，之后读到的又是已提交的旧数组，而缓存键里存的是事务内的数组，对不上就重建。事件流缓存（`command-events.ts`）在有新事件时生成新的 Map 和新数组。`CommandDraft` 的写入只记在 `changes`，查找时先查 `changes`，所以命令内先写后读拿到的是新值；另一个草稿或回滚后的新草稿看不到这些写入。返回新数组的后端（没有快照缓存，或测试桩）只是缓存不命中，结果仍正确。非测试代码里没有对这些数组原地 `push`/`splice` 的地方（已检索）。

**C-231 的编译期约束**：`CommandState` 的各集合、仓储的 `list`/`listAfter`、员工和成员列表、Store 快照和事件流缓存在类型上本来就是 `readonly` 数组，实体字段也都是 `readonly`，所以经这些类型拿到的数组和实体，原地修改编译不过。C-231 加了 `packages/domain/src/commands/command-state-readonly.contract.test.ts`（由 `pnpm --filter @cardigan/domain test:types` 检查），断言 `CommandState` 没有可变数组字段、`CommandDraft` 索引的每个集合都是只读数组、仓储读接口返回只读数组，并用 `@ts-expect-error` 列出 `push`/`splice`/`sort`/下标赋值/改实体字段等写法；以后谁把类型放宽，这个文件就编译不过。另外收紧了两处：`queueSnapshot` 首次构建时把缓存的排序结果以可变数组返回，现在返回类型改为只读；`role.contract.test.ts` 里对 `state.roles` 原地 `push` 改为每步生成新状态。仍未覆盖的是别名：调用方自己用可变类型持有同一个数组再改（TypeScript 结构类型挡不住），目前生产代码里没有这种写法。

**测试**：`packages/domain/src/commands/command-draft-get.contract.test.ts` 用 300 组随机状态（重复键、复合键、带版本键、缺省集合）把新 `get` 与原 `list().find` 逐键对照，覆盖草稿内写后读、同键再次写入、事件追加、提交后换新快照、回滚后在旧快照上新建草稿；`apps/server/src/run-queue-cache.test.ts` 把原 SQL 原样留作对照，覆盖优先级变化、BellAttempt 占用与释放、Owner 释放、清除 `queue_reason`、standing PM、多项目排序，以及写事务内写后读（新 Run 带新追加的触发事件、改优先级）和回滚后恢复。去掉缓存键里的卡片列表时该测试会失败（已验证）。

### 7.3 修前修后（本机合成数据，`REPLAY_TICKS=4`）

| 卡数 | 稳态 tick 修前 → 修后 | 首次 tick 修前 → 修后 | `deliver` 稳态 修前 → 修后 | `route` 稳态 修前 → 修后 | 事件循环延迟 max 修前 → 修后 |
|---:|---:|---:|---:|---:|---:|
| 40 | 0.11～0.15 → 0.07 s | 0.39 → 0.32 s | 0.07～0.08 → 0.02～0.03 s | 0.04～0.07 → 0.04～0.05 s | 0.40 → 0.34 s |
| 120 | 1.16～1.48 → 0.33～0.38 s | 3.80 → 1.83 s | 0.97～1.21 → 0.16 s | 0.19～0.26 → 0.17～0.22 s | 3.85 → 1.87 s |
| 240 | 5.54～5.83 → 1.49～1.62 s | 20.1 → 7.2 s | 4.58～4.83 → 0.68～0.76 s | 0.93～1.11 → 0.81～0.93 s | 20.3 → 7.3 s |

| 卡数 | Web tick 期间 p50 / max 修前 → 修后 | MCP tick 期间 p50 / max 修前 → 修后 | Web / MCP 空闲 p50 修后 |
|---:|---:|---:|---:|
| 40 | 0.15 / 0.40 → 0.06 / 0.34 s | 0.15 / 0.40 → 0.07 / 0.35 s | 6 / 8 ms |
| 120 | 1.5 / 3.8 → 0.42 / 1.9 s | 1.5 / 3.9 → 0.42 / 1.9 s | 38 / 41 ms |
| 240 | 6.0 / 20.4 → 1.8 / 7.5 s | 6.0 / 20.4 → 1.8 / 7.5 s | 164 / 168 ms |

修后 240 卡 profile（4 次 tick 共 16.1 s 采样）：`claim` 29.5 → 5.4 s，`queueSnapshot` 11.9 → 0.7 s，`exclusive` 9.9 → 0.3 s，`CommandDraft.get` 8.8 → 0.2 s 以下。

结论：240 卡稳态 tick 再降约 72%，`deliver` 段降约 85%，两处热点已不在 profile 前列。tick 仍整段阻塞事件循环（ELU 1.0）。剩下的大头是首次 tick（对全部积压候选的认领和首次路由，约 7 s）和 `route` 段（稳态约 0.9 s，其中 `cardView` 里的 `list()` 重建较多）；分片或让出事件循环仍按 §6.7 交人另行决定，本卡不做。


## 8. C-233：已释放 Assignment 的资源清理

### 8.1 生产证据与根因

依据 C-221#40（H-44，1 小时 47 分钟生产采样）：cleanup 平均 43.2 秒、最长 104.9 秒；其中 `cleanup.revoke_and_release` 平均 41.0 秒、最长 71.3 秒，约占平均墙钟的 95%。当时有 657 个 released Assignment、36 个 active。该段没有复用“资源已经消失”的事实，历史释放记录越多，重复调用越多。

基线 `077f5ccf` 的 `CleanupExecutor.project` 每轮筛出全部 released Assignment，以及 suspended 的常驻 PM，对每个候选串行执行：

1. `tokensForAssignment` 同步查该 Assignment 的全部 Token、排序、JSON 解码工具清单，再逐个撤销尚未撤销的 Token。tokens 表只有主键和 Token 哈希唯一索引，没有项目／Assignment 索引，因此会对历史表重复扫描，即使全部早已撤销也如此。
2. `runtime.status` 查询记录中的终端；Herdr 适配器先调用 `hc get`，存在时还打开事件订阅读快照。除明确不存在外，再调用 `runtime.release`，它又执行 `hc get`，需要时 kill，最后 rm。每个候选串行 await，历史上已删除的终端仍每轮付出查询成本。代码足以确认重复工作，但生产 41 秒中 SQL 与外部调用各占多少，现有引述数据不能分开证明。
3. 有 worktree 时进入 `settle`，读状态和清理决策、检查路径，必要时调用 Git。原进程内 `cleaned` 只在 `clean` 内生效，不能避免前两步，也不能避免 `settle` 读状态。构建目录另按实际目录列表和未结束 Run 检查。

### 8.2 实现及恢复边界

- 每项目每轮只查一次未撤销 Token 的编号和所属 Assignment，不读哈希或历史工具清单。筛选依据仍是本轮 released／暂停 PM 候选；active 不撤销。每轮重新查询，无 Token 缓存，外部连接新签发的晚到凭据下轮仍会撤销。仍有一次表扫描和轻量 Assignment 遍历，没有宣称整个 cleanup 已与历史大小无关。
- 复用现有 `runtime_ref` 表达“尚需回收的终端”：只有 `status` 或 `release` 明确返回 `runtime_not_found` 才收集消失证据。本轮结束时在一个写事务中批量调用 system 专用领域命令，重新核对业务状态为 released 且完整引用与观察时相同，再清空引用。命令不开放 MCP；不改变角色规则。状态更新与含旧引用的项目审计事件一起提交，原释放事件不变。
- `release` 返回成功不等于已经证明消失，仍保留引用，下轮复查。失败和抛错不记录完成；写入失败全部回滚；进程在观察后、提交前退出会重复检查，提交后重启则跳过。引用在 IO 期间变化时不清除新引用。暂停 PM 可恢复，保持原有复查行为，不清空其引用。
- 工作区和构建目录各自继续处理：终端引用清空后，Git 删除失败仍重试，人工 keep／force_clean 决策仍生效；`settle` 在读取状态前跳过本进程已清理的 worktree。终端失败仍阻止删除其工作区／构建目录。没有新增“整个 Assignment 已清理”的字段或迁移，也没有新增重试次数、间隔、分片或并发策略。

### 8.3 等效回放：修前与修后

新增可重复的 `apps/server/src/cleanup.replay.test.ts`，沿用 C-216 的 TickProfiler 和真实 SQLite。固定 657 个已释放、带终端引用的 Assignment，每个写入 3 个已撤销 Token，终端桩返回明确不存在；不注入耗时、不制造 CPU 负载。连续跑 3 轮，同机单 worker。修前为上述基线实现加同一回放文件；修后为本卡实现。

```sh
pnpm exec tsc -b apps/server
CARDIGAN_CLEANUP_REPLAY=1 pnpm exec vitest run apps/server/src/cleanup.replay.test.ts --maxWorkers=1 --silent=false
```

| 指标 | 修前 | 修后 |
|---|---:|---:|
| 第 1 轮 cleanup | 101.4 ms | 139.8 ms |
| 第 2 轮 cleanup | 95.4 ms | 4.6 ms |
| 第 3 轮 cleanup | 108.9 ms | 0.7 ms |
| 每轮逐终端 status 调用 | 657 / 657 / 657 | 657 / 0 / 0 |
| Token 查询时间（3 轮） | 96.8 / 92.6 / 92.2 ms | 0.3 / 0.2 / 0.2 ms |

首轮一次性保存 657 个引用清除和审计事件，事务约 136 ms，所以本地首轮比修前慢；第 2 轮还包含写入后的快照重建。稳态移除了逐历史 Assignment 的 Token 查询和终端 IO。`cleanup.revoke_tokens` 现在独立于 `cleanup.revoke_and_release` 计时，旧版前者嵌套在后者中，比较时以 cleanup 总墙钟为准。

这里测到的是数据库／JavaScript 开销和外部调用次数，桩没有生产 hc、SSH 延迟，也没有真实 Git 清理；不能把本地毫秒数换算成生产的 41 秒。生产收益仍须上线后的同口径分段日志确认。reconcile.git 和 backup.fetch 不在本卡范围。

### 8.4 验证覆盖

- domain 契约：system 身份和项目边界；仅清空仍 released 的同一引用；active／suspended 不清空；并发更换引用、重复提交和回滚后的重试；旧释放审计保留。
- store：只返回本项目未撤销凭据；另一个连接签发／撤销立即可见；事务回滚不缓存错误结果。
- server：601 个历史候选首轮处理后，后续及重建执行器均不再调用终端或重复撤销；失败结果／抛错重试；只有 release 成功仍复查；清理后晚到凭据仍撤销；active 与刚释放的候选分离；审计写入失败使引用清除整体回滚；IO 期间新引用不会被旧观察覆盖；终端清除后 Git 失败仍独立重试。原 cleanup、构建目录及暂停／释放用例共同回归。

## 9. C-244：route.candidates 与 route.decision_followups 增量化

> 卡片 C-244 / 工作项 W-755。依据 H-45 生产分段（dispatcher 420 轮）：平均墙钟 7.26 秒，`route.candidates` 平均 3.5 秒、`route.decision_followups` 平均 2.9 秒。本卡只改查找、复用和“哪些对象需要重算”，不改派发顺序（`compareDispatchOrder`）、容量规则、催办时机（拍板后 30 分钟）和任何数值；没有表结构变化。

### 9.1 测量手段

- **新增分段**（`apps/server/src/dispatch.ts`，都用 `profileSpanSync`，不增加 `await`）：
  - `route.decision_followups.state`／`.evaluate`／`.persist`；
  - `route.candidates.attempts`（未结束 BellAttempt）／`.state`／`.notifications`（读 pending 通知）／`.owners`（逐条求归属并分组）／`.index`／`.groups`（组内排序并生成候选）／`.queued`（只有排队 Run 的 Assignment）；
  - `route.maintenance.obsolete`／`.review_limit`／`.merge_stalls`／`.belled`／`.inactive_runs`。
- **生产形状回放** `apps/server/src/dispatch-route.replay.test.ts`（默认跳过，`CARDIGAN_ROUTE_REPLAY=1` 运行；不起 server、不探测请求，只跑 dispatcher tick 并输出 `tick_profile` 行）。C-216 的回放没有已释放 Assignment、Agent 发起的拍板和常驻 PM，测不出这两段，所以新写一份：
  - 240 张卡，其中 223 张走完合并检查并释放全部 3 个 Assignment（669 个 released），17 张未完成；
  - 每张卡一条由 coder 发起、人已拍板的拍板，一半有人在时间线引用它写了执行结果、一半没有；
  - 每张卡 75 条评论，合计 25,878 条事件、21,344 条时间线、463 个拍板、722 个 Assignment、1,134 个 Run；
  - 一个 PM Ops（有正在运行的 Run，铃声积压）和一个 PM Office，`standing` 用生产同款 `standingResolver`；每个 Run 签发 2 个 Token（2,268 个）。
  - 时钟固定，所有拍板都已超过 30 分钟。
- 命令（本机，不设 `CARDIGAN_TICK_PROFILE`，理由同 §6.1）：

```sh
pnpm exec tsc -b apps/server
CARDIGAN_ROUTE_REPLAY=1 ROUTE_REPLAY_CARDS=240 ROUTE_REPLAY_OPEN_CARDS=17 \
  ROUTE_REPLAY_COMMENTS=75 ROUTE_REPLAY_TICKS=11 ROUTE_REPLAY_OUT=/tmp/r.json \
  pnpm --filter @cardigan/server exec vitest run src/dispatch-route.replay.test.ts --maxWorkers=1
```

  可选 `ROUTE_REPLAY_PROFILE=<file>` 从第 2 轮起记录 CPU profile。**数据来源：合成数据，不是生产库副本，也没有在生产上做实验。** 合成数据里 PM Ops 积压的通知比生产多得多，所以 candidates 的绝对秒数比生产大；看热点和量级，不直接对标生产秒数。

### 9.2 修前：最大的几项

修前（本卡起点 `b69d15a`，只加了上面的分段）记录 CPU profile 的那次运行（第 2～8 轮；profile 本身有开销，绝对值比 §9.5 偏大）给出的前三项：

| 位置 | 稳态每轮 | 原因 |
|---|---:|---|
| `route.candidates.owners` | 10～26 s | ① 常驻 PM 的通知每条都调一次 `standingResolver`，它对每个活跃常驻 PM 先查 `tokensForAssignment`（tokens 表没有项目／Assignment 索引，全表扫描并解码工具清单），即使行里已经有 `standing_mode`；② 分组用 `[...(groups.get(key) ?? []), n]`，同一组（积压的 PM Ops 通知）每加一条就复制一次整组，是平方级 |
| `route.candidates.groups` | 1.1～1.9 s | 每组取 Assignment 时 `state.assignments.find((a) => a.id === this.owner(first, state))`：**谓词里**再算归属，每个 Assignment 都调一次 `standingResolver`（722 次 Token 查询）；候选优先级 `cards.find(c => c.id === work_items.find(...))` 是卡数 × 工作项数 |
| `route.decision_followups.evaluate` | 1.0～2.8 s | 每轮对全部 463 个拍板：先线性找 `decision_followup_due` 事件，再对未催办的拍板跑 `decisionImplementationRecorded`（全量事件过滤、全量事件 `some`、全量时间线 `some`），是“拍板数 × 事件数” |

其余：`route.ack_inbox` 4～6 s（同样逐条走 `standingResolver`），`route.maintenance` 0.8～1.5 s。

生产上 candidates 3.5 s 与此同源：生产有 PM Ops／Office 常驻 Assignment，tokens 表随每个 Run 增长，分组和组内取 Assignment 都会逐条触发 Token 全表扫描。

### 9.3 改了什么

**decision_followups（`packages/domain/src/commands/decision-followup.ts`，`apps/server/src/decision-followup-schedule.ts`）**

1. 新增 `decisionFollowupStatus(state, q, now)`，把原 `remindDecisionFollowups` 的判断拆成五种结果：`ineligible`（不是已拍板的 Agent 拍板）、`waiting`（未满 30 分钟，带 `due_at`）、`reminded`（已有同一 `resolved_at` 的 `decision_followup_due`）、`recorded`（已观察到落实；`durable` 表示证据只依赖只追加的事件／时间线）、`due`（应催办）。`remindDecisionFollowups` 只对 `due` 发事件，新增可选 `decision_ids` 把这一轮限定在某些拍板上，不传时与原来一样扫全部。判断规则逐条照搬原实现，常量 `DECISION_FOLLOWUP_DELAY_MS = 30 分钟` 与原数值相同。
2. 查找走按快照身份缓存的索引（与 §6.3 同一约定）：`decision_followup_due` 键集合、按拍板分组的 `decision_resolved`、按卡分组的进展事件、按 (卡, seq) 分组的事件、按引用拍板分组的评论。判断一个拍板从“全量事件 × 3 + 全量时间线”降到只看相关卡的事件。`decisionFollowupNeedsHuman`（needs-you 视图）和 `decisionFollowupBlocked`（改用 `eventById`）同样受益。
3. dispatcher 持有 `DecisionFollowupSchedule`（跨轮，进程内）：按 **Decision 对象** 记住不会再变的答案。Store 快照对未改动的行复用同一对象、改动的行重新解析成新对象（reducer 也复制），所以拍板一改就是新键、必然重算。只记三类：`ineligible`、`reminded`、`durable` 的 `recorded`——它们只取决于拍板本身和只追加的事件／时间线；`waiting` 记到 `due_at`，到点再算。`due`（本轮正在写催办事件，下一轮会看到它变成 `reminded`）和只有 PM Ops 评论作证的 `recorded`（取决于该 Assignment 是否仍是 ops 常驻 PM）每轮都重算。答案在事务提交之后才写入；事务回滚时什么都不记。进程重启后从空开始，第一轮从库里把全部拍板重算一次。

**candidates（`apps/server/src/dispatch.ts`、`dispatch-inbox.ts`、`assembly.ts`，`packages/domain/src/run-index.ts`）**

1. 每条通知的归属只算一次（按通知对象缓存），组内取 Assignment 用按 id 的 Map（取第一个，与 `find` 一致）。
2. `memoStanding`：同一段**同步、且不写 Token 和 Assignment** 的代码里，同一 (项目, 种类, 状态对象) 的常驻 PM 只解析一次。用在 candidates（不写库）、`acknowledgeInbox`（只移动通知行）和 maintenance 的已响铃重试循环（只写通知和告警事件）。`standingResolver` 本身改为只有缺 `standing_mode` 的旧行才读 Token（原来先读再判断，读出的结果用不上）。
3. 分组改为原地 `push`，不再每条复制整组。
4. Run 查找按快照身份建索引（`runById`、`queuedRun`、`runsOf`）：通知归属、排队 Run、`busy` 和重试循环里的“该 Assignment 是否还有未结束 Run”、`obsoleteDispatchAttention` 都改为按键查。最后一段“只有排队 Run 的 Assignment 才可能补候选”从“每个 Assignment 扫两遍全部 Run”变为一次 Map 查找，已释放、已完成的 Assignment 只花一次查表。
5. 候选优先级先找工作项再找卡（`cardPriority`），不再在卡的谓词里找工作项。

**通知读取（`packages/store/src/inbox.ts`）**：`NotificationQuery` 新增 `statuses`，在 SQL 里过滤；maintenance 的过期提醒检查、`resolveUnreadableNotifications`（都本来就跳过 acked／resolved）、`acknowledgeInbox`（只处理 pending／belled／delivery_failed）和 `retireReconcileNotifications`（跳过终态）改为只读出它们会处理的状态，终态历史不再逐条 JSON 解码。结果顺序仍是 `seq, id`。

**已释放、已完成、已取消对象的处理边界**：它们不再触发 Run 扫描和 Token 查询，但没有被直接排除——
- 发给已释放 Assignment 的 pending 通知仍然进入候选，由 `deliver` 走原来的 `assignment_released` 拒绝流程收尾（否则会永远 pending）；
- 排队 Run 带容量等待的 Assignment 无论状态如何都照原规则补候选；
- 已拍板但还没到 30 分钟、或只有 PM Ops 作证的拍板每轮仍会重看，不会被“已关闭”误判跳过。

### 9.4 为什么不会读到旧状态、重复派发或漏派

- 同轮快照：`dispatchStateLoader`（C-216 起）在每个消费事务里按 `command_versions` 版本号复查，写入后（含其它连接）一定重读；本卡没有改这一层。认领、ACK、停止仍在各自写事务里重新读状态并复查（`claim` 里的 `hasRunTarget`、`busy`、BellAttempt 互斥、容量 `runCapacitySnapshot` 都没动）。
- 新增的索引（事件、时间线、Run）都按数组身份缓存，规则与 §6.3 相同：写入生成新数组，回滚后读到旧数组对应旧索引；`WeakMap` 不阻止回收。
- `DecisionFollowupSchedule` 只会让 dispatcher **少看**确定不会变的拍板：键是对象，拍板任何字段变化都换新对象；记下的三类答案只依赖不可变数据；`due` 不记，所以催办事件写失败（回滚）时下一轮还会再算；重复催办仍被“同一 `resolved_at` 已有催办事件”挡住（与原来一样）。
- `memoStanding` 只用在不写 Token、不写 Assignment 的同步代码段内，段内状态对象不变时解析结果不可能变化；状态对象一换就重算。

### 9.5 修前修后（本机合成数据，同一份数据，11 轮取第 2～11 轮）

本机同时有其它任务在跑（负载约 4～9），绝对值有波动，比较以同批相对值为准。

修前是本卡起点 `b69d15a` 加同一份回放文件，修后是本卡提交；两次在同一台机器上顺序运行，种子数据完全相同（25,878 条事件、463 个拍板、669 个已释放 Assignment、2,268 个 Token）。

| 指标（第 2～11 轮） | 修前 平均 / p90 | 修后 平均 / p90 |
|---|---:|---:|
| dispatcher 墙钟 | 23.54 s / 29.02 s | **1.51 s / 1.76 s** |
| route.decision_followups | 1.30 s / 2.90 s | 1 ms / 11 ms |
| route.candidates | 15.84 s / 20.99 s | 130 ms / 148 ms |
| route.ack_inbox | 4.58 s / 5.64 s | 368 ms / 431 ms |
| route.maintenance | 904 ms / 1.12 s | 189 ms / 217 ms |
| route（合计） | 22.84 s / 28.16 s | 891 ms / 1.03 s |
| deliver | 695 ms / 1.32 s | 607 ms / 767 ms |
| 首轮（含路由全部积压事件） | 28.55 s | 17.18 s |

- `route.decision_followups.evaluate` 首轮 27 ms（全部 463 个拍板按索引判断一次），之后每轮 0.1～0.2 ms：只剩 `DecisionFollowupSchedule` 对每个拍板做一次 `WeakMap` 查找。
- 修后 candidates 子段（平均）：`notifications` 75 ms（读出并解码 pending 通知）、`groups` 32 ms、`owners` 23 ms，其余不到 10 ms。
- 修后 maintenance 子段：`obsolete` 85 ms、`merge_stalls` 82 ms，其余不到 30 ms。

### 9.6 项目状态缓存：同轮共享与跨轮增量方案

- **同轮共享**：已经由 `dispatchStateLoader` 做到——一轮内所有步骤共用按版本号缓存的同一份 `CommandState`，没有写入就不重建（本卡回放稳态 `state_builds` 为 0）。本卡在此基础上把派生索引（事件、时间线、Run、拍板状态）也挂在同一份快照上，同一快照只建一次。
- **跨轮增量（建议另开卡）**：剩余耗时主要是“每轮从 SQLite 读出并解码全部未终结通知”和逐候选认领，而不是 CommandState。方案：
  1. 给 notifications 加与 `command_versions` 相同的版本触发器（或 `updated_seq` 列），dispatcher 记住上轮版本，只读出变化的通知行，在内存里维护“未终结通知集合”和按 Assignment 的分组；
  2. 候选按“脏 Assignment 集合”增量维护：来源是自上轮以来变化的通知、`command_rows` 里变化的 runs／assignments／work_items／deliveries 行，以及到期的 `next_attempt_at`；
  3. 重启时从库全量重建（与本卡的 `DecisionFollowupSchedule` 相同的恢复方式），每次认领仍在写事务里复查。
  这涉及新的表结构和“内存集合与库一致”的不变量，需要单独的契约测试（随机事件序列对照全量计算），改动面明显大于本卡。

### 9.7 剩下的耗时与未覆盖

- **合成数据修后仍是平均 1.51 s，没有到 1 秒。** 剩下的时间在：`deliver` 约 0.6 s、`route.ack_inbox` 约 0.37 s、`route.maintenance` 约 0.19 s、`route.candidates` 约 0.13 s，`unreadable`、`retry_dispatched` 各约 0.08～0.09 s。前三项都随“未终结通知数 × 候选数”增长：合成数据里 PM Ops 一直有运行中的 Run，所有卡的通知都积压在它名下，每张卡一组，每轮几百个候选在 `deliver` 里逐个读状态、判 `busy` 后返回；ACK 每轮逐条查游标。生产没有这么大的积压（H-45 里这两段以外的合计约 0.86 s，本卡也让 ack_inbox、maintenance 变快），按比例看生产应能到 1 秒以内，但这要上线复测才能确认。
- 继续往下降的方向：`stoppedByHuman` 每次倒序扫事件（可按快照记忆）、ACK 循环按游标批量判断、`deliver` 对同一 Assignment 的多组候选只判断一次 `busy`；更彻底的是 §9.6 的跨轮增量。都不在本卡范围，建议看生产复测数字后再决定是否开卡。

- 合并部署后，由主机侧在生产上开一次 `CARDIGAN_TICK_PROFILE=1` 复测（张良执行），用新增分段核对 `route.candidates`、`route.decision_followups` 是否降到亚秒级，以及剩余时间是否与本节的判断一致。
- 本卡不改 `docs/development-plan.md` 正文：派发、催办的规则和数值都没有变化。
