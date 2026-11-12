# P2a-13 分层合并检查与 MB-n 批次合并队列

- 对应：`docs/plans/phase-2.md` §2 P2a 表新增一行 P2a-13（指向本文件）；卡片 C-143（接替 C-124）。
- 决策记录：[ADR 0004](../adr/0004-merge-batch-check.md)（不变量 21 改写，用户 2026-11-11 四项拍板）。
- 开发方案改动：本卡已同步 §3.5、§4.4（合并阶段子标签，状态机不变）、§4.5 不变量 21／23／27、§7.4 合并确认、§8.2 Needs You、§8.4 卡片页、§8.7 看板、§12.5 合并、§12.6 对账。B 组各卡合并时再按实际实现补细节。
- 前提：P2a-1 合并闸门、P2a-12 A–E（C-118、C-119、C-127、C-128、C-129）及 C-130、C-139 已合入 main。

## 0. 背景

### 0.1 数据（张良 2026-11-11 调研）

- 合并检查六步：install／build／test／lint／deps／e2e。149 次 `merge_check_finished` 中，通过的检查平均 207 秒（140–386 秒），其中 test 平均 127 秒，e2e 约 63 秒且只能串行；结果为 passed 87、failed 40、interrupted 22。
- 主要放大因素：main 每前进一次，所有排队卡的候选 tree 都会变，全部重跑。k 张卡排队时，一次合并使其余 k−1 张作废。出处：`apps/server/src/merge-checks.ts:236`（`prepare` 的候选缓存键含基线）、`docs/development-plan.md:684`（调研时不变量 21 所在行）、`p2a-1-merge-gate.md` §2.1、`packages/host/src/merge-gate-config.ts:50`（单一检查列表与超时）。
- 近 40 次合并中只改文档的 3 次；60% 同时改了 apps 和 packages。所以“只改文档跳过测试”收益有限，主要收益来自批次合并。

### 0.2 当前执行容量（2026-11-12）

- `cardigan` 项目的合并检查在 `cardigan-ci` 执行目标上跑，并发 3（C-128 分桶，`executors.cardigan-ci.max_concurrent: 3`），test 用 `--maxWorkers=4`，3 × 4 正好占满 12 vCPU。
- 主机 GS66 的 Agent 并发为 6：干活的 Run 按 4 个排，另外 2 个留给常驻 PM 和主机运维（P2a-9 `run-capacity.yaml`）。合并检查不占这些名额（C-128）。
- 一执行目标只服务一个项目（C-139），所以 `cardigan-ci` 的 3 个槽位全部属于 `cardigan` 项目。

## 1. 目标

1. **A+C（不动不变量，先做）**：分层检查。卡级快速检查只跑 build、lint、deps 和受影响包的测试；只改 `docs/` 的卡跳过 test 和 e2e。旧配置缺省仍为全量。
2. **B（ADR 0004 之后）**：合并队列和批次检查。只收已确认的卡，按顺序叠加成批次 MB-n，每张卡仍各自一个合并提交；在批次最终 tree 上跑一次全量检查，通过后 main 一次快进到批次最终提交；失败自动二分定位。卡片状态机不变。
3. **D（P2a-12 切到 cardigan-ci 之后）**：缓存与分片，识别不稳定测试。

## 2. A+C 组：分层检查

### 2.1 变更范围

主机从中心 bare 仓库读取“候选的基线 → 候选提交”之间的改动文件（`git diff --name-only <previous_sha> <candidate_sha>`，只在中心仓库执行，符合 §12.1），算出变更范围：

| 范围 | 条件 | 检查 |
|---|---|---|
| `docs_only` | 改动文件全部在 `docs/` 下，或是根目录的 `*.md` | 跳过标记为 `skip_docs_only` 的检查（test、e2e），其余照跑 |
| `full` | 改了 `packages/domain`；或改了全局文件：根目录的 `package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`tsconfig*.json`、`vitest.config.ts`、`biome.json`、`.dependency-cruiser.cjs`，以及 `test-support/**`、`e2e/**`，或任何不在 `docs/`、`packages/*/`、`apps/*/` 下的文件 | 全部检查，test 跑全量 |
| `affected` | 其余情况 | test 只跑受影响包：改动的包，加上直接或间接依赖它们的包 |

- 依赖关系从候选 tree 的 workspace 推导：主机从中心仓库读取 `pnpm-workspace.yaml` 列出的各包 `package.json`（`git show <candidate>:<path>`），按 `dependencies`／`devDependencies` 里的 `@cardigan/*` 建反向依赖图。不在候选 tree 外读任何文件。
- 当前依赖图（2026-11-12）：`domain` 被所有包依赖，所以“改 domain 等于全量”是推导结果，同时作为显式规则保留；`apps/web` 不依赖任何 `@cardigan/*` 包，也没有包依赖它；`apps/server` 依赖几乎全部包，改任一 `packages/*` 都会带上 server 的测试。
- 测试跨包读文件的情况（例如测试里用 `../../` 读其他包的资源）不在依赖图里。A1 实现时要扫描一遍，把这类边作为配置里的显式补充边（`extra_dependents`），扫描结果写进 PR 描述。
- 范围计算是纯函数，放在 `packages/host`（不进 domain，domain 不需要知道文件路径）。

### 2.2 配置

`merge-gate.yaml` 的检查条目增加两个可选字段，项目增加一个可选字段：

```yaml
projects:
  cardigan:
    checks:
      - name: install
        run: pnpm install --frozen-lockfile
      - name: build
        run: pnpm build
      - name: test
        run: pnpm --filter @cardigan/domain test:types && pnpm vitest run --maxWorkers=4 $CARDIGAN_AFFECTED_PATHS
        scope: affected          # 主机注入 CARDIGAN_AFFECTED_PATHS；full 时为空，等于全量
        skip_docs_only: true
      - name: lint
        run: pnpm lint
      - name: deps
        run: pnpm check:deps
      - name: e2e
        run: pnpm test:e2e
        skip_docs_only: true
        tiers: [batch]           # 只在启用合并队列后生效：卡级不跑，批次跑
    affected:
      extra_dependents: {}       # 跨包读文件的补充边，键和值都是包目录
```

- `tiers`：`[card]`、`[batch]` 或 `[card, batch]`，缺省两者都跑。`tiers` 只在项目启用合并队列（B 组）后生效：卡级检查跑含 `card` 的步骤，批次检查跑含 `batch` 的步骤。未启用队列时，闸门照旧对每张卡跑全部步骤（单卡检查，`level=single`），所以 A+C 阶段就给 e2e 配上 `tiers: [batch]` 也不会丢掉 e2e。用户拍板第 3 条（卡级不跑 e2e）在 B5 打开队列时落实。A2 只解析 `tiers`，B2a 才使用它。
- `scope: affected`：主机注入受控变量 `CARDIGAN_AFFECTED_PATHS`，值为空格分隔的包目录（只允许 `^(packages|apps)/[a-z0-9-]+$`，由主机从候选 tree 读出的包名生成，不来自改动文件名本身），范围为 `full` 时为空字符串。该变量名加入 `check-environment.ts` 的受控名单，配置的 `env` 不能覆盖。
- `skip_docs_only: true`：范围为 `docs_only` 时这一步记为“已跳过”，不执行。
- 旧配置不含这些字段时，行为和现在完全一样：每一步都跑、test 跑全量。
- 校验沿用现有规则：未知字段、非法 `tiers` 值、`extra_dependents` 里的非法路径，项目闸门判为 invalid（中文原因），不回退成无闸门。

### 2.3 记录

- `merge_check_finished` 的逐项结果增加 `skipped`（附原因 `docs_only`）；检查事件增加可选 `scope: {kind: docs_only | affected | full, packages?: string[]}`，如实记录这次检查覆盖了什么。domain 只校验字段格式，不重新计算范围。
- 不变量 21 不变：A+C 阶段的检查都是单卡检查（事件不带 `level`，视同 `single`），passed 记录仍绑定 `(completion_id, tree_sha)`。差别只是“passed”的含义变成“按本次范围检查通过”，卡片详情显示范围，避免让人误以为跑了全量。
- 基线前进后候选 tree 改变，仍按现状重新检查（A+C 不解决重跑放大，只缩短单次检查）。

### 2.4 A+C 任务

| 任务 | 分支 | 内容 | 范围（包和文件） | 验收标准 | 依赖 |
|---|---|---|---|---|---|
| A1 变更范围计算 | `feat/p2a-13a1-change-scope` | 纯函数：改动文件列表 + workspace 包清单 → `docs_only／affected／full` 和受影响包集合；中心仓库读改动文件与各包 `package.json` 的主机入口；扫描跨包读文件的测试 | `packages/host/src/change-scope.ts`（新）及测试；`apps/server/src/git.ts` 增加只读入口 `changedPaths(project, base, commit)` 和 `readWorkspace(project, commit)`；`packages/git-transport` 中心仓库服务按需加只读方法 | 表 2.1 每一行至少一个用例；改 domain、改全局文件、改 web、只改 docs、改根目录 md、改未知目录各有用例；依赖传递（改 store 带上 mcp-server、host、cli、server）有用例；读 workspace 只用完整 commit SHA，拒绝 ref | — |
| A2 配置解析 | `feat/p2a-13a2-tiered-gate-config` | `merge-gate.yaml` 解析 `tiers`、`scope`、`skip_docs_only`、`affected.extra_dependents`；`CARDIGAN_AFFECTED_PATHS` 列入受控变量 | `packages/host/src/merge-gate-config.ts`、`check-environment.ts` 及测试 | 不含新字段的配置解析结果与改动前逐字段相同（回归）；每种非法值判 invalid 且原因是中文；`env` 里写 `CARDIGAN_AFFECTED_PATHS` 被拒 | — |
| A3 分层执行与记录 | `feat/p2a-13a3-tiered-check-run` | 合并检查按 A1 结果和 A2 配置跳过步骤、注入变量；检查事件记录 `scope` 和 `skipped`；Workbench 合并检查组件显示范围和“已跳过” | `apps/server/src/merge-checks.ts`；`packages/host/src/temporary-checkout.ts`（逐项结果支持 skipped）；`packages/domain/src/commands/merge-check.ts`（事件字段）及契约测试；`apps/web/src/components/MergeCheck.tsx` | 只改 docs 的候选 test、e2e 记为 skipped 且整体 passed；affected 时注入变量只含合法包目录；full 时为空；未配置新字段的项目事件与现在相同；改 domain 须跑 `pnpm --filter @cardigan/domain test:types` | A1、A2 |

A1 和 A2 互不依赖，可以并行开卡。

## 3. B 组：合并队列与批次检查

### 3.1 概念

- **卡级快速检查**（`level=card`）：启用队列后，跑 `tiers` 含 `card` 的步骤（按 B5 的配置不含 e2e），test 按 A+C 的范围裁剪。卡片进入 `awaiting_merge` 就跑，绑定 `(completion_id, tree_sha)`。它是确认前给人看的信息，也是 PM 代确认和 C-115 展示的前置条件。**基线前进后不重跑**：只要当前完成申请有一条 `level=card` 的 passed 记录（任意 tree），就算卡级通过。这一条消除了“main 前进一次，排队卡全部重跑”的放大。
- **合并队列**：每个项目一条。卡片在下列条件同时满足时在队列中（由事件派生，不另存队列表）：卡片 `awaiting_merge`；当前完成申请的合并确认已解决为 `merge`（人确认、PM 代确认、C-29 代批，或 `merge_policy=auto` 且卡级通过）；卡级检查已通过；不是 noop；当前完成申请没有未处理的批次失败定位；不在一个进行中的批次里。
- **批次 MB-n**：项目内编号，格式 `MB-<n>`，与其他项目内编号一样递增、不复用。字段：`id`、`project_id`、`purpose`（`main`：正常组批；`bisect`：二分探测）、`parent_batch_id?`、`base_sha`、`members[]`（按叠加顺序：`card_id`、`completion_id`、`merge_sha`，即本卡在叠加链上的合并提交）、`final_sha`、`final_tree_sha`、`solo`、`priority`（成员中最高档，见 3.6）、`status`（`checking → passed → published`；`checking → failed → bisecting → resolved`；任何未发布状态 → `aborted`）。
- **叠加**：第 1 张卡在 `base_sha` 上做合并提交，第 i 张卡在第 i−1 张卡的合并提交上做合并提交。每张卡一个合并提交，main 发布时一次快进到 `final_sha`，所以 main 上每张卡的提交都在，但 main 的分支指针只停在批次最终提交。

### 3.2 流程

1. **组批**：项目没有进行中的批次（`checking`、`bisecting`）且队列非空时立即组批，不设攒批等待时间。从队首按顺序取卡，直到批次上限（`queue.max_batch_size`，默认 4，范围 1–8）；遇到 `solo` 卡时：如果它在队首，组一个只有它的批次；否则批次在它之前截止。
2. **叠加与冲突**：主机在中心仓库依次 `merge-tree --write-tree` + `commit-tree`。某张卡和 `base_sha` 本身冲突，按现有 `merge_conflicted` 流程处理（卡回 `in_progress`，给原实现方排修复 Run），并从本批去掉；只和本批前面的卡冲突、和 `base_sha` 不冲突时，从本批去掉但保留队列位置，等前面的卡合入后在下一批里自然暴露冲突。至少剩一张卡才组批。
3. **候选分发**：批次最终提交固定到 `refs/cardigan/candidates/MB-<n>`。这个前缀已经由 C-127 的候选分发同步到执行目标的基础 clone，所以批次可以直接作为 C-127 的候选分发（一个候选对应一棵 tree），不需要新的分发通道（C-124#8）。
4. **全量检查**：在 `final_tree_sha` 上跑 `batch` 层全部检查（含 e2e），范围固定为 `full`。执行目标、槽位锁、远程目录准备沿用项目 `executor` 配置（C-127、C-130）；占用的名额与卡级检查在同一执行目标的分桶里共同计数（C-128，C-124#8）。
5. **发布**：通过后，主机重新校验每个成员仍在队列中、成员的 `merge_sha` 在叠加链上，再用 `update-ref <base> <base_sha> → <final_sha>` 比较更新。成功后 domain 在**一个事务**里写 `merge_batch_published`，并为每个成员按叠加顺序写 `card_merged`（`merge_sha` 为本卡合并提交，附 `batch_id` 和同批卡片编号），卡片转 `done`；启用推送的项目照常每卡追加 `merge_push_queued`（§12.7）。
6. **失败**：见 3.3。

### 3.3 失败、二分和定位

- 批次检查 `failed` 或 `timed_out`：
  1. 先套用 C-116 的规则：失败原因全部是测试超时时，同一批次自动重跑一次（每个批次只一次），记“因超时自动重跑”。C-116 合并前 B 组不做这一步。
  2. 批次只有 1 张卡：直接定位到它。
  3. 否则进入 `bisecting`，按前缀探测：第 i 个前缀是叠加链上前 i 张卡，它的 tree 就是第 i 张卡合并提交的 tree，所以探测不需要新合并提交。每个探测是一个子批次（`purpose=bisect`，`parent_batch_id` 指向原批次，成员是前 i 张卡），跑 `batch` 层全量检查。
  4. 探测策略：空闲槽位够时，一次并行探测全部前缀 1…k−1（批次上限 4 时最多 3 个探测，正好用满 `cardigan-ci` 的 3 个槽位）；槽位不够时按二分逐轮探测。
  5. 定位规则：最短的失败前缀为 i，且前缀 i−1 通过（i=1 时前缀 0 就是 `base_sha`，视为通过），则第 i 张卡是失败原因。如果失败前缀就是整批（即 i=k，证据只有原批次那一次失败），再单独把整批重跑一次确认；重跑通过则视为偶发失败，本批按通过发布。每个定位结论至少有两次失败证据（原批次 + 一次探测或确认重跑）。
  6. 通过的最长前缀（1…i−1）本身就是一个检查通过的子批次，直接发布，不重新检查。
- **定位结果**：失败原因卡写一条卡片流的 `merge_check_finished`（`level=batch`，`batch_id`，结果为探测中的 `failed`／`timed_out`，绑定本卡完成申请和失败前缀的 tree），退出队列。卡片仍是 `awaiting_merge`，状态机不动；现有失败处理（C-66、C-79）因此直接生效：PM 可退回修改或重新检查，敏感卡和已交人的确认只交人。“重新检查”让卡回到队列原位置，不需要重新确认，也不需要重跑卡级检查。
- 同批其余未发布的卡自动回到队列，保留原排队位置，不需要重新确认。
- `interrupted`（server 重启、候选改变）和 `executor_unreachable` 不算失败，不进入二分：前者以新 attempt 重跑同一批次；后者按 C-129 留在排队状态退避重试，不回退本机（C-124#8）。
- 二分期间也只有这一个批次族在跑，项目队列等它结束。

### 3.4 队列和 main 的外部前进

- main 在启用队列的项目里仍可能被别的路径推进：登记源的快进同步（§12.1）、队列关闭期间的旧单卡路径。批次和二分探测都绑定 `base_sha`。
- 合并循环每轮读基线；发现基线已不是 `base_sha` 时，中止进行中的批次检查（记 `interrupted`，`merge_batch_aborted` 原因 `stale`），成员按原位置回到队列，在新基线上重新组批。发布时的比较更新失败同样按 `stale` 处理，不强写。
- 同一项目同时只有一个进行中的批次族；下一批不在本批上投机叠加（不做投机执行，见第 6 节“不做”）。
- 队列开启时，单卡旧路径对该项目关闭：已确认的卡只能经批次合并。noop 卡不进队列，仍按现有 noop 路径收尾（无需检查）。

### 3.5 成员退出与中止

- 成员卡在批次进行中被退回修改、取消、标为敏感导致 PM 的确认作废、完成申请被取代或撤回审核（不变量 27 已禁止批次检查运行中撤回，见 3.8）时，该卡退出队列，所在批次中止（`merge_batch_aborted` 原因 `member_left`，检查进程按现有取消路径结束），其余成员按原位置回到队列。
- server 停止：沿用现有顺序，取消检查、等中断结果持久化后再关闭 Store。

### 3.6 优先级、插队和“单独跑”（与 C-144 的配合，由 q(222) 决定）

C-144（接替 C-121，在途）把优先级改为固定五档 None／Low／Medium／High／Urgent，Run 名额排队和合并检查排队都先按档位、再按时间，运行中的检查不被抢占，改档位后下一轮按新档位重排。

批次和档位的配合由 q(222) 决定（2026-11-12 PM 王熙凤代拍，选 a）。以下为提问时的原文：

> 1）选卡：合并队列按“档位 → 确认时间”排序（与 C-144 的检查队列一致），批次从队首连续取卡，最多取到批次上限，同一批可以混档；批次的档位取成员中的最高档，用来和其它检查在执行目标上排队。
> 2）插队：批次一经组成（已排队或已开始检查），成员和叠加顺序不再变，高档位卡不插入、也不打断；它排到队首，进入下一批。二分探测沿用原批次的档位，失败后被重新入队的成员保留原来的排队位置。
> 3）单独跑：与档位无关，只决定批次大小。单独跑的卡按自己的档位和时间排队，到队首时单独组成只有它一张卡的批次；Urgent 不自动视为单独跑。
> 附带一条：同一执行目标上，同档位的批次全量检查排在卡级快速检查前面（批次检查直接决定能否合并），不同档位仍先按档位。

- 前提：同一项目同一时间只有一个批次族在检查；批次在“上一批结束、队列非空”时立即组成并固定成员，不设攒批等待时间，所以不存在“正在组、成员未定”的阶段。
- 拍板理由要点：与 C-144 的“不抢占”一致，不需要新增“批次中止重组”的状态；高档位卡最多多等一个批次的检查；紧急情况可打“单独跑”或由人处理。
- C-144 先合并时，B2a 直接复用它的排序键；B2a 先合并时，按“全部视为同一档”实现，C-144 合并后补排序键。

### 3.7 “单独跑”标记

- 卡片字段 `merge_solo?: boolean`。人（Workbench 卡片详情、CLI `cardigan merge solo <C-n> on|off`）和常驻 PM Ops（MCP `set_merge_solo({card_id, solo, reason})`，理由必填）可以设置；其他 Agent 不能。只在卡片未 `done`／`cancelled` 时可改；已在进行中批次里的卡改标记，下一次组批才生效。
- 敏感卡是否默认单独跑不在本计划内决定（ADR 0004“待定”），B5 上线前由 PM 提给人拍板。

### 3.8 领域模型（B1）

- 检查级别：检查事件增加 `level`：`single`（未启用队列的单卡检查；旧事件没有该字段，视同 `single`）、`card`、`batch`。
- 编号：`packages/domain/src/ids.ts` 新增 `merge_batch: ["MB-", ""]`，属于项目内可分配编号（`ReadableIdKind`），与 `M-`（成员，全局）不冲突；解析时 `MB-12` 不能被误认为 `M-` 前缀。
- 事件（批次事件写项目流，卡片侧只写阶段变化，避免刷屏）：

| 事件 | 流 | 内容 |
|---|---|---|
| `merge_batch_formed` | 项目 | 批次全部字段（含 `purpose`、`parent_batch_id`、成员与叠加顺序、`base_sha`、`final_sha`、`final_tree_sha`、`priority`、`solo`） |
| `merge_batch_check_queued／started／finished` | 项目 | 与 `merge_check_*` 同形，`level=batch`、`batch_id`、`completion_ids[]`；`finished` 结果为 passed／failed／timed_out／interrupted／executor_unreachable |
| `merge_batch_bisect_started` | 项目 | 原批次、探测子批次编号 |
| `merge_batch_culprit_identified` | 项目 | 原批次、失败原因卡及完成申请、证据（子批次编号与结果） |
| `merge_batch_published` | 项目 | `previous_sha`、`final_sha`、成员 |
| `merge_batch_aborted` | 项目 | 原因 `stale／member_left／interrupted` |
| `merge_batch_stage_changed` | 每个成员卡 | 阶段 `batch_checking／bisecting／requeued`，附批次编号；只在阶段变化时写 |
| `merge_check_finished`（`level=batch`） | 失败原因卡 | 见 3.3，让 C-66／C-79 的失败处理直接生效 |
| `card_merged`（增加 `batch_id?`、`batch_peers?`） | 成员卡 | 见 3.2 第 5 步 |
| `merge_solo_set` | 卡片 | `solo`、操作者、理由 |

- 命令：`formMergeBatch`、`recordMergeBatchCheck`、`identifyMergeBatchCulprit`、`recordMergeBatchResult`（整批原子）、`abortMergeBatch` 只允许 system；`setMergeSolo` 允许 human 和常驻 PM Ops。全部在同一新鲜事务快照里校验。
- 不变量（契约测试必须覆盖）：
  1. 不变量 21 新表述（ADR 0004）：单卡合并只认 `level=single` 的 passed 记录；批次合并的 passed 记录绑定的完成申请集合与成员集合完全相等，且每个成员是本卡当前完成申请；`level=card` 的记录永远不能授权 merged；不同批次、不同 tree 不复用。
  2. `recordMergeBatchResult` 要么为全部成员写 `card_merged`，要么全部不写。
  3. 一个项目同时最多一个进行中的批次族（主批次及其二分子批次）。
  4. 卡片同时最多属于一个进行中的批次；`done`／`cancelled` 卡不能入批。
  5. 组批只收在队列中的卡（3.1 的条件），未确认、卡级未通过、敏感卡未获 human 确认的卡入批被拒。
  6. 失败原因卡退出队列，其余成员回到队列且确认不失效。
  7. 卡片状态只经已有迁移：批次相关命令不新增 Card 状态，只有 `card_merged` 让卡片 `done`。
  8. 不变量 23 新前置条件：PM 代确认选 merge 时要求卡级通过；不变量 27 扩展：本卡所在批次检查为 running 时禁止撤回审核。
  9. `setMergeSolo` 拒绝 Agent（除常驻 PM Ops）、拒绝空理由（PM Ops）、拒绝终态卡。
- 读模型：卡片视图增加派生字段 `merge_stage`：

| 值 | 条件 | 附带 |
|---|---|---|
| `awaiting_confirmation` | 待合并、未确认 | 卡级检查结果 |
| `queued` | 在队列中 | 队列位置（第 n 位） |
| `batch_checking` | 在进行中的主批次里 | `MB-n`、颜色序号、已完成步数／总步数 |
| `bisecting` | 所在批次在二分 | `MB-n` |
| `culprit` | 定位为失败原因，等处理 | `MB-n`、失败摘要 |
| `merged_in_batch` | 已随批次合并（卡片 `done`） | `MB-n`、同批卡片 |

  项目视图增加 `merge_batches`：进行中的批次摘要（编号、颜色序号、成员、状态、已完成步数／总步数、`solo`）。颜色序号 = 批次编号数字对调色板长度取模，同批同色。

### 3.9 Workbench（B4，用户已认可的设计）

- **卡片子标签**：卡片仍在“待合并”列，状态不新增。看板卡片和详情显示 `merge_stage` 子标签：待确认（附快速检查结果）→ 排队中（第 n 位）→ 批次检查中（MB-n 徽章，同批同色）→ 二分定位中 → 定位为失败原因（红色，退出队列）→ 已随批次合并（转为 done，时间线写“随 MB-12 合并，同批 C-a、C-b”）。
- **看板**：同批卡在“待合并”列里相邻排列，用同色竖条串起；该组顶部显示“MB-12 检查中 · 4 张 · 3/6 步”；悬停其中一张时同批卡一起高亮；“单独跑”的卡显示“单独批次”。排序只在同批卡之间调整相邻关系，其他卡沿用 C-30 的排序。
- **批次详情**（抽屉，`#/p/<项目>/merge-batches/MB-<n>`）：成员和叠加顺序、逐步结果和日志链接（沿用 `GET /api/projects/:project/merge-checks/:attempt`）、二分过程（子批次和各自结果）、批次前后的 main SHA。
- **卡片详情**：分开显示“卡级快速检查”和“批次全量检查”两块；批次检查块如实写明“本卡合并提交未单独检查，检查覆盖的是批次最终 tree”；提供“单独跑”开关（人）。
- **Needs You 合并确认**：附快速检查结果，按钮写“确认合并（批次检查通过后生效）”；确认后移出；批次失败定位到本卡时作为新事项重新出现（沿用 C-66 的已确认失败展示）。
- 颜色和图标沿用主题变量和 `StatusTag`，亮暗两套主题都满足现有对比度测试。

### 3.10 B 组任务

| 任务 | 分支 | 内容 | 范围（包和文件） | 验收标准 | 依赖 |
|---|---|---|---|---|---|
| B1a 批次实体与事件 | `feat/p2a-13b1a-merge-batch-domain` | MB-n 编号、批次实体、3.8 的事件与 system 命令、队列和 `merge_stage` 派生 | `packages/domain/src/ids.ts`、`entities.ts`、`commands/merge-batch.ts`（新）、`card-derived.ts`、`index.ts`；`packages/store` 的事件持久化和读取 | 3.8 不变量 2–7 的契约测试；`MB-` 编号递增不复用且与 `M-` 解析不混；`merge_stage` 每个值有派生用例；`pnpm --filter @cardigan/domain test:types` 通过 | ADR 0004 已合并（本卡） |
| B1b 不变量 21／23／27 改写 | `feat/p2a-13b1b-batch-merge-invariants` | `recordMergeResult` 支持批次依据；卡级记录不能授权 merged；PM 代确认、C-115 展示、C-29 代批改看卡级通过；撤回审核扩展到批次运行中；`setMergeSolo` | `packages/domain/src/commands/merge-result.ts`、`merge-check.ts`、`merge-delegation.ts`、`auto-merge.ts`、`merge-preparation.ts` 相关判断、撤回审核命令；对应契约测试 | 3.8 不变量 1、8、9 的契约测试；未启用队列的项目所有现有合并契约测试不改断言即通过（回归） | B1a |
| B2a 队列循环：组批、检查、发布 | `feat/p2a-13b2a-merge-queue-loop` | 组批与叠加、冲突处理、`MB-<n>` 候选分发、批次全量检查、整批发布、`stale` 与成员退出中止；`merge-gate.yaml` 增加 `queue: {enabled, max_batch_size}`；C-144 排序键（或同档） | `apps/server/src/merge-loop.ts`、`merge-checks.ts`（新增批次任务类型）、`apps/server/src/git.ts`（`prepareBatch`、`publishBatch`）；`packages/git-transport` 中心仓库叠加与比较更新；`packages/host/src/merge-gate-config.ts` | 不配置 `queue` 时行为与现在相同（回归）；3 张卡一批：一次检查、一次比较更新、3 个 `card_merged`；基线外部前进时中止并重组；成员被退回时中止且其余回原位；批次检查与卡级检查共用执行目标分桶名额；远程不可达时排队退避不回退本机 | B1b、A3 |
| B2b 二分与定位 | `feat/p2a-13b2b-merge-batch-bisect` | 3.3 的探测、并行／二分策略、定位规则、整批确认重跑、通过前缀发布、失败原因卡记录；C-116 超时重跑扩展到批次 | `apps/server/src/merge-loop.ts`、`merge-checks.ts`；`packages/domain/src/commands/merge-batch.ts` 的定位校验 | k=4 时第 1／2／3／4 张为坏卡各一个用例；偶发失败（确认重跑通过）发布整批；探测 `interrupted`／`executor_unreachable` 不产生定位结论；定位后 C-66 退回和重查路径可用，敏感卡只交人 | B2a；C-116 合并后补超时重跑用例 |
| B3 接口与工具 | `feat/p2a-13b3-merge-queue-api` | 读接口：卡片 `merge_stage`、项目 `merge_batches`、批次详情 `GET /api/projects/:project/merge-batches/:batch`；MCP `set_merge_solo`（仅常驻 PM Ops）；CLI `cardigan merge solo`；`list_needs_you` 增加批次失败定位的条目 | `apps/server/src/web/read.ts`、`card-state.ts`、`server.ts`；`packages/mcp-server`；`apps/cli`；`packages/roles`（PM Ops 工具清单） | 批次详情要求登录且批次属于本项目；MCP 工具对其他角色 `unauthorized`；CLI 只接受人 | B1b |
| B4 Workbench 界面 | `feat/p2a-13b4-merge-queue-ui` | 3.9 全部界面 | `apps/web/src/components/BoardCard.tsx`、`Board.tsx`、`MergeCheck.tsx`、`CardSidebar.tsx`，新增批次详情抽屉；Needs You 合并确认文案 | 组件测试覆盖六个子标签、同批相邻与同色、悬停高亮、单独批次、批次详情的二分展示、两块检查分开显示和“未单独检查”说明；亮暗主题对比度测试通过 | B3 |
| B5 上线切换（Claude 负责，不开实现卡） | — | `cardigan` 的 `merge-gate.yaml` 打开 `queue`，把 e2e 改成 `tiers: [batch]`（落实拍板第 3 条）；先一张卡试跑 | 私有部署仓库的配置 | 见第 8 节 | B1–B4；敏感卡默认单独跑的拍板 |

B1a 只加实体和事件，不改变任何现有合并行为，可以在 A+C 进行中并行开卡；B2a 依赖 A3（检查要能按层跑）。

## 4. D 组：缓存、分片和不稳定测试

前提：P2a-12 已把 `cardigan` 的合并检查切到 `cardigan-ci`（P2a-12 计划 §6 第 4 步）。D 组只改执行目标上的检查方式，不改变不变量。

### 4.1 缓存与分片

- **pnpm store**：执行账号在执行目标上保留一个 pnpm store（内容寻址，安装时校验完整性），检查用 `--frozen-lockfile` 安装，可以跨 attempt 复用而不信任候选代码写入的内容。
- **热构建目录和 `tsc -b` 增量**：每个槽位保留一个构建缓存目录，检查前把上一次的 `*.tsbuildinfo` 和输出复制进新的 attempt 目录。风险：候选代码以执行账号运行，可以污染缓存，影响下一张卡的检查结果。缓解：缓存按槽位隔离；只有 `main` 上的批次检查**通过后**才回写缓存（未通过、卡级检查都只读不写）；批次检查（决定合并的那一次）可以配置为不使用增量缓存（`cache: {incremental: card_only}`），保证合并依据不受缓存影响。
- **test 分片**：vitest 的 `--shard` 在同一检查内分成多个进程跑，或 lint、deps 与 test 并行；先在卡级检查上用，批次检查保持串行直到实测结果一致。e2e 仍串行。
- 这些都是检查命令和执行目标上的目录约定，C-130 的远程目录准备需要多准备一个按槽位的缓存目录（操作员预建，规则同槽位锁所在的 agent 根目录）。

### 4.2 不稳定测试识别（与 C-116 的分工）

- **C-116（在途）只处理超时这一类**：一次检查失败且失败原因全部是测试超时（vitest 的 Test timed out，或步骤整体超时）时，自动重新排队重跑一次，记“因超时自动重跑”；第二次仍失败，或失败中含非超时的断言错误，按现有流程交给 PM。每个完成申请只自动重跑一次。B2b 把这条扩展到批次：每个批次只自动重跑一次。
- **D 组识别其它不稳定用例，并隔离或标记它们**：
  - 证据来源：批次二分中“原批次失败、确认重跑通过”的用例；C-116 重跑后通过的用例；同一 tree 上先失败后通过的重新检查。vitest 以 JSON 报告输出逐用例结果，主机从日志旁的报告文件解析（仍写主机数据目录，按现有脱敏规则）。
  - 记录：主机侧按项目维护“疑似不稳定用例”台账（用例文件、名称、最近 N 次的通过／失败、首次和最近时间），在 Workbench 执行视图展示，不进被开发项目仓库。
  - 标记：达到阈值（例如 14 天内 ≥2 次“失败后同 tree 通过”）的用例自动标记为“疑似不稳定”，通知 PM Ops 开修复卡。
  - 隔离（失败不挡合并）会削弱闸门，**需要用户拍板后才做**；拍板前只标记、不隔离。
  - 例子：C-141 修好的 `merge-loop.test.ts`“stopping the long-lived loop cancels a real check”偶发失败，就是这类用例的典型：确认是测试同步问题后，修测试本身，而不是隔离。

### 4.3 D 组任务

| 任务 | 分支 | 内容 | 范围（包和文件） | 验收标准 | 依赖 |
|---|---|---|---|---|---|
| D1 依赖和构建缓存 | `feat/p2a-13d1-check-cache` | 4.1 的 pnpm store 和按槽位构建缓存；`merge-gate.yaml` 增加 `cache` | `packages/host/src/temporary-checkout.ts`、`merge-gate-config.ts`；`packages/runtime-herdr` 远程准备脚本；P2a-12 远程初始化清单 | 未配置 `cache` 时行为不变；未通过的检查不回写缓存；缓存目录不是链接、不越界 | P2a-12 切换完成；B2a（区分批次和卡级） |
| D2 测试分片 | `feat/p2a-13d2-test-shards` | vitest 分片和步骤并行的配置支持 | `packages/host/src/temporary-checkout.ts`、`merge-gate-config.ts` | 分片结果合并后逐项结果和日志与不分片一致；任一分片失败整体失败 | D1 |
| D3 不稳定用例识别与标记 | `feat/p2a-13d3-flaky-tests` | 4.2 的证据采集、台账、标记和通知；不做隔离 | `apps/server/src/merge-checks.ts`、`packages/store`（台账表）、Workbench 执行视图 | 三种证据来源各有用例；与 C-116 的超时重跑不重复计数；标记只通知不改变检查结果 | C-116、B2b |

## 5. 与其他计划和在途卡的关系

| 卡／计划 | 状态 | 关系和先后 |
|---|---|---|
| P2a-1 合并闸门 | 已合并 | 本计划在其 prepare／publish 拆分、检查事件状态机、失败处理（重新检查、退回修改）上扩展。A+C 只缩小检查范围；B 把“每张卡一个通过记录”改为“每批一个通过记录”（ADR 0004），P2a-1 §2.1 的“先检查后确认”变为“卡级检查 → 确认 → 批次检查” |
| C-118（P2a-12 A） | 已合并 | agent-ssh 远程目标，本计划直接使用，不改 |
| C-119（P2a-12 B） | 已合并 | `merge-gate.yaml` 的 `executors`；A2、B2a、D1 在同一文件加字段，沿用其解析风格 |
| C-127（P2a-12 C） | 已合并 | 批次 MB-n 直接作为它的候选分发：`refs/cardigan/candidates/MB-<n>` 在已同步的前缀下，一个候选对应一棵 tree；对账按 attempt 识别检查目录，批次 attempt 同样适用 |
| C-128（P2a-12 D） | 已合并 | 分桶名额按执行目标计数，卡级快速检查和批次全量检查（含二分探测）共用同一个桶 |
| C-129（P2a-12 E） | 已合并 | “不可达时不回退本机”同样适用于批次检查：批次 attempt 记 `executor_unreachable`，留在排队状态退避，不进入二分，超过 30 分钟进 Needs You |
| C-130、C-139 | 已合并 | 远程目录准备沿用；一执行目标一项目，所以一个执行目标上同时最多一个批次族，e2e 不会在同一台机器上并发跑两个项目的 |
| C-115 | 已合并 | 交人的确认等检查通过才进 Needs You：B1b 改为等卡级检查通过；noop 立即可见的例外不变 |
| C-116 | 在途（孙悟空，A-356） | 只处理超时、只重跑一次。B2b 合并在 C-116 之后，再把规则扩展到批次；D3 依赖 C-116 合并，计数时区分超时重跑 |
| C-144（接替已取消的 C-121） | 在途（赵云，A-359） | 五档优先级决定排队。批次选卡、插队、单独跑与档位的关系见 3.6（由 q(222) 决定）；B2a 复用 C-144 的排序键，二者谁先合并都可以 |
| C-141 | 已合并 | 修好的不稳定用例，作为 D3 的例子 |

先后顺序：A1 ∥ A2 → A3 → （B1a 可提前）B1b → B2a → B2b；B1b → B3 → B4；B1–B4 → B5。D 组在 P2a-12 切换完成后开始，D1 → D2，D3 在 C-116 和 B2b 之后。所有卡都不修改在途卡 C-116、C-144 正在改的判断逻辑本身，只复用它们的结果；B2a／B2b 若和它们同时改 `merge-checks.ts`，后合并的一方按 AGENTS.md 合入基线后解决冲突。

## 6. 不做

- 不新增 Card 状态，不改状态机。
- 不做投机执行（在进行中的批次上再叠一批先跑）；收益要在实测批次失败率后再评估。
- 不做跨项目批次。
- 不自动隔离不稳定测试（需用户拍板）。
- 不允许跳过批次检查直接合并的入口；“单独跑”只是批次大小为 1，仍跑全量。

## 7. 测试要求

- 改 `packages/domain` 的卡（A3、B1a、B1b、B2b）必须附契约测试，并运行 `pnpm --filter @cardigan/domain test:types`。
- 每张卡都要有“不配置新字段时行为不变”的回归用例。
- B2a／B2b 用本地 bare 仓库和假检查执行器做集成测试（参照 `merge-loop.test.ts`、`merge-checks.test.ts` 的现有夹具），覆盖：多卡叠加后每卡一个合并提交、main 一次快进、基线外部前进、成员退出、二分各位置、偶发失败、远程不可达。
- B4 的组件测试覆盖 3.9 的全部展示。
- 端到端：B5 前补一条 e2e 场景，两张卡同批合并、一张卡被定位失败后退回。

## 8. 上线与回退（Claude 负责）

1. A+C 合并后，`cardigan` 的 `merge-gate.yaml` 给 test 加 `scope: affected`、`skip_docs_only: true`，e2e 加 `skip_docs_only: true` 和 `tiers: [batch]`（打开队列前不生效）；观察一周，对比检查时长。
2. B1–B4 合并、敏感卡是否默认单独跑拍板后：打开 `queue.enabled`，`max_batch_size: 4`；先让一张卡单独走一次批次，结果与卡级相同再放开。
3. e2e 的 `tiers: [batch]` 随队列打开生效，落实拍板第 3 条。
4. 回退：关闭 `queue.enabled`，`tiers` 随即不生效，下一轮回到单卡全量检查路径（不变量 21 的 (a) 分支）；进行中的批次中止，成员回到待合并，需要按单卡路径重新检查。

## 9. 已知风险

- **中间 tree 未检查**、**同批互相抵消**、**二分误判**：见 ADR 0004 的风险表。
- **受影响包计算漏边**：测试跨包读文件、运行时动态加载不在 `package.json` 依赖里时，受影响测试会漏跑。A1 扫描一次并用 `extra_dependents` 补边；B 上线后批次检查跑全量，漏边最多推迟到批次阶段发现。A+C 到 B 之间这段时间，漏边会直接漏检，这是 A+C 先行的代价。
- **队列被一张卡长期阻塞**：二分加确认重跑最坏约 3 轮全量检查（约 10–20 分钟）。批次上限默认 4，上线后按实测调整。
- **缓存污染**：见 4.1，批次检查默认不用增量缓存。
- **C-144、C-116 同时在改 `merge-checks.ts`**：合并冲突风险，按第 5 节的先后处理。
