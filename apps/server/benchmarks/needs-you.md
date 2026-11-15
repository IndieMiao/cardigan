# C-319 Needs You 读取优化与验收操作单

孙悟空交付 W-1064。首轮基线为 `ac7187c4a13b1cb9f729db5661f9ff7616a16085`，返工已合入 `f9ab8d815019c9c47885e76d6a349f614bb49df4`；本地提交，不推送。开发方案更新 §6.1、§8.2、§20.2 正文，不修改顶部版本号或计划文件。

## 行为与实现

- Needs You 与主机命令共用 Store 的项目快照和增量行解码。快照只在读事务提交后发布；跨连接写入、全局身份及项目偏好沿用原修订触发器。领域事件按不可变数组建立拍板索引，未变的事件元素保持索引可复用；知会先筛候选再排序。事件索引只加速读取，不授予任何写权限。
- 受影响卡片只推导原有摘要所需的状态，不重复构造完整看板、员工候选和审核矩阵。原状态机、拍板权限、敏感内容和排序不变。大规模响应指纹与未修改基线逐字节相同，包含字段与数组顺序。
- 全局计数与列表继续用同一资源；SSE 更新沿用原 100ms 合并，隐藏时停止 Needs You 新读取，恢复后重读。旧项目、旧更新和隐藏前的响应由资源代次丢弃。显式重试和写后刷新不用旧请求标识。
- 同一已验证会话、项目和更新标识的重叠请求用 Web Locks 和 BroadcastChannel 交接。结果锁保留到已排队消费者收取，防止广播排队慢于锁授予而重复请求；关闭或隐藏发起读取的上下文会释放交接，另一方可接管。没有磁盘存储、完成结果缓存、有效期或新超时。没有浏览器能力时使用原请求。
- 加入共享前访问原会话入口重新验证身份。服务端只为活跃会话返回专用命名摘要，摘要不能作为 Cookie 或 Bearer 凭据使用。每个 Needs You 网络请求仍通过原会话鉴权，读取缓存不进入写入授权路径。既有轮询、重连、重试与业务数值保持不变。

## 本轮返工与对照

已先合入基线 `f9ab8d815019c9c47885e76d6a349f614bb49df4`。本轮统一处理 V-1312 两项及 Q-597 / C-319#44 指令中的跨流共享键缺陷：

1. 启用合并闸门时，只为合并确认读取当前完成申请的检查；不再逐条拍板调用 `cardViews → projectSnapshot`。旧交付只测了默认 disabled，是上一轮遗漏，不能据此证明 enabled 的性能。
2. 增量快照用缓存实体重建旧 SQL 读取器的候选/来源/关联依赖闭包次序，保留来源拍板优先及同阻塞级别、同等待时间的稳定顺序。冻结 ac7187c 原读取器只用于差异测试；覆盖普通库、source→Q-110、关联已关闭卡及项目拍板，disabled/enabled/invalid 均逐字段及逐项比较完整响应。
3. 共享键包含连接就绪代次和按流排序的完整已见序号。A 只见 C-2:100 与 B 已见 C-1:100、C-2:100 时键不同；二者见到相同集合后键相同。ready 重连改变代次。已有项目、会话隔离和显式重试标识继续生效，没有更改轮询、超时或缓存有效期。

## 同环境合成剖析

Node v24.22.2；C-287 `needs-you` 档位、seed 287，固定时钟。主项目 events 42347、timeline 18075、notifications 8729、decisions 590、cards 318、runs 5261，另有单卡项目。四个临时库依次测试：旧交付投影/当前投影 × enabled/disabled。每个库按 cold、warm、after-write、after-event 各采一次单请求 CPU profile，没有并发、压测、空转或人为延迟；生成和一次写入不计时，不同时运行自己的测试或浏览器。计时仅为同步源状态读取与完整领域/Web 投影，不含鉴权、HTTP 和 JSON 序列化。单样本不称为平均值或 p95。

旧交付参照通过只读 `git show 200d82fb...` 转译当时的 needs-state/read 两个模块，公共依赖采用当前合入基线，因此比较隔离的是本轮读取/Web 优化，不是运行完整旧版二进制。旧完整 ac7187c 初轮 ≥0.5秒复现证据仍见 attachment-2587。本轮 profile 的引用模块 URL 替换为固定名称，不导出 data URL 中的内嵌源码/环境路径。

合成目标仍为两种配置的热读及实体变更后各低于75ms，追加事件后低于100ms；这是测量目标，不是运行时门槛或生产 SLA。首次冷读单列，不满足热读目标。

| 闸门 | 条件 | 旧交付参照 ms | 本轮 ms |
|---|---|---:|---:|
| enabled | cold | 457.35 | 310.28 |
| enabled | warm | 240.29 | 68.22 |
| enabled | after-write | 236.82 | 59.53 |
| enabled | after-event | 248.26 | 87.18 |
| disabled | cold | 295.59 | 308.20 |
| disabled | warm | 54.93 | 46.73 |
| disabled | after-write | 57.27 | 49.53 |
| disabled | after-event | 85.48 | 69.76 |

启用闸门的热读从240.29ms降至68.22ms，实体变更后59.53ms，追加事件后87.18ms。关闭闸门对应46.73/49.53/69.76ms。两种配置首次冷读均约308～310ms，仍需解码历史。旧 enabled profile 的重复卡片投影是本轮消除的热点，完整16份 profile 和测量JSON随新交付附件，不将合成结果预报为生产改善。

两种配置的旧参照/当前完整响应 SHA-256 各自相同（含字段与数组顺序）：

- disabled：`94e71388811fd10e5a618c03f0113874a900d1285560f68d8461348abea8fe5d`
- enabled：`b950ef7b5e6fb8aef32fe86f938c8a5bd8a6915024ef50707fe1d987245685c0`

复现（输出前缀位于调用方自己的临时目录）：

```sh
pnpm exec tsc -b apps/server apps/web apps/cli
pnpm exec node apps/server/benchmarks/needs-you.mjs . "$C319_OUTPUT_PREFIX-enabled" enabled current
pnpm exec node apps/server/benchmarks/needs-you.mjs . "$C319_OUTPUT_PREFIX-disabled" disabled current
# 对照旧交付读取/Web模块；需要本地Git历史，无网络操作：
pnpm exec node apps/server/benchmarks/needs-you.mjs . "$C319_OUTPUT_PREFIX-previous-enabled" enabled previous
pnpm exec node apps/server/benchmarks/needs-you.mjs . "$C319_OUTPUT_PREFIX-previous-disabled" disabled previous
```

## 软件与浏览器验证

本轮先跑22个定向文件385项通过，再补敏感夹具及对照断言（needs-state/synthetic-fixture两文件11项通过，含复跑）；不将重跑重复计数为新测试。具体范围：

- domain：event-index、decision-followup-index、decision-suggestion、readiness、delegation、merge-delegation、合入基线的system-review-limit七个合同；`pnpm --filter @cardigan/domain test:types`通过。
- server：needs-state、read、pagination、merge-gate、notices、sensitive、decision-suggestion、decision-wait、delegation及合成生成器。新增enabled原响应指纹、冻结旧读取器整份对照、来源排序/关联闭包/项目拍板回归及可选敏感待办的项目隔离。
- Web：useProjectStream、shared-read、App、m5-views、RefreshLayout、operations。新增跨流不同批次完整版本键、同版本合并、较旧事件不回退、ready重连与切项目回归。所有Vitest命令均列具体文件并使用`--maxWorkers=1`，不跑全仓/E2E。
- `pnpm exec tsc -b apps/server apps/web apps/cli`、Web构建、check:deps、改动代码Biome及Git差异检查通过；Markdown按差异人工核对。

真实Chromium受控回归：给`CHROMIUM_PATH`指定已有浏览器，运行`pnpm exec node apps/web/test-support/needs-you-race.mjs`。该脚本只起Vite与临时合成SQLite投影，不起调度/合并循环；使用实际App、HttpCardiganClient、原生Web Locks/BroadcastChannel和两个同源上下文。SSE回调及一个已经计算好的旧响应由测试门闩控制，这是确定性并发测试，不是性能采样或生产观测。

复现顺序与孙权反例一致：A见C-2:100后持住212项旧响应；合成库新增Q-90001；B批次见[C-1:100,C-2:100]；A再见C-1:100；两页新请求完成后放回旧响应。结果：A/B均保留新增拍板，decisions均213，页面计数均214，所有锁排空。随后两方ready重连，键的代次变为1，仍读到213项；浏览器异常0。原`needs-you-sharing.mjs`可继续独立核对隐藏/退出接管、共享/隔离和结果不保留。该证据不替代W-1067/W-1068对新SHA的正式Review或全部视口/主题截图。

敏感展示夹具：生成命令加`--sensitive-needs`，或`generateFixture({..., sensitiveNeeds:true})`；新待办Q-90002指向敏感卡C-14，events/decisions各比原档位增加1，manifest标明编号。默认不加，原指纹不变。对应测试证明human项目视图含待办、空项目不含敏感文本；不能由此宣称所有权限负向场景均已覆盖。

## 当前 SHA 界面验收操作单

1. 验收方检出本交付完整 SHA，按上文构建；参考 `docs/synthetic-ui-fixtures.md`，使用 `--profile needs-you --seed 287 --sensitive-needs` 生成新目录并核对 manifest 的六类规模。只访问自己的合成实例，不读取生产数据。
2. 用已有 `fixture:web` 入口核对 1440×900 与 390×844、亮暗主题下的列表和导航计数、排序、空态、等待态、展开、返回、焦点及错误重试。该预览入口拒绝写操作，不能将 405 当作拍板/状态保存测试通过。
3. 在验收方隔离的可写合成实例中操作现有拍板和人工待办，观察创建、变更、解决、失效、敏感标记及项目偏好更新后的 SSE、计数与列表；同时打开同会话同项目的两个页面，记录 `/api/session` 与 `/needs-you` 网络请求，区分轻量会话验证和全量列表读取。跨标签仅合并真正重叠且更新标识相同的请求，依次打开页面仍会各读一次。
4. 隐藏其中一个页面并产生多次更新，应不再发起新的 Needs You 读取；恢复后只取最新状态，旧响应不得覆盖。切换项目、退出并重新登录，不能出现旧上下文内容；关闭或隐藏发起读取的页面，另一方继续更新。先运行上述独立协议脚本可快速检查锁/广播能力，再记录完整 Workbench 行为与截图。
5. Review 绑定当前交付及 SHA、截图附件和网络记录；完整界面验收仍由 W-1068 执行，不用作者组件测试代替。代码审核和独立权限复核分别绑定 W-1065、W-1067。

## 合并部署后交张良的复测操作单

1. 按既有授权部署通过合并检查的基线，记录实际部署 SHA、观察窗口和开着的 Workbench 标签页数量；由现场操作员执行，不让开发 Agent 读取生产库或配置。
2. 在与开卡观察相近的实际使用条件下，用现有接口耗时观测与进程监控记录 Needs You 请求数量、平均/最大耗时和 server CPU；另记录重启后的首次冷读。不要通过并发请求或空转制造负载。
3. 核对普通读、拍板后刷新、隐藏/恢复和同项目多标签请求数；将部署前已有观察值与部署后同口径结果回帖到 C-319。若口径或标签页数量不同，写清差异，不能直接宣称同比改善。

现场生产复测和独立界面 Review 尚未执行，保留为交付后的必需验证。缓存会保留已解码的历史源数据；冷启动、源数组比较和事件索引重建仍有随数据量增长的成本。本卡消除了主要的重复解码、全历史排序和嵌套重复投影，不承诺任意数据量下固定耗时；不新增后台线程或进程（C-248 单独处理）。
