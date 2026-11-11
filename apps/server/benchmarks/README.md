# C-131 共享状态缓存基准与交付说明

赵云：周期任务共享按项目、按表修订的 Store 缓存；timeline、runs 等集合只解码变更行，员工活动按 Assignment 增量维护。基准的完整调度包含前后两次 RuntimeMonitor，持续运行轮次达到十倍性能目标。

## 范围与实现

对应 C-131 / W-388（C-126 的冻结期性能后续）；开工和交付前均合入 `origin/main`，基线为 `036ff4f0b63f3ccd0c207efcfebe83b14048a212`。开发方案只更新 §6.1 正文。

- 迁移 0017 增加事务内修订、每实体最后变更标记和员工活动投影。触发器覆盖主机、CLI、其他连接和直接 SQL 写入；回滚不发布缓存，读事务保持 WAL 快照。
- 缓存放在 Store，由 `loadCommandState` 统一使用，因此调度器、RuntimeMonitor、merge、merge-checks、merge-push、cleanup 和 MCP 共用。主机设置只覆盖返回值，不污染项目缓存。无缓存端口的后端和旧 schema 保留原路径。
- 员工活动是跨项目数据，相关负载变化必须使其他项目刷新；无关项目的普通写入、通知、Token 和幂等写入不会使缓存失效。
- 新触发器增加了 SQL 编译成本，基准揭示后改为按连接复用预编译语句和仓储实例。没有改调度规则、命令语义或旧测试期望。
- dispatch、merge、merge-push、cleanup、reconcile、backup、attachments 循环记录超过默认 1000ms 的慢轮，包含循环名、耗时和阈值。调度统计含 RuntimeMonitor。

## 基准方法

Node v24.22.2，同一环境顺序运行前后版本。用脚本生成独立临时 SQLite 库：131 张卡、330 个 Assignment、20 名员工、4000 条 timeline、1600 条 runs、10000 条 events。历史文本约 1 KiB/行；历史事件已路由，另保留一个运行中的 Run 和 RuntimeMonitor 订阅。没有读取生产库。

每轮执行 `monitor.reconcile → await dispatcher.tick → monitor.reconcile`。冷启动计首次完整轮次；另预热一轮，再分别统计 40 轮空闲和 40 轮每轮更新一次 Run 的场景。带写入场景的计时包含写事务。CPU profile 只采集这 80 个持续运行轮次；原始 profile 与 JSON 数据随交付作为附件提供。

| 场景                | 036ff4f 平均 / p95 / 最大 (ms) | 本次平均 / p95 / 最大 (ms) | 平均加速 |
| ------------------- | -----------------------------: | -------------------------: | -------: |
| 空闲完整轮次        |       289.42 / 309.92 / 349.44 |      19.56 / 25.33 / 35.11 |   14.79× |
| 带 Run 写入完整轮次 |       318.12 / 335.80 / 339.29 |      19.16 / 30.40 / 31.98 |   16.60× |

首次冷启动：398.00ms → 101.82ms（3.91×）。冷启动需要解码全量历史，十倍结论针对上表的持续运行轮次；本次冷启动也低于 200ms。

## CPU profile 自耗时前十

按函数、文件和行号合并采样点；原生 SQLite 调用用“原生函数 ← 调用者”标明来源。百分比为各自 profile 的采样占比，不能用占比直接比较绝对 CPU 时间。文件位置来自编译产物。

### 基线 036ff4f

| 函数                        | 位置                                     | 样本 |   占比 |
| --------------------------- | ---------------------------------------- | ---: | -----: |
| prepare ← jsonRepository    | `packages/store/dist/repositories.js:9`  | 6713 | 29.46% |
| decode                      | `packages/store/dist/repositories.js:23` | 4269 | 18.73% |
| all ← assignmentActivity    | `packages/store/dist/employees.js:14`    | 3268 | 14.34% |
| all ← list                  | `packages/store/dist/repositories.js:29` | 1905 |  8.36% |
| (garbage collector)         | `(V8):0`                                 | 1551 |  6.81% |
| list                        | `packages/store/dist/repositories.js:29` |  930 |  4.08% |
| jsonRepository              | `packages/store/dist/repositories.js:9`  |  724 |  3.18% |
| placeholders                | `packages/store/dist/repositories.js:4`  |  492 |  2.16% |
| prepare ← createIdAllocator | `packages/store/dist/ids.js:14`          |  428 |  1.88% |
| prepare ← eventRepository   | `packages/store/dist/repositories.js:56` |  408 |  1.79% |

### 本次实现

| 函数                        | 位置                                          | 样本 |   占比 |
| --------------------------- | --------------------------------------------- | ---: | -----: |
| prepare ← createIdAllocator | `packages/store/dist/ids.js:14`               |  333 | 22.98% |
| queued                      | `apps/server/dist/dispatch.js:203`            |  174 | 12.01% |
| (anonymous)                 | `apps/server/dist/dispatch.js:206`            |  130 |  8.97% |
| prepare ← routerCursor      | `packages/store/dist/inbox.js:163`            |  105 |  7.25% |
| exec ← #run                 | `packages/store/dist/store.js:105`            |   99 |  6.83% |
| snapshotRepositories        | `packages/store/dist/repositories.js:184`     |   72 |  4.97% |
| (garbage collector)         | `(V8):0`                                      |   67 |  4.62% |
| all ← (anonymous)           | `packages/store/dist/command-snapshots.js:35` |   62 |  4.28% |
| tick                        | `apps/server/dist/dispatch-inactive.js:10`    |   58 |  4.00% |
| project                     | `apps/server/dist/dispatch.js:116`            |   53 |  3.66% |

## 复现

分别编译基线源码和本次源码，使用本次提交中的同一个脚本。脚本第一个参数是待测源码目录，第二个是输出文件前缀，第三个是每种场景的轮数；输出 `.json` 和 `.cpuprofile`，最终删除自己的临时数据库。

```sh
pnpm exec tsc -b packages/store packages/mcp-server apps/server apps/cli
pnpm exec node apps/server/benchmarks/command-state.mjs . /tmp/c131-after 40
# 对已编译的 036ff4f 源码目录运行相同脚本：
pnpm exec node apps/server/benchmarks/command-state.mjs "$C131_BASELINE_DIR" /tmp/c131-before 40
```

## 验证

- `pnpm exec tsc -b packages/store packages/mcp-server apps/server apps/cli`：通过。
- `pnpm --filter @cardigan/domain test:types`：通过。
- `pnpm exec vitest run packages/store packages/mcp-server packages/domain packages/host apps/server apps/cli`：229 文件通过，2930 测试通过，1 项既有 todo；原有测试期望未修改。
- 最后调整增量集合顺序查询后，重跑 `pnpm exec vitest run packages/store/src/command-snapshots.test.ts packages/mcp-server/src/command-state.test.ts apps/server/src/dispatch-state.test.ts`：3 文件、10 项通过。
- `pnpm lint`：通过，5 条基线已有的 e2e 文件警告。`pnpm check:deps`：通过。
- 新增覆盖：项目隔离和 spy 次数、所有消费方共享、跨连接提交与固定读快照、await 后停用阻止派发、写后可见、回滚后版本复用、更新/删除/重插的增量解码、旧库回填与幂等迁移、员工跨项目活动、设置覆盖隔离、慢轮成功/失败日志。

## 限制与上线核对

这是合成数据的本地结果，尚未部署。由张良按本卡验收上线后的空闲 CPU <30%、连续 3 分钟无 >1s 调度慢轮、Workbench /login p95 <100ms。未运行仓库全量测试或独立 e2e 测试套件，仍由合并前主机检查负责。

缓存保留已解码历史，内存随项目数据量增长；每个实体只保留一个最新修订，删除留下主键墓碑，当前没有清理墓碑的周期任务。增量更新仍要读取键顺序并重建集合数组，但不会重新传输或解析整表 JSON。迁移需为已有 Assignment 回填员工贡献；基准不包含迁移耗时。
