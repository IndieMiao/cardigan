# Phase 1 · M1 任务计划：领域模型、事件存储、Card MCP

- 版本：v3（2026-11-04）：调整分工，M1.5 改由 Pi 做
- v2（2026-11-04）：新增 M1.8（提前做的 `cardigan launch`）
- v1（2026-11-04）
- 对应：开发方案 v0.6 §16 Phase 1 M1
- M1 的验收（开发方案 §16）：状态机和不变量的单元测试；MCP 契约测试；伪造身份、非法状态迁移会被拒绝。
- M1 不做：运行时和门铃（M2、M3）、Git 拉取与校验（M4，M1 用一个桩代替）、Web 界面（M5）、多机。

## 1. 任务总览

| 任务 | 内容 | 实现 | 验收测试 | 依赖 | 分支 |
|---|---|---|---|---|---|
| M1.1 | domain：类型、编号、端口 | Codex | — | 无 | `feat/m1-domain-types` |
| M1.2 | domain：状态机与派生计算 | Codex | Pi（M1.T1） | M1.1 | `feat/m1-domain-states` |
| M1.3 | domain：命令与不变量 | Codex | Pi（M1.T1） | M1.2 | `feat/m1-domain-commands` |
| M1.4 | store：SQLite、迁移、事件存储、游标、幂等 | Pi | Codex（M1.T2） | M1.1 | `feat/m1-store` |
| M1.5 | mcp-server：传输、认证、只读工具 | Pi | Codex（M1.T3） | M1.2、M1.4 | `feat/m1-mcp-core` |
| M1.6 | mcp-server：写入类工具 | Codex | Codex 不能验收自己的实现，由 Pi 补充 M1.T3 中写入类工具的用例 | M1.3、M1.5 | `feat/m1-mcp-tools` |
| M1.7 | apps/server、apps/cli 组装，端到端流程 | Pi | Codex 审读 | M1.6 | `feat/m1-server-cli` |
| M1.T1 | domain 契约测试（§4.4、§4.5） | Pi | — | M1.3 | `test/m1-domain-contract` |
| M1.T2 | store 验收测试 | Codex | — | M1.4 | `test/m1-store` |
| M1.T3 | MCP 契约测试 | Codex（M1.5 部分）、Pi（M1.6 部分） | — | M1.6 | `test/m1-mcp-contract` |
| M1.8 | 接入点、启动配置和 `cardigan launch`（提前做） | Pi | Claude 审核 | 无 | `feat/m1-launch` |

建议顺序：

```
M1.1 ──┬─ M1.2 ─ M1.3 ─┬─ M1.T1（Pi）
       │               │
       └─ M1.4（Pi） ───┴─ M1.5 ─ M1.6 ─┬─ M1.T3（Pi）
              └─ M1.T2（Codex）          └─ M1.7（Pi）
```

M1.2 和 M1.4 可以并行：Codex 做 M1.2，Pi 做 M1.4。

分工调整（v3，2026-11-04）：M1.4 合并后 Pi 会空闲，所以 M1.5 改由 Pi 做，依赖从 M1.3 放宽到 M1.2（只读工具不需要 M1.3 的命令），`heartbeat` 挪到 M1.6。M1.T3 按"实现和验收测试由不同模型完成"拆开：M1.5 的契约测试由 Codex 写，M1.6 的由 Pi 写。

M1.8 不依赖其他任务，用户要求提前做：Pi 在 Codex 做 M1.1 时先做 M1.8，做完再接 M1.4。

## 2. 通用约定

- 开工前先读 `AGENTS.md`、本计划的 §2、§3 和对应任务，以及开发方案 §4、§5、§6、§9、§14。
- 依赖方向（§20.2）已由 `pnpm check:deps` 强制执行。`domain` 不引用任何包，也不做 IO：时间、编号、文件和 Git 一律通过端口注入。
- 修改 `packages/domain` 必须附带契约测试（AGENTS.md）。
- 每个 PR 控制在几百行以内，测试和代码一起提交；合并前 `pnpm build && pnpm test && pnpm lint && pnpm check:deps` 必须全部通过。
- 提交信息和 PR 标题用英文（Conventional Commits），PR 描述用中文，按 AGENTS.md 的格式写。
- 合并后复用 worktree 时，执行 `git fetch origin && git switch -c <新分支> origin/main`。
- 验收测试由另一个模型写，在实现 PR 合并之后另开 PR，只加测试。发现失败时在 PR 里列出，由实现者修复。

## 3. 技术选择（本计划确定）

| 项 | 选择 | 理由 |
|---|---|---|
| SQLite 驱动 | Node 24 内置的 `node:sqlite`（`DatabaseSync`） | 不用编译原生模块；已在项目的 Node 24.22 上实测可用。只在 `store` 内使用，以后换驱动不影响其他包 |
| 迁移 | `packages/store/migrations/NNNN_<name>.sql`，加一个简单的执行器，版本记在 `schema_version` 表 | 足够简单，Agent 容易写对 |
| 查询 | 手写 SQL，加少量类型化的辅助函数；不引入 ORM | 表不多，ORM 的收益抵不上学习和调试成本 |
| MCP | 官方 `@modelcontextprotocol/sdk`（锁版本，0.4 用的是 1.32.2）；工具参数用 zod 描述 | 0.4 已验证三个 Harness 都能接入 |
| HTTP | M1 直接用 `node:http` 承载 MCP 端点，和 0.4 的 spike 一样 | Web API 的框架到 M5 再定 |
| 编号 | 事件 id 用 ULID；业务对象用项目内递增的可读编号（见 §4.1） | 门铃和时间线里要能直接读、直接引用 |
| 配置 | 环境变量：`CARDIGAN_DATA_DIR`（默认 `.data/`，已被 git 忽略）、`CARDIGAN_MCP_PORT`；只监听 `127.0.0.1` | 第一版是单机 |

## 4. 设计要点（所有任务共用）

### 4.1 编号

| 对象 | 格式 | 范围 |
|---|---|---|
| Card | `C-<n>` | 项目内递增 |
| WorkItem | `W-<n>` | 项目内递增 |
| Assignment | `A-<n>` | 项目内递增 |
| Run | `R-<n>` | 项目内递增 |
| Delivery | `D-<n>` | 项目内递增 |
| Review | `V-<n>` | 项目内递增 |
| Decision | `q(<n>)` | 项目内递增，不复用 |
| HumanAction | `h(<n>)` | 项目内递增，不复用 |
| TimelineEntry | `C-<n>#<m>` | `m` 为卡片内递增 |
| Event | ULID；另有 `seq` | `seq` 在卡片内单调递增；项目级事件在项目内单调递增 |

编号由 `IdAllocator` 端口分配，在 store 的同一事务里递增。

### 4.2 命令模型

domain 只提供纯函数：输入"当前状态 + 调用者身份 + 参数"，输出"实体变更 + 事件 + 时间线条目"，或者一个带错误码的拒绝。store 在**一个事务**里写入全部变更和事件；之后才轮得到门铃（不变量 7，门铃本身在 M3）。

调用者身份 `Actor` 只来自 Token（§9.1），参数里自报的身份一律忽略。

### 4.3 错误码

拒绝统一返回 `{code, message, details?}`。至少包括：`unauthorized`、`forbidden_tool`、`not_found`、`illegal_transition`、`invariant_violation`、`validation_failed`、`idempotency_conflict`、`stale_target`。MCP 层原样透出，契约测试按错误码断言。

### 4.4 端口（domain 定义，其他包实现）

- `Clock`：当前时间。
- `IdAllocator`：按对象类型分配可读编号。
- `DeliveryVerifier`：校验交付的 `subject`。M1 用一个可配置的桩：默认接受，测试里可以设为拒绝。M4 换成 §12.3 的实现。
- `AttachmentStore`：按 sha256 存取文件内容。M1 写到 `CARDIGAN_DATA_DIR/attachments/`。
- 各实体的仓储接口和 `UnitOfWork`（事务）。

## 5. 各任务说明

### M1.1 domain：类型、编号、端口（Codex）

范围：

- §4.3 全部实体的 TypeScript 类型：Card、WorkItem、Assignment、Run、TimelineEntry、Delivery、Review、Decision、HumanAction、Event、Cursor、Attachment，以及 M1 需要的最小 Role 引用：`role_id`、`role_version`、`allowed_tools[]`、`capabilities[]`。
- 各状态的枚举（§4.4）、本计划 §4.1 的编号格式及解析函数、§4.3 的错误码、§4.4 的端口接口。
- 卡片模板的类型，以及第一版唯一的模板"开发卡"（D4）：工作项为开发（produce，coder，必需）、代码审核（verify → 开发，reviewer，必需）、PM 验收（verify，pm，必需）；完成申请的审核者为 PM。

验收：编号的格式化与解析有单元测试（包括非法输入）；`pnpm check:deps` 通过（domain 没有引用任何东西）。

### M1.2 domain：状态机与派生计算（Codex）

范围：

- §4.4 每个状态机写成迁移表，加一个 `transition(from, event) → to | illegal_transition` 函数：WorkItem（产出型、验证型）、Delivery、Decision、HumanAction、Run、Assignment（业务状态和运行状态）。
- 卡片状态：`backlog`、`todo` 由 PM 设置；`in_progress`、`review` 由工作项推导；`done` **只能**经由完成申请审核通过得到。
- 派生计算：
  - Review 的 `verdict` 和 `blocking`（§4.3）：存在 `must_fix` 且不是 `pre_existing` 的问题就是驳回；`critical` 没有 `proof` 时按 `major` 处理；`recheck_required` 为真且没有必须修复的问题时，结果为有条件通过；其余为通过。`blocking` 等于是否驳回。
  - Review 的 `stale`：交付有新版本，或者 `target_sha` 和交付的 `subject` 不一致时为真。
  - Attachment 的 `approval_status`：由 `basis` 指向的 Decision 状态推导。
  - Card 的 `review_matrix`：每个交付 × 每个验证型工作项 → 针对当前 SHA 的最新结论。
- 审核轮次：验证型工作项带 `max_review_rounds`（默认 3），超出时迁移到 `waiting_decision`（§4.4）。

验收：每张迁移表里允许和禁止的迁移各至少一个测试；派生计算的每条规则至少一个测试。

### M1.3 domain：命令与不变量（Codex）

范围：§9.2 每个工具对应的命令处理函数，以及 §9.3、§4.5 中可以在 M1 检查的规则。

| 命令 | 规则 |
|---|---|
| `post_comment` | 从正文里识别 `C-n`、`C-n#m`、`q(n)`、`h(n)`、`D-n`、PR 链接，写入 `refs[]`；`supersedes` 只能指向同一作者的条目 |
| `report_blocker` | 工作项进入 `blocked`；`needs=human` 时提示改用 `request_human_action` 或 `request_decision` |
| `request_decision` | 分配 `q(n)`；`decider` 必填；花钱、账号、权限、删除数据这几类，`decider` 必须是人；`blocking=true` 时受影响的工作项进入 `waiting_decision` |
| `record_decision` | 只允许 pm-office 调用；`raw_quote` 必填；支持 `batch` 和 `via_chain` |
| `request_human_action` | 分配 `h(n)`；受影响的工作项进入 `blocked`；完成（由 M1.7 的 CLI 或 M5 的界面操作）后解除 |
| `submit_delivery` | 只有该工作项的 Assignment 能提交；`subject`、`requested_verifiers` 必填；`summary` 不超过 160 字；调用 `DeliveryVerifier`；新交付让旧交付变为 `superseded`，并让针对旧版本的审核结论失效；验证型工作项回到 `ready` |
| 完成申请（`submit_delivery`，`kind=card_completion`） | 只接受主产出工作项负责人的提交；附上前置条件的校验结果，未满足的条件必须出现在 `known_gaps` 里；卡片进入等待审核 |
| `submit_review` | 只有验证该交付的验证型工作项的 Assignment 能提交；`target_sha` 必须等于交付的 `subject`，否则返回 `stale_target`；`verdict` 和 `blocking` 由 M1.2 计算，不接受调用者传入；驳回时产出型工作项进入 `changes_requested` |
| 完成申请的审核 | 通过：卡片变为 `done`；驳回：卡片回到 `in_progress` |
| `upload_attachment` | `kind=artifact` 时 `basis` 必须指向存在的 Decision；必须指定 `attach_to` |
| `heartbeat`、`finish_run` | 只能针对自己的 Run；`finish_run` 结束 Run，并记录结果和摘要 |
| PM 工具：`create_card`（按模板生成工作项）、`create_work_item`、`assign` | 只允许 PM 角色调用。`assign` 在 M1 只建 Assignment 记录和 Token（`machine_id=local`），不启动任何东西 |

不变量（§4.5）在 M1 的覆盖范围：

- **M1 必须覆盖**：1、2、5、8、10、11、12、13、14。
- **在后续里程碑覆盖**：3（路由，M3）、4（写锁，M3）、6（机器固定，M2）、7（先持久化再按门铃：M1 保证事件和变更在同一事务里写入，门铃部分在 M3）、9（拉取 SHA，M4）。

验收：每条命令的正常路径和每条拒绝规则至少各一个测试；M1 要覆盖的每条不变量至少一个测试，测试名里写明不变量编号。

### M1.4 store：SQLite、迁移、事件存储、游标、幂等（Pi）

范围：

- 用 `node:sqlite` 打开 `CARDIGAN_DATA_DIR/cardigan.db`，启用 WAL 和外键约束。
- 迁移执行器和第一份迁移：建立 M1.1 全部实体的表、`events`、`cursors`、`idempotency`、`id_counters`、`tokens`。
- `UnitOfWork`：在一个事务里写入命令产生的全部变更和事件；任何一步失败就整体回滚。
- 事件存储：每张卡片的 `seq` 单调递增、不重复（用唯一约束保证）；`get_updates(card_id?, since_seq?)` 按 `seq` 返回事件和时间线条目；`ack_events` 只能向前推进游标。
- 幂等：表 `idempotency(assignment_id, key, request_hash, response)`。同一个键、同样的请求内容，返回上次的结果；同一个键、不同的内容，返回 `idempotency_conflict`。
- Token：只保存 sha256 哈希；记录 `assignment_id`、`role_version`、`allowed_tools[]`、是否已作废。
- `IdAllocator` 的实现：按项目和对象类型递增，和业务写入在同一事务里。

验收：从空库迁移成功、重复执行不出错；事务中途失败时没有任何写入残留；同一张卡片连续写入时 `seq` 连续且不重复；游标不能后退；幂等的三种情况（首次、相同重放、冲突）都有测试。

### M1.5 mcp-server：传输、认证、只读工具（Pi）

范围：

- 无状态的 Streamable HTTP 端点 `/mcp`，只监听 `127.0.0.1`，开启 DNS 重绑定防护；可以参考 `spikes/0.4-mcp/server.ts`。
- Bearer Token 认证：用常量时间比较；缺少或错误时返回 401；Token 已作废时同样返回 401。认证通过后得到 `Actor`（`assignment_id`、角色、允许的工具）。
- 按角色注册工具：不在 `allowed_tools` 里的工具，既不出现在工具列表里，调用时也返回 `forbidden_tool`。
- 只读工具：`whoami`、`get_card`、`get_updates`、`ack_events`。`get_card` 里的卡片状态等派生字段用 M1.2 的派生计算；`ack_events` 直接调用 store。
- 日志里不记录 Token 和请求正文，只记方法、工具名、调用者和结果码。

验收：缺少 Token、Token 错误、Token 已作废三种情况都返回 401；参数里自报的身份被忽略，`whoami` 只返回 Token 对应的身份；角色没有权限的工具调用不了。

### M1.6 mcp-server：写入类工具（Codex）

范围：把 M1.3 的全部命令（含 `heartbeat`）接成 MCP 工具，参数用 zod 描述；写入类工具都接受 `idempotency_key`；`upload_attachment` 第一版用 base64 传文件内容，单个文件不超过 10MB，内容写入 `AttachmentStore`。

验收：每个工具至少一个正常调用测试；domain 的每类错误码都能从 MCP 层原样拿到；同一个 `idempotency_key` 重放不会产生第二个交付或第二条事件。

### M1.7 apps/server、apps/cli 组装，端到端流程（Pi）

范围：

- `apps/server`：读取配置，组装 store 和 mcp-server，启动 MCP 服务；收到 SIGTERM 时正常关闭。
- `apps/cli`：
  - `cardigan init`：建库、执行迁移；
  - `cardigan project create`；
  - `cardigan role add`：M1 只有最小的角色定义：`allowed_tools`、`capabilities`；
  - `cardigan card create --template dev`：按"开发卡"模板建卡；
  - `cardigan assign`：建 Assignment，并签发 Token。Token 只打印一次，不写入任何文件；
  - `cardigan human-action done h(n)`：标记你执行完了某个操作（M5 之前的临时入口）。
- 端到端测试：启动 server，用 MCP SDK 的客户端扮演 coder、reviewer、pm 三个 Agent，走完下面的流程：
  1. pm 建卡并指派 coder 和 reviewer；
  2. coder 发评论，然后提交交付 D-1；
  3. reviewer 驳回 D-1；
  4. coder 提交 D-2，D-1 变为 `superseded`；
  5. reviewer 用 D-1 的 SHA 提交审核，被拒绝（`stale_target`）；改用 D-2 的 SHA，审核通过；
  6. coder 提交完成申请；pm 审核通过，卡片变为 `done`。

  过程中还要验证：用 reviewer 的 Token 提交交付会被拒绝；对同一个 `idempotency_key` 重放不会产生重复的事件。

验收：端到端测试通过；`pnpm build && pnpm test && pnpm lint && pnpm check:deps` 全部通过；README 补充本地启动方法。

### M1.8 接入点、启动配置和 `cardigan launch`（Pi）

依据：开发方案 §10.2 的"接入点与启动配置"。这项本属于 M2，用户要求提前：先让人手动启动 CLI 时能用上，替代现有的 shell 别名。M2 再把它接到 Agent 的自动启动上。

范围：

- `packages/roles`：配置的 schema 和"编译"逻辑，写成**纯函数**：输入启动配置、接入点、密钥值，输出 `{command, args, env, files}`。其中 `files` 是需要临时生成的文件，例如 Claude Code 的 settings 文件。
- `apps/cli`：负责所有 IO。读取配置和密钥，写临时文件，启动 CLI。
- 配置文件为 `~/.config/cardigan/launch.yaml`，可以用 `CARDIGAN_CONFIG_DIR` 改目录。用 YAML 是为了方便手改，可以引入 `yaml` 包。格式示意：

  ```yaml
  providers:
    of:
      harness: claude-code
      env:                       # 不含密钥的环境变量
        ANTHROPIC_BASE_URL: https://example.invalid
      secret_env:                # 变量名 → secrets.env 里的键
        ANTHROPIC_AUTH_TOKEN: OF_AUTH_TOKEN
  profiles:
    claude-of:
      harness: claude-code
      provider: of
      permission_mode: bypassPermissions
      auto_update: true          # 人手动用时可以保留自动更新；Agent 用的配置默认关闭
    codex-yolo:
      harness: codex
      args: ["--yolo", "--no-alt-screen"]
    pi-deepseek:
      harness: pi
      provider_flag: deepseek
      model: deepseek-flash
  ```

- 密钥放在 `~/.config/cardigan/secrets.env`，每行一个 `KEY=VALUE`。文件权限不是 600 时拒绝读取，并提示修复命令。
- 命令：
  - `cardigan launch <profile> [--cwd <dir>] [-- <透传给 CLI 的参数>]`：在当前终端启动 CLI，继承标准输入输出，退出码原样返回；
  - `cardigan launch --list`：列出启动配置；
  - `cardigan launch <profile> --print`：只打印实际命令和环境变量，密钥显示为 `***`；
  - `cardigan launch check <profile>`：检查 CLI 是否已安装、版本号、需要的密钥是否齐全、密钥文件权限；
  - `cardigan launch import-claude-settings <settings.json> --provider <name>`：把一个现有的 Claude Code settings 文件转成接入点定义。名字里含 `TOKEN`、`KEY`、`SECRET` 的变量写进 `secrets.env`，其余写进 `launch.yaml`；**不打印任何密钥**。
- 各 Harness 的生成方式：
  - Claude Code：在 `$XDG_RUNTIME_DIR/cardigan/`（没有就用 `~/.cache/cardigan/run/`）下生成临时 settings 文件，权限 600，用 `--settings` 传入，CLI 退出后删除。`auto_update: false` 时加上关闭自动更新的环境变量（`DISABLE_AUTOUPDATER=1`）；
  - Codex：只拼参数（`--profile`、`-c key=value`、`-m`、额外参数），不改 `~/.codex`；
  - Pi：`--provider`、`--model`，需要时设置 `PI_CODING_AGENT_DIR`。

不做：MCP 配置注入、Assignment 运行目录（M2）；写数据库；修改用户已有的 shell 配置、`~/.claude`、`~/.codex`、`~/.pi`。

验收：

- 编译逻辑的单元测试覆盖三种 Harness，并且全部使用虚构的测试数据，**不读取用户真实的配置和密钥**；
- `--print` 的输出里不出现任何密钥值；
- `secrets.env` 权限是 644 时拒绝读取；
- 临时 settings 文件的权限是 600，CLI 退出后被删除；
- `import-claude-settings` 用测试用的假 settings 文件验证：密钥进入 `secrets.env`，其余进入 `launch.yaml`；
- README 补充用法，以及从现有别名迁移的步骤。迁移由用户自己执行，Agent 不碰用户真实的配置。

### M1.T1、M1.T2、M1.T3：交叉验收测试

由另一个模型只看本计划和开发方案来写，不参照实现代码的内部细节，只调用公开接口：

- **M1.T1（Pi）**：domain 的契约测试，覆盖 §4.4 每张迁移表和 M1 要覆盖的每条不变量。
- **M1.T2（Codex）**：store 的验收测试，覆盖 M1.4 的全部验收项，另加并发写入下 `seq` 不重复。
- **M1.T3**：MCP 的契约测试，覆盖 M1.5 和 M1.6 的全部验收项，以及开发方案 §16 M1 的验收："伪造身份、非法状态迁移会被拒绝"。M1.5 的部分由 Codex 写，M1.6 的部分由 Pi 写。

## 6. M1 完成的标准

- M1.1–M1.8、M1.T1–M1.T3 全部合并。
- 开发方案 §16 M1 的验收项都有对应的测试。
- Claude 根据 M1 的实际情况，写 M2 的任务计划；M2 开工前按 D9 复核运行时基线（ADR 0001）。
