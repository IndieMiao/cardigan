# Phase 0 任务计划

- 版本：v3（2026-11-04）：0.5b 的 SSH 部分改用本机专用用户
- v2（2026-11-04）：0.3 增加 Herdr 换代评估和 D9
- 原版本：v1（2026-10-27）
- 对应：开发方案 v0.5 §16 Phase 0
- 目标：先在现有实践里验证"PM 前后台 + 结构化条目"这套模式；把 Herdr、MCP、Git 三个外部依赖的实际表现查清楚；敲定剩余决策（D3–D8）；搭好代码骨架。Phase 0 结束后，Phase 1 M1 可以直接开工。

## 1. 任务总览

| 任务 | 内容 | 执行者 | 前置条件 | 产出 | 分支 |
|---|---|---|---|---|---|
| 0.1 | PM 拆成前台、后台（试行） | 你 + zhangliang | 看 0.2 的结论再决定是否试行 | 一周的打断记录 | 不涉及仓库 |
| 0.2 | 回溯两个现有看板项目的卡片和时间线 | Claude | 你确认是哪两个项目 | `docs/research/0.2-board-retrospective.md` | `docs/p0-board-retrospective` |
| 0.3 | Herdr 多机预研与运行时基线（含 herdr-core / herdr-app 换代评估，给出 D9 建议） | DeepSeek（Pi） | 你确认可以用那台已保存的远程机器，并且 SSH 已连通 | `docs/research/0.3-herdr-machine.md` | `docs/p0-herdr-machine` |
| 0.4 | 各 Harness 接入 MCP 的预研 | Codex | 无 | `docs/research/0.4-mcp-harness.md` + `spikes/0.4-mcp/` | `docs/p0-mcp-harness` |
| 0.5a | 评估 herdr-projects | DeepSeek（Pi） | 无 | `docs/research/0.5a-herdr-projects.md` | `docs/p0-herdr-projects` |
| 0.5b | 主机发起的 Git 模型预研 | Codex | 无（本地部分）；SSH 部分需要你先在本机建好专用用户 `cardigan-agent`（见 0.5b） | `docs/research/0.5b-git-model.md` + `spikes/0.5-git/` | `docs/p0-git-model` |
| 0.6 | 敲定 D3–D9 | Claude 汇总，你拍板 | 0.3、0.4、0.5a、0.5b 已合并；你提供机器清单（D6） | 开发方案 v0.6 | `docs/p0-decisions` |
| 0.7 | 代码骨架 | Codex | 无 | `package.json`、`packages/*`、`apps/*` 骨架 | `feat/p0-skeleton` |
| 0.8 | 同类产品对比、名字收尾检查（非开发） | Claude | 无 | `docs/research/0.8-market-and-name.md` | `docs/p0-market-name` |

### 顺序

```
第 1 周  Codex：0.7 → 0.4 → 0.5b
        DeepSeek：0.5a → 0.3
        Claude：0.2 → 0.8；审核各 PR
        你：看 0.2 的结论，决定要不要试行 0.1
第 2 周  你：（如果试行）0.1
        Claude：0.6 汇总 → 你拍板 → 更新开发方案
```

0.3–0.5b 和 0.7 彼此独立，可以按实现者的空闲情况调整顺序。

## 2. 通用约定

- 每个任务开工前，先读 `AGENTS.md`、本计划中对应的小节，以及开发方案中列出的相关章节。
- 预研结论写在 `docs/research/<任务号>-<名字>.md`，用中文，要求：
  - 写明所用工具的确切版本（Herdr、各 Agent CLI、Node）；
  - 命令写完整、可复制；关键输出贴原文（可截断）；
  - 结尾单列"对开发方案的修改建议"，指出要改哪一节、改成什么。由 Claude 在 0.6 统一并入，预研 PR 不直接改 `docs/development-plan.md`。
- 预研用的代码放在 `spikes/<任务号>-<名字>/`：
  - 用 npm，带自己的 `package.json` 和 lockfile，不加入 pnpm workspace；
  - 只为验证结论服务，不追求质量；Phase 1 不直接复用。
- **不提交机器名、IP、用户名、个人路径**（AGENTS.md）。文档里本机叫 `local`，远程机器叫 `worker-a`；路径用 `~` 或 `/srv/...` 这类示例路径。
- **不提交任何 Token 或密钥**。测试用的 Token 在运行时生成，或从环境变量读取。
- Herdr 固定使用 0.9.3，预研期间不要执行 `herdr update`。
- 只操作预研自己创建的对象（session、workspace、pane、worktree、仓库），不碰你正在用的 Herdr 会话和真实项目。结束后清理干净，并在文档里写明清理步骤。
- PR 描述按 AGENTS.md 的要求写：对应任务、改动摘要、运行过的命令和结果、已知未覆盖的风险。

## 3. 各任务说明

### 0.1 PM 拆成前台、后台（你执行，零代码）

相关章节：开发方案 §7.1、§7.3。

这项在你现有项目的实践里做，不是在开发 Cardigan 时做。是否试行，看 0.2 的结论：如果 PM 收到的汇报中，大部分都不需要你拍板，就值得拆分试行一周。

步骤：

1. 在 Herdr 里把 zhangliang 拆成两个 Agent：`zhangliang-office` 和 `zhangliang-ops`。两者用同一份角色说明，各自再追加一段职责说明，见附录 A。
2. 把所有岗位 Agent 提示词中的门铃目标，从 `zhangliang` 改为 `zhangliang-ops`。
3. 你只和 `zhangliang-office` 对话。
4. 每次主对话被打断时，在下表追加一行（放哪里都行，周末交给 Claude）：

| 日期 | 打断内容（一句话） | 类型：拍板 / 风险 / 其他 | 该不该打断 |
|---|---|---|---|

验收（同开发方案 §16）：

- 连续一周，"该不该打断"一列都是"该"；
- `zhangliang-ops` 仍能正常分配和跟进，没有出现漏处理。

如果试行，同时在各 Agent 的提示词里使用附录 B 的评论模板（按 0.2 的结论修订后的版本），并记录 ops 判断错误的情况：

| 日期 | 卡片 | 模板 | 问题 |
|---|---|---|---|

产出：试行结束后，由 Claude 根据记录写 `docs/research/0.1-pm-split-trial.md`。

### 0.2 回溯现有看板项目（Claude）

相关章节：开发方案 §4.3（Card / WorkItem / Delivery / Review / Decision 的字段）、§5.2、§6.4、§7.3。

数据来源（全部只读，不修改任何内容）：

- 两个用"你 + PM + 岗位 Agent"方式推进的看板项目（共约 580 张卡），通过看板的 MCP 读取。
- PM（张良）的 Claude Code 会话记录。原始数据放在仓库之外，不提交。

抽样：每个项目取约 40 张卡，读完它们的全部评论。三类卡各占一部分：

- 最近完成的；
- 来回返工多的；
- 有拍板的。

统计数字按样本估算，在报告里注明。

步骤：

1. 按上面的规则抽样，读取样本卡片和全部评论。
2. 卡片层面：目标、验收标准、子任务实际是怎么写的；和 §4.3 的 Card / WorkItem 字段对照，找出用不上的字段和缺少的字段。
3. 评论层面：按 §5.2 的条目类型给每条评论归类（评论、指令、交付、审核、待拍板、决定、状态变化）。统计各类的数量，以及无法归类的评论。
4. 交付、审核、拍板这三类：实际写了哪些信息，缺了哪些，和 §4.3 的字段一一对照。
5. 下一步是否清楚：找出 PM 靠猜才确定下一步的地方，例如反复追问、重复提醒、派错人、返工原因说不清。每一处都写明缺了什么信息。
6. 打断：从 PM 的会话记录里统计门铃和你自己的消息各占多少，门铃中有多少真正需要你拍板，以及门铃有没有插进你正在输入的内容。用这些数据估计 PM 拆成前台、后台以后能减少多少打断，作为是否试行 0.1 的依据。
7. 拍板：决定有没有散落在普通评论里、事后被反复询问，被阻塞的工作是否知道何时可以恢复。

产出：`docs/research/0.2-board-retrospective.md`，包含统计表、典型案例（已脱敏）、对 §4.3 和 §9.2 的修改建议，以及修订后的附录 B 模板。

脱敏要求：报告进仓库，所以不写项目名、客户名、金额和具体业务内容。案例只保留结构，例如"卡片 X：交付评论没写提交号，测试 Agent 追问了两次"。

验收：

- 样本卡片的全部评论都已归类，并写明抽样方法；
- §4.3 中 Delivery、Review、Decision 的每个字段都有"实际用到 / 用不到 / 缺失"的结论；
- 给出"是否值得试行 0.1"的明确建议。

### 0.3 Herdr 多机预研与运行时基线（DeepSeek）

相关章节：开发方案 §6.8、§11、§13.9；0.5a 报告第 1.2 节和第 10 节。

背景（2026-11-04 补充）：Herdr 正在换代。官方新出了 `herdr-core` 和 `herdr-app`（0.1.x），0.5a 评估的 herdr-projects 已经迁移过去；而我们锁定的是 Herdr 0.9.3，0.9.x 的最新版是 0.9.5。所以 0.3 分两部分：A 部分评估换代，给出运行时基线的建议（新增决策 D9）；B 部分在 0.9.x 上做原定的多机验证。

前置条件：

- 你确认可以使用那台已保存的远程机器（下称 `worker-a`），并且已经从 `local` 用 SSH 连通它。它的地址变过，SSH 配置和 Herdr 保存的机器需要先更新，由你来改。
- 在 `local` 和 `worker-a` 上各准备一个临时 Git 仓库：`git init` 后提交一个文件即可，不要用真实项目。

**不能动用户正在使用的 Herdr**：不升级、不替换、不重启用户的 Herdr 0.9.3，不操作用户已有的 session、workspace 和 pane。需要试用 herdr-core 或 herdr-app 时，只能装在临时目录、以独立进程运行，用完删除；做不到隔离就只读文档和源码。

#### A 部分：换代评估（只读为主）

1. 查清 `herdr-core`、`herdr-app` 是什么，和 Herdr 0.9.x 是什么关系：是后继、并行的两条产品线，还是底层拆分出来的组件？0.9.x 会不会停止维护，有没有迁移指南？列出版本节奏和许可证。
2. 对照开发方案 §11.1 的运行时接口（provision、wake、status、interrupt、resume_or_replace、human_entry、release），逐项写出 Herdr 0.9.x 和 herdr-core / herdr-app 各用什么命令或 API 实现；不支持的写"不支持"。重点看：多机（`--machine` 的等价物）、建删 worktree、按门铃、等待、Agent 状态识别、以 socket 还是 RPC 访问。
3. 0.9.3 到 0.9.5 之间有没有影响 §11 的改动。
4. 如果能在临时目录隔离运行 herdr-core，就做一次最小的本机试用：启动、开一个终端、发一条 prompt、读回状态。

#### B 部分：Herdr 0.9.x 多机验证

步骤：

1. 隔离：先确认能否用 `herdr --session <名字>` 配合 `--machine` 把预研放进独立 session。如果不能，就只操作自己创建的 workspace 和 pane，并在文档里写明这一点。
2. 在 `local` 和 `worker-a` 上分别验证下列命令，记录确切参数、输出的关键字段和退出码：

| 动作 | 命令（以 `herdr <cmd> --help` 为准） | 要记录的 |
|---|---|---|
| 服务状态 | `herdr [--machine M] status server` | 输出字段；远程 server 没启动时的表现 |
| 建 worktree | `herdr [--machine M] worktree create`，分支名用 `agent/C-0/W-0` | 返回的 workspace / pane 标识、worktree 路径 |
| 启动 Agent | `herdr [--machine M] agent start`；再用 `agent rename` 改名为 `coder-c0-w0` | 支持哪些 Agent；名字的唯一性范围 |
| 按门铃 | `herdr [--machine M] agent prompt`，内容用 §6.2 的门铃格式 | Agent 空闲时和忙碌时分别是什么表现 |
| 等待 | `herdr [--machine M] agent wait` | 可等待的状态、超时参数、超时后的退出码 |
| 查询 | `agent list`、`agent get`、`agent read`、`api snapshot` | 哪个命令最适合给 Runtime Adapter 轮询 |
| 删 worktree | `herdr [--machine M] worktree remove` | 干净时；有未提交修改时（保护机制）；强制删除 |
| 状态识别 | `agent explain`、`integration status` | Pi、Claude Code、Codex 分别靠什么识别状态 |

3. 故障表现。每一项都记录 CLI 的输出、退出码、耗时，以及恢复后的状态：
   - 向不存在的 pane 或 Agent 发 prompt；
   - `worker-a` 的 Herdr server 停止时发 prompt；
   - 网络断开时发 prompt（断开方式自选，在文档里写明）；网络恢复后，这条 prompt 是丢了、补发了，还是重复了；
   - 断网期间在 `local` 查询 `worker-a` 的 `agent list`：是报错还是返回缓存状态；
   - Agent 正在工作时连续发两次 prompt。
4. 逐行核对开发方案 §11.2 的映射表和 §11.3 的已知限制：哪些成立，哪些需要改。

产出：`docs/research/0.3-herdr-machine.md`。第一页是结论，包括：

- D9 的建议：Cardigan 的运行时以哪一代为基线（Herdr 0.9.x，还是 herdr-core / herdr-app），理由，以及 Runtime Adapter 要怎样隔离才能以后平滑切换；
- §11.1 接口在两代上的对照表；
- B 部分的"命令 → 确切参数 → 关键输出字段"表和故障表现表；
- 对 §11 的修改建议。

验收：

- A 部分：§11.1 的每个接口在两代上都有结论（可以是"不支持"）；D9 的建议有明确理由；
- B 部分：第 2 步表中每一行都有实测结果，第 3 步每种故障都有观察到的表现；
- 用户的 Herdr 版本没变，用户已有的 session 没受影响；预研创建的对象全部清理干净。

### 0.4 各 Harness 接入 MCP 的预研（Codex）

相关章节：开发方案 §9.1、§10.2、§14。

步骤：

1. 在 `spikes/0.4-mcp/` 用 TypeScript 和官方 MCP SDK 写一个最小的 Streamable HTTP 服务：
   - 校验 `Authorization: Bearer <token>`：缺少 Token 或 Token 错误时返回 401；
   - Token 在启动时生成，或者从环境变量读取，并映射到一个身份（例如 `asg=A-1`）；
   - 提供两个工具：`whoami`（返回 Token 对应的身份，验证"身份由 Token 决定"）和 `echo`；
   - 只监听 `127.0.0.1`，并打印每个请求的方法和身份。
2. 对 Claude Code、Codex、Pi 三个 Harness 逐一验证：
   - 能连上，能列出工具，能调用 `whoami`；
   - Token 通过环境变量传入，配置文件里不出现 Token 原文；
   - 配置文件可以放在仓库之外，或者放在已被 git 忽略的路径（§10.2）。逐一找出每个 Harness 怎么指定配置文件的位置；
   - Token 错误时，Harness 给出什么提示，会不会卡住；
   - 服务重启后，Harness 能否自动重连。
3. 为每个 Harness 填一份 Launch Profile 草稿，字段按 §10.2：启动命令模板、指定 Provider / 模型、注入 Core Prompt、写入 MCP 配置（含 Token）、Herdr 如何识别状态、恢复会话的命令。每个字段都要附上实测过的命令。

产出：`docs/research/0.4-mcp-harness.md`，含三份 Launch Profile 草稿；`spikes/0.4-mcp/`。

验收：

- 三个 Harness 都能通过 Bearer Token 调通 `whoami`；
- 三份 Launch Profile 的每个字段都有实测命令；
- 仓库里没有 Token 原文。

OpenCode 本机没有安装，这次不测。等 D3 选定它时再补。

### 0.5a 评估 herdr-projects（DeepSeek）

相关章节：开发方案 §2.1、§4、§12，以及 §15 的 D8。

步骤：

1. 阅读 `eliasstravik/herdr-projects` 的源码和文档。可以用 `pi-web-access` 把仓库 clone 到本地再读。
2. 写一张实体对照表：它的概念 → 我们的 Card / WorkItem / Assignment / Run / Delivery / Review / Decision。标出缺失和冲突。
3. 对比它的 worktree、review、合并流程和我们 §12 的主机发起模型，找出差异。
4. 了解它的扩展接口、许可证、活跃度（最近提交时间、issue 处理情况）。
5. 给出 D8 的建议：直接 fork、借鉴部分设计，还是不用。写明理由；如果建议借鉴，列出具体借鉴哪些点。

产出：`docs/research/0.5a-herdr-projects.md`。

验收：对照表覆盖 §4.1 的全部概念；D8 建议有明确理由。

### 0.5b 主机发起的 Git 模型预研（Codex）

相关章节：开发方案 §12、§13.2、§13.9。

SSH 部分的做法（2026-11-04 修订）：不连远程机器，而是在本机建一个专用用户 `cardigan-agent` 当作"工作机"，`hub`（你当前的用户）通过 `ssh cardigan-agent@localhost` 访问它。这和开发方案 §13.4 的 `agent` 用户一致：没有 sudo，不持有任何 SSH 密钥和 Git 凭据；SSH 方向只有 hub → worker。这样走的是和真实多机相同的 SSH 代码路径，但不碰任何正在使用的机器。

前置条件（由你执行，需要 sudo；实现者不要自己建用户、不要用 sudo）：

```bash
# 1. 建专用用户：有自己的 home，没有 sudo，没有可用的登录密码
sudo useradd -m -s /bin/bash cardigan-agent
# 2. 生成一把只用于本次预研的密钥（放在 hub 用户这边）
ssh-keygen -t ed25519 -N "" -C "cardigan-spike" -f ~/.ssh/cardigan_spike_ed25519
# 3. 授权：只允许从本机登录，禁止各种转发
sudo install -d -m 700 -o cardigan-agent -g cardigan-agent /home/cardigan-agent/.ssh
echo "from=\"127.0.0.1,::1\",no-port-forwarding,no-agent-forwarding,no-X11-forwarding $(cat ~/.ssh/cardigan_spike_ed25519.pub)" \
  | sudo tee /home/cardigan-agent/.ssh/authorized_keys >/dev/null
sudo chown cardigan-agent:cardigan-agent /home/cardigan-agent/.ssh/authorized_keys
sudo chmod 600 /home/cardigan-agent/.ssh/authorized_keys
# 4. 验证（应输出 cardigan-agent 和 git 版本）
ssh -i ~/.ssh/cardigan_spike_ed25519 -o IdentitiesOnly=yes cardigan-agent@localhost 'whoami; git --version'
# 如果第 4 步被拒绝登录，可能是账户被标为锁定，执行：sudo usermod -p '*' cardigan-agent
```

脚本里一律用 `-i ~/.ssh/cardigan_spike_ed25519 -o IdentitiesOnly=yes` 显式指定密钥（可以通过 `GIT_SSH_COMMAND` 传入），不要修改 `~/.ssh/config`。预研结束后的清理（由你决定是否执行）：`sudo userdel -r cardigan-agent`，并删除 `~/.ssh/cardigan_spike_ed25519*`。

步骤：在 `spikes/0.5-git/` 写一个可以重复执行的脚本。`hub` 和 `worker` 先用本机的两个目录模拟，走本地路径；全部跑通后，再把 `worker` 换成 `cardigan-agent@localhost`，走 SSH。

1. `hub`：建中心 bare 仓库和集成 clone。
2. 基线：`hub` 把 main 推到 `worker` 基础 clone 的 `refs/remotes/origin/main`，并确认不影响 `worker` 当前检出的分支。
3. `worker`：建 worktree，分支 `agent/C-1/W-1`，提交两次，不 push。
4. 拉取交付：`hub` 从 `worker` 拉取 `agent/C-1/W-1`，存入 `refs/cardigan/deliveries/D-1`，并验证：
   - 指定的 SHA 在该分支上：接受；
   - 伪造的 SHA：拒绝；
   - 存在、但不在该分支上的 SHA：拒绝。
5. 定期拉取：用一条 refspec 拉取 `worker` 上全部 `agent/*` 分支。
6. 断线与接管：让 `worker` 不可达，记录拉取失败的耗时和报错（SSH 设置 `ConnectTimeout`）。不可达用两种方式模拟，都只改这一次调用的参数：连一个不存在的地址（例如保留的测试地址 `203.0.113.1`，观察超时），以及连一个没有服务的端口（观察连接被拒）。然后从 `hub` 最后拉取到的 SHA，在第三个目录（模拟另一台机器）建 worktree 继续开发。
7. 合并：在 `hub` 的集成 clone 合并，并更新中心仓库的 main。
8. 记录：`worker` 一侧全程不需要任何 Git 凭据；`cardigan-agent` 的 home 里只有 `authorized_keys`，没有私钥。

产出：`docs/research/0.5b-git-model.md`，写明每一步的确切 git 命令、refspec、超时设置和失败表现，以及对 §12 的修改建议；`spikes/0.5-git/`。

验收：

- 脚本从空目录开始，一次跑完第 1–7 步；
- 两种错误的 SHA 都被拒绝；
- 接管后能继续提交，并被 `hub` 拉取。

### 0.6 敲定 D3–D9（Claude 汇总，你拍板）

前置条件：0.2、0.3、0.4、0.5a、0.5b 已合并；你提供机器清单（D6）：哪台常开做主机、哪台接测试真机，各自的系统和架构。

步骤：

1. Claude 根据预研结论，为 D3（每个角色的 Harness 和模型）、D4（Done 条件）、D5（Session 策略）、D7（core memo）、D8（herdr-projects）、D9（运行时基线，依据 0.3）各给一条建议和理由。
2. 你逐条拍板。
3. Claude 更新开发方案：§15 全部标为已决定；按预研的修改建议修订 §4.3、§9.2、§11、§12；版本升到 v0.6。D8 如果决定 fork，另写 ADR。
4. Claude 写 Phase 1 M1 的任务计划 `docs/plans/phase-1-m1.md`。

验收：§15 没有未决项；M1 计划可以直接派发。

### 0.7 代码骨架（Codex）

相关章节：开发方案 §15 D2、§20.1、§20.2。

前置条件：无。本机 pnpm 11.7 已安装；系统 Node 是 22.20，不需要升级。

Node 24 由 pnpm 在项目内管理：在 `package.json` 里声明 `devEngines.runtime`，pnpm 会自动下载 Node 24，并只在本项目使用。已在本机用 pnpm 11.7 实测：`pnpm run` 和 `pnpm exec` 用的是下载的 Node 24.22.1，系统里直接运行的 `node` 仍是 22.20。所以所有命令都必须通过 `pnpm run` 或 `pnpm exec` 执行，不要直接运行 `node` 或 `npx`。

范围：

- 根目录：
  - `package.json`：
    - `private: true`；
    - `packageManager` 固定 pnpm 版本；
    - Node 版本的声明：

      ```json
      "devEngines": { "runtime": { "name": "node", "version": "^24.0.0", "onFail": "download" } }
      ```

  - `pnpm-workspace.yaml`：包含 `packages/*` 和 `apps/*`；
  - `tsconfig.base.json`：`strict`，模块方案用 NodeNext。
- 按 §20.1 建所有包：`packages/` 下 8 个，`apps/` 下 3 个。
  - 包名用 `@cardigan/<名字>`；
  - 每个包有 `package.json`、`tsconfig.json`（使用 project references）和 `src/index.ts`（空导出）；
  - `apps/web` 用 Vite + React + TypeScript，只显示一个标题页；
  - `e2e/` 和 `deploy/examples/` 暂不创建。
- 工具（这些是默认选择，你有不同意见可以在审核时提）：
  - 测试：Vitest，在根目录统一运行；
  - 检查和格式化：Biome；
  - 依赖方向：dependency-cruiser。
- 依赖方向规则（§20.2），按层级只能引用更低层：

| 层 | 包 |
|---|---|
| 0 | `domain`（不引用任何内部包，也不引用 Node 的 IO 模块） |
| 1 | `store`、`router`、`mcp-server`、`git-service`、`roles` |
| 2 | `runtime-herdr`、`git-transport` |
| 3 | `apps/*` |

- 根目录脚本：`pnpm build`、`pnpm test`、`pnpm lint`、`pnpm check:deps`。

不做：数据库驱动、HTTP 框架、MCP SDK、任何领域代码、CI。这些在 M1 计划中决定。

验收：

- 在全新 clone 上，`pnpm install && pnpm build && pnpm test && pnpm lint && pnpm check:deps` 全部通过，并且 `pnpm exec node -v` 输出 v24.x；
- 让 `packages/domain` 故意引用 `@cardigan/store`，或者引用 `node:fs`，`pnpm check:deps` 会失败。在 PR 里贴出这次失败的输出，然后撤回这个改动；
- 每个包都有一个最小的测试，确保 Vitest 能找到它。

### 0.8 同类产品对比、名字收尾检查（Claude）

- 同类产品：Kandev、Castra、Atelier、cline/kanban、Orchestrator.inc。对比的维度：PM 前后台分离、结构化拍板、是否支持多种 Agent CLI、多机部署、看板形态、许可证。结论用来确认我们的差异点。
- 名字：域名、npm scope（`cardigan` 这个包名已被占用，需要用 scope）、中美商标、Shopify 上同名礼品卡集成的影响。

产出：`docs/research/0.8-market-and-name.md`。只做调研，结论交给你决定。

## 4. 怎么派发任务

每个任务用一个独立的 worktree，避免两个实现者在同一个目录里切换分支、互相干扰：

```bash
cd <cardigan 仓库目录>
git switch main && git pull
git worktree add ../cardigan-<分支名最后一段> -b <分支名> main
cd ../cardigan-<分支名最后一段>
```

任务合并后清理：`git worktree remove ../cardigan-<分支名最后一段>`。

给实现者的开场提示（把 `<任务号>` 和分支名替换掉）：

```
读 AGENTS.md，再读 docs/plans/phase-0.md 的 §2（通用约定）和 §3 中的 <任务号>，以及其中列出的开发方案章节。
按计划执行 <任务号>，在 <分支名> 分支上提交，完成后开 PR。
PR 描述按 AGENTS.md 的格式写。遇到计划没覆盖的情况，在 PR 里写明，不要自行扩大范围。
```

- Codex：在该任务的 worktree 里启动 `codex`，粘贴上面的提示。
- DeepSeek：在该任务的 worktree 里启动 `pi`，粘贴上面的提示。如果 Pi 提示信任项目，选择信任；第一次启动时，Pi 会自动安装 `.pi/settings.json` 里声明的插件。

PR 提交后由 Claude 审核，合并前需要你确认。

---

## 附录 A · 0.1 的两段职责说明

追加到 `zhangliang-office` 的提示词：

```
你是 zhangliang-office，只负责和用户对话。
- 你不接收岗位 Agent 的汇报。需要了解进展时，去看板读卡片和评论。
- 只有两类消息会转给你：需要用户拍板、重大风险。收到后用一句话告诉用户，并给出你的建议。
- 用户做出决定后，在对应卡片下发一条 [决定] 评论，按模板写，用户原话照录。
- 分配任务、催进度、安排返工都交给 zhangliang-ops，不要自己给岗位 Agent 发门铃。
```

追加到 `zhangliang-ops` 的提示词：

```
你是 zhangliang-ops，不和用户对话。
- 所有岗位 Agent 的汇报都发给你。你负责分配任务、跟进进度、安排返工、处理阻塞。
- 只有两类情况才通知 zhangliang-office：需要用户拍板、重大风险（例如需要停止发布）。通知只写一行：
  [升级] 卡片=<编号> 类型=拍板|风险 <一句话说明>
- 交付、审核、一般进度都不通知 office，写在卡片评论里即可。
- 事实都在看板上，不靠你的记忆，所以你的会话随时可以重建。
```

## 附录 B · 评论模板（草稿，0.2 完成后修订）

```
[交付]
工作项：<名称>
摘要：<做了什么>
提交：<分支> @ <commit SHA>
测试：<命令和结果>
附件：<截图、录屏的链接>
请求验证：<设计走查 / 测试验收 / …>
```

```
[审核]
针对交付：<交付评论的链接，或 commit SHA>
类型：设计 | 代码 | 测试 | 产品
结论：通过 | 驳回 | 有条件通过
问题：
- [必须修复] <描述>
- [建议] <描述>
是否阻塞整卡：是 | 否
```

```
[待拍板]
问题：<一句话>
背景：<为什么需要拍板>
选项：
- A：<描述>；影响：<…>
- B：<描述>；影响：<…>
建议：<选项和理由>
受影响的工作：<…>
是否阻塞：是 | 否
由谁拍板：用户 | <角色>
```

```
[决定]
针对：<待拍板评论的链接>
选择：<选项>
理由：<…>
原话：「<用户原话>」
来源：对话 | 看板
```

`zhangliang-ops` 的下一步规则（简化自开发方案 §6.4）：

| 模板 | 下一步 |
|---|---|
| `[交付]` | 通知"请求验证"中列出的岗位开始验证 |
| `[审核]`，结论为通过 | 不唤醒任何人；检查这张卡的必需项是否都已通过，都通过了就安排 PM 验收 |
| `[审核]`，结论为驳回 | 通知交付者返工，附上"必须修复"的问题 |
| `[待拍板]`，阻塞，由用户拍板 | 升级给 office；把受影响的工作标为等待拍板 |
| `[待拍板]`，不阻塞 | 不升级，留在卡片上，下次和用户同步时一并带上 |
| `[决定]` | 唤醒"受影响的工作"对应的岗位继续 |
