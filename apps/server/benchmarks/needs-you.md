# C-319 Needs You 读取优化与验收操作单

孙悟空交付 W-1064。基线为 `ac7187c4a13b1cb9f729db5661f9ff7616a16085`；本地提交，不推送。开发方案更新 §6.1、§8.2、§20.2 正文，不修改顶部版本号或计划文件。

## 行为与实现

- Needs You 与主机命令共用 Store 的项目快照和增量行解码。快照只在读事务提交后发布；跨连接写入、全局身份及项目偏好沿用原修订触发器。领域事件按不可变数组建立拍板索引，未变的事件元素保持索引可复用；知会先筛候选再排序。事件索引只加速读取，不授予任何写权限。
- 受影响卡片只推导原有摘要所需的状态，不重复构造完整看板、员工候选和审核矩阵。原状态机、拍板权限、敏感内容和排序不变。大规模响应指纹与未修改基线逐字节相同，包含字段与数组顺序。
- 全局计数与列表继续用同一资源；SSE 更新沿用原 100ms 合并，隐藏时停止 Needs You 新读取，恢复后重读。旧项目、旧更新和隐藏前的响应由资源代次丢弃。显式重试和写后刷新不用旧请求标识。
- 同一已验证会话、项目和更新标识的重叠请求用 Web Locks 和 BroadcastChannel 交接。结果锁保留到已排队消费者收取，防止广播排队慢于锁授予而重复请求；关闭或隐藏发起读取的上下文会释放交接，另一方可接管。没有磁盘存储、完成结果缓存、有效期或新超时。没有浏览器能力时使用原请求。
- 加入共享前访问原会话入口重新验证身份。服务端只为活跃会话返回专用命名摘要，摘要不能作为 Cookie 或 Bearer 凭据使用。每个 Needs You 网络请求仍通过原会话鉴权，读取缓存不进入写入授权路径。既有轮询、重连、重试与业务数值保持不变。

## 同环境合成剖析

Node v24.22.2；独立临时 SQLite 数据库，C-287 生成器的 `needs-you` 档位、seed 287，固定时钟。主项目实际规模：events 42347、timeline 18075、notifications 8729、decisions 590、cards 318、runs 5261；另有一个单卡项目。通知是已处理的合成记录。每种条件只执行一次读取并独立采集 CPU profile，没有压测、并发轰击、空转或人为延迟。数据生成及一次写入均在计时/采样区间外；库和服务关闭后删除自己的临时目录。基线与当前版本依次在同一主机运行，未同时运行自己的测试。

计时范围为同步源状态读取和完整 Needs You 领域/Web 投影，**不包含 HTTP 传输、鉴权和 JSON 序列化**。本卡测量目标：热读和一次实体变更后各低于 75ms；追加事件导致索引重建时低于 100ms。这是合成验收目标，不是运行时数值规则或生产 SLA。冷启动不满足热读目标，单列如下；不能用三次单样本冒充平均值或 p95。

| 条件 | 基线投影总耗时 ms | 当前投影总耗时 ms | 当前源状态读取 ms |
|---|---:|---:|---:|
| 首次冷读 | 653.49 | 309.94 | 211.148 |
| 无变更热读 | 652.73 | 58.53 | 0.217 |
| 一次拍板实体变更后 | 598.40 | 59.79 | 3.415 |
| 追加一个项目事件后 | 未采集 | 85.51 | 1.593 |

基线源状态每次约 135～157ms；当前热读源状态 0.217ms，一次实体变更后 3.415ms。冷读从 653.49ms 降至 309.94ms，仍需要一次历史解码和建索引。热读从 652.73ms 降至 58.53ms，单次实体变更后从 598.40ms 降至 59.79ms；追加一个项目事件后为 85.51ms，该条件只在当前版本新增采集。

基线 profile 的主要自耗时来自 `notices` 对全部事件排序（约 76～86 个采样）、`decisionActionView` 对所有事件反复 filter/findLast（相关位置约 116 个采样）、`CommandDraft.list` 与 `projectSnapshot` 重复构造，以及 `readDocs` 查询/解码。优化后不再反复解码未变历史或为每个影响卡片完整投影看板；当前冷读主要是首次 Store 解码，热读主要是当前拍板/Web 展示，追加事件会重建不可变数组索引。完整 CPU profile 与采样点位置见本交付附件，比例只表示各自采样占比。

原基线与当前的完整响应 SHA-256 均为：

`94e71388811fd10e5a618c03f0113874a900d1285560f68d8461348abea8fe5d`

新增事件条件只追加无业务语义的合成项目事件；响应仍完全相同。真实变更、解决、撤回、偏好、身份和敏感标记在定向合同/临时库测试中单独覆盖，不能从这个指纹推断任意输入都等价。

复现当前版本：

```sh
pnpm exec tsc -b apps/server apps/web apps/cli
pnpm exec node apps/server/benchmarks/needs-you.mjs . "$C319_OUTPUT_PREFIX"
```

输出前缀由调用方指定到自己的临时目录。脚本只创建新临时库，不发现生产配置；输出 JSON、响应和四份去除环境绝对路径的 `.cpuprofile`。基线证据为在修改实现前使用相同前三种条件采集的结果，附件保留原始值。

## 软件验证

定向测试累计 23 个不同文件、334 项通过（按最终通过结果去重；调试重跑不重复计数）。不运行全仓或 E2E。

- `pnpm --filter @cardigan/domain test:types`：通过。
- `pnpm exec vitest run packages/domain/src/commands/event-index.contract.test.ts packages/domain/src/commands/decision-followup-index.contract.test.ts packages/domain/src/commands/decision-suggestion.contract.test.ts packages/domain/src/commands/readiness.contract.test.ts packages/domain/src/commands/delegation.contract.test.ts packages/domain/src/commands/merge-delegation.contract.test.ts apps/server/src/synthetic-fixture.test.ts`：7 文件、166 项通过。
- `pnpm exec vitest run apps/server/src/web/pagination.test.ts apps/server/src/web/read.test.ts apps/server/src/web/notices.test.ts apps/server/src/web/sensitive.test.ts apps/server/src/web/decision-suggestion.test.ts apps/server/src/web/decision-wait.test.ts apps/server/src/web/delegation.test.ts apps/server/src/web/merge-gate.test.ts apps/web/src/App.test.tsx apps/web/src/m5-views.acceptance.test.tsx apps/web/src/views/RefreshLayout.test.tsx apps/web/src/operations.test.tsx`：12 文件、124 项通过。
- `pnpm exec vitest run apps/server/src/web/security.acceptance.test.ts apps/server/src/web/server.test.ts`：2 文件、37 项通过，覆盖会话入口兼容和权限边界。
- `pnpm exec vitest run apps/server/src/web/needs-state.test.ts apps/web/src/shared-read.test.ts`：2 文件、7 项通过。覆盖大库基线指纹、跨连接、回滚、全局身份、偏好、敏感标记、新增/失效拍板、事件追加与重启，以及隐藏/恢复、旧响应丢弃、项目/会话隔离、排队失败重试与能力降级。
- `pnpm exec tsc -b apps/server apps/web apps/cli`、Web 构建、`pnpm check:deps`、改动代码的 Biome 检查和 `git diff --check`：通过。Markdown 不在当前 Biome 支持范围内，按差异检查与人工核对。

真实 Chromium 协议验证：给 `CHROMIUM_PATH` 指定现场已有浏览器，然后执行 `pnpm exec node apps/web/test-support/needs-you-sharing.mjs`。脚本只启动临时静态服务器，两个同源浏览器上下文的结果：重叠请求 1 次，不同更新请求 2 次，后续新读 1 次，发起方退出和隐藏后均可接管，浏览器异常为 0。这个证据验证共享协议，**不是完整 Workbench 的双标签截图或生产复测**。

## 当前 SHA 界面验收操作单

1. 验收方检出本交付完整 SHA，按上文构建；参考 `docs/synthetic-ui-fixtures.md`，使用 `--profile needs-you --seed 287` 生成新目录并核对 manifest 的六类规模。只访问自己的合成实例，不读取生产数据。
2. 用已有 `fixture:web` 入口核对 1440×900 与 390×844、亮暗主题下的列表和导航计数、排序、空态、等待态、展开、返回、焦点及错误重试。该预览入口拒绝写操作，不能将 405 当作拍板/状态保存测试通过。
3. 在验收方隔离的可写合成实例中操作现有拍板和人工待办，观察创建、变更、解决、失效、敏感标记及项目偏好更新后的 SSE、计数与列表；同时打开同会话同项目的两个页面，记录 `/api/session` 与 `/needs-you` 网络请求，区分轻量会话验证和全量列表读取。跨标签仅合并真正重叠且更新标识相同的请求，依次打开页面仍会各读一次。
4. 隐藏其中一个页面并产生多次更新，应不再发起新的 Needs You 读取；恢复后只取最新状态，旧响应不得覆盖。切换项目、退出并重新登录，不能出现旧上下文内容；关闭或隐藏发起读取的页面，另一方继续更新。先运行上述独立协议脚本可快速检查锁/广播能力，再记录完整 Workbench 行为与截图。
5. Review 绑定当前交付及 SHA、截图附件和网络记录；完整界面验收仍由 W-1068 执行，不用作者组件测试代替。代码审核和独立权限复核分别绑定 W-1065、W-1067。

## 合并部署后交张良的复测操作单

1. 按既有授权部署通过合并检查的基线，记录实际部署 SHA、观察窗口和开着的 Workbench 标签页数量；由现场操作员执行，不让开发 Agent 读取生产库或配置。
2. 在与开卡观察相近的实际使用条件下，用现有接口耗时观测与进程监控记录 Needs You 请求数量、平均/最大耗时和 server CPU；另记录重启后的首次冷读。不要通过并发请求或空转制造负载。
3. 核对普通读、拍板后刷新、隐藏/恢复和同项目多标签请求数；将部署前已有观察值与部署后同口径结果回帖到 C-319。若口径或标签页数量不同，写清差异，不能直接宣称同比改善。

现场生产复测和独立界面 Review 尚未执行，保留为交付后的必需验证。缓存会保留已解码的历史源数据；冷启动、源数组比较和事件索引重建仍有随数据量增长的成本。本卡消除了主要的重复解码、全历史排序和嵌套重复投影，不承诺任意数据量下固定耗时；不新增后台线程或进程（C-248 单独处理）。
