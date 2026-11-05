# Phase 1 · M4 任务计划：Git 服务（交付固定、中心合并、清理、对账）

- 版本：v3（2026-11-05）：新增 M4.2b（大仓库：长超时、agent-ssh 下用增量推送代替整仓 bundle），排在 M4.4 之前；M4.T1 提前到 M4.4 之前
- v2（2026-11-05）：M4.3 改由 Pi 实现（Pi 先做完 M3 收尾，Codex 还排着 M4.1 修改和 M3.T2），交叉验收相应对调；M4.4 补充释放后 Token 立即失效的要求
- v1（2026-11-05）
- 对应：开发方案 §16 Phase 1 M4；§12 Worktree 与 Git 服务；§4.4 状态机、§4.5 不变量 9、13、14；§14 安全模型
- M4 的验收（开发方案 §16）：**伪造的或不在该分支上的 SHA 被拒；有未提交修改的 worktree 不被静默删除；孤儿 worktree 能被发现。**
- 只做 `machine_id=local`，两种运行模式（同用户、agent-ssh）都要支持。M4 不做：向验证方所在机器推送 SHA（§12.4，Phase 2 多机）；合并后自动推送到 GitHub 等外部平台；合并后的自动构建或测试。
- 前提：M2 已合并（基础 clone、worktree、agent-ssh 的 bundle 和 Agent 执行入口）；M3 的 Router、Dispatcher 已合并（合并冲突通过它们唤醒 coder）。

## 0. 已经拍板的事项（2026-11-05 用户确认）

| 事项 | 决定 |
|---|---|
| 中心仓库放在哪 | 主机数据目录下的 bare 仓库 `<CARDIGAN_DATA_DIR>/central/<project_id>.git`，从登记源（`projects.repo_path`）克隆而来，主机独占。Agent 的基础 clone 改为从中心仓库取基线；交付固定和合并只写中心仓库。**Cardigan 从不写用户登记的工作仓库**，合并结果由用户自己 `git fetch` 回去。M2 已建的基础 clone 允许重建（目前没有真实项目在跑） |
| 合并后推送到外部平台 | M4 不做，只更新中心仓库的基线分支。自动推送要求主机持有推送凭据，以后单独拍板 |
| 卡片什么时候 done | **合并成功才 done**。完成审核通过后卡片进入新状态 `awaiting_merge`（已验收、待合并）；按卡片模板决定是否需要用户确认合并；冲突时卡片回到 `in_progress`，给原 coder Assignment 开 `fix` Run |

## 1. 任务总览

| 任务 | 内容 | 实现 | 验收测试 | 依赖 | 分支 |
|---|---|---|---|---|---|
| M4.1 | domain + router：卡片 `awaiting_merge`、合并确认、合并结果、`release`、清理决策；路由新增事件 | Codex | Pi（M4.T1） | 无 | `feat/m4-domain-merge` |
| M4.2 | git：中心仓库、登记源同步、基础 clone 改从中心取基线、交付校验与固定、备份拉取 | Codex | Pi（M4.T1） | 无 | `feat/m4-central-repo` |
| M4.2b | git：大仓库支持（可配置的长超时；agent-ssh 下基线和固定交付改用主机推送，经 Agent 执行入口跑 receive-pack，只传增量） | Codex | Pi（M4.T1） | M4.2 | `fix/m4-large-repos` |
| M4.3 | git：bare 仓库内合并、删除 worktree、worktree 清单与对账 | Pi | Codex（M4.T2） | M4.2 | `feat/m4-merge-cleanup` |
| M4.4 | 组装：交付校验接进 MCP、合并执行循环、release 后清理、对账和备份循环、CLI | Pi | Codex（M4.T2） | M4.1–M4.3 | `feat/m4-assembly` |
| M4.T1 | 交叉验收：M4.1 状态机和命令、M4.2 的 Git 行为（M4.2b 合并后补它的部分） | Pi | — | M4.1、M4.2 | `test/m4-git` |
| M4.T2 | 交叉验收：M4.3 的 Git 行为、M4.4 端到端 | Codex | — | M4.3、M4.4 | `test/m4-e2e` |
| M4.S | 真实冒烟：一张卡从交付走到合并（agent-ssh 模式，用户装好之后） | Claude | — | M4.4、M3.S | — |

```
M4.2（Codex，已合并） ─ M4.3（Pi） ─────────┐
M4.1（Codex） ──────────────────────────────┼─ M4.4（Pi） ─ M4.T2（Codex） ─ M4.S
                                            └─ M4.T1（Pi）：M4.1、M4.2 合并后
```

v1 把 M4.1–M4.3 都排给了 Codex，因为当时 Pi 还在做 M3 收尾。v2：Pi 已做完 M3 收尾，M4.3 改给 Pi；M4.1、M4.2 仍由 Codex 实现、Pi 验收（M4.T1）；M4.3、M4.4 由 Pi 实现、Codex 验收（M4.T2）。

## 2. 通用约定

沿用 M2 计划 §2、M3 计划 §2：每个 PR 约 800 行以内；domain 测试从 `createCard` + `assign` 的真实状态出发；验收测试只看计划和开发方案、只用公开接口、每条用例做注入验证，不符合计划的用 `test.fails` 标出；不在代码和测试里写个人路径、机器名、IP。

Git 测试一律在临时目录里用真实 `git` 建仓库，不 mock git 的输出；需要 agent-ssh 的地方用假的 Agent 执行入口（记录每次调用的参数和工作目录），断言主机自己从不在 Agent 可写的目录里执行 git。

## 3. 关键设计（本计划确定）

### 3.1 仓库布局

| 仓库 | 路径（默认，可配置根目录） | 所有者 | 用途 |
|---|---|---|---|
| 登记源 | `projects.repo_path`（用户的仓库） | 用户 | **只读**。中心仓库从它克隆，之后只 fetch 它的基线分支 |
| 中心仓库 | `<data>/central/<project_id>.git`（bare） | 主机 | 基线分支、交付 ref、备份 ref、合并结果 |
| 基础 clone | `<data>/agent/repos/<project_id>`（M2） | 同用户模式：主机；agent-ssh：agent | 来源改为中心仓库 |
| worktree | `<data>/agent/worktrees/<project_id>/<assignment_id>`（M2） | 同上 | 不变 |

中心仓库里的 ref：

| ref | 含义 | 写入规则 |
|---|---|---|
| `refs/heads/<base_branch>` | 基线（合并结果） | 只按"比较后更新"写（`update-ref <ref> <new> <old>`），从不强推 |
| `refs/cardigan/source/<base_branch>` | 登记源基线的最近一次快照 | 每次同步强制更新 |
| `refs/cardigan/incoming/<assignment_id>` | 校验时拉来的 Assignment 分支顶端 | 每次校验强制更新 |
| `refs/cardigan/candidates/<assignment_id>/<sha>` | 已通过校验、尚未固定的 SHA，防止对象被回收 | 只创建 |
| `refs/cardigan/deliveries/<delivery_id>` | 固定的交付 | **只创建，从不覆盖**；已存在且 SHA 相同视为成功，不同则报错 |
| `refs/cardigan/backups/<machine_id>/agent/*` | 定期备份的半成品 | 每次备份强制更新；失败不动 |

### 3.2 登记源和中心仓库的同步

- 中心仓库不存在时：`git clone --bare --no-local <登记源> <临时目录>`，校验后改名发布（沿用 M2 的"经临时目录发布"做法），并在中心仓库的配置里记下登记源路径；之后登记源路径变了就拒绝，要求显式重建。
- 同步：`fetch <登记源> +refs/heads/<base_branch>:refs/cardigan/source/<base_branch>`，然后比较：
  - 中心基线是登记源快照的祖先 → 快进中心基线（比较后更新）；
  - 登记源快照是中心基线的祖先 → 不动（中心领先，说明用户还没把合并结果拉回去）；
  - 分叉 → 不动，返回 `diverged`，由组装层放进 `cardigan attention`。**从不强制覆盖任何一边。**
- 何时同步：建新的写入型 worktree 之前（取最新基线）、合并之前。

### 3.3 交付校验与固定（§12.3）

`prepareDelivery` 在事务之前调用 `DeliveryVerifier.verify(subject, assignment)`，那时还没有 delivery_id，所以分两步：

1. **校验（事务前，M4.2 的 `GitDeliveryVerifier`）**：
   - `subject.kind` 不是 `git_head` 时不做 Git 校验（附件、文档版本另有规则），返回空证据；
   - `git_head` 必须是完整的 40 位（或 SHA-256 仓库的 64 位）小写十六进制；Assignment 必须有 `branch` 和 `worktree_path`（写入型），否则拒绝；
   - 把 **数据库里记录的** Assignment 分支（不用 Agent 提交的参数）从基础 clone 拉到 `refs/cardigan/incoming/<assignment_id>`；拉取失败就拒绝；
   - 检查 `cat-file -t <sha>` 是 `commit`，并且 `merge-base --is-ancestor <sha> refs/cardigan/incoming/<assignment_id>`；任何一项不过就拒绝，错误信息说明是"不是 commit"还是"不在该分支上"；
   - 通过后创建 `refs/cardigan/candidates/<assignment_id>/<sha>`，返回证据 `{ kind: "commit", details: { sha, branch, base_sha, commits_ahead } }`。
2. **固定（事务提交后，M4.4 组装）**：`pinDelivery(project, delivery_id, sha)` 创建 `refs/cardigan/deliveries/<delivery_id>`。这一步失败不回滚交付（交付已经提交），记日志；对账（§3.6）发现"有 `git_head` 交付但没有固定 ref"时，从 candidates 补上，补不上就放进 attention。

生产环境必须使用真实的校验器：M4.4 去掉 mcp-server 里"接受一切"的默认桩，`startMcpServer` 必须显式传入校验器；桩只留在测试支持代码里。

### 3.4 主机侧 Git 的安全规则（§14、HANDOFF 里 M2.7 的教训）

- 主机**只在自己拥有的仓库**（中心仓库）里以自己的身份执行 git。Agent 可写的仓库（agent-ssh 下的基础 clone 和 worktree）里的 `.git/config` 可以设置 `core.fsmonitor`、filter、hook 等任意命令，主机在里面跑 `git status`、`git fetch` 就会以主机身份执行它们。
- 从 Agent 仓库拉取：在中心仓库里执行 `git fetch`，远端用 Agent 仓库的本地路径，并通过 `--upload-pack` 让 `git-upload-pack` 经 M2.7 的 Agent 执行入口以 agent 身份运行。主机这一侧只接收 pack 数据，并开启 `transfer.fsckObjects=true`。
- 同用户模式没有账号边界，可以直接以本地路径拉取，但同样开启下面的加固参数。
- 中心仓库上的所有 git 调用：`GIT_CONFIG_NOSYSTEM=1`、`GIT_CONFIG_GLOBAL=/dev/null`（只用显式传入的配置），`core.hooksPath=/dev/null`，`protocol.allow=never` 且只放开 `file`，沿用 M2 去掉 `GIT_*` 环境变量的做法；合并提交的作者和提交者显式设置（默认 `Cardigan <cardigan@localhost>`，可配置）。
- 需要在 Agent 仓库里执行的操作（`worktree list`、`status`、`diff`、`worktree remove`、`branch -D`）在 agent-ssh 下一律经 Agent 执行入口；同用户模式直接执行。

### 3.5 合并（§12.5）

- **在中心 bare 仓库里合并，不检出文件**：对合并集合里的每个交付依次执行 `git merge-tree --write-tree <当前顶端> <交付 SHA>`，成功则 `git commit-tree <tree> -p <当前顶端> -p <交付 SHA>` 得到新顶端；全部成功后 `update-ref refs/heads/<base_branch> <新顶端> <旧顶端>`。不检出就不会运行 filter、hook 或 smudge，比 §12.5 原文的"集成 clone"更安全；§12.5 正文同步改成这一做法。本机 git 2.53 已实测支持 `merge-tree --write-tree`。
- 合并集合（M4.1 的纯函数 `mergePlan`）：卡片里每个 produce 工作项最新一份已接受、未被取代、`subject.kind=git_head` 的 code 交付，按工作项编号排序。交付 SHA 必须和 `refs/cardigan/deliveries/<id>` 一致，不一致就拒绝合并。
- 已经是基线祖先的交付跳过（重复执行合并是无操作）。
- 冲突：`merge-tree` 退出码 1 时，记下冲突文件列表，**不改任何 ref**，返回 `conflicted`。
- 比较后更新失败（期间基线被别的合并或同步推进）：返回 `stale`，由执行循环下一轮重算，不强写。
- 合并提交信息：`Merge <card_id>/<work_item_id> delivery <delivery_id>`，附上卡片标题。

### 3.6 Release、清理与对账（§12.6）

- **release**：卡片 done 或 cancelled 之后，系统释放该卡所有工作项级 Assignment（常驻 PM 不受影响）；人和 PM Ops 也可以手动释放。前提是没有未结束的 Run。释放会作废 Token（沿用 M2 `stop` 的作废方式）、释放终端。
- **清理 worktree**（释放之后）：
  1. 先做一次备份拉取（§3.7），把分支上的提交保存到中心仓库；
  2. 检查 worktree 是否有未提交的修改（M2 的 `isDirty`，包含未跟踪文件），以及分支顶端是否已在中心仓库的某个 ref 里；
  3. 都没有 → 删除 worktree 和分支；
  4. 有任一项 → **不删除**，由 domain 发起一个清理决策（Decision，`trigger=worktree_cleanup`，决策人是人，选项 `keep` / `force_clean`）。它会按现有路由进入 Needs You 并给 PM Office 一条简短提示。用户可以先用 `cardigan worktree diff <A-n>` 查看改动；
  5. 选 `force_clean` 时，先把 `git diff HEAD` 和未跟踪文件清单保存到 `<data>/cleanup/<project_id>/<assignment_id>-<时间>.patch`（主机目录，0600），再强制删除；选 `keep` 就保留，之后的对账不再为它发起决策。
- **对账**（server 启动时一次，之后默认每 10 分钟）：比对基础 clone 的 `git worktree list --porcelain`、worktree 根目录下的实际目录、数据库里的 Assignment：
  - 孤儿：目录或 worktree 登记存在，但没有 active Assignment 拥有它；
  - 缺失：active Assignment 记录的 worktree 不存在；
  - 失效登记：git 里登记了，目录已经没有；
  - 有 `git_head` 交付但没有固定 ref；
  - M2.7 留下的失败临时 clone；
  - 登记源和中心仓库分叉（§3.2）。
  - **对账只报告，从不删除。** 结果写进 store 的对账表（首次发现时间、最近一次看到的时间、已解决时间），`cardigan attention` 显示；新发现的项写一条项目级事件，路由给 PM Ops。
- 写锁（§12.7）已经在 `domain/commands/launch.ts` 的 `exclusive()` 实现，M4 不改。

### 3.7 备份拉取（§12.3 第 4 条）

每个有基础 clone 的项目默认每 10 分钟执行一次：`fetch +refs/heads/agent/*:refs/cardigan/backups/<machine_id>/agent/*`，取自基础 clone，拉进中心仓库（agent-ssh 下同样经 `--upload-pack`）。失败只记日志，不推进、不删除已有备份，也不据此判定任务成功或失败。

### 3.8 卡片状态机的修改（M4.1，同步开发方案 §4.4）

```
review --completion_review_passed--> awaiting_merge
awaiting_merge --merge_not_required--> done      （卡片没有 git_head 的 code 交付，同一命令内直接完成）
awaiting_merge --merge_succeeded--> done
awaiting_merge --merge_conflicted--> in_progress
awaiting_merge --cancel--> cancelled
```

- `resolution: "done"` 改为在卡片真正变成 done 时写入。
- 卡片模板增加 `merge_policy: "confirm" | "auto"`，开发卡默认 `confirm`。进入 `awaiting_merge` 且策略为 `confirm` 时，domain 发起合并确认决策（`trigger=merge_confirmation`，决策人是人，选项 `merge` / `hold`，阻塞该卡）；选 `merge` 后执行循环才合并，选 `hold` 就停在 `awaiting_merge`，之后可以用 `cardigan merge request <C-n>` 重新发起。
- 合并冲突时：卡片回到 `in_progress`；冲突交付所属的 produce 工作项从 `accepted` 变为 `changes_requested`（新增迁移 `merge_conflicted`）；之后按现有流程重新交付、审核、申请完成，旧的审核结论按不变量 14 自动失效。
- 不变量 13 不变：done 仍然必须经过完成申请和审核，合并只是在审核通过之后多加的一道门。

## 4. 各任务说明

### M4.1 domain + router（Codex）

- 卡片状态 `awaiting_merge` 和 §3.8 的迁移；produce 的 `accepted --merge_conflicted--> changes_requested`。
- 模板字段 `merge_policy`；完成审核通过时按"有没有 git_head code 交付"和策略决定直接 done、发起合并确认，还是等待自动合并。
- 纯函数 `mergePlan(state, card_id)`：返回合并集合（§3.5），卡片不在 `awaiting_merge`、确认决策未通过、或缺少交付时返回说明原因的错误。
- 命令：
  - `recordMergeResult`（只允许 system）：`merged { merge_sha, previous_sha }` → 卡片 done，事件 `card_merged`；`conflicted { delivery_id, files }` → §3.8 的冲突处理，事件 `merge_conflicted`；`failed { reason }` → 卡片不动，事件 `merge_failed`。卡片不在 `awaiting_merge` 时拒绝，重复提交同一结果是无操作。
  - `requestMerge`（人或 PM Ops）：在 `hold` 之后重新发起合并确认。
  - `releaseAssignment`（人、PM Ops、system）：没有未结束的 Run 才允许；Assignment 和 runtime 状态迁移到 `released`，事件 `assignment_released`（带 `worktree_path`、`branch`）。
  - `requestWorktreeCleanup`（只允许 system）：§3.6 的清理决策，每个 Assignment 同时最多一个未决的。
- router（纯函数，判断依据只来自事件和快照）：`merge_conflicted` → 冲突工作项的 Assignment（种类 `fix`）；`card_merged` → PM Ops 摘要；`merge_failed` → PM Ops 升级；对账新发现项（M4.4 定义事件 `reconcile_finding`）→ PM Ops。合并确认和清理决策走现有的 `decision_requested` 路由。
- 同步开发方案：§4.4（卡片、produce 状态机）、§6.4（新增的行）、§12.5、§12.6。
- 验收：每条新迁移的允许和禁止各至少一个测试；没有 git 交付的卡片审核通过后直接 done；`confirm` 策略下未确认不能合并；冲突后重新交付、审核、申请完成，能再次进入 `awaiting_merge`；非 system 调用 `recordMergeResult` 被拒。

### M4.2 中心仓库与交付校验（Codex，可立即开始）

- git-service / git-transport：
  - `ensureCentral(project)`、`syncFromSource(project)`（§3.2，返回 `fast_forwarded` / `up_to_date` / `ahead` / `diverged`）；
  - 基础 clone 的来源改为中心仓库：同用户模式直接以中心仓库路径 clone / fetch；agent-ssh 模式的 bundle 改从中心仓库生成。fetch 的 refspec 增加 `+refs/cardigan/deliveries/*:refs/cardigan/deliveries/*`，审核方建只读 worktree 时用的是主机固定过的对象，不怕 coder 在共享 clone 里删对象。已有基础 clone 的来源不是中心仓库时拒绝，并提示重建；
  - `GitDeliveryVerifier`（实现 domain 的 `DeliveryVerifier`，§3.3 第 1 步）；
  - `pinDelivery(project, delivery_id, sha)`（§3.3 第 2 步，只创建不覆盖）；
  - `backupAgentBranches(project, machine_id)`（§3.7）。
- §3.4 的加固全部落实；agent-ssh 下用 `--upload-pack` 经 Agent 执行入口。
- 同步开发方案：§12.1（中心仓库的位置）、§12.2（基础 clone 的来源）、§12.3。
- 验收：伪造的 SHA（仓库里不存在）、不是 commit 的对象（tree、blob）、存在但不在该 Assignment 分支上的 SHA（例如另一个 Assignment 分支上的提交）都被拒，且不创建任何 candidates 或 deliveries ref；`deliveries/<id>` 已存在时不被覆盖；登记源分叉时中心基线不动；同步和校验在 agent-ssh 模式下，主机自己从不在 Agent 目录里执行 git；备份失败不动已有备份。
- PR 太大就拆：先中心仓库、同步、基础 clone 来源，再校验、固定、备份。

### M4.2b 大仓库支持（Codex）

M4.3 审核时发现：中心仓库、基础 clone、bundle 生成的 git 命令都写死了 30 秒超时，超时直接 SIGKILL；目标项目的 pack 有 2.2 GiB，首次克隆一定会被杀掉。agent-ssh 模式每次建 worktree 都把整个中心仓库重新打成 bundle，对大仓库太重。

- 超时：查询类命令（rev-parse、cat-file、for-each-ref 等）保持短超时；克隆、拉取、推送、bundle 用单独的长超时（默认 30 分钟），两者都可配置。超时仍然杀进程，但错误信息要说明是超时，并给出配置项的名字。
- agent-ssh 的基线分发改为主机推送（开发方案 §12.2 的"主机把中心仓库的基线推到工作机"）：主机在**中心仓库**里执行 `git push`，`--receive-pack` 经 M2.7 的 Agent 执行入口以 agent 身份运行，目标是该项目的基础 clone；推送 `refs/heads/*:refs/remotes/origin/*` 和 `refs/cardigan/deliveries/*`，只传增量，不碰基础 clone 当前检出的分支。主机这一侧仍然只在中心仓库里执行 git。
- 首次创建基础 clone：由 Agent 执行入口建一个空仓库，再由主机推送；或者首次仍用 bundle、之后改用推送。两种都可以，选实现简单的，写清理由。
- 同用户模式保持现状（直接从中心仓库路径 fetch）。
- 同步开发方案 §12.2 的 agent-ssh 段落和 §14 的 Git 一行。
- 验收：推送路径下，主机从不在 Agent 目录里执行 git；第二次同步只传新增对象（例如断言没有生成 bundle 文件，并且新增提交在基础 clone 里可见）；不覆盖基础 clone 当前检出的分支和未提交文件；长超时、短超时分别生效（用可配置的小超时值触发超时）。

### M4.3 合并与清理（Codex）

- `mergeIntoBase(project, plan)`（§3.5）：返回 `merged { merge_sha, previous_sha }` / `conflicted { delivery_id, files }` / `stale` / `noop`。
- `removeWorktree(assignment, { force })`、`diffWorktree(assignment)`（§3.6）：不强制时，有未提交修改或分支提交不在中心仓库里就返回 `needs_decision`，附上改动摘要；强制时先备份提交和补丁再删。
- `listWorktreeState(project)` 和纯函数 `reconcile(state, assignments, deliveries)`（§3.6 对账的六类发现）。
- 验收：两份不冲突的交付依次合并、提交带两个父节点、基线只前进；冲突时不改任何 ref，冲突文件列表正确；基线被别人推进时返回 `stale` 而不覆盖；重复合并是无操作；有未提交修改或未跟踪文件的 worktree 不强制时不被删除；强制删除前补丁已写入；孤儿、缺失、失效登记都能被发现，对账从不删除任何东西。

### M4.4 组装（Pi）

- MCP：`startMcpServer` 必须传入真实校验器（两种模式各自的 `GitDeliveryVerifier`），去掉默认桩；`submit_delivery` 事务提交后调用 `pinDelivery`。
- Token：收到 `assignment_released` 后作废该 Assignment 的 Token；另外 MCP 认证要拒绝状态不是 active 的 Assignment，多一道防线（M4.1 审核时发现：现在写命令会因 Assignment 不是 active 被拒，但 Token 在作废前仍能读卡片和更新）。
- 合并执行循环（与 Dispatcher 并列，SIGTERM 时等当前合并结束）：找出 `awaiting_merge` 且已确认（或策略为 `auto`）的卡片 → `syncFromSource` → `mergePlan` → `mergeIntoBase` → `recordMergeResult`；`stale` 下一轮重试；同一项目同时只跑一个合并。
- Dispatcher：`merge_conflicted` 触发的 Run 种类为 `fix`。
- 卡片 done / cancelled 后的 release 和清理（§3.6）；清理决策解决后执行 `keep` 或 `force_clean`。
- 对账循环和备份循环（默认各 10 分钟，可配置）；store 增加对账表和迁移；对账新发现项写 `reconcile_finding` 事件。
- CLI：`cardigan merge status [C-n]`、`cardigan merge confirm <C-n>`（代用户记录合并确认决策，原话记为命令行确认）、`cardigan merge request <C-n>`、`cardigan worktree diff <A-n>`、`cardigan worktree clean <A-n> --force`、`cardigan worktree keep <A-n>`；`cardigan attention` 增加对账发现和登记源分叉。
- 验收（端到端，真实 server、真实 git、假 Agent；真实 hc 可用时也跑一遍）：伪造 SHA 的 `submit_delivery` 被拒；正常交付 → 审核 → 完成申请 → `merge confirm` → 中心基线出现合并提交、卡片 done、Assignment 被释放、干净的 worktree 被删除；构造冲突 → coder 被按门铃并新建 `fix` Run，卡片回到 `in_progress`；留有未提交修改的 worktree 进入 Needs You，不会被删除；手动在 worktree 根目录下建一个目录，对账能报出孤儿。
- PR 太大就拆：先 MCP 校验和合并循环，再 release、清理、对账、备份和 CLI。

### M4.T1、M4.T2 交叉验收

- **M4.T1（Pi）**：M4.1 的状态机和命令（每条迁移、合并确认、冲突回到 `in_progress` 后的完整重来）；M4.2 的校验（§16 的"伪造或不在分支上的 SHA 被拒"逐类覆盖）、固定不覆盖、同步三种结果；agent-ssh 下主机不在 Agent 目录里执行 git。
- **M4.T2（Codex）**：M4.3 的合并、`stale`、清理和对账（agent-ssh 下主机不在 Agent 目录里执行 git）；M4.4 端到端，覆盖 §16 的三条验收和 §3.8 的状态流转；重启 server 后合并循环和对账从持久化状态继续，不重复合并、不重复发起清理决策。

### M4.S 真实冒烟（Claude）

M3.S 之后、用户装好 agent-ssh 之后：真实 coder 交付、真实 reviewer 审核、PM 验收、用户 `merge confirm`，中心仓库出现合并提交；用户从登记源 `git fetch` 中心仓库能拿到结果。结果写进本计划的附录。

## 5. 后续事项（M4 不处理）

| 事项 | 处理 |
|---|---|
| 合并后自动推送到 GitHub / GitLab | 需要主机持有推送凭据，以后单独拍板 |
| 合并后自动构建、测试 | 以后视需要加到合并执行循环 |
| 向验证方所在机器推送 SHA（§12.4） | Phase 2 多机 |
| §6.4 的"指令"没有任何命令产生（M3.T2 发现） | 下指令的入口（Web / CLI / PM Ops 工具）在 M5 计划里补 |

## 6. M4 完成的标准

- M4.1–M4.4、M4.T1、M4.T2 全部合并；M4.S 冒烟通过并记录。
- 开发方案 §16 M4 的三条验收都有对应的自动化测试。
- 开发方案 §4.4、§6.4、§12 已按实际实现更新。
- Claude 根据 M4 的实际情况写 M5 的任务计划。
