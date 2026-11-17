# C-374：GitHub 检查共享依赖缓存信任边界调查

作者：赵云。调查日期：2026-11-17。对应工作项：W-1285。

固定源码基线：`2f1eb2ca46333ad7b83ebb6519ed44759c1926e1`。本次修订先将该基线合入工作分支，无冲突；下列被引 workflow、host 源文件和 package.json 与首版调查基线 `900d8763fbc407cbbe99183d2fd70158ea409137` 字节一致，原行号仍适用。本报告只交付调查结果和待选方案，不修改执行器、工作流、安装命令、权限或生产配置，不新建任务计划。

## 结论与证据等级

**共享缓存是仍需处理的条件性信任风险；本次没有证明真实跨候选投毒或门禁绕过。** 源码证实：检查从基线分支派发，在同一 job 执行候选；检查恢复与 main 预热任务保存的缓存采用相同键规则。独立的候选 Git ref 并没有让检查取得独立的缓存作用域。`actions/cache/restore` 只限制这个 action 的行为，不能单凭它证明整个 job 没有缓存写能力。

公开 GitHub 文档现已明确提供服务端缓存权限 `cache-mode`；`workflow_dispatch` 在未设置该字段时属于默认可写类型，本基线没有设置它。**已识别的具体身份通道是候选执行之后的 JavaScript action 后置步骤**：若候选能写其本地入口，后置步骤会以获注入运行时身份的环境执行被改入口。shell 不直接继承 token 不能阻断这条链。源码与公开机制支持该可复现条件；实际 action 目录写权限、后置步骤执行和缓存写权限仍未现场验证。

**不可变性保护的是首个条目，不认证首个写者。** 它阻止同键同版本原地替换已存在的良性条目；若候选借新锁文件在 main 预热之前首建条目，它也会保留这个不可信首写，预热任务精确命中后不会覆盖修复。作用域和版本匹配仍是必要条件。pnpm 的逐文件完整性检查可以发现与索引不符的内容，但索引也来自恢复的 store，不能把它直接视为来自原始 tarball 的独立认证。

| 环节 | 已核事实 | 尚不能据此断言的内容 |
| --- | --- | --- |
| 派发作用域 | host 上传 `ci/<card>/<delivery>/<attempt>`，随后向 `context.baselineBranch` dispatch；平台文档以接收 dispatch 的分支作为 `GITHUB_REF` | 当前私有执行器配置、实际运行的 ref/runner 版本；本次没有查现场 |
| 缓存生产与恢复 | `cache-warm.yml` 的 main push 保存 store；检查恢复 store；两者键表达式相同 | 某个具体缓存已存在、它来自哪个 run、实际命中哪条条目 |
| 候选执行 | 固定 SHA/tree 检出校验后，安装、构建和测试在同一 job 中执行候选文件 | 校验 Git 对象不等于认证从外部恢复的依赖内容 |
| 缓存写身份 | 本工作流具有候选执行后的 post 步骤；已核 runner 在选择 main/pre/post 入口前注入运行时身份，再加载本地入口。候选可写入口时构成具体间接通道 | 真实 runner 的 action 目录权限、post 实际运行及有效缓存写权未核；不声称 shell 直接继承 token |
| 新键首写 | 检查早于该锁文件变更合入 main；main push 预热无法先为这一变更建缓存。全新键在没有其它先写者时，可被有写身份的候选首建 | 任意锁文件变更不保证键从未出现，也不保证赢过其它候选；实际首写与消费未复现 |
| 后续消费 | 相同仓库/ref、键和版本可跨 workflow/run 恢复；pnpm store 命中可直接返回文件，不重新下载 tarball | 未复现篡改索引被当前安装接受，也未观察跨卡执行或检查结论变化 |
| 门禁 | host 从绑定 run/job 的步骤结论计算检查结果 | 平台步骤成功不为依赖来源作认证；缓存被消费也不必然导致错误通过 |

## 固定基线的源码链

| 证据 | 位置与行为 |
| --- | --- |
| S1 派发 | `packages/host/src/github-check-executor.ts:219–250`：主机取得自身 App token、推送候选 ref、以基线分支发起 dispatch。`packages/host/src/github-client.ts:251–260`：发送 `{ ref, inputs }`。候选 ref 供 checkout 使用，不是 dispatch ref。 |
| S2 身份验证 | `github-check-executor.ts:389–418`：核 workflow 路径、事件、基线分支、App actor、run attempt、URL、时间和基线祖先。它认证运行绑定，不认证 cache archive。 |
| S3 候选与安装 | `.github/workflows/cardigan-check.yml:37–104`：`contents: read`，Ubuntu runner，checkout `inputs.sha`，`persist-credentials: false`，验证 HEAD/tree，Node 24，Corepack，候选上下文中定位 pnpm store，恢复后 `pnpm install --frozen-lockfile`。`140–167` 继续执行 build/test/lint/deps/e2e。 |
| S4 键与消费者 | `cardigan-check.yml:94–104`：path 来自 `pnpm store path --silent`，key 为 `pnpm-${runner.os}-${runner.arch}-${hashFiles('pnpm-lock.yaml')}`；没有 `restore-keys`、没有显式 save。`package.json:6` 固定 `pnpm@11.7.0`。 |
| S5 正常缓存写者 | `.github/workflows/cache-warm.yml:2–26`：main push，同为 Ubuntu/Node 24/Corepack，按同一 store 定位方式及键表达式使用完整 `actions/cache`，随后 frozen install。完整 action 与 restore-only 的区别是具有保存阶段。 |
| S6 门禁消费 | `packages/host/src/github-check-poller.ts:14–38,389–469`：严格核已知步骤及 run/job，映射六项检查，整体与步骤成功才通过，允许已批准 docs-only 跳过。未核缓存来源或 store 内容摘要。 |
| S7 后置步骤 | `github-check-poller.ts:404–406` 明确接受候选步骤结束后的 `Post Setup Node`、`Post Checkout candidate`；固定基线的两份 `packages/host/src/__fixtures__/github-jobs-*.json.fixture` 也记录这两个步骤（编号 29、30）。这是既有合同/历史样本证据，不代表本次调查做了平台实验。 |

两份 workflow 都固定 `actions/cache` 到 `0057852bfaa89a56745cba8c7296529d2fc39830`（该 action 的 package.json 为 4.3.0）。其 `src/restoreImpl.ts:32–51` 调用 restore；`src/saveImpl.ts:46–69` 在已有精确命中时不保存，否则调用 save。这证明原工作流没有安排候选 save 步骤，**不是进程之间的权限隔离证明**。

正常检查的可执行输入不只限于安装生命周期脚本：`package.json` 的构建/检查命令和测试本来就执行候选代码。即使某一 pnpm 版本默认拒绝部分依赖构建脚本，也不足以排除后续候选执行阶段。恢复之前的 `Enable corepack` / `Locate pnpm store` 已处于候选目录：Corepack 按候选 package.json 的 packageManager 选择工具，`pnpm store path` 受该工具版本及其支持的候选配置影响（如 .npmrc / pnpm-workspace.yaml）。因此执行和 path 控制面早于 restore，版本中的 path 不是独立可信输入；具体配置项应按选定 pnpm 版本核对。

锁文件相同而源文件、测试不同的两张卡可得到相同缓存 key。改变锁文件会改变键的哈希部分；风险包括预先计算并首建新键，随后等待其它运行使用同一新锁文件，而不需要让不同键互相命中。具体时序见下文。

## 平台身份、命中与阻断条件

### 三种身份不能混为一谈

1. **主机 App token**：`github-client.ts:154–165` 为推送/派发申请指定仓库的 actions、contents、workflows write 及 metadata read。它在主机使用，dispatch inputs 没有传它；不能假设候选拥有这个 token。
2. **作业的 GITHUB_TOKEN**：工作流设置 `contents: read`，checkout 不持久保存凭据。它限制仓库 API 权限，不能替代独立缓存服务的访问规则。
3. **缓存/运行时身份**：公开 runner `v2.329.0` 的 `NodeScriptActionHandler.cs:54–78` 向 JavaScript action 设置运行时 token、缓存/结果服务地址；`80–104` 随后按 main/pre/post 选择入口，在 post 阶段读取 `Data.Post`，拼接 `ActionDirectory` 后执行。注入不只发生于 main 阶段。相同版本 `ScriptHandler.cs:288–335` 没有同样注入缓存 token，当前公开文档也说明 `ACTIONS_CACHE_MODE` 不直接暴露给 `run`；这只说明直接环境继承有区别，不能用来排除后置步骤的间接身份通道。

当前公开 toolkit 的 `cacheHttpClient.ts:66–72` 用运行时 token 建认证客户端；`cacheUtils.ts:136–166` 计算版本并读取运行时 token。这是公开协议实现的辅助证据，不是对本次真实运行环境或固定 action 内所有依赖版本的逐字节证明。

### 可复现条件一：本地 action 入口到 post 身份

链路是“候选代码先执行 → 改变 runner 本地 action 的后置入口 → post 从该入口加载 → 在 post 环境使用运行时缓存身份”。不要求候选 shell 直接获得 token，也不要求修改仓库内固定的 workflow/action 提交。只有步骤名称和 action 下载时的固定版本，不能证明其本地入口在运行前仍未被修改；S6 的步骤名核对不会认证入口字节。

成立前提必须一起满足：候选能写 `ActionDirectory` 中实际 post 入口（通常位于 runner 的 `_actions` 目录）；候选与 post 在同一 job 的可互写权限边界内；post 在候选执行之后确实运行并加载该入口；运行时身份仍有效且服务端允许对目标作用域写缓存。官方托管 runner 文档 P7 明确 Linux/macOS VM 提供免密 sudo，因此不能把按步骤分开或文件归属本身当作隔离保证。本次未运行 sudo、未查看实际 runner 权限，也未改写入口、读取 token 或调用缓存服务。此项是已具体化的可复现条件，尚非本项目现场漏洞实证。

### 逐步判定

| 条件/阻断点 | 对本仓库的含义 |
| --- | --- |
| 仓库与 ref 作用域 | GitHub 允许当前分支及默认分支缓存被恢复；父分支不能任意恢复子/兄弟分支缓存。若检查真的以独立候选分支运行，候选写入该分支的缓存不会反向进入 main。当前 S1 从基线 dispatch，不能援引这一阻断。配置基线非 main 时应重新核当前分支与默认分支回退关系。 |
| 服务端允许写入 | 公开文档列 `workflow_dispatch` 与 `push` 为可信触发类型，未设 `cache-mode` 默认 write。源码没有显式 read/none；`contents: read` 或 restore-only 不能单独证明不可写。平台实际强制规则、版本适用性仍未现场核实。 |
| 候选能用到写身份 | 后置入口改写是具体间接通道：S7 与 P4 的 post 分支给出顺序和身份机制；可写本地入口、同 job 权限边界、post 执行和有效写权是待核现场条件。shell 不注入 token 不是这一链路的阻断。不得读取或展示真实 token 补证。 |
| 键和版本一致 | 相同 key 还须匹配版本；版本包含 path、压缩方法等元数据。相同 OS/架构和锁文件仍不自动保证 store path、工具版本/压缩方式相同。版本失配会 miss；这些元数据也不是秘密或作者签名，不能把失配当持久隔离机制。 |
| 已有精确条目 | 仅在首写已可信时，不可变性才保护良性内容免受同键同版本替换。候选首建的条目也不可变，main 预热精确命中后跳过保存，不能修复或证明它可信。首写来源因此是边界的一部分；没有证明候选能删除条目，也没有做删除。 |
| 新锁文件与空缺窗口 | 检查发生在该变更合入 main 之前，main push 预热在其后，形成可预先计算的新键首写机会；全新且无更早写者的 key/version 不依赖等待旧条目淘汰。其余空缺还可能来自正常淘汰。多候选先写竞争和历史重复键仍须区分，不宣称任意改锁文件必然赢得首写。不得造负载或人为淘汰。 |
| 前缀回退 | 当前 GitHub 文档的匹配顺序还包含 primary key 的 prefix-match，再尝试 restore-keys 和默认分支；没有显式 restore-keys 不等于绝不前缀命中。精确命中优先，具体固定 action/服务实现的边界需隔离验证，不能据此宣称绕过不可变性已成立。 |
| 后续解包和安装 | 还需证明条目被恢复到实际使用的 store，并通过 pnpm 版本/索引格式、manifest、逐文件校验，最终文件被导入和使用。只看到 cache hit 不等于已污染 node_modules。 |
| 门禁影响 | 必须再观察受影响依赖进入检查路径，导致检查结论与独立干净对照不同。拒绝安装、普通失败、恶意文件未执行和错误通过分别记录，不合并成“绕过”。本次均未执行验证。 |

GitHub 文档同时使用了“create or overwrite”的权限说明和“cannot change the contents of an existing cache”的存储说明。本报告不据前者推导任意替换能力；不可变性约束后写者，也会保留不可信首写，不能用它整体排除污染链。

### 可复现条件二：新锁文件首写到后续消费

1. main 当前使用锁文件 L；候选引入此前未用的新锁文件 L'，据其哈希预先得到 K'。在目标 ref/version 下尚无更早条目，是“空键”的明确前提。回退到历史锁文件、其它候选已运行相同 L' 或并发先写，都会使“改了锁文件所以必为空”不成立。
2. 该变更的预检/合并检查在合入 main 前，从基线分支派发并 checkout 候选 L'。main push 的预热无法早于这次合入为此变更生产 K'；若候选通过上述身份通道先成功保存 K'，该条目成为首写。保存是否成功、版本是否一致仍是必须观察的结果，不能只凭可计算 key 推定。
3. L' 合入并推送 main 后，预热运行也计算 K'。若精确命中此前候选首建的同版本条目，完整 actions/cache 恢复它；P3 的 saveImpl 精确命中分支跳过保存。即使该次安装在本地修复了损坏内容，跳过 save 也不会据此更新共享归档。
4. 之后使用同一 L'、相同作用域及版本的其它候选可恢复这个首写条目。缓存内容不在 Git diff 内，普通源码/锁文件审核无法直接认证其来源；只有恢复后实际导入和执行证据才能继续证明安装或门禁影响。
5. 条目不可变会保留上述首写，直至被实际淘汰或经授权处置。P1 的“超过 7 天未访问”是闲置淘汰规则，不是创建后固定 7 天到期；持续访问可能延长保留，容量策略也可能提前淘汰。因此不能仅等待固定 7 天就声称风险已清除。

## pnpm 完整性校验能证明什么

只读检查已安装的 **pnpm 11.7.0 发布分发文件**，没有执行安装或读取用户配置。可复核对象是分发包中的 `dist/pnpm.mjs` 和 `dist/worker.js`，不是仓库源码。摘要见附录。

- `pnpm.mjs:161902` 默认 `verifyStoreIntegrity=true`。`158381–158405` 先读取 CAFS；verified 为真就返回已恢复文件，否则走重新获取。并非每次 frozen install 都重新下载并校验原 tarball。
- `worker.js:11558–11607` 从 store 索引读取条目，检查已提供的包名/版本，随后按开关执行逐文件完整性校验，并返回 store 的 filesMap、manifest 和 sideEffectsMaps。
- `worker.js:8026–8050,8082–8141` 依据同一索引的算法、digest、大小及检查时间核文件，side effects 也按其索引处理。这能发现内容与索引不一致；索引和内容同时可写时，校验基准本身没有因此变为可信。
- 锁文件的 tarball integrity 约束下载内容，`--frozen-lockfile` 约束锁文件更新；不能直接推出“从缓存恢复的整份 store 已由锁文件逐文件认证”。只有篡改内容而不满足原索引的情况，才有对应的拒绝/重新获取路径；保持包名/版本也不等于内容来源可信。

这是静态调用链分析，没有制作恶意 store、修改索引、执行合成包或真实候选。因此只得出“现有校验不足以作为排除整份 store 篡改的证据”；不声称已证明某种索引改法在真实安装中奏效，也不把 pnpm 普通损坏检测描述成一个新的已复现漏洞。

## 最薄隔离验证方案（未运行）

本轮源码和公开资料已足够给出条件链，未运行合成验证。后续若需要补证，先在本卡列出并按既有权限确认以下具体执行边界；本节不是执行批准。

1. **本地安装消费对照**：只在新建的专用临时目录，使用固定摘要的 pnpm/Node 分发文件及无害合成包；单独 store、cache、HOME 配置目录和工作目录，不使用工作机现有 pnpm store，不带真实仓库数据/令牌。由可信入口在启动前强制禁网，并限制文件写入到该目录；无隔离能力则不运行，不能只靠“脚本不联网”的约定。
2. **最小样本**：同一合成锁文件下比较干净 store、只改文件、索引与内容一致改变、包名/版本失配、缺条目五种情况。合成内容只输出固定标记，不访问外部资源。记录安装退出、导入文件摘要及读取标记；不测试隐蔽载荷，不用真实候选，不遍历或复制生产 store。
3. **缓存规则模型**：纯内存模拟仓库/ref/key/version、不可变性和查询优先级，覆盖同键不同版本/分支、精确命中、空缺/竞争和前缀；增加 L' 首建 → main 预热精确命中并跳过保存 → 后续同锁文件消费，以及历史重复键、并发先写、访问刷新闲置时间的反例。模型只证明分析假设自洽，不能证明 GitHub 服务或真实 token 可达性。
4. **清理**：等待本次进程结束，核临时根归属及无越界链接，仅删除本次创建的临时根；检查不留子进程、网络监听、Git 改动或共享目录写入。保存脱敏命令、工具摘要、样本摘要和结果，临时路径不写进仓库报告。
5. **平台验证另案批准**：本地不能证明缓存服务授权。若仍必要，应提出一次性测试仓库、合成工作流、专用账号/凭据提供方式、有限运行次数/费用、仅该仓库缓存及清理范围的具体申请。明确核 action 本地目录/入口归属及可写性、候选与 post 的执行用户/权限边界、post 在候选之后是否运行、是否加载无害合成标记、post 环境是否提供可用的缓存身份，以及 read/none 策略下写操作是否被服务端拒绝。再按 L' 首写、预热跳过、后续恢复分别留证，不能用一次成功保存代替完整链路。不得使用生产仓库/共享缓存，不得从当前候选或 runner 文件中读取真实凭据；专用测试身份只由获批可信入口使用，不输出 token，证据只保留能力是否存在、操作结果、身份绑定及非秘密摘要。

## 缓解选项与待批准差异

以下互有代价，**本轮未选择、实现或启用任何方案**。最终权限或执行规则变化按本卡要求交人确认。恢复旧策略也会恢复对应风险，不能把“可回滚”当安全保证。

| 选项 | 具体差异与可能收益 | 安装语义/性能代价 | 回滚与剩余条件 |
| --- | --- | --- | --- |
| A：平台强制检查 job 只读缓存 | 待核服务支持后，给检查 job 设置 `cache-mode: read`，保留独立 main 预热写者。服务端拒绝候选写入，不能仅设置同名环境变量代替。 | 保留现有 frozen install 和热缓存，理论性能代价小；须核固定旧版 action 与平台兼容性，包含 post 在内的所有间接写通道均被限制。 | 只阻止新写，不认证候选曾首建的旧条目。切换还须选择新命名空间并由可信写者冷启动，或停用旧条目直至确认实际淘汰，按下文制定迁移；回滚权限或旧命名空间会恢复对应风险。 |
| B：检查不恢复共享缓存 | 移除共享 restore，安装使用每 job 的空 store；同时考虑服务端禁用该 job 的缓存访问，防止它继续影响其它消费者。 | 保持在线 frozen install，但失去热 store，更多下载/安装时间和网络失败；不能擅自改成 offline/fetch 两阶段并宣称等价。 | 恢复原步骤和路径；若仍有未受限的共享写者，恢复读取即恢复风险。只停读不能保证 main 预热或其它 workflow 安全。 |
| C：可信依赖生产与认证消费 | 在候选无法写入的身份/存储边界产生缓存，消费前独立验证来源及内容；认证覆盖实际索引与内容、工具和绑定，不用候选同进程自报摘要代替。 | 需要处理 workspace/link/file/Git/patch/pnpmfile、脚本、原生构建、运行时及 side effects 等语义；额外 IO、制品和维护成本，范围最大。 | 独立开关回退原在线安装；来源/摘要失配失败关闭。与 C-350 可信获取合同相邻，但本卡不授权其原型或启用。 |
| D：真正隔离运行 ref/执行身份 | 若改为候选作用域运行，需同时保证工作流来自受信版本，不执行候选自改 workflow，并收窄缓存可见/可写范围。 | 改变 host 绑定、派发恢复、缓存复用率；单加 card/SHA 键名不是权限边界，同作用域写者仍能指定其它键。 | 派发与绑定合同必须整套回滚；不能只把 dispatch 参数改到 ci ref，后者会破坏当前受信 workflow 假设。 |

由候选检查首建或无法证明首写来源的 key，不能因为后来 main 预热命中、条目不可变或已启用 A 就视为可信。A 等方案的切换必须具体选择历史条目处置：先限制所有不可信写者（含仍在运行的旧 job/有效写身份），再让所有消费者切到新的 key 命名空间，由不恢复旧缓存的可信写者从干净 store 首建；或停止旧条目的读写并确认实际淘汰后再可信重建。等待方案有冷安装和等待代价，持续读取不能指望“7 天后自然安全”。命名空间方案也会损失首次热缓存，应记录新前缀、生产者/消费者范围、切换顺序及回滚禁用旧条目的要求。两种方案均待具体批准，本轮不选定或执行。

直接删除生产缓存属于真实数据删除，未获批准不得操作；只换 key 前缀而不限制写身份，仍无法阻止候选写入新命名空间。也不能让“可信预热”先恢复旧不可信 store，再以新键保存并冒称净化。

后续实施需先圈定消费者：`.github/workflows/cardigan-check.yml` 与 `cache-warm.yml`；host 的 `github-check-executor.ts`、`github-client.ts`、`github-check-poller.ts` 及相关 scope/恢复测试；server 的 `author-prechecks.ts`、`merge-checks.ts` 等预检与最终检查调用方；roles 的测试/交付说明是否需同步。A 若不改变步骤名，通常无需改轮询合同；B/C 改步骤集合则必须连同固定步骤校验及其快照/契约更新；D 必须重新审运行身份。这里只列待评估范围，不要求全部修改，也不扩大角色工具或 Token 权限。相关局部测试由实施项明确，全仓/E2E 仍由主机检查负责。

## 调查边界与交付验证

- 已做：读取固定基线源码、相关公开文档和公开上游源码；只读查看本机已安装 pnpm 发布分发文件；读取 C-350、C-365 的 Card-MCP 参考资料。C-350 的 V-1607 是风险来源，V-1623/V-1624 的已有结论不替代本卡审核。
- 未做：真实候选风险演练、安装消费对照、GitHub 缓存创建/覆盖/删除、生产/私有配置或凭据读取、真实 GitHub/SSH 风险验证、生产数据查询、服务商联系、故障/负载制造、合成投毒实验。公开文档 GET 不访问项目账户 API。交付检查的 pnpm 包装入口自动准备了本 worktree 的依赖（日志显示复用本机包、下载 0），这属于本地检查前置，不能算成安装消费实验或声称完全没有依赖准备。
- 本次只新增本报告，没有受影响实现包或快照；依卡片要求不运行实现单测/安装对照。本地交付检查为 `pnpm lint`、`pnpm check:deps`、`git diff --check`，实际结果写正式交付。按流程版本 5 对报告提交申请主机同 SHA 预检；正常交付预检不作为缓存风险现场验证证据。
- 未核清单：真实执行器配置和 runner 版本、作业有效 cache-mode、post 本地入口可写及运行时身份可用的现场条件、当前缓存库存与首写者、新锁文件首写/预热/后续消费的实际序列、固定服务的实际前缀选择、篡改 store 被安装接受、后续候选执行影响和错误门禁结论。已识别两条具体可复现条件链，不再把身份路径或新键窗口泛称未知；现场事实仍未核。
- 本卡调查完成不改变 C-350 的暂停/只读范围，也不替代 C-365 的真实生产输入隔离合同。两个后续方向的启用授权不从本报告产生。

## 公开资料与内容指纹

查阅日期均为 2026-11-17。文档是当日取得的内容快照，不能外推到旧版或私有部署。引用的简短原文与 SHA-256 便于复核；原文只读下载到本次临时目录，不包含凭据。raw.githubusercontent.com 获取失败的资料改用公开 GitHub Contents API，无认证；未取得的内容不作为证据。

| 编号 | 已实际读取的来源 | 对应证据与 SHA-256 |
| --- | --- | --- |
| P1 | [GitHub：Caching dependencies](https://docs.github.com/en/actions/using-workflows/caching-dependencies-to-speed-up-workflows)，经公开 `/api/article/body?pathname=/en/actions/using-workflows/caching-dependencies-to-speed-up-workflows` 取得正文 | “You cannot change the contents of an existing cache”；“enforced with scoped cache tokens”；作用域、版本、默认触发权限、cache-mode 与前缀搜索。正文 `b6647069a21ee51a74d863fe00d93a46c04ad6bf20caba89bc10e8c84654accf`。 |
| P2 | [GitHub：Events / workflow_dispatch](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch)，同样通过公开正文 API | `GITHUB_REF`：“Branch or tag that received dispatch”。正文 `f24a7813b65939cdbeb6b4f0d594242c04648e285b2b15f5129d684e50f4eac8`。 |
| P2a | [GitHub：Workflow syntax / cache-mode](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#cache-mode)，同样通过公开正文 API | 顶层及 job 级语法、作用域 token 强制权限；正文 `5d56229db925f0bb8ea99e3b77cd27713868de8bf7073ebe4c39f9d4e8b48017`。 |
| P3 | [固定 cache restore 源码](https://github.com/actions/cache/blob/0057852bfaa89a56745cba8c7296529d2fc39830/src/restoreImpl.ts)、[save 源码](https://github.com/actions/cache/blob/0057852bfaa89a56745cba8c7296529d2fc39830/src/saveImpl.ts) | restore `a826ba32c328383f17db138d061c684481c18220fd72733e4bfd552be456c1ec`；save `1e619eb826ff8cde79c58fd3ff8bc3f922f1fca1bf9cd2dfd3aafa068c1148bb`。 |
| P4 | [runner v2.329.0 Node handler](https://github.com/actions/runner/blob/v2.329.0/src/Runner.Worker/Handlers/NodeScriptActionHandler.cs)、[Script handler](https://github.com/actions/runner/blob/v2.329.0/src/Runner.Worker/Handlers/ScriptHandler.cs) | Node `ffb9937d511124b301065b76ffd5a76b40f76077c305a1416ebfe3dc9ed0fd1c`；Script `00ea0e0695ff399f4db9c642f2a76f2435033bcb93a5e7cf71a6339b8b7b9284`。修订复读 Node `54–104`：先注入身份，再选择并加载 post 入口。此版本只作公开机制例证，不冒称实际 runner。 |
| P5 | [toolkit cacheUtils](https://github.com/actions/toolkit/blob/main/packages/cache/src/internal/cacheUtils.ts)、[cacheHttpClient](https://github.com/actions/toolkit/blob/main/packages/cache/src/internal/cacheHttpClient.ts)，当日 main 内容快照 | utils Git blob `e19e320f88478732415be3f7ac14bdb86333bed1`，SHA-256 `11b525baf18af2317527ca0d0346258c5d62e33a9270cfb542c8fa5d8e7ad20a`；client Git blob `3b364814d57dae2871bb2c6bce301ed7d8744dfe`，SHA-256 `7049689097f5f7dfa61b743065a9e36186aca467571632e572efda0c4122caca`。只作辅助证据。 |
| P6 | pnpm 11.7.0 已安装发布分发包中的 `dist/pnpm.mjs`、`dist/worker.js` | main `d3a7f4bde2f32c5acc5f012d1edc24c24ea247c2f6c8823146f8cd69ed70b22f`；worker `993dcddacabfd9f600c8b814cf6233bc97fd37346cf5eaa6e72636ebc299c3f9`。只读正文及摘要，不读配置，不把本机分发文件证明成远端实际版本。 |
| P7 | [GitHub-hosted runners reference：Administrative privileges](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#administrative-privileges)，通过公开正文 API 取得 | Linux/macOS VM “run using passwordless sudo”。正文 `9745b4a47e889a2e77a7a6da7d646f4121935513a2aebf93a377b239f6fbc048`；它是公开默认能力，不是本项目目录权限现场证明。本次未调用 sudo。 |

修订取证时，GitHub Contents API 部分请求返回匿名额度 403，raw/CDN/页面请求亦失败；未读取到 Cacheract README、action.yml 或 ActionManager 正文，故不把这些材料列为已核证据。上文 post 条件链依据已实际读取的 P4 post 分支、S7 仓库合同/样本及 P7 官方能力说明，不把审核提出的公开研究名称直接当成已经核验的案例。
