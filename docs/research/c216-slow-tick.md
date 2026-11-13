# C-216 server 周期任务 slow tick 调查（第一阶段：测量）

> 卡片 C-216 / 工作项 W-664。第一阶段只加测量、不改业务逻辑（PM 口径 C-216#12）；修复范围待 PM 在卡上确认后进入第二阶段，修前修后用本文同一方法各测一次。

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

### 3.1 规模与 dispatcher tick 耗时

| 卡数 | 事件 | Run | 首次 tick | 稳态 tick（第 2～4 次） | ELU | 事件循环延迟 max |
|---:|---:|---:|---:|---:|---:|---:|
| 40 | 1,590 | 120 | 0.57 s | 0.31～0.34 s | 1.0 | 0.58 s |
| 120 | 5,190 | 440 | 7.8 s | 5.2～5.6 s | 1.0 | 8.0 s |
| 240 | 10,590 | 920 | 45.7 s | 24.0～30.8 s | 1.0 | 45.9 s |

- 卡数翻倍（120→240），稳态 tick 约涨 4.7 倍，是**超线性增长**（约 n^2.2）。UnitOfWork 次数只线性增长（1,564→3,244），单次 UnitOfWork 越来越慢（max 0.37 s→2.4 s），说明每次认领里做的是“全量读、全量算”。
- 分段：`deliver` 占 tick 的 67%～88%，`route` 占 18%～33%，`host_ops`、`inactive` 可忽略；`uow_ms` 占 wall 的 72%～92%，即绝大部分是同步 SQLite 读加解码和其中的纯计算。首次 tick 多出的部分是状态重建（120 卡 444 次、240 卡 924 次），之后命中缓存只剩 1 次。

### 3.2 tick 是否阻塞事件循环

**是，而且是整段阻塞。** 三档规模的 `event_loop_utilization` 都是 1.0；事件循环延迟最大值等于最长 tick 的耗时（240 卡 45.9 s）。tick 期间事件循环一次都没让出，HTTP、SSE、MCP 请求全部排队到 tick 结束。

### 3.3 对 Workbench 接口和 MCP 的影响（开环探测）

| 卡数 | Web 卡片列表 空闲 p50 / p95 | Web tick 期间 p50 / max | MCP get_updates 空闲 p50 / p95 | MCP tick 期间 p50 / max |
|---:|---:|---:|---:|---:|
| 40 | 8 / 13 ms | 334 / 582 ms | 11 / 16 ms | 338 / 586 ms |
| 120 | 64 / 100 ms | 5.6 / 8.0 s | 65 / 101 ms | 5.6 / 8.0 s |
| 240 | 190 / 353 ms | 31.0 / 46.1 s | 195 / 354 ms | 31.0 / 46.1 s |

- tick 期间两条渠道的延迟几乎一样，等于“剩余 tick 时间 + 自身耗时”，与请求本身多重无关——瓶颈是事件循环被占满，不是接口自己慢。
- 空闲时 MCP 自身只要 4～9 ms（服务端计时），Web 卡片列表自身随规模涨到约 190 ms（这部分属于 C-203 的读模型范围，本卡不处理）。
- 生产 dispatcher 中位 6.6 s，意味着 Agent 的 MCP 调用和 Workbench 请求若落在 tick 内会多等数秒；按 1 秒间隔连跑，事件循环大部分时间都在 tick 里。

### 3.4 最慢的是哪一段（240 卡 CPU profile，4 次 tick 共约 131 s 采样；包含关系，数字有重叠）

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

## 4. 第二阶段修复建议（待 PM 确认范围）

按收益和风险排序，均不改调度语义（派发顺序、优先级、合并检查互斥不变），不涉及数据库结构变化：

1. **认领时只取被请求且仍为 pending 的通知**：`listNotifications` 增加 `ids` 条件，在 SQL 里按主键过滤，结果顺序仍按 `seq, id`。预期去掉约 27% 的 tick 时间。
2. **容量快照复用 Store 已有的按流事件缓存**（`events.listStreams`，C-126/C-131 已有），不再每次认领重读全部事件；没有该端口的后端保持原路径。预期去掉约 10%～14%。
3. （可选，面较大）`hasRunTarget` 先按卡建索引再查，改的是 `packages/domain`，需要附契约测试；或拆卡。
4. 把长 tick 分片让出事件循环、把 cleanup/backup 移到 worker：改动面大、涉及并发，建议在 1、2 之后重测再定，必要时另开卡。

修复后用本文 §2.2 同一命令、同样规模（40/120/240）复测，修前修后数字写进 PR 和本文。
