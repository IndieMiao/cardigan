# 检查账号下的测试目录

P2a-1a 的检查进程继承 attempt 专属的短 `TMPDIR` / `XDG_RUNTIME_DIR` 别名。
这些目录的祖先由主机控制或供共享组写入，不能当作测试中模拟的“主机独占中心仓库”。

- 两个 Vitest 入口通过 `setup.ts` 给当前 worker 分配一个执行账号独占的真实临时数据目录，权限 0700。普通夹具继续按原来的 `mkdtemp` / `rm` 生命周期工作；不改产品路径校验。
- 这是真实目录，不是在全局临时目录建立短路径别名。父层取系统临时目录的真实路径，避免系统自身的路径别名。
- 真实 hc 夹具通过 `createTestRuntime` 在继承的 `XDG_RUNTIME_DIR` 下分配短、独占、0700 的叶目录；没有继承值时才使用夹具自己的后备目录。core 的环境也指向它，监督进程因此仍能识别 attempt 内的 core/holder。
- `HcCore.finalStop` 或 runtime 包的 `stopCore` 先按已记录 PID 停止并验证 core，再移除自己分配的运行目录。测试中途模拟失联的 `stop()` 不删除目录，仍可重启。
- worker 收尾只删除空的数据根；不会递归删除尚未完成的夹具或 socket。e2e 仍单独运行，不加入普通测试命令。
- 测试 worker 设置 `NODE_DISABLE_COMPILE_CACHE=1`，子进程即使调用 `module.enableCompileCache()` 或继承 `NODE_COMPILE_CACHE` 也不会在私有 TMPDIR 留下 `node-compile-cache`；不改主机环境，不额外递归删除缓存目录。
- 测试入口覆盖继承的 `CARDIGAN_CONFIG_DIR`、`XDG_CONFIG_HOME` 和 `CARDIGAN_DATA_DIR`，分别指向 worker 私有根内的空配置／数据目录（0700），避免默认读取主机的合并闸门、启动凭据或数据库。收尾按子目录到父目录只删除空目录。需要自定义配置的夹具仍显式覆盖；测试默认路径时使用临时或虚构 HOME。
- 不改 worker 的 HOME：真实 hc 测试仍可定位执行账号安装的二进制。若测试给函数传入独立的 `env` 对象，需显式提供配置／数据路径，或把测试进程 HOME 指向临时目录；它不会自动继承 worker 的隔离变量。
- `build-output.ts` 的 `requireBuildOutput` 供依赖构建产物（`dist`）的测试使用（路径相对工作区根；测试文件静态导入构建包时，在 `vi.hoisted` 里调用，才能赶在导入之前执行）：缺产物时直接报出缺哪些文件和构建命令，而不是模块解析错误或超时断言。只读的验证工作区没有可写构建目录（见 C-91），这类测试在那里会明确失败，不跳过。

- `hc.ts` 的 `testHcBinary` 统一五个真实运行时套件的版本探测，兼容版本边界从 `deploy/hc-version.json` 读取；只调用 `--version`，不会启动 core。未设置 `CARDIGAN_REQUIRE_HC=1` 时缺失或版本不符继续跳过真实部分，设置后直接让套件失败。探测优先使用 `CARDIGAN_TEST_HC`，未指定时使用 PATH 上的 hc；检查监督器还须让 PATH 中的 hc 指向同一个二进制，保证探测和子进程执行一致。

- `CARDIGAN_TEST_TMP_ROOT` 仅供检查监督器将测试临时目录限制在获授权的私有工作目录；不设置时保持原有系统临时目录布局。目录必须足够短以满足 Unix socket 长度限制，不改变任何产品配置目录。

## 进程、探针和时间

- 单元测试不要启动真实 CLI、hc、SSH 或机器能力探针；在最后一个 IO 边界注入替身。断言命令参数、目标和调用次数，继续走真实的业务判断；不要直接 mock 被测结果。
- 测并发顺序时，在替身进入、释放或退出时显式通知测试；不要用 sleep 猜任务已经开始。过期、重试、停止调度用固定记录时间或假时钟，测试结束恢复时钟。
- 必须核实操作系统语义（如文件描述符、PTY、锁、独立 Worker 或 hc 协议）时，使用私有临时夹具，明确验证目标、等待上限和清理方式。新增此类测试登记在根 Vitest 的 `processContracts`，不与单元测试抢运行槽；不要用放宽全局时限或跳过用例代替隔离。
- GitHub Actions 的单测和 e2e 各自在结束时打印 `Slowest test cases (up to 20)`，按单条用例耗时（毫秒）排序，保留原有失败注解。排查先看文件和用例名，再判断慢在业务逻辑还是外部 IO；耗时榜不是失败门槛。
