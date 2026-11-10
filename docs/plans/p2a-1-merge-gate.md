# P2a-1 合并闸门：合并前自动检查、合并后自动推送

- 对应：`docs/plans/phase-2.md` §2 P2a-1；用户拍板见该文件 §0"合并"一行；试行发现 13（人在 Needs You 直接确认合并，带进了回归）。
- 前提：P2a-2 测试残留已修（#204），全量测试和 e2e 可以在同一台机器上反复跑而不留进程。
- 开发方案要改的章节：§3.5（合并流程）、§4.4（`awaiting_merge` 期间的检查状态，卡片状态机本身不变）、§4.5（新增不变量）、§8（Needs You 合并卡片）、§12.5（合并）、新增 §12.7（推送到外部远程）、§13.1（配置文件）、§14（检查账号和推送密钥）。

## 1. 目标

1. 卡片进入 `awaiting_merge` 后，主机把"将要合并成的那棵代码树"放到隔离账号的干净目录里，跑项目配置的检查（构建、全量测试、lint、依赖检查、e2e）。
2. 只有检查通过的代码树才能成为新的基线；检查失败时卡片停在 `awaiting_merge`，Needs You 的合并卡片显示失败摘要和日志。
3. 合并成功后，主机把新基线快进推到项目配置的外部远程（Cardigan 自己是 GitHub `IndieMiao/cardigan`），用仓库级 deploy key；被拒就停下，进 Needs You。
4. 没有配置闸门或推送的项目，行为和现在完全一样。

## 2. 关键设计

### 2.1 检查的时机：先检查，后确认

- 卡片进入 `awaiting_merge`（且合并计划有效）就开始检查，不等人确认。人在 Needs You 看到合并卡片时，检查结果已经在上面（排队 / 运行中 / 通过 / 失败）。
- 人可以在检查结束前确认；确认只是"同意合并这次完成申请"，真正合并仍要等检查通过。
- `auto` 策略的卡片：检查通过即合并。

### 2.2 检查的对象：合并候选

- 把 `CentralRepositoryService.mergeIntoBase` 拆成两步：
  - `prepareMerge(project, plan)`：在 bare 仓库里用 merge-tree + commit-tree 算出候选提交，**不动基线**；返回 `{ status: "candidate", candidate_sha, tree_sha, previous_sha } | conflicted | noop`。候选提交固定到 `refs/cardigan/candidates/<completion_id>`（可覆盖，只此前缀）。
  - `publishMerge(project, candidate_sha, previous_sha)`：比较后更新基线（现有 compare-and-swap），基线已动返回 `stale`。
- 检查记录绑定 `(completion_id, tree_sha)`。基线前进导致候选重算时：新候选的 `tree_sha` 和已通过的一样就直接复用结果；不一样就重新排队检查。合并时必须满足"要发布的候选提交的 tree 有一条通过记录"，否则不发布。
- 冲突、`noop` 维持现有处理；`noop` 不需要检查（代码树没有变化）。

### 2.3 在哪里跑：隔离账号的干净目录

- agent-ssh 模式：检查在 `agent` 账号下跑，经现有 Agent 执行入口（同一套 SSH 参数、固定 PATH）。候选提交按 §12.2 现有的增量推送机制推到该项目的 Agent 基础仓库（推送 refspec 增加 `refs/cardigan/candidates/*`），再在 `<agentRoot>/checks/<project>/<attempt>` 用 `git worktree add --detach` 检出候选提交。
- 检查进程不继承主机进程的环境变量：命令行只带固定的 `PATH` 和配置里显式列出的变量，不带 `HC_SESSION`、`HC_SOCKET`、`CARDIGAN_*`、`XDG_RUNTIME_DIR` 等。主机侧拼命令时用白名单，不用"复制再删除"。
- local 模式（没有隔离账号）：允许跑，但启动时和检查日志开头都写明"没有账号隔离"；同样用白名单环境。
- 检查结束（无论通过、失败、超时、取消）都删掉检查目录和对应 worktree 登记；删除失败记入日志，不影响检查结论。
- 依赖缓存走 Agent 账号已有的共享缓存（`pnpm` 配置在 Agent 账号自己的配置文件里），本任务不改。
- 这里做出来的"在 Agent 账号下检出某个提交到临时目录、跑命令、删掉"要写成可复用的函数（放 `packages/host`），P2a-3 验证方构建目录会复用它。

### 2.4 配置

主机侧配置文件 `~/.config/cardigan/merge-gate.yaml`（`CARDIGAN_CONFIG_DIR` 下），按项目区分，不进被开发项目的仓库：

```yaml
projects:
  cardigan:
    checks:
      - name: install
        run: pnpm install --frozen-lockfile
        timeout_minutes: 10
      - name: build
        run: pnpm build
      - name: test
        run: pnpm test
      - name: lint
        run: pnpm lint
      - name: deps
        run: pnpm check:deps
      - name: e2e
        run: pnpm test:e2e
    env: {}                 # 可选，显式传给检查进程的变量；值不得出现在日志里
    total_timeout_minutes: 60
    push:
      remote: git@github.com:IndieMiao/cardigan.git
      branch: main          # 省略时等于项目基线分支
      key_file: merge-gate/cardigan.deploy-key   # 相对数据目录，文件必须 0600
      known_hosts_file: merge-gate/known_hosts   # 相对数据目录，严格校验
```

- 读取时校验：项目存在；`run` 非空；超时为正整数；`key_file`、`known_hosts_file` 解析后在数据目录内、不是链接、权限 0600（目录 0700）；不合规就拒绝启用该项目的闸门并在 server 启动日志里用中文说明，不回退成"无闸门直接合并"——**配置了但无效的项目一律不合并**，直到配置修好。
- 每条检查依次执行，前一条失败就停（后面的记为"未运行"）。单条超时默认 30 分钟，总超时默认 60 分钟。

### 2.5 排队和并发

- 全机同一时间只跑一个检查（检查本身吃满 CPU）。按卡片进入 `awaiting_merge` 的时间先后排队，跨项目也一样。
- 每个项目仍然一次只合并一张卡（现有 `MergeExecutor` 的串行保证不变）。
- server 关闭时：正在跑的检查按进程组结束（只按记下的 PID），结果记为"中断"；启动后中断的检查自动重新排队，不算失败。

### 2.6 失败之后

- 检查失败或超时：记录一次失败结果（摘要 + 日志引用），不自动重试同一棵代码树。
- 人在 Needs You 合并卡片上可以：
  - **重新检查**（新操作）：同一候选再排一次队，用于偶发失败；
  - **退回修改**：当前完成申请的最新检查为 `failed` 或 `timed_out` 时，未处理的确认和已确认合并（人确认或超时代批）的确认均可退回。CLI `merge request-changes` 与 Workbench 共用 `recordDecision`，原因必填；完成申请作废、主产出回到 `changes_requested`、验收项回到 `todo`，沿用 `merge_changes_requested` 通知原实现方并记录时间线；
  - **暂缓**（已有）。
- 已确认合并的退回仅允许 human：旧确认标记为 `superseded`，保留原合并授权（包括超时代批依据）；退回原因另存事件与时间线。Needs You 重新展示可退回的已确认项，只提供“退回修改”，不重复确认合并。
- 已确认合并时，最新检查为 `passed`、`queued`、`running`，或没有检查／检查中断，均不允许退回，并给出中文说明；显式重新检查后立即按 `queued` 拒绝，不能沿用更早的失败结果。未确认项仍保持已有退回行为；`hold` 仍须先重新发起确认。
- 新的完成申请（退回修改后再次交付）产生新的 `completion_id` 和新的合并确认，自然重新检查；旧确认和旧检查不能授权新申请。

### 2.7 记录和领域模型

- 新增事件（domain 定义，主机以 system 身份记录）：`merge_check_queued`、`merge_check_started`、`merge_check_finished`（`result: passed | failed | timed_out | interrupted`，带 `completion_id`、`candidate_sha`、`tree_sha`、每条检查的名称 / 退出码 / 用时、失败摘要、日志引用）、`merge_check_requeued`（人点了重新检查）。
- 卡片状态机不变；卡片视图新增派生字段 `merge_check`（当前完成申请最新一次检查的状态和摘要）。
- 新增 §4.5 不变量：**项目启用了合并闸门时，`recordMergeResult(kind=merged)` 的 `merge_sha` 的 tree 必须有一条同一 `completion_id` 的 `passed` 检查记录**；domain 拒绝不满足的记录。唯一例外是 `noop`：所有计划交付都已是当前基线的祖先，基线没有任何新代码，此时按现有做法以 `merge_sha == previous_sha` 收尾并在结果里标明 `noop`，不需要也不伪造 `passed` 检查记录（2026-11-09 实现中确认）。项目是否启用闸门由主机在加载命令状态时作为项目设置传入（domain 不读文件）。
- 日志：`<dataDir>/merge-gate/logs/<project>/<attempt>.log`，0600；每条检查的输出各自截断到 2 MB（保留首尾）；每个项目保留最近 50 次，旧的删除。日志写入前过滤配置里 `env` 的值和推送密钥路径以外的任何密钥内容（检查进程拿不到密钥，这条是兜底）。
- 失败摘要：失败检查的名称、退出码，加上输出最后 40 行里的错误行（vitest 的 `FAIL`、`Error`、`×` 开头的行），最多 20 行。

### 2.8 合并后推送（§12.7 新增）

- 只在 `recordMergeResult(merged)` 成功写入之后推。推送在中心 bare 仓库里执行：`git push <remote> <merge_sha>:refs/heads/<branch>`，**不加 `--force`、不用 `+` refspec**；SSH 用 `-F /dev/null -i <key_file> -o IdentitiesOnly=yes -o IdentityAgent=none -o StrictHostKeyChecking=yes -o UserKnownHostsFile=<known_hosts_file>`，环境同样走白名单（不带主机的 `SSH_AUTH_SOCK`）。
- 推送是排队的：一个项目上一次推送没成功之前，不推后面的提交（后面的合并照常在中心仓库进行，等前一个问题解决后一次推到最新）。
- 结果事件 `merge_pushed`（`sha`、远程分支）、`merge_push_failed`（`reason: rejected | network | auth | other`，中文说明）。
  - `rejected`（远程已前进、不能快进）：建一条 `human_action` 进 Needs You："GitHub 的 main 已经前进，需要先处理分叉"，停止该项目的推送，直到人把这条事项标为完成；之后自动重试一次。
  - `network`：指数退避重试（1、2、4…最长 30 分钟），不进 Needs You；连续失败超过 2 小时再建 `human_action`。
  - `auth`：直接建 `human_action`（多半是 deploy key 没加或被删）。
- 推送命令的错误输出写进日志前去掉密钥路径以外的敏感内容；密钥内容永远不进日志、事件和界面。
- 推送不改变卡片状态（卡片在合并成功时已经 `done`）。

### 2.9 界面和 CLI

- Needs You 的合并卡片：检查状态徽标（排队 / 运行中 / 通过 / 失败 / 超时）、用时、失败摘要、"查看日志"链接（Workbench 新增已认证的只读接口，按 attempt 读日志，纯文本，带 `Content-Type: text/plain; charset=utf-8` 和 `X-Content-Type-Options: nosniff`）、"重新检查"按钮。
- 检查未通过时，"合并"按钮仍可点（记录确认），但按钮旁写明"检查通过后才会合并"。
- 卡片详情的时间线显示检查和推送事件；推送失败在项目页顶部显示提示。
- CLI：`cardigan needs-you` 的合并项后面带检查状态；新增 `cardigan merge recheck <C-n>`。
- 遵守现有 Workbench 样式约束（`apps/web` 全部测试）。

## 3. 拆分（三个 PR，按顺序合并）

| PR | 分支 | 内容 | 负责 |
|---|---|---|---|
| 1a | `feat/p2a-1a-merge-checks` | §2.2 prepare / publish 拆分；§2.3 Agent 账号下的临时检出和执行（可复用）；§2.4 配置读取和校验（先不含 `push`）；§2.5 排队；§2.6 失败后的"重新检查"命令（domain + CLI）；§2.7 事件、不变量、日志、摘要；`MergeExecutor` 接入闸门 | Codex |
| 1b | `feat/p2a-1b-merge-push` | §2.4 的 `push` 配置；§2.8 推送、排队、错误分类、`human_action` | 1a 合并后，Codex 或 Pi |
| 1c | `feat/p2a-1c-merge-gate-ui` | §2.9 Workbench 和 CLI 显示、日志接口、重新检查按钮 | 1a 合并后，可与 1b 并行 |

每个 PR 控制在几百行；1a 若超过 800 行，把"Agent 账号临时检出"单独先开一个 PR。

## 4. 测试

- domain 契约测试：新事件的合法性；启用闸门时没有通过记录的 `merged` 被拒绝、tree 不一致被拒绝、未启用闸门时行为不变；重新检查只能针对 `awaiting_merge` 且已有失败结果的完成申请。
- git-service：prepare 不动基线、候选 ref 只写在 `refs/cardigan/candidates/`；publish 在基线移动时返回 `stale`；冲突和 `noop` 不变。
- 检查执行器（用假执行入口）：顺序执行、前一条失败后面不跑、单条和总超时、中断后重新排队、环境白名单（断言子进程拿到的环境变量集合）、检出目录在所有结局下都被删除、日志截断和保留数量。
- `MergeExecutor`：检查通过才发布；基线前进后 tree 相同则复用、不同则重新检查；检查失败基线不动；两个项目排队的先后；未配置闸门的项目走原流程；配置无效的项目不合并。
- 推送（1b）：用本地 bare 仓库当"远程"（`file://` 路径，不用密钥），覆盖快进成功、非快进被拒建 `human_action` 且停止后续推送、标为完成后重试、推送顺序。另写一条测试断言拼出的 `git push` 参数里没有 `--force` 和 `+`，SSH 参数含 `IdentitiesOnly=yes`、`IdentityAgent=none`、严格主机校验。
- 一条验收测试：真实 git + 真实检查命令（例如一个会成功、一个会失败的小脚本），走完"进入待合并 → 检查失败 → 重新检查 → 通过 → 确认 → 合并 → 推到本地远程"。
- 实现方只跑改动所在包的测试和 `pnpm lint`、`pnpm check:deps`；涉及 `apps/web` 时跑 `apps/web` 全部测试。全量和 e2e 由审核方跑。

## 5. 上线（Claude 负责）

1. 1a 合并后，为 `cardigan` 项目写 `merge-gate.yaml`（不含 `push`），先用一张小卡验证检查流程；此时仍由 Claude 手动推 GitHub。
2. 1b 合并前，Claude 在数据目录生成 deploy key（ed25519，0600），请用户在 GitHub 仓库 Settings → Deploy keys 添加公钥并勾选写权限；`known_hosts` 用 GitHub 公布的主机密钥。
3. 1b 合并后启用 `push`，用一张小卡验证自动推送；之后 Claude 不再手动推送。
4. 每一步验证后更新 `HANDOFF` 里的流程说明和 memory。

## 6. 不做

- 不做远程 CI（GitHub Actions 等）集成。
- 不做多台检查机器、检查并行。
- 不做按改动范围挑选测试；配置里写什么就全跑什么。
- 不做推送到多个远程、推送标签或其他分支。
- 不改 Agent 在自己终端里跑测试的规则（那是 P2a-4）。

## 7. 已知风险

- e2e 需要 Agent 账号能运行 `hc`（Agent 安装器已固定安装 hc 0.1.18）；实现时先在 Agent 账号下手动跑一次 `pnpm test:e2e` 确认，跑不通就在 PR 里说明并暂时把 e2e 从 `cardigan` 的检查里拿掉，另开任务。
- 检查一次要几分钟，排队的卡多时合并会变慢；先观察，不做优化。
- 检查目录在 Agent 账号下，Agent 理论上能在检查期间改动它；检查开始前比对检出的 HEAD 和 tree，结束后再比对一次，不一致就判失败。
