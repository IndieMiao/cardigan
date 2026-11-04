# Phase 1 · M2 任务计划：Role Registry、Launch Profile、Runtime Adapter

- 版本：v1（2026-11-05）
- 对应：开发方案 v0.6.15 §16 Phase 1 M2；§10 Role Registry 与 Agent 启动；§11 Runtime Adapter；§12.2 worktree 布局；§13.3–§13.4 约定与运行环境
- M2 的验收（开发方案 §16）：**从卡片一键创建 coder 的 Assignment：worktree 建好，Agent 启动并通过 `whoami` / `get_card` 读到任务。**
- 运行时基线：herdr-core（`hc`）**0.1.18**，锁版本。2026-11-05 已按 ADR 0001 复核 D9，结论是维持 herdr-core（见 ADR 0001 的"复核记录"）。
- M2 只做 `machine_id=local`。多机在 Phase 2。
- M2 不做：门铃、Router、ACK 重发（M3）；主机拉取交付、合并、对账（M4）；Web 界面（M5）。

## 1. 任务总览

| 任务 | 内容 | 实现 | 验收测试 | 依赖 | 分支 |
|---|---|---|---|---|---|
| M2.1 | domain：Role 定义、Runtime 端口、启动 Run 的命令 | Codex | Pi（M2.T1） | 无 | `feat/m2-domain-launch` |
| M2.2 | store：Role 定义与版本、项目仓库配置、迁移 | Pi | Codex（M2.T2） | M2.1 | `feat/m2-store-roles` |
| M2.3 | runtime-herdr：herdr-core 适配器 + Runtime 契约测试套件 | Codex | Pi（M2.T1） | M2.1 | `feat/m2-runtime-herdr` |
| M2.4 | roles：Assignment 启动编译（MCP 配置、Core Prompt、首条提示）、默认角色包 | Pi | Codex（M2.T2） | M2.1 | `feat/m2-roles-launch` |
| M2.5 | git-service / git-transport：本地基础 clone 与 worktree | Codex | Pi（M2.T1） | M2.1 | `feat/m2-git-worktree` |
| M2.6 | 组装：`cardigan assignment start`、MCP 首次调用确认 Run、端到端测试 | Pi | Codex（M2.T2） | M2.2–M2.5 | `feat/m2-assignment-start` |
| M2.7 | Agent 专用系统用户（§13.4）：安装脚本、运行时经 `agent@localhost` 接入 | Codex | Claude 审核 + 用户执行 sudo 部分 | M2.3 | `feat/m2-agent-user` |
| M2.T1 | 交叉验收：domain 启动命令、Runtime 契约、worktree | Pi | — | M2.1、M2.3、M2.5 | `test/m2-runtime` |
| M2.T2 | 交叉验收：store、启动编译、一键启动端到端 | Codex | — | M2.2、M2.4、M2.6 | `test/m2-launch` |
| M2.S | 真实 Agent 冒烟：用真实 Codex 起一个 coder，读到任务 | Claude | — | M2.6 | — |

建议顺序：

```
M2.1 ──┬─ M2.2（Pi） ─────────┐
       ├─ M2.3（Codex） ──┬───┼─ M2.6（Pi） ─ M2.T2（Codex） ─ M2.S
       ├─ M2.4（Pi） ─────┼───┤
       └─ M2.5（Codex） ──┘   │
                          M2.7（Codex）
       M2.T1（Pi）：M2.1、M2.3、M2.5 合并后
```

## 2. 通用约定

沿用 M1 计划 §2（`docs/plans/phase-1-m1.md`），并补充 M1 审核中得到的教训：

- **每个 PR 控制在约 800 行以内**，超出就拆成依赖 PR。
- domain 命令的测试要**从真实状态出发**（用 `createCard`、`assign` 建数据），不要手工把工作项预置成 `in_progress`。
- 验收测试（M2.T*）只看计划和开发方案、只用公开接口；每条用例都要**注入 bug 验证**确实会失败，并在 PR 里列出注入结果；不符合计划的行为用 `test.fails` 标出。
- 涉及真实 `hc` 的集成测试：本机没有 `hc` 或版本不是 0.1.18 时跳过，并打印原因；测试一律用独立的 `HC_SESSION`，结束时清理自己创建的终端，**不碰用户正在使用的 session**。
- 不在测试或代码里写个人路径、机器名、IP。

## 3. 技术选择（本计划确定）

| 项 | 选择 | 理由 |
|---|---|---|
| 调用 herdr-core 的方式 | 子进程调用 `hc … --json`（参数数组，不经过 shell）；事件用 `hc events --json` 的逐行输出 | CLI 的 JSON 输出就是 OpenRPC API 的结果；子进程实现简单、易于在契约测试里替换。以后换成直连 socket 只改适配器 |
| hc session | Cardigan 专用，默认 `cardigan`，可配置（`CARDIGAN_HC_SESSION`） | 不和用户自己的 hc 终端混在一起 |
| 版本锁定 | 适配器启动时检查 `hc --version` 等于配置的版本（默认 0.1.18），不等就拒绝启动 | herdr-core 是预览版，升级频繁（ADR 0001） |
| 终端名（agent_name） | `<role>-<card>-<work_item>-<assignment>` 的小写形式，例如 `coder-c3-w7-a12`；超出 32 字符时截断前缀并保留 assignment 编号 | hc 要求 1–32 个 `a-z 0-9 - _`，且全局唯一（§11.3） |
| 标签 | `cardigan=1`、`project=<id>`、`assignment=<id>`、`run=<id>` | 对账和过滤靠标签，不靠名字 |
| 运行目录 | `<CARDIGAN_DATA_DIR>/runs/<assignment_id>/`，目录 0700、文件 0600，在 worktree 之外 | §10.2：注入的提示词、MCP 配置和 Token 不进仓库 |
| Token 交给 Agent | 每次启动由主机签发新 Token（旧的作废），写入运行目录的 `token` 文件；包装脚本 `launch.sh` 读出后**立即删除文件**，以环境变量 `MCP_TOKEN` 启动 CLI | `hc run` 没有传环境变量的选项；读后即删，减少明文停留 |
| worktree 根目录 | 可配置；默认 `<CARDIGAN_DATA_DIR>/agent/repos/<project>`（基础 clone）和 `<CARDIGAN_DATA_DIR>/agent/worktrees/<assignment_id>`；生产按 §12.2 用 `/srv/agent/...` | 开发机上不需要 root |
| 分支 | `agent/<card_id>/<work_item_id>`，从卡片的 `base_branch` 建，记录 `base_sha` | §12.2 |
| 项目仓库 | M2 给项目登记一个本地 Git 仓库路径（`cardigan project set-repo`），作为基础 clone 的来源；中心 bare 仓库在 M4 | 单机先走本地路径（§12.1 最后一条） |

## 4. 一键启动的流程

`cardigan assignment start <A-n>`（人执行；也可以 `cardigan assign <W-n> --role coder --start`）：

1. 读取 Assignment、Role（固定版本）、卡片和工作项；Assignment 必须 active。
2. domain `queueRun`：为该 Assignment 建 `kind=initial`、`status=queued` 的 Run，快照 Role 版本、模型（来自启动配置）、Agent CLI 版本（执行 `<cli> --version` 得到），写事件 `run_queued`。同一 Assignment 已有未结束的 Run 时拒绝（不变量 4：一个 worktree 同时最多一个写入型 Run）。
3. Git：确保项目的基础 clone 存在，按需建 worktree 和分支，记录 `base_sha`。Role 声明不需要 worktree 时跳过（PM 等）。
4. 主机签发新 Token（作废该 Assignment 的旧 Token），编译启动配置，写运行目录：`token`、MCP 配置、`core.md`（Core Prompt）、`first.md`（首条提示）、`launch.sh`。
5. Runtime `provision`：`hc run --bg --json --name <agent_name> --cwd <worktree 或运行目录> --label … -- <运行目录>/launch.sh`（选项必须放在程序前面）。
6. domain `dispatchRun`：Run → `dispatched`；记录 `runtime_ref`、`worktree_path`、`branch`、`base_sha`；Assignment 的 `runtime_state` 按 §4.4 推进到 `running`。
7. Agent 启动后读首条提示（形如门铃：`[bell] card=C-3 wi=W-7 asg=A-12 run=R-5 kind=initial → 请调用 whoami、get_card、get_updates`），通过 MCP 调用 `whoami`、`get_card`。
8. **mcp-server 在该 Assignment 第一次通过认证的工具调用时**执行 domain `acknowledgeRun`：Run `dispatched → acked → running`，并对调用者自己的工作项应用 `run_started`（复用 M1.3 的 `activeWork`）。重复调用是无操作。这样 M1 遗留的"Run 开始时不推进工作项状态"在这里解决。
9. 任一步失败：已建的终端由 `release` 清掉，Run 记为 `cancelled`（或 `failed`）并记录原因；worktree 保留（清理归 M4）；Token 作废。

## 5. 各任务说明

### M2.1 domain：Role 定义、Runtime 端口、启动 Run 的命令（Codex）

- **Role 定义**（§10.1 的子集）：`role_id`、`version`、`display_name`、`kind`（standing | work）、`core_prompt`、`harness`、`launch_profile_ref`、`allowed_tools`、`capabilities`、`abilities`、`worktree`（none | write | readonly）、`required_machine_tags`。`RoleReference` 保持兼容（M1 代码继续可用）。
- **Runtime 端口**：§11.1 的 7 个接口写成 domain 端口（TypeScript 接口，不做 IO），`RuntimeRef` 沿用现有类型。错误用稳定的错误码（如 `runtime_not_found`、`runtime_unavailable`、`version_mismatch`）。
- **命令**：`queueRun`、`dispatchRun`、`acknowledgeRun`、`abortDispatch`（启动失败）。只允许主机侧（human/system Actor）调用前两个和第四个；`acknowledgeRun` 由 mcp-server 以该 Assignment 的身份调用。
- 状态迁移全部走 M1.2 的 `transition`；`acknowledgeRun` 推进自身工作项要复用 `activeWork`。
- 验收：每条命令的正常路径和每条拒绝规则至少一个测试（从 `createCard` + `assign` 的真实状态出发）；不变量 4、5、12 各至少一个测试，测试名写明编号。

### M2.2 store：Role 定义与版本、项目仓库配置（Pi）

- 迁移 0003：Role 定义的完整字段（JSON 列即可，沿用 M1.4 的做法）；同一 `role_id` 修改时版本号递增，旧版本保留，不能原地改写（§10.1"Role 修改后版本号递增，Run 记录所用版本"）。
- 项目登记本地仓库路径和默认基线分支。
- `cardigan role add` 支持 `--file <role.yaml>`；`cardigan role update` 生成新版本；`cardigan project set-repo`。
- 验收：版本递增、旧版本可读、Run 引用的版本不会被改写；迁移可重复执行。

### M2.3 runtime-herdr：herdr-core 适配器（Codex）

- 实现 M2.1 的 Runtime 端口：`provision`、`wake`（`hc send`，带 `--if idle` 的选项）、`status`（`hc get`，并提供基于 `hc events` 的订阅，输出带 `seq` 的事件）、`interrupt`、`resume_or_replace`、`human_entry`（返回 `hc attach --session <s> <t>` 这类可直接粘贴的命令）、`release`（`hc kill` + `hc rm`）。
- 启动时检查版本；所有调用带超时；把 hc 的错误种类（`not_found`、`finished`、`status_mismatch` 等）映射成端口的错误码。
- **探活不能顺带拉起 core**（0.3 实测：`hc` 的读命令会自动启动 core）：先检查 socket 是否存在。
- **Runtime 契约测试套件**：一套与实现无关的测试，同时跑在"内存假实现"和真实 herdr-core 上（ADR 0001：两种实现必须通过同一套测试）。用一个假 Agent 程序（按 OSC 7501 上报 working / blocked / idle）验证状态和事件。
- 验收：契约套件在真实 hc 0.1.18 上全部通过；版本不符被拒；测试结束没有残留终端。

### M2.4 roles：Assignment 启动编译、默认角色包（Pi）

- 在 M1.8 的 `compileLaunch` 基础上，增加"为某个 Assignment 启动"的编译：输入 Role 定义、启动配置、Card MCP 地址、运行目录；输出 CLI 命令、参数、需要写的文件和包装脚本。三家的做法以 `docs/research/0.4-mcp-harness.md` §3 的实测草稿为准：
  - Claude Code：`--strict-mcp-config --mcp-config <运行目录>/mcp.json`（Header 用 `${MCP_TOKEN}`），`--append-system-prompt-file <运行目录>/core.md`，显式放行 Card MCP 工具，关闭自动更新；
  - Codex：`CODEX_HOME=<运行目录>/codex`，`bearer_token_env_var="MCP_TOKEN"`，`model_instructions_file` 指向 core.md（它会替换模型指令，core.md 要包含完整的基础协议），逐个工具 `approval_mode="approve"`；
  - Pi：`PI_CODING_AGENT_DIR=<运行目录>/pi`，Header 引用环境变量，`--append-system-prompt`；不要用 `--no-extensions`。
- MCP 配置和其他文件里**不出现 Token 明文**，只有变量名或占位符。
- 默认角色包：`pm`、`coder`、`reviewer` 三个角色的 Core Prompt，必须包含 §6.3 的 Agent 侧协议；PM 验收也用 `pm` 角色（见 §6 决定）。
- 验收：三家各有编译结果的快照测试；生成的文件里没有 Token 明文；Core Prompt 包含 §6.3 的每一条。

### M2.5 git-service / git-transport：本地基础 clone 与 worktree（Codex）

- git-transport 的本地实现：从项目登记的本地仓库建基础 clone（`git clone --no-local` 或等价方式，避免和源仓库共享对象导致误删），按需 fetch。
- git-service：`ensureWorktree(assignment)`：分支 `agent/<card>/<work_item>`，从 `base_branch` 的当前 SHA 建，记录 `base_sha`；已存在则复用（同一 Assignment 再次启动不重建）；`readonly` 角色按 SHA 建 detached worktree（§12.4）。
- 不实现删除（M4），但要提供"worktree 是否有未提交修改"的查询，供以后清理使用。
- 验收：在临时目录的真实 Git 仓库上测试新建、复用、只读 worktree；分支名和路径符合 §12.2；不 push、不碰源仓库的检出分支。

### M2.6 组装：一键启动和端到端（Pi）

- `cardigan assignment start <A-n>`、`cardigan assign … --start`、`cardigan assignment stop <A-n>`（release 终端，不删 worktree）、`cardigan assignment attach <A-n>`（打印 `human_entry`）。
- 按 §4 的流程组装 M2.2–M2.5；失败时按第 9 步回收。
- mcp-server：Assignment 第一次通过认证的工具调用时执行 `acknowledgeRun`（单独的写事务，幂等）。
- 端到端测试：真实 server + 真实 hc（独立 session）+ 一个假 Agent 程序（读 `MCP_TOKEN`，调用 `whoami`、`get_card`，再按 OSC 7501 上报 idle）。验证：worktree 建在约定路径和分支上；终端带正确的名字和标签；运行目录里没有残留的 token 文件；Run 依次经过 queued → dispatched → running；coder 的工作项进入 `in_progress`；重复执行 start 被拒（已有未结束的 Run）。
- README 补充一键启动的用法。

### M2.7 Agent 专用系统用户（Codex）

- §13.4：第一版就要求 Agent 以专用系统用户 `agent` 运行，它没有任何机器的 SSH 密钥、没有 sudo、碰不到你的个人文件和 Cardigan 的数据目录。
- 交付一个安装脚本（需要用户用 sudo 执行）：建 `agent` 用户、给它装 hc 0.1.18、配置只允许主机用户通过 SSH 登录它的一把专用密钥。
- 运行时配置支持把 `local` 机器接到 `hc machine add agent@localhost`（经 SSH 的 herdr-core 机器），这样本机和多机走同一条代码路径（§11.2 最后一句）。运行目录、worktree 根目录在这种模式下要放到 `agent` 用户可读、但它读不到 Cardigan 数据库的位置。
- 开发和测试时仍可以用"当前用户直接运行"的模式，但 server 启动时要醒目地提示没有隔离。
- 验收：脚本可重复执行；`agent` 用户读不到 Cardigan 数据目录；一键启动在 `agent` 模式下跑通（由用户执行 sudo 部分后，Claude 实测）。

### M2.T1、M2.T2 交叉验收

- **M2.T1（Pi）**：domain 启动命令（M2.1）、Runtime 契约（在内存假实现和真实 hc 上各跑一遍）、worktree（M2.5）。
- **M2.T2（Codex）**：Role 版本（M2.2）、启动编译（M2.4，重点：文件里没有 Token 明文、Core Prompt 含 §6.3）、一键启动端到端（M2.6，重点：失败回收、重复启动、Run 状态推进）。

### M2.S 真实 Agent 冒烟（Claude）

M2.6 合并后，用真实 Codex（D3：coder 用 Codex）从一张开发卡一键启动 coder，确认它通过 `whoami`、`get_card` 读到任务，并调用 `get_updates`、`ack_events`。结果写进本计划的附录。这是 M2 验收的最终依据；自动化测试里的假 Agent 只验证管道。

## 6. 本计划确定的事项

| 事项 | 决定 | 来源 |
|---|---|---|
| PM 验收由谁来做 | 每张卡的 PM 验收工作项单独指派一个工作项级的 `pm` Assignment（独立会话，Claude Code Opus），不交给常驻的 PM Ops | 用户 2026-11-05："不用担心成本，哪个效果好就用那个，可以多开 PM 会话"。独立会话只装这张卡的上下文，符合 §9.3"只有验证型工作项的 Assignment 能提交审核"；M1 已按此实现 |
| D9 运行时基线 | 维持 herdr-core，锁 0.1.18 | ADR 0001 复核记录（2026-11-05） |
| Run 开始时推进工作项状态 | `acknowledgeRun` 在 Agent 第一次 MCP 调用时推进 | M1 计划 §6 的后续事项 |
| Token 何时签发 | 每次启动 Agent 会话时由主机签发，旧的作废 | 开发方案 §9.1"Session 被替换时作废"；M1.6b 审核 |

## 7. 后续事项（来自 M1，M2 不处理）

| 事项 | 处理 |
|---|---|
| macOS 主机上的 core 管理 Linux 工作机（反向拓扑）还没实测 | Phase 2 开工前补测；需要用户授权一个测试账号的 SSH 登录 |
| 附件先落盘后校验权限，越权上传会留下没人引用的文件 | 以后加写入前的只读预校验 |
| Office / Ops 靠最新 Token 的工具范围区分，没有专门字段 | 改 Assignment 模型时加字段 |
| 每条命令都加载整个项目快照 | 数据量变大时优化 |

## 8. M2 完成的标准

- M2.1–M2.7、M2.T1、M2.T2 全部合并；M2.S 冒烟通过并记录。
- 开发方案 §16 M2 的验收项有对应的自动化测试（假 Agent）和一次真实 Agent 的冒烟记录。
- Claude 根据 M2 的实际情况写 M3 的任务计划。
