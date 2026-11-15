# C-339 后台重投 CPU 剖析与修复

赵云；对应开发工作项 W-1142、既有 M3.4 Dispatcher 计划及本卡验收标准。修复前基线为 `0e16d40f3513f69e96aea9305faf3b96492b08a5`。本报告随代码提交，原始证据上传本卡，不提交数据库或含本机路径的原始 profile。

原始证据：修复前 profile 为 attachment-2749，修复前更正窗口为 attachment-2755（取代 attachment-2750 的派生表），修复后 profile / 窗口为 attachment-2756 / attachment-2757；均为 gzip 压缩的原始 JSON。

## 改动与边界

重投循环原先对所有历史 Run 在过滤前读取一次状态；每个未启动失败 Run 又扫描事件寻找恢复关系；进入 inspect 的候选还会完整解码项目投递历史。默认每轮完成后等待 1 秒，历史越大，每轮越慢。本次样本每轮平均 6,218 个事务，其中约 5,500 次源于过滤前的历史读取，重投平均每轮 3,272ms。这能解释该路径的稳定成本；生产约 11 秒/分钟的具体构成仍需现场 profile 核实。

现在先筛 dispatched、queued、任意状态的停止栅栏及有恢复后启动失败证据的历史 Run。恢复失败编号按不可变事件数组弱引用缓存，乱序/迟到恢复事实在新快照可见后重建，不改持久事件。保留原领域规则的最后校验，未把终态失败一概忽略。读取门铃历史按项目和 Run 定向；查询未完成租约按项目和 Assignment 定向。迁移 0031 只加 `(project_id, run_id, started_at)` 索引，保留时间相同的 rowid 顺序。全项目读取的旧调用不变。

外接身份、当前目标归属、停止栅栏、重启补偿、事务内领取、等待状态/Git 期间 MCP 启动优先、关闭窗口、重试次数/退避/超时/恢复预算均保持原规则。未改 C-329 的合并检查恢复空转，也未改 C-338 的 Web 诊断隔离；没有生产配置或数值规则变更。

直接核查范围：server 的 `dispatch.ts`、`dispatch-retry.ts`、`dispatch-stop.ts`、`dispatch-state.ts`、`dispatch-inbox.ts`、`dispatch-loop.ts`、`cleanup-loop.ts`；router 的恢复路由契约；store 的 `dispatcher.ts`、迁移及命令快照/事务；domain 的 `dispatch-recovery` 契约。代码改动限 server 重投与 Store 定向读取/索引。开发方案更新 §6.1、§20.2 正文，未改版本号和变更记录。

## 实验与复现

复用 C-287 的 `seedScenarios`，固定种子 339；350 张卡、1,050 个工作项、1,053 个 Assignment、5,500 个 Run、55,000 条事件、18,075 条时间线及 590 个拍板。另加 5,500 条已结算投递历史（每五条一条失败）。Run 分布：4,495 completed、1,001 failed、queued/dispatched/acked/running 各 1；Assignment 为 active 794、released 207、suspended 52。将首批历史改为未启动失败，用来观察 C-270 已指出的稳定扫描路径；这不是生产状态分布的证明。生成器部分展示快照不表示完整命令执行历史，少量活动展示 Run 已有 started_at；合法未启动重投由语义回归另行覆盖。

两个版本初始事件摘要完全相同：`842a09e77c5b07b9f38732a22017879f0ea5cf10639a88b7b46cdb02984a5fe7`。假 Runtime 不启动进程、不访问 hc/SSH/Git；路由游标先推进历史，预热一轮，再测名义 60 秒窗口；循环沿生产每轮完成后等待 1 秒，不追赶错过的时隙，不空转、提频或制造负载。使用 Node 24.22.2，未并行运行本工作项的其它测试或采样进程。

```sh
pnpm exec tsc -b apps/server apps/cli
pnpm --filter @cardigan/server exec node test-support/background-profile.mjs /tmp/c339-before-2
pnpm --filter @cardigan/server exec node test-support/background-profile.mjs /tmp/c339-after-1
```

前一条测量在基线产品代码构建后运行；后一条在修复代码构建后运行。同一工具可复制到独立的基线检出中复现，输出目录必须不存在。工具不发现主机配置，不读取、复制生产库或生产日志；生成数据只写入显式新目录。报告阶段对 span 排他耗时公式作了修正，测量路径、原始 tick 行、CPU profile 与样本均不变。

只装配完整 Dispatcher；未装配 RuntimeMonitor、cleanup、merge、merge-push、真实 host_ops 和外部 IO。因此这里的进程 CPU 是合成派发进程的 CPU，不是整个生产后台的收益预测。后台其它路径的生产差值仍未核。

## 同窗口结果

| 指标 | 修复前 | 修复后 |
|---|---:|---:|
| 实际窗口 | 60.976s | 60.079s |
| 完成轮数 | 14 | 57 |
| user CPU | 49.149s | 5.693s |
| system CPU | 1.085s | 0.634s |
| 单核 CPU | 82.38% | 10.53% |
| 平均 tick 墙钟 | 3,426.5ms | 81.6ms |
| 平均事务数/轮 | 6,218 | 720 |
| retry 墙钟/轮 | 3,272.1ms | 3.074ms |
| retry 墙钟/分钟 | 45.076s | 0.175s |
| 事件循环 p99 | 13.5ms | 75.8ms |
| 事件循环 max | 6,438.3ms | 110.8ms |

CPU 下降约 71.85 个百分点；重投每分钟下降约 99.61%。优化后轮数增加是同一完成后等待节奏的自然结果，没有提频。目标为消除每历史 Run 的事务/事件扫描和每候选的全投递历史解码；没有新增调度或业务数值目标。**p99 未改善**，不能把本实验写成延迟全面达标；Node 10ms histogram 在长阻塞时不会为每个错过的采样补记，前后阻塞频率/轮数不同，尾部分位数不能单独用于判断收益。最大阻塞明显缩短，但生产 p99/max 仍待部署后同口径复测。

## CPU self 样本前十

按函数名、文件和行号合并各调用栈位置，分母包含 idle，以下只列非 idle 前十。修复前 54,259 样本、profile 时长 61.121s，idle 21.58%；修复后 56,561 样本、60.193s，idle 91.59%。profile 包括极短的启停边界，CPU 表使用 process.cpuUsage 的独立实际窗口。

| 修复前函数/位置 | 样本占比 | 修复后函数/位置 | 样本占比 |
|---|---:|---|---:|
| retryDispatchedRuns | 49.28% | SQLite prepare | 1.78% |
| dispatchRecoveryQueuedAt 事件谓词 | 15.69% | InactiveRunReaper.tick | 1.77% |
| SQLite all | 2.69% | 实验 clock.now | 0.65% |
| command snapshot version | 2.31% | Dispatcher 中同步谓词 | 0.55% |
| dispatchRecoveryQueuedAt | 1.24% | SQLite exec | 0.41% |
| SQLite exec | 0.96% | program | 0.38% |
| snapshotRepositories | 0.80% | GC | 0.30% |
| InactiveRunReaper.tick | 0.76% | snapshotRepositories | 0.23% |
| SQLite prepare | 0.71% | SQLite get | 0.21% |
| Store.#read | 0.31% | SQLite all | 0.21% |

高置信度结论是该合成窗口的重投历史扫描为主要热点，且定向修复明显削减它。self 样本受 V8 内联、native 归因、非均匀采样和当前机器调度影响；单次前后窗口不提供统计置信区间，也不把样本百分比视为精确 CPU 时间。JSON 解析与 SQLite/native 的全部细分占比未独立核实，GC 在修复后约 0.30% 样本。**不能从含 await 的墙钟 span 与单核 CPU 百分比相减，认定生产“未覆盖的 35～40%”已被证实或被本次修复覆盖。**

## 不重叠 span 表

单位：墙钟秒/分钟。每个 span 减去它的直接子 span（各层分别做减法），父项展示的是剩余自身耗时；不将父子累计相加。按实际窗口归一化，含 await；未装配路径不写假零收益。输入原始 span 四舍五入到 0.1ms，因此极小值存在舍入误差。

| span 自身 | 修复前 | 修复后 |
|---|---:|---:|
| `startup_check` | 0.0000 | 0.0000 |
| `host_ops` | 0.0001 | 0.0000 |
| `route.patrol_host_ops` | 0.1231 | 0.1238 |
| `route.decision_followups.state` | 0.0006 | 0.0000 |
| `route.decision_followups.evaluate` | 0.0192 | 0.0170 |
| `route.decision_followups` | 0.0049 | 0.0080 |
| `route.merge_shadow` | 0.0000 | 0.0000 |
| `route.suggestion_progress` | 0.0066 | 0.0121 |
| `route.system_rules` | 0.2570 | 0.2979 |
| `route.route_events` | 0.7429 | 1.8407 |
| `route.unreadable` | 0.0108 | 0.0251 |
| `route.ack_inbox` | 0.0564 | 0.1174 |
| `route.bell_attempts` | 0.0011 | 0.0008 |
| `route.retry_dispatched` | 45.0761 | 0.1750 |
| `route.maintenance.obsolete` | 0.0070 | 0.0194 |
| `route.maintenance.review_limit` | 0.0138 | 0.0320 |
| `route.maintenance.merge_stalls` | 0.0074 | 0.0149 |
| `route.maintenance.belled` | 0.0008 | 0.0005 |
| `route.maintenance.inactive_runs` | 0.0706 | 0.0753 |
| `route.maintenance` | 0.0083 | 0.0179 |
| `route.candidates.changes` | 0.0014 | 0.0025 |
| `route.candidates.state` | 0.0000 | 0.0000 |
| `route.candidates.notifications` | 0.0001 | 0.0001 |
| `route.candidates` | 0.0018 | 0.0044 |
| `route` | 0.0029 | 0.0103 |
| `inactive` | 0.7891 | 1.8482 |
| `deliver` | 0.0000 | 0.0000 |

最初上传的窗口 JSON 中派生表错误地减去了所有后代，出现负的 route remainder；原始 tick 行有效。最终以本表及更正附件为准；复现工具已按直接子项计算。

## 回归与遗留

新增回归覆盖：普通失败/已结束历史增长不增加重投状态读取，历史旁的合法失败门铃继续按原节奏重试；迟到/重复/乱序恢复事件在跨连接提交后可见、回滚不污染索引且只升级一次；升级已有门铃历史后保持 Run/项目隔离与同时间戳顺序；跨连接新租约和回滚可见；查询计划使用新索引且不建排序临时树。

定向派发/重投/重启/权限收尾、唤醒前校验、并发租约、路由恢复及领域恢复契约：12 文件 165 项通过。新增索引的升级历史用例补测：1 文件 6 项通过。相关构建 `pnpm exec tsc -b apps/server apps/cli`、`pnpm check:deps`、改动代码 Biome 通过。补充派发/自动上下文/关闭循环/cleanup/Store 快照回归：6 文件 90 项通过，合计 18 个不同文件 255 项通过。没有改 domain 文件，因此无需 test:types；其恢复契约已在上述测试中运行。全仓测试和端到端测试未运行，交主机合并检查。

修复后残余主要成本为 InactiveRunReaper 历史扫描与路由准备/SQLite prepare。实测两段分别约 1.85 与 1.84 墙钟秒/分钟，inactive self 约 1.77% 样本，不能据此承诺生产收益。建议 PM 在生产复测确认后另卡规划按活动 Run 定向巡检及路由准备复用；本卡不扩大改 domain 状态机、C-329 或 Web 诊断。生产复测由张良在合并部署后完成，沿同一 analyze.py 口径对齐 CPU、事件循环、各 span，当前尚无现场结论。

## 基线集成返工

赵云在合并冲突返工中先合入基线 `c0f7bba0d9033a2b64a7cc93cf85d7a492b7fe3c`；§20.2 同时保留本卡重投说明和基线的候选分支清理说明，其余基线改动完整保留。

主机检查发现的迁移测试问题已修复：C-248 的历史投影槽位仅核固定 28–30 版，升级终点从写死 30 改为当前迁移目录的最新版本；保留已发布迁移的摘要、栅栏、代次和审计不变断言。监督器旧库测试改为只应用截至 28 版的真实迁移，不再从最新库删表和版本记录、却留下后续索引。补核不迁移打开时版本记录及索引不变，正式启动才新增索引，重复迁移无效果。清理时只关闭尚未关闭的连接，避免掩盖原始失败。

合入后运行 Store 的 c248-migration-integration、store-open、migrate、dispatcher、command-snapshots，server 的 dispatch-retry、dispatch-restart，以及 router/domain 的 dispatch-recovery 契约，共 9 文件 105 项通过（单 worker）；相关 server/cli 构建通过。产品重投实现和迁移 0031 未改，本轮没有重复性能采样；上文性能数字仍是原始基线 `0e16d40f3513f69e96aea9305faf3b96492b08a5` 与初版修复 `f71fdbab823882323fbcdbb73aca29d023dac46c` 的历史实验，不将它们写成新基线或完整生产后台的复测结果。生产归因、p99 限制及部署后复测遗留保持不变。
