# Phase 1 · M5 任务计划：Web Workbench 与自研看板

- 版本：v2（2026-11-06）：Codex 还在做 M4.T2，关键路径上的 M5.1 改给空闲的 Pi；M5.1、M5.3 由 Pi 实现、Codex 验收，M5.2、M5.4 由 Codex 实现、Pi 验收
- v1（2026-11-06）
- 对应：开发方案 §16 Phase 1 M5；§8 用户界面；§9 Card MCP（Workbench Web API 不经过 MCP）；§14 安全模型；附录 A 端到端验收场景
- M5 的验收（开发方案 §16）：**附录 A 场景完整跑通。** 通过标准：你只在附录 A 第 8 步（拍板）和第 10 步（合并确认）被打断；人为重复发送门铃不产生重复 Run；中途重启 Herdr server 后，所有 Assignment 都能恢复或得到明确处理。
- 只做 `machine_id=local`。M5 不做：Web 聊天（PM Office 仍在 Herdr 里，§8.1）、多用户和权限、移动端、邮件通知、甘特图和日历、diff 视图（先给可直接运行的 git 命令，§8.7）、开放局域网访问。
- 前提：M1–M4 已合并。M3.S、M4.S（真实 Agent 冒烟）等用户装好 agent 账号后进行，和 M5 并行。

## 0. 已经拍板的事项（2026-11-06 用户确认）

| 事项 | 决定 |
|---|---|
| 访问范围 | Workbench **只监听 127.0.0.1**。从别的设备访问走 SSH 隧道（`ssh -L`）。配置成非回环地址时拒绝启动；开放局域网（需要 HTTPS）以后单独拍板 |
| 登录方式 | `cardigan web set-password` 设置密码，用 scrypt 加盐哈希存储（`node:crypto`，不加新依赖）。登录后发 HttpOnly、SameSite=Strict 的会话 Cookie，会话默认 7 天；改密码使所有会话失效。Agent 的 MCP Token 不能访问 Workbench API，Workbench 的会话也不能调用 MCP |

## 1. 任务总览

| 任务 | 内容 | 实现 | 验收测试 | 依赖 | 分支 |
|---|---|---|---|---|---|
| M5.1 | server：Workbench Web API 的骨架、登录、只读接口、SSE、静态文件 | Pi | Codex（M5.T1） | 无 | `feat/m5-web-api` |
| M5.2 | domain + server：人的写操作（评论、指令、拍板、执行操作、合并确认、worktree 处置）和编号自动链接 | Codex | Pi（M5.T2） | M5.1 | `feat/m5-web-commands` |
| M5.3 | web：应用外壳、登录页、卡片列表和看板、卡片详情、评论框 | Pi | Codex（M5.T1） | M5.1 | `feat/m5-web-cards` |
| M5.4 | web：Needs You、项目快照、执行视图、项目动态、实时刷新 | Codex | Pi（M5.T2） | M5.1、M5.2 | `feat/m5-web-needs-you` |
| M5.5 | e2e：附录 A 场景（真实 server、真实 hc、真实 git、模拟 Agent），含中途重启 Herdr server | Pi | Codex（M5.T1 复核） | M5.2、M5.4 | `test/m5-appendix-a` |
| M5.6 | server：Session 失联后的恢复（M5.5 发现的缺陷） | Codex | Pi（M5.5 的重启场景） | M5.5 诊断 | `fix/m5-session-recovery` |
| M5.T1 | 交叉验收：M5.1、M5.3，复核 M5.5 | Codex | — | M5.1、M5.3、M5.5 | `test/m5-api-cards` |
| M5.T2 | 交叉验收：M5.2、M5.4 | Pi | — | M5.2、M5.4 | `test/m5-commands-ui` |
| M5.S | 真实冒烟：用真实 Agent 跑附录 A，并在浏览器里走一遍 | Claude | — | M5.5、M4.S | — |

```
M5.1（Pi，可立即开始） ─┬─ M5.3（Pi） ─────────── M5.5（Pi） ─┬─ M5.T1（Codex） ─ M5.S
                         └─ M5.2（Codex，M4.T2 之后） ─ M5.4（Codex） ┴─ M5.T2（Pi）
```

M5.2 的 domain 部分（`issueInstruction`、编号识别、人记录决策）不依赖 Web API，Codex 可以在 M5.1 合并前先做。

## 2. 通用约定

沿用 M2–M4 计划的 §2：每个 PR 约 800 行以内；domain 测试从 `createCard` + `assign` 的真实状态出发；验收测试只看计划和开发方案、只用公开接口、每条用例做注入验证，不符合计划的用 `test.fails` 标出；用真实 hc 的测试用 `test-support` 里的 `HcCore` 清理，跑完不能留下 herdr-core；不在代码和测试里写个人路径、机器名、IP。

Web 部分另加：

- 依赖：React、React DOM、Vite 已在 `apps/web`。允许新增：一个不渲染原始 HTML 的 Markdown 渲染库（`markdown-it` 关闭 `html`，或同等），测试用 `@testing-library/react` 和 `jsdom`。其他运行时依赖（组件库、状态管理库、路由库）需要在 PR 里写明理由，能用几十行代码解决的不引库。所有版本锁死。
- 界面文字用中文；代码和标识符用英文。
- 组件测试用 vitest + testing-library；不在 CI 里跑真实浏览器，真实浏览器的走查放在 M5.S。

## 3. 关键设计（本计划确定）

### 3.1 进程与端口

- Workbench Web API 由 `apps/server` 提供，和 MCP 端点是**两个独立的监听**：MCP 继续用现有端口；Workbench 默认 `127.0.0.1:7781`（`CARDIGAN_WEB_PORT` 可改端口，地址不可改成非回环）。
- 同一个监听同时提供 `/api/*` 和 `apps/web` 构建出的静态文件（`/` 下的 SPA）。
- Workbench API 只调 domain 命令和查询，以 `{ kind: "human" }` 身份执行，不经过 MCP（§9 末尾）。

### 3.2 安全（§14）

| 风险 | 做法 |
|---|---|
| 非本机访问 | 只绑定回环地址；配置成别的地址时拒绝启动 |
| DNS rebinding | 校验 `Host` 头必须是 `127.0.0.1:<port>` 或 `localhost:<port>`，否则 421 |
| CSRF | 会话 Cookie 为 SameSite=Strict；所有非 GET 请求校验 `Origin` 与 `Host` 一致，并要求 `Content-Type: application/json`（上传接口除外，上传也校验 Origin） |
| 暴力破解 | 登录失败按来源计数，连续失败后退避；密码最短 12 位 |
| XSS（Agent 写的内容会显示在你的浏览器里） | Markdown 渲染不允许原始 HTML，链接只允许 http、https 和站内路径；附件只在 `<img>` 里显示已知的位图类型，SVG、HTML 等一律作为下载（`Content-Disposition: attachment`）；全站 CSP：`default-src 'self'`，禁止内联脚本 |
| 点击劫持 | `X-Frame-Options: DENY`、`frame-ancestors 'none'` |
| 凭据串用 | MCP Token 访问 Workbench API 一律 401；会话 Cookie 对 MCP 端点无效 |
| 会话 | Cookie HttpOnly、SameSite=Strict、Path=/；会话记录存数据库（哈希后的会话标识、创建时间、最后使用时间、过期时间）；登出和改密码立即失效 |

### 3.3 实时刷新

- `GET /api/projects/:id/stream?after=<流:seq,...>`（SSE）：按流（每张卡、项目级）推送事件序号和类型，正文由前端按需重新拉取；心跳 15 秒一次。
- 断线重连时带上已看到的各流 seq，服务端补发缺失的事件；不依赖浏览器的 `Last-Event-ID`。
- 事件推送只读，不推进任何 Agent 的游标。

### 3.4 编号自动链接（§8.4）

- 服务端在返回时间线、描述、评论时，识别正文里的编号（`C-n`、`W-n`、`D-n`、`A-n`、`R-n`、决策编号、`q(n)` 之类的拍板引用），返回结构化的引用列表（编号、类型、当前状态、是否存在）。前端只根据这个列表生成链接，不自己用正则猜。
- 不存在的编号原样显示为文本，不生成链接。

### 3.5 指令（补上 §6.4 的"指令"一行）

M3.T2 发现：路由表里有"指令"一行，但没有任何命令产生指令事件。M5.2 补上：

- domain 命令 `issueInstruction(card_id, work_item_id, body)`：人（Workbench）和 PM Ops（MCP 新工具 `issue_instruction`，只给常驻 PM Ops）可以下达；工作项必须属于该卡且未结束。
- 事件 `instruction_issued { work_item_id }`，时间线条目类型 `instruction`；路由沿用 M3.1 已有的规则（对应工作项的 Assignment；还没有 Assignment 时交给 PM Ops）。
- 同步开发方案 §9.2 的工具表和 §6.4。

### 3.6 Needs You 里的操作（§8.2）

| 操作 | 实现 |
|---|---|
| 选方案 / 批准 / 驳回 | `recordDecision`，`via=needs_you`，原话就是你在页面上输入的文字（没有输入时记"在 Needs You 选择了 X"）。M4.1 已允许人记录合并确认和清理决策，M5.2 放开到所有 `decider=human` 的决策 |
| 要求补充信息 | 在决策下发一条评论并 @ 发起方 Assignment；路由按现有评论规则唤醒它 |
| 让 PM 解释后果 | 发一条评论并 @ PM Office；这是你主动要求的，路由交给 PM Office 属于正常的"你找它" |
| 完成待你执行的操作 | 现有的 `human_action_completed` 命令 |
| 合并确认 | M4.4 的合并确认决策，和 `cardigan merge confirm` 走同一条路径 |
| worktree 保留 / 强制清理 | M4.1 的清理决策，和 `cardigan worktree keep/clean` 走同一条路径；"查看 Diff"给出 `cardigan worktree diff <A-n>` 命令 |

- 不紧急的拍板合并成批次显示；阻塞性的拍板和风险排在最前（§8.2）。
- 每项显示一句原因（≤40 字）和已经等了多久；全文在卡片页。

### 3.7 界面原则

- 先保证信息密度和可读性：卡片页一屏能回答 §8.4 的五个问题（目标、进行到哪、下一步谁、被什么阻塞、谁验收依据是什么）。
- 状态用文字加颜色，不只靠颜色；时间线条目按类型（评论、指令、交付、审核、决策、状态变化、系统）区分样式。
- 不做所见即所得编辑器；评论框是带预览的 Markdown 文本框，支持 @提及补全、粘贴图片上传。

## 4. 各任务说明

### M5.1 Web API 骨架（Pi，可立即开始）

- 监听、`Host` 校验、安全响应头、静态文件、JSON 错误格式。
- 登录：store 新增凭据表和会话表（迁移）；`cardigan web set-password`（交互输入两次，不经命令行参数传密码）；`POST /api/login`、`POST /api/logout`、`GET /api/me`；§3.2 的全部要求。
- 只读接口：项目列表；卡片列表（按状态分列、筛选"等我处理"和"等 Agent 处理"）；卡片详情（卡片、工作项、时间线、交付、审核、决策、附件、关联区，§8.4）；Needs You；项目快照（§8.3）；执行视图数据（Assignment、Run、runtime、worktree、游标，§8.5）；项目动态（事件流，按卡片、角色、类型过滤，分页）。尽量复用 domain 已有的查询（`projectSnapshot`、`listNeedsYou` 等）。
- SSE（§3.3）。
- 附件下载（§3.2 的 XSS 规则）。
- 验收：未登录的接口全部 401；MCP Token 访问 401；`Host` 不对返回 421；非 GET 请求 Origin 不对返回 403；配置非回环地址时拒绝启动；SSE 断线重连后不丢事件、不重复推送；SVG 附件作为下载返回。

### M5.2 人的写操作和编号链接（Codex）

- domain：`issueInstruction`（§3.5）和 MCP 工具 `issue_instruction`；`recordDecision` 放开到人记录所有 `decider=human` 的决策（§3.6）；编号识别（§3.4，纯函数）。修改 domain 必须附带契约测试。
- Web API 写接口：发评论（@提及、Markdown 正文、附件）、上传附件（复用 `uploadAttachment`，大小上限沿用现有配置）、下达指令、Needs You 的各项操作（§3.6）。全部以人的身份执行，经 domain 命令校验，不直接写仓储。
- 验收：每个写接口的成功路径和被拒路径（非法状态、越权、CSRF）；指令按路由唤醒对应 Assignment，没有 Assignment 时交给 PM Ops；PM Ops 能用 `issue_instruction`，工作项 Assignment 不能；不存在的编号不生成链接。

### M5.3 卡片界面（Pi）

- 应用外壳（项目切换、导航）、登录页。
- 卡片列表和看板视图，"等我处理"和"等 Agent 处理"两个筛选。
- 卡片详情：五个问题的头部、可折叠的工作项清单（负责人、状态、交付）、关联区（拍板、卡片、PR 的编号和状态，点击跳转）、时间线（按类型区分样式，编号变成链接，附件缩略图显示所依据的拍板状态，已取代的附件折叠）。
- 评论框：Markdown 预览、@提及补全、粘贴图片上传。M5.2 的写接口合并前，评论框可以先接只读的预览。
- 验收：组件测试覆盖各视图的主要状态（空、加载、错误、有数据）；Agent 写的正文里的 HTML 和 `javascript:` 链接不会被执行；状态不只靠颜色区分。

### M5.4 Needs You 和其他视图（Codex）

- Needs You（§8.2、§3.6）：批次和阻塞优先、一句话原因、已等待时间、所有操作。
- 项目快照（§8.3）：进行中、Review 中、阻塞中、最近交付；每张卡的下一步负责人；等你和等 Agent 分开。
- 执行视图（§8.5）：每个状态旁边给出动作；需要终端的动作（在 Herdr 中打开、恢复会话）给出可以直接复制的命令。
- 项目动态（§8.6）：事件流，按卡片、角色、类型过滤，默认折叠。
- 实时刷新：所有视图订阅 SSE，收到相关流的新 seq 后重新拉取。
- 验收：组件测试覆盖各视图；Needs You 的每个操作调用了正确的接口；断线重连后界面能补上错过的变化。

### M5.5 附录 A 端到端（Pi）

- 放在仓库根的 `e2e/`（§20.1）：真实 server、真实 hc、真实 git（本地登记源和中心仓库）、模拟 Agent（只走 Card MCP，按脚本行动）。
- 按附录 A 的 12 步执行，Workbench 的操作通过 Web API 完成（拍板、合并确认）。
- 重启场景（2026-11-06 裁定）：只执行 `hc server stop`，由系统在下一次需要时经 hc 自动拉起 core（不在测试里手动重启）；测试记下新 core 并在结束时清理。常驻 PM 的 Assignment 不伪造 RuntimeRef，否则会被监控判为失联，产生多余的 Needs You。
- 断言附录 A 的三条通过标准：你只在第 8 步和第 10 步被打断（Needs You 里只出现这两次）；人为重复发送门铃不产生重复 Run；中途重启 Herdr server（`hc server stop` 后重启）后，所有 Assignment 都恢复或得到明确处理（Needs You 或 attention 里有记录）。
- 跑完不能留下 herdr-core。

### M5.6 Session 失联后的恢复（Codex，2026-11-06 加入）

M5.5 的重启场景（停掉 hc core）暴露了三处实现缺陷。附录 A 第 7 步之后，coder 的 Run 已经以 blocked 结束，拍板产生的 decision_resumed Run 还在 queued。这时 core 消失：
1. `apps/server/src/dispatch-monitor.ts` 只监控未结束且不是 queued 的 Run，所以处在"两次 Run 之间"的 Assignment 没有任何订阅。core 消失对它不可见，`runtime_state` 停在 running，§13.9 的宽限期不会开始，也不会进 Needs You。
2. `apps/server/src/dispatch.ts` 的 `deliver()` 只在 `runtime_not_found` 时继续处理，`runtime_unavailable`（core 不在，"hc socket is absent"）被静默跳过：不认领门铃、不重试、不升级，通知一直挂着。
3. D5 规定失联时替换 Session 并写交接，但 `resume_or_replace` 在生产代码里没有调用方。

按 D5 和 §13.9 补齐，规则如下：

- **两次 Run 之间失联，自动替换**：投递门铃时，如果 `runtime.status` 返回 `runtime_not_found` 或 `runtime_unavailable`，并且这个 Assignment 没有在途的 Run（dispatched、acked、running、unknown），就按 D5 替换 Session。
  - 用主机编译的启动描述调用 `resume_or_replace`，和 provision 用同一份。hc 需要时会自动拉起 core（0.3），不另写启动 core 的逻辑。
  - 成功后写一条 `type=handoff` 的系统时间线条目，内容包括：原因（运行时失联）、旧的 RuntimeRef、最近一次 Run 及其 outcome、"新 Session 先读卡片和 `get_updates`"。然后更新 RuntimeRef，按原流程投递，启动排队的 Run，不产生第二个 Run。
  - 替换失败时走现有的投递失败路径：重试退避，用尽后升级。不能静默挂起。
- **Run 进行中失联，不自动替换**：保持 §13.9 的流程，unknown → 宽限期 → lost → Needs You。旧进程可能还在改代码。
- **runtime_state 要准确**：Run 结束后 Assignment 回到 idle。核实现在为什么停在 running，并修正。
- **Needs You 显示 runtime_lost**：§13.9 规定 lost 进入 Needs You，但 Web 的 `/needs-you` 和 MCP 的 `list_needs_you` 现在只列 Decision 和 HumanAction。补上 runtime_lost 升级的显示，包括哪个 Assignment、什么时候失联、最后一次 Run。本次只显示，不加操作按钮，接管属于 Phase 2（§13.9 第 3 条）。
- **已知未做**：D5 的后半句"控制面记录 CLI 会话 ID、恢复时用 CLI 自带的恢复参数"还没有实现，所以替换后是一个新 Session，靠交接条目和卡片接续。列入 Phase 2 计划。

测试：用假 Runtime 和真实 store 覆盖以下情况：
- 两次 Run 之间出现 `runtime_not_found`，以及出现 `runtime_unavailable`：替换 Session、写交接、启动 Run，并且只有一个 Run；
- 有在途 Run 时失联：不替换；
- 替换失败：升级，不挂起；
- Run 结束后 runtime_state 回到 idle；
- Needs You 列出 runtime_lost。

端到端由 M5.5 的重启场景验证。

### M5.T1、M5.T2 交叉验收

- **M5.T1（Codex）**：M5.1 的 Web API（§3.2 安全表逐条、只读接口的数据正确性、SSE 补发）；M5.3 的界面（组件测试，XSS 用例）；复核 M5.5 的场景是否和附录 A 一致，有没有绕开公开接口。
- **M5.T2（Pi）**：M5.2 的写操作和指令；M5.4 的界面。

### M5.S 真实冒烟（Claude）

M4.S 之后：真实 coder、reviewer、tester、designer（可以用同一个 harness 扮演多个角色）跑附录 A，你在浏览器里完成第 8、10 步；记录被打断的次数和每一步的耗时，写进本计划的附录。

## 5. 后续事项（M5 不处理）

| 事项 | 处理 |
|---|---|
| 开放局域网访问（HTTPS） | 需要时单独拍板 |
| Web 聊天、diff 视图 | Phase 3 / 以后 |
| 多机 | Phase 2 |

## 6. M5 完成的标准

- M5.1–M5.5、M5.T1、M5.T2 全部合并；M5.S 冒烟通过并记录。
- 附录 A 的三条通过标准都有自动化测试。
- 开发方案 §8、§9、§14 已按实际实现更新。
- Claude 在 Phase 1 收尾时补开发方案的版本号和变更记录，并写 Phase 2 的任务计划。
