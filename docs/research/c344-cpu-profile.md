# C-344 按需 CPU 录制开销对照

赵云；测试代码提交为 `d84e925182bdc8864b075c41249e83c0baf97085`，已合入基线 `b4d1e1b90f4f1f953839f130a85c48d37c53a66e`。后续提交仅补本报告，产品代码相同。依据为人正式批准的 Q-646：默认 60 秒、1000 微秒采样，最长 120 秒，满额拒绝且不自动删旧证据。没有读取生产库、主机真实配置或私有 profile，没有操作生产；软件交付与张良上线后的采集验收分开。

## 数据来源与方法

复用 C-339 的 `background-profile.mjs`／C-287 合成场景生成器，固定种子339：350张卡、1050个工作项、1053个Assignment、5500个Run、55000条事件、18075条时间线、590个拍板；另有5500条已结算投递记录。Run 为 completed 4495、failed 1001，queued／dispatched／acked／running各1；Assignment为active 794、released 207、suspended 52。活动展示夹具不是生产完整命令历史；启动和状态语义由定向测试另外覆盖。

两个初始事件摘要均为 `842a09e77c5b07b9f38732a22017879f0ea5cf10639a88b7b46cdb02984a5fe7`。假Runtime无hc、SSH、Git网络和真实Agent；路由游标推进历史，先预热一轮，再测名义60秒。每轮正常Dispatcher完成后等1秒，不提频、不追赶、不空转或制造负载。顺序先off再on，没有并行运行本工作项其它测试或采样进程，worker未扩容。Node 24.22.2、pnpm 11.7.0。

两次都装配真实主机私有控制器并在原tick前同步；on由主机CLI共用的请求函数提交60秒／1000微秒请求，不直接调用Session。隔离实验的release身份用40个零标记合成材料，不能当作生产release证据。进程CPU取`process.cpuUsage`，事件循环p99用10ms分辨率监测；窗口包含stop和完整安全落盘。原C-339不带on/off参数时仍沿其直接inspector实验路径。

在同一提交构建后，用两个全新私有输出目录复现；以下路径仅为临时目录示例，不是生产配置：

```sh
pnpm exec tsc -b apps/server apps/cli packages/router
pnpm --filter @cardigan/server exec node test-support/background-profile.mjs /tmp/c344-example-off off
pnpm --filter @cardigan/server exec node test-support/background-profile.mjs /tmp/c344-example-on on
```

输出目录必须尚不存在，工具以0700创建；窗口结果为0600的`window.json`，profile只在实验私有目录内，不上传或提交。两份目录的数据库为独立合成副本，不共享生产库。

## 实测

| 指标 | off | on（1000微秒） |
|---|---:|---:|
| 墙钟窗口 | 60001.007 ms | 60105.425 ms |
| 进程user CPU | 4.835928 s | 6.871937 s |
| 进程system CPU | 0.138835 s | 0.915022 s |
| 合计CPU | 4.974763 s | 7.786959 s |
| 单核CPU占比 | 8.2911% | 12.9555% |
| event_loop p99 | 12.902399 ms | 73.334783 ms |
| 正常tick数 | 56 | 56 |
| 完整profile数 | 0 | 1 |

开启后该样本CPU增加4.6644个百分点，p99增加60.432384ms；不能说开销可忽略。两侧都完成56轮，录制在有限的诊断窗口内取得完整制品，但延迟代价须由评审结合短时取证用途判断。这里只测了一组顺序窗口，宿主其它工作的影响未隔离，p99也会受10ms计时分辨率和约1%阻塞样本阈值影响；这不是生产容量或延迟保证，不能据此制定新的自动录制／调度阈值。未更改已拍默认值来掩盖开销，也未把热点优化并入本卡。

on制品606400字节、442个节点、56114个样本，inspector时间范围约60085.765ms。目录0700，制品0600、单硬链接、JSON完整可读；超过名义60秒的少量延迟符合事件循环／stop并非硬实时的边界。制品SHA256为 `1b63f4b956937c00e50956a901fafc02a50198f66e2ea6421472e41adc58bfe6`，仅用于标识本次合成证据，不附原文。off窗口JSON摘要 `8a3cec526d06ab4def369e3ab03df0fe560f91a29b9c77e21a9d7a4eed70953f`；on为 `11f26c9b09d1527407abdeb82450d9db2d4c847bf5cdb4414536a53f8dd4b95f`。

## 定向验证与界限

合入上述最新基线后，构建 `pnpm exec tsc -b apps/server apps/cli packages/router` 通过；下列11个定向文件共127项通过，均用`--maxWorkers=1`：host的`cpu-profile-recorder`、`cpu-profile-control`、`cpu-profile-files`、`cpu-profile-process`；CLI的`cpu-profile`、`preference`；server的`cpu-profile`、`tick-profile-switch`、`tick-profile`、`process-roles`、`shutdown`。依赖检查通过（869模块、3995依赖），新增／改动代码的Biome与`git diff --check`通过。domain未修改，不涉及其类型契约检查；没有跑全量或E2E。

覆盖Token身份拒绝、精确目标与重放、双角色原子请求、Web／后台装配、互斥含清理、链接／目录／锁替换、配额、磁盘满部分写入后只清理本次临时文件、真实子进程SIGKILL后旧代次失效和新采集SIGTERM完整落盘；同时核直接调用方原行为。实际SIGKILL测试落在采样阶段，未知临时残留用独立文件夹具验证拒绝且保留，磁盘满用定向ENOSPC故障注入，不把这些称为对任意机器崩溃／文件系统掉电的穷尽证明。

生产热点前十对照仍须正式合入、部署ready、操作单受审后由张良执行，并观察真实CPU和响应延迟。C-339#64的原临时profile为547秒／428052样本，self／inclusive不能混加；墙钟span含await和嵌套，不能与CPU秒相减证明未覆盖比例。Profile可含动态脚本名／函数名及路径，任何外传必须人工检查；本报告不含生产制品。
