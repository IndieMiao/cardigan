# ADR 0005：角色升级后已有 Assignment 如何拿到新增工具

- 状态：提议（待人选方案）。本 ADR 只记录现状和备选方案，不改代码和配置；凡是让已有 Token 获得更多工具的做法，都要人确认后才能实现
- 依据：开发方案 §4.3（角色升级）、§4.5 不变量 5／11／12／15／21、§7.1（常驻 PM 换版本）、§9.1（Token）、§10.1（角色版本）、§14.1（角色权限边界）
- 卡片：C-96（来源 C-83#6 第 4 点、PM 验收 V-268 第 2 条 minor）

## 现状

### 工具范围由两层固定

1. **Assignment 固定角色版本。** `assign`、`pm create`、`host-ops create` 创建 Assignment 时写入当时最新启用的 `role_version`，之后不改（§10.1：“已有 Assignment 固定使用指派时的版本”）。主机启动和签发 Token 都按这个版本读角色：`packages/host/src/commands.ts` 的 `launchEntities` 用 `assignment.role_version` 取 Role，`issueAssignmentToken` 用这个 Role 的 `allowed_tools` 签发。
2. **除常驻 PM 外，Token 重签不扩权。** 重签有两条代码路径，都不会变宽：
   - 启动路径：Dispatcher 启动和替换会话、`assignment start` 经 `packages/host/src/launch.ts` 调 `issueAssignmentToken`。这个函数只对 `scope=standing && role_id=pm` 走特殊分支，按 `standing_mode` 从角色工具里重新筛选。其余所有 Assignment，包括工作项和常驻 host_ops，都取“角色工具 ∩ 上一张 Token 的工具”（M3.T2 规则：新 Token 不比被替换的宽）。
   - `cardigan token issue`：`apps/cli/src/workflow.ts` 自己按 `assignment.role_version` 读角色。非常驻 PM 时直接沿用上一张 Token 的 `allowed_tools`（没有上一张才用角色工具），再经 `issueTokenForAssignment` → `issueTokenInTransaction` 签发，不经过 `issueAssignmentToken`。

   所以对工作项和常驻 host_ops 来说，即使只改了 Assignment 的 `role_version`，不改这两条重签规则，也仍然拿不到新工具。

MCP 认证（`packages/mcp-server/src/auth.ts`）只信 Token 记录的 `allowed_tools`，角色行只补充 `capabilities`。`cardigan role upgrade` 只追加角色版本（`role_updated`），不碰任何 Assignment 和 Token。

### 现有的换版本途径

| Assignment 类型 | 途径 | 说明 |
|---|---|---|
| 常驻 PM（Office／Ops） | `cardigan pm rotate --ops\|--office` | 只接受 human；新建 Assignment，交接游标、拍板和待你执行，释放旧 Assignment（§7.1） |
| 常驻 host_ops | 人工两步：`cardigan assignment release <旧A>`，再 `cardigan host-ops create` | `host-ops create` 只复用未释放的身份；旧身份释放后，它按最新启用版本新建身份（`packages/domain/src/commands/host-ops.ts`）。前置条件（`packages/domain/src/commands/release.ts`）：只接受 human；旧身份没有待处理的主机运维操作；没有未结束的 Run，有的话先 `assignment stop`。局限：不是原子操作，两步之间项目里没有 host_ops；新身份不继承旧身份的 ACK 游标（`pm rotate` 会迁移游标，这条路径不会）；新身份按新版本首次签发 Token，所以能拿到新增工具。这是“换新身份”，不是旧 Token 变宽 |
| 工作项 Assignment | 实际上没有 | `assign` 对已有 Assignment 的工作项只复用原身份，且要求 `role_version` 一致；原身份释放后再 `assign` 返回 `invariant_violation`（`packages/domain/src/commands/pm.ts` 的 `assign`，不变量 15）。验证项可以用 `replace_verification_work_item` 换新工作项，产出项没有对应命令 |

§10.1 和 P2a-10 A 里写的“需要重新指派”，对已有工作项走不通：只能取消原工作项、另建工作项再指派。常驻 host_ops 能换版本，但要人手工两步，没有 `pm rotate` 那样的原子轮换和交接。

P2a-10 A／C-83 的会话替换（`tool_catalog_changed`）和 C-154 的 `pm restart` 都沿用原 Assignment 和原角色版本，所以新会话的角色版本和工具都与旧会话相同（线上记录和签发实测见下文“核实记录”）。

### 复现

1. 准备一个项目，coder 角色停在 vN；用 `cardigan assign` 给某个工作项指派 coder，得到 A-x（`role_version=N`）。
2. 给 coder 追加 vN+1，`allowed_tools` 比 vN 多一个工具 T：默认角色包已有新工具时用 `cardigan role upgrade coder --from-default`（输出会列出新增工具 T），否则用 `cardigan role update --file` 写入新版本。
3. 用 A-x 的 Token 调 `whoami`：`role_version` 仍为 N，`allowed_tools` 不含 T；`tools/list` 也没有 T。
4. 执行 `cardigan token issue` 给 A-x 重签，或让 Dispatcher 替换会话：结果同第 3 步。
5. 再执行一次 `cardigan assign` 同一个工作项：返回原 A-x，版本不变。

常驻 PM 同理：第 3、4 步不变，只有 `pm rotate` 后的新 Assignment 拿到 T。

### 核实记录

- **启动路径的函数实测（2026-11-13，孙悟空）。** 在临时库里调用 `launchEntities` + `issueAssignmentToken`，也就是 Dispatcher 启动／替换会话和 `assignment start` 所走的签发函数。用的是临时测试文件，跑完已删除，没有提交。场景：coder v1 的工具为 `[whoami, submit_delivery]`，工作项 Assignment 固定 v1，先签发一次；再追加 v2，工具多一个 `post_comment`。结果：
  - 不改 Assignment 直接重签：`role_version=1`，工具 `[whoami, submit_delivery]`；
  - 假设把 Assignment 的 `role_version` 改成 2 再重签：`role_version=2`，工具仍为 `[whoami, submit_delivery]`，被“与上一张 Token 取交集”挡住。

  启动路径上两层固定都得到了验证：只改版本号不够，备选 B／C 必须同时改重签规则。实测只覆盖工作项 Assignment；常驻 host_ops 走同一个取交集分支，是按源码判断的，没有单独实测。
- **`token issue` 路径（只读源码，没有实测）。** 按 `apps/cli/src/workflow.ts` 和 `apps/cli/src/host.ts` 的调用链，非常驻 PM 重签时沿用上一张 Token 的工具清单，版本取 Assignment 固定版本，所以同样拿不到新增工具。这个结论来自读源码，不是上面函数实测的覆盖范围。
- **线上会话替换记录（2026-11-12 部署后，数据由 PM 王熙凤从事件 actor 字段原样抄录，见 C-96#12，不涉及 Token）。**
  - C-171#43（15:46:41，`tool_catalog_changed`）：被替换的是 coder A-467。替换前 R-2535 的 `role_version=4`，替换后 R-2537 的 `run_started` 的 `role_version=4`。`allowed_tools` 前后相同，共 13 个，就是 coder 的标准清单，以 `submit_delivery` 结尾。
  - C-164#147（15:54:01，`tool_catalog_changed`）：被替换的是 reviewer A-452。替换前 R-2517、替换后 R-2548 的 `role_version` 都是 3。`allowed_tools` 前后相同，共 14 个，含 `submit_review`、`withdraw_review`。
  - 16:4x 查到的最新版本：coder=5、reviewer=5、pm=13。替换发生那一刻的最新版本号查不到，未核。旁证：16:08 新建的 coder A-474 和 16:14 新建的 reviewer A-480 都是 v5，它们的 `allowed_tools` 与上面 v4 coder、v3 reviewer 的清单逐项相同。
  - 结论：线上替换证实了“替换会话后 `role_version` 不变”（v4、v3 都没有升到 v5）。但这几个版本之间的工具清单本来就相同，所以线上记录**证明不了**“新增工具拿不到”。这一点以上面的签发实测为准。同批被替换的 A-446（coder）、A-459（pm）没有逐个核对。

## 备选做法

### A. 只提示，不改权限

`role upgrade`（含 `--dry-run`）输出差异后，追加列出受影响的 active／suspended Assignment：编号、员工、固定版本、所属卡片或常驻模式，以及新版本里它们拿不到的工具；按类型给出可行的下一步（常驻 PM 用 `pm rotate`；验证项用替换命令；产出项需要另建工作项；host_ops 先 `assignment stop`／`release`，再 `host-ops create`，并附上前置条件和局限）。Workbench 的 Assignment 详情可以标“角色有更新版本”。

- 权限影响：无。任何 Token 都不变宽。
- 工作量：小。domain 加一个只读查询，CLI 输出加一段，约 1 张卡。
- 不变量：不涉及。§10.1“固定版本”保持原样。
- 局限：问题本身没解决。产出项仍然没有升级途径；host_ops 只能走人工两步，不是原子操作，也不交接游标。

### B. 显式升级命令（仅 human，逐个 Assignment）

新增 `cardigan assignment upgrade-role <A-n> [--dry-run]`，只接受 human、拒绝 Token 模式，与 `pm rotate` 同级。在一个写事务里：

1. 核对 Assignment 为 active，角色有更高的启用版本；新旧版本的 `kind`、`worktree` 模式必须相同（放宽 worktree 或改类型一律拒绝，要换只能新建工作项）；新版本缺少现有待处理事项所需工具时拒绝（沿用 `pm rotate` 的检查）。
2. 把该 Assignment 的 `role_version` 改为新版本，写审计事件（如 `assignment_role_upgraded`，含 from／to 版本、新增和移除的工具、操作者）。
3. 作废旧 Token，按新版本签发新 Token。除常驻 PM 外的 Assignment（工作项和常驻 host_ops）在这里显式绕过“不比旧 Token 宽”的规则，这是唯一的例外入口。其他重签路径保持不变：`issueAssignmentToken` 仍然取交集，`token issue` 仍然沿用上一张 Token 的工具。
4. 取消未结束的 Run，下一次唤醒按新版本启动新会话（复用 C-154 的“确认旧终端退出后再动”流程）。

- 权限影响：**会让已有 Assignment（及其新 Token）获得更多工具**，但每次都由人对单个 Assignment 明确执行，`--dry-run` 先列出将新增的工具。
- 工作量：中。domain 命令和契约测试、主机侧停终端和重签、CLI，约 2–3 张卡；还要改下面几处约束和 §10.1、§9.1 正文。
- 不变量：
  - 5（Assignment 不替换）：保持，身份、worktree、游标、员工都不变。
  - 12（Run 记录角色版本）：已有 Run 仍记录旧版本；升级前必须结束未完成的 Run，因为 `launch.ts` 的 `snapshot` 和 `resumption.ts` 都要求 Run 与 Assignment 版本相同。阻塞中的 Run（等拍板）恢复时会生成新 Run，需改为按 Assignment 当前版本记录，否则会触发 `invariant_violation`。
  - 15／16（审核隔离）：身份不变，不受影响。
  - 21（角色只能由人管理）：命令只接受 human，满足。
  - 11：权限仍由服务端按 Token 校验。
  - §10.1 和 §7.1 的“Assignment 终身固定创建时的角色版本”要改为“固定，除非人显式升级”。
- 可选收窄：只允许升级产出项。常驻 PM 有 `pm rotate`，验证项有替换命令，host_ops 有人工两步，或者改用 D 的 `host-ops rotate`。这样例外入口只对工作项开放，host_ops 不需要放宽重签规则。

### C. 替换会话时自动按最新版本重签

Dispatcher 替换会话（`tool_catalog_changed`、`launch_profile_changed`）或 `pm restart` 时，顺带把 Assignment 升到角色最新启用版本并重签 Token。对工作项和常驻 host_ops，还要让 `issueAssignmentToken` 在这条自动路径上放开取交集。

- 权限影响：**会让已有 Token 在无人逐个确认的情况下获得更多工具**，生效时机取决于下一次自然唤醒，人无法预知哪个会话在何时扩权。人执行 `role upgrade` 只看到角色差异，看不到会影响哪些在跑的身份。
- 工作量：中。除 B 的改动外，还要处理正在执行中的工作被替换打断、新版本缺工具时如何降级等情况。
- 不变量：与 B 相同的 12 号问题；另外违背 §10.1 现有“不自动替换既有会话、Token 或 worktree”（C-25 的 PM 指令）和 §4.3“不自动升级任何角色”，需要人改写这两条约定。
- 不推荐：扩权没有显式授权点，不可审计到人。

### D. 不改机制，补“重新指派”路径

承认 Assignment 固定版本，给产出项补一个与 `replace_verification_work_item` 对称的替换命令（取消原项、生成新项、新 Assignment 用最新版本）。给 host_ops 补一个类似 `pm rotate` 的 `host-ops rotate`，把现有的人工两步（release + create）收进一个事务，并迁移 ACK 游标。

- 权限影响：不扩大已有 Token；新 Assignment 是新身份、新 Token，按最新版本签发，与新指派相同。
- 工作量：中到大。产出项替换要处理已有交付、审核、分支和 worktree 的去留（新身份要不要接手原分支），比验证项替换复杂得多。host_ops rotate 较小，现有人工路径已经能换版本，它只补原子性和交接。
- 不变量：5 保持（换的是工作项或常驻身份，不是在原 Assignment 上换会话）；15／16 需要新 Assignment 继续满足审核隔离，产出项替换后原验证项的 Assignment 不能被复用；2（每个改代码的工作项只有一个 Coding Assignment）由“新项新身份”满足。
- 局限：换掉一个进行中的产出项代价高，实际多半会选择等这张卡做完。

## 需要人拍板的权限点

以下几点都会让**已存在的** Assignment 或 Token 获得更多工具，实现前必须由人确认：

1. **是否允许已有 Assignment 改变 `role_version`。** 选 B 或 C 就是“允许”，要改写 §10.1、§7.1 的“终身固定版本”。
2. **是否允许除常驻 PM 外的 Token 重签时变宽。** 现在 `issueAssignmentToken` 对工作项和常驻 host_ops 都取交集，`token issue` 沿用上一张 Token 的工具，保证重签不扩权。B 要求为“人显式升级”开一个例外入口；C 要求在系统自动替换会话时开例外。两者都要写明例外覆盖哪些 Assignment：只开放工作项，还是连 host_ops 一起开放。
3. **扩权由谁触发。** B 是人逐个 Assignment 执行；C 是系统在下一次唤醒时自动执行，没有逐个确认。
4. **升级范围。** 是所有 Assignment 都可升级，还是只对产出项这一类没有其他途径的开放。host_ops 已有人工路径，可以靠 D 补原子性，不放宽重签规则。

A 和 D 不扩大任何已有 Token 的权限，可以不经上述拍板直接排期。

## 建议

先做 A：提示受影响的 Assignment，写明 host_ops 的人工两步及其前置条件，并修正 §10.1 关于“重新指派”的不准确说法。成本低，不涉及权限。host_ops 现在已能人工换版本；如果两步之间的空窗和游标丢失不可接受，再做 D 的 `host-ops rotate`（换新身份，不扩大旧 Token）。产出项是否做 B（建议收窄为只开放产出项），由人就上面四个权限点拍板。不建议 C。
