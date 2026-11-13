# P2a-14：独立复核角色（二郎神）与三类卡自动合并

- 状态：草稿，待排入 `docs/plans/phase-2.md` P2a 任务表（P2a-14），待拆卡实现。
- 对应 ADR：[`docs/adr/0006-independent-reviewer-auto-merge.md`](../adr/0006-independent-reviewer-auto-merge.md)——本计划只做任务拆分，关键设计决定以该 ADR 为准，不重复展开。
- 开发方案要改的章节（本计划只做拆分，不改正文；实现 PR 合并后由 Claude 按各 PR 描述统一回填）：§4.3（Card 新增 `risk_tags` 字段）、§4.4（verify WorkItem 不变、合并确认新增 risk_tags 代确认分支）、§4.5（不变量 15/16 扩展为三方隔离、23 改写、新增一条"打标签必须配复核项"）、§9.2（新增角色 `independent_reviewer` 的工具清单、按角色追加的第二个本地 MCP 服务器字段）、§10.1（`mcp_servers[]` 由"规划字段"变为"已实现字段"）、§10.4（新增 `independent_reviewer` 行，模型 Claude Opus）、§14（浏览器能力的安全边界）。
- 对应：用户 2026-11-13 拍板（独立复核做成角色+员工+1a 自动合并范围+员工名二郎神）；同日协调方追加拍板（浏览器能力纳入复核范围，界面卡自动合并灰度）。
- 必读：`docs/development-plan.md` §4.4（L576–598 verify 状态机、L532–554 合并确认）、§4.5 不变量 15/16（L709/712）、20/21（L718/719）、23（L726）、§7.4（L1017–1049）、§10.1（L1438–1467，`mcp_servers[]` 规划字段 L1452）、§10.4（L1539 起）、§14（L2018–2070）、§15 D11/D12（L2107/2108）；代码：`packages/domain/src/preferences.ts`、`packages/domain/src/commands/delegation.ts`、`packages/domain/src/commands/pre-merge-checks.ts`、`packages/domain/src/entities.ts`、`packages/domain/src/commands/pm.ts`（`createWorkItem`/`assign`）、`packages/domain/src/commands/employee-assignment.ts`、`packages/roles/src/role-pack.ts`、`packages/roles/src/assignment.ts`、`packages/domain/src/avatar-library.ts`、`apps/web/test-support/chromium.mjs`、`packages/store/migrations/0020_run_capacity_limits.sql`。

## 1. 目标与不做的范围

**目标**：

1. 把"独立复核"从张良在系统外派子 Agent 的临时做法，变成系统内的角色（`independent_reviewer`）+ 员工（二郎神，Claude Opus），结论留痕在 Review 和合并前核对项上。
2. 安全、权限、数值规则三类卡，独立复核 passed 且合并检查通过、其它验证项都通过后，合并确认改由 PM Ops 代确认，不再交人。
3. 界面卡的截图核对纳入二郎神职责，验证类角色接入本地无头浏览器能力，灰度后同样可以代确认合并。

**不做（本计划范围之外）**：

1. 不新增 D12 五类/六类高风险——`risk_tags` 与 D12 `category` 是两套独立机制，不合并、不互相转换（见 ADR 决定 4 的澄清）。
2. 不实现 Phase 3 的"演进式记忆"或任何让复核员跨卡积累经验的机制，复核仍是每张卡独立判断。
3. 不做共享远程浏览器服务（多机鉴权浏览器池），本阶段只做单机本地无头浏览器，远程服务记为未来备选（ADR 决定 6 末尾）。
4. 不改变 `developmentCardTemplate`/`designCardTemplate` 等内置模板本身的必需工作项（`independent_reviewer` 是 PM 动态加的，不是模板默认项），不扩大 §8.7 看板第一版范围。
5. 不实现"PM 按常驻授权代批 risk_tags 分类"之类的新代拍机制；`risk_tags` 由 PM 当场判断设置，不经过 Decision/代拍流程。
6. 不新增浏览器相关的专用并发限流机制（卡 ⑧ 先用现有 `run_capacity_limits`/C-168 观察实测数据，是否需要专用限流留给上线后评估）。

## 2. 关键设计（摘要，完整论证见 ADR 0006）

- **角色**：`independent_reviewer`，`kind=verify`，`worktree=readonly`（+C-91 可写构建目录），工具清单同其它 verify 角色去掉 `submit_delivery`，不含任何 PM/`host_ops_*` 工具。
- **三方隔离**：`employeeConflicts`（`employee-assignment.ts:80`）为 `independent_reviewer` 增加"同卡其它 verify 项（如 `code_review`）"的冲突集合，双向检查。
- **合并前核对项所有权**：`independent_reviewer` 调用 `submit_review` 时，命令在同一事务内把结论投影成固定 label（如"独立复核"）的 `pre_merge_checks` 条目；PM/human 对该固定 label 的 passed/failed 直接写入被拒（`pending` 允许，用于人工打回）。
- **`Card.risk_tags`**：新字段，PM（Office/Ops）或 human 可写，Agent 不可写；枚举固定为 `security | permission | numeric_rule` 三个值（用户 2026-11-13 确认），数据迁移/并发等高风险代码路径归入 `security`，不单独开第四个枚举。
- **不变量 23 新分支**：`risk_tags` 非空 ⊆ 上述枚举、且未命中 `mergeNeedsHuman` 现有四条规则（D12 四类 Decision、`scope_change`、`sensitive`、`human_required_reason`）、且存在一个必需 `independent_reviewer` 验证项当前 Review 非 stale 且 passed 时，PM Ops 可代确认合并；否则按现状交人。
- **缺配套工作项的硬门**：打了 `risk_tags` 但没有配套必需 `independent_reviewer` 验证项的卡，在"提交完成申请"这一步直接拒绝（中文提示），不是自动创建工作项，避免静默漏项。
- **浏览器能力**：`compileAssignmentLaunch`（`packages/roles/src/assignment.ts:150` 起）扩展支持按角色追加第二个本地 stdio MCP 服务器（`@playwright/mcp --headless --isolated`），只读共享 Chromium 装在 `/opt/playwright-chromium-<版本>`；工具名以 `mcp__playwright__*` 加入 `ui_ux_designer`/`design_director`/`independent_reviewer` 的 `allowed_tools`；界面卡的自动合并先走灰度开关。

## 3. 对 §4.4/§4.5 的具体改动

| 条目 | 现状 | 改动 |
|---|---|---|
| §4.3 Card 实体字段 | 无 `risk_tags` | 新增 `risk_tags?: readonly RiskTag[]`，`RiskTag = "security" \| "permission" \| "numeric_rule"` |
| §4.4 verify WorkItem 状态机 | 不变 | 不改状态机本身；`independent_reviewer` 的验证项按现有 verify 状态机运作（todo→ready→in_progress→passed/failed，`target_redelivered` 使其回到 ready） |
| §4.4 合并确认（不变量 23） | PM 代确认要求：合并检查通过、所有未取消验证项通过、无未处理 must_fix、知会必填；D12 四类/`scope_change`/`sensitive`/`human_required_reason` 强制交人 | 新增分支：满足上述全部现有条件，且 `risk_tags` 非空子集、未命中现有四条强制交人规则、且有对应 `independent_reviewer` 验证项当前 passed 且非 stale 时，PM Ops 也可代确认 |
| §4.5 不变量 15/16 | 验证方 ≠ 目标产出项的作者（两两隔离） | 新增：`independent_reviewer` 的验证项额外与同卡其它验证型工作项（当前已指派的 Assignment）三方隔离，双向检查；不改变对其它角色的既有语义 |
| §4.5（新不变量，编号待定） | 无 | "卡片 `risk_tags` 非空且模板审核者非 human 时，提交完成申请前必须存在一个必需、未取消、`role_id=independent_reviewer` 的验证型工作项，否则拒绝" |
| C-160 `pre_merge_checks` 权限 | passed/failed 只接受 PM Office 或 human | 固定 label"独立复核"的 passed/failed 改由 `submit_review` 投影写入；该 label 的直接 `applyPreMergeCheck(passed/failed)` 调用对所有 actor（含 PM Office/human）拒绝，仅允许写回 `pending` |
| §10.1 Role 字段 | `mcp_servers[]` 为规划中的文字描述 | 落地为实际字段：角色可声明"额外本地 MCP 服务器"（非 Card MCP），编译时按角色追加 |

## 4. 拆卡（按建议顺序）

| 卡 | 标题 | 目标 | 改动范围 | 依赖 | 合并确认归属 |
|---|---|---|---|---|---|
| ① | 新角色 `independent_reviewer` | 在 `role-pack.ts` 新增默认角色（verify，readonly，Core Prompt：聚焦安全/权限/数值规则，不复查 code_review 已覆盖内容，有阻塞问题必须退回；分工边界先按此粗粒度执行，上线后用首批真实案例校准，不在本卡穷举，用户 2026-11-13 已确认这一做法），加入 `DEFAULT_ROLE_KINDS`、`ATTACHMENT_READERS`、`DEFAULT_ROLE_LAUNCH`（`claude-opus`）；员工二郎神的创建脚本（CLI 层，不是 domain 新命令）；**审核轮次上限固定为 2**（用户 2026-11-13 确认）：`createWorkItem`（`pm.ts:323`）对 `role_id="independent_reviewer"` 新增硬校验——省略 `max_review_rounds` 时默认取 2（不是全局 `DEFAULT_MAX_REVIEW_ROUNDS`），显式传入大于 2 的值被拒 | `packages/roles/src/role-pack.ts`、`packages/domain/src/commands/pm.ts`（`createWorkItem` 的轮次上限校验）及契约测试 | 无 | 常规 PR，按 AGENTS.md 审核通过后由 Claude 合并；**本卡因为改了 `createWorkItem` 而涉及 `packages/domain`，须跑 `pnpm --filter @cardigan/domain test:types`** |
| ② | 三方审核隔离扩展 | `employeeConflicts`（`employee-assignment.ts`）为 `independent_reviewer` 增加"同卡其它 verify 项"的冲突集合，双向检查；回归测试覆盖现有角色不受影响 | `packages/domain/src/commands/employee-assignment.ts` 及契约测试 | ① | 同上；**改了 `packages/domain`，须跑 `pnpm --filter @cardigan/domain test:types`** |
| ③ | 合并前核对项所有权：`submit_review` 投影 | `submit_review` 命令对 `role_id=independent_reviewer` 的提交，在同事务内 upsert 固定 label 的 `pre_merge_checks` 条目；`applyPreMergeCheck` 对该固定 label 的 passed/failed 写入一律拒绝（含 PM Office/human）；`checked_versions` 复用 `currentPreMergeVersions` 保证与 Review 失效同步 | `packages/domain/src/commands/delivery.ts`（或 `submit_review` 所在文件）、`packages/domain/src/commands/pre-merge-checks.ts`、`packages/domain/src/entities.ts`（注释更新） | ① | 同上；domain 改动，跑 `test:types` |
| ④ | `Card.risk_tags` 字段与配套硬门 | `entities.ts` 新增字段；`update_card` 允许 PM/human 写入该字段，产出/验证角色写入被拒；新增不变量："`risk_tags` 非空且 `completion.reviewer !== human` 时，提交完成申请前必须存在必需且未取消的 `independent_reviewer` 验证项，否则拒绝" | `packages/domain/src/entities.ts`、`packages/domain/src/commands/pm.ts`（`updateCard`）、完成申请前置校验所在文件 | ①③ | 同上；domain 改动，跑 `test:types` |
| ⑤ | 不变量 23 新分支：PM 代确认合并 | `delegation.ts` 的 `mergeNeedsHuman`/`mergeRequiresHuman`/`delegationAllowed` 保持原四条规则不变，新增独立判断函数（如 `riskTagAutoMergeAllowed`），在合并确认命令里接入：满足现有全部前置条件 + 新函数为真时，PM Ops 可选 `merge`；知会正文沿用现有必填要求 | `packages/domain/src/commands/delegation.ts`、`packages/domain/src/commands/merge.ts`（或合并确认解析逻辑所在文件） | ③④ | 同上；domain 改动，跑 `test:types`；**本卡本身属于"合并确认逻辑"改动，按 AGENTS.md 审核清单第 2 条重点核对不变量 23 的措辞与实现是否一致** |
| ⑥ | 员工二郎神创建与启动配置（主机侧部署） | 在目标主机执行：`cardigan role create --from-default independent_reviewer`（或等价的角色注册步骤）、`cardigan employee create --name 二郎神 --role independent_reviewer --avatar library:erlang-shen --launch-profile claude-opus`，核对 `whoami` 工具清单与预期一致；写成给张良执行的编号部署步骤，不进本仓库代码 | 无代码改动（部署文档/步骤，放 `cardigan-deploy` 或执行记录） | ①–⑤ 合并上线后 | 部署操作，不走 PR 合并流程，但执行前需人确认（见 ADR"需要人确认的细节"） |
| ⑦ | PM 角色规则与文档更新 | `role-pack.ts` 的 `pm` 角色正文新增规则："看到安全/权限/数值规则相关改动要打 `risk_tags` 并补 `independent_reviewer` 验证项"；`docs/development-plan.md` 对应章节回填（由 Claude 在里程碑收尾时统一做，本卡只需 PR 描述写清改了哪些章节）；`AGENTS.md`/审核清单如需补充独立复核相关检查项，一并提出 | `packages/roles/src/role-pack.ts`（PM 角色正文）及契约测试 | ①④⑤ | 同上 |
| ⑧ | 验证类角色的本地浏览器能力（含界面卡截图核对灰度） | 1) `compileAssignmentLaunch` 扩展支持按角色追加本地 stdio MCP 服务器（`@playwright/mcp --headless --isolated`），三种 Harness（Claude Code `mcpServers`、Codex `[mcp_servers.X]`、Pi `mcp.json`）各自补一个分支；2) 浏览器可执行文件路径通过环境变量指向只读共享安装（部署步骤，不进代码）；3) 工具名 `mcp__playwright__*` 加入 `ui_ux_designer`/`design_director`/`independent_reviewer` 的 `allowed_tools`；4) `independent_reviewer` Core Prompt 补充"界面卡用浏览器工具截图核对亮/暗/390px，经 `upload_attachment(kind=evidence)` 留痕；不得导航到 127.0.0.1:7781 或其它已知 Workbench 端口，被测页面只能是自己在可写构建目录起的本地 Vite dev server"（这条是角色规则/Core Prompt 约定，不依赖网络层面限制，见 ADR 决定 6 和威胁分析——用户 2026-11-13 确认**不**把防火墙列为硬前提：Agent 本来就有 shell，可用 `curl` 访问本机任何端口，浏览器不增加新的网络能力；真正的边界是 Workbench 的密码登录和 Card MCP 的 Token）；5) 项目偏好新增灰度开关（如 `enable_reviewer_browser`，默认关闭），**灰度标准固定为**：先试跑 5 张界面卡，张良逐张抽查，5 张都没有漏判才打开开关，出现一次漏判则保持关闭、分析原因、修正后重新计数 5 张（用户 2026-11-13 确认）；6) 目标主机部署步骤：root 安装只读共享 Chromium 到 `/opt/playwright-chromium-<版本>`，版本匹配所选 `@playwright/mcp` | `packages/roles/src/assignment.ts`、`packages/roles/src/role-pack.ts`、`packages/domain/src/preferences.ts`（灰度开关字段）及各自契约测试；主机部署步骤单独成文档 | ①⑤，建议在 ①–⑦ 合并稳定后开工，避免和合并确认逻辑改动同批冲突 | 常规 PR 流程；灰度开关默认关闭，常规审核即可通过——**不再要求**部署前额外确认主机防火墙/网络限制（2026-11-13 已推翻该前提） |

每张卡控制在几百行以内；①②③④可基本并行开工（②③④都依赖①提供的角色/工具白名单常量，但彼此之间耦合小）；⑤需要③④都合并后才能接线；⑥是纯部署操作，可以在⑤合并后随时执行；⑦可以和⑤并行写，合并顺序上在⑤之后；⑧建议整体靠后，且拆成"MCP 接入机制"和"灰度开关+Core Prompt 文案"两个子 PR 更安全（如果实现者觉得一张卡过大，可以进一步拆成 ⑧a／⑧b）。

## 5. 测试清单

- **卡①**：契约测试覆盖 `defaultRoleDefinition("independent_reviewer", ...)` 的 `kind`、`worktree`、`allowed_tools`（不含 `submit_delivery`/PM 工具/`host_ops_*`）；`DEFAULT_ROLE_LAUNCH` 映射到 `claude-opus`。另需覆盖审核轮次上限：`createWorkItem` 对 `role_id="independent_reviewer"` 省略 `max_review_rounds` → 落地值为 2（不是全局默认）；显式传 3 → 拒绝；显式传 1 或 2 → 允许；连续 2 轮 `reject` 后第 3 轮前触发 `review_limit_exceeded` 进入 `waiting_decision`（复用现有审核轮次上限的事件断言模式）。
- **卡②**：
  - 先指派 `code_review` 给员工 A，再指派 `independent_reviewer` 给同一员工 A 到同卡 → 拒绝。
  - 先指派 `independent_reviewer` 给员工 A，再指派 `code_review` 给同一员工 A → 拒绝（反向）。
  - `independent_reviewer` 与 `development`（目标产出项）同员工 → 拒绝（回归，已有不变量 15 覆盖，确认不因改动破坏）。
  - 三者各用不同员工 → 允许。
  - 其它角色（`reviewer`/`tester`）互相之间仍不隔离 → 回归测试确认未被误改。
- **卡③**：
  - `independent_reviewer` 提交 `submit_review(verdict=passed)` → 断言 `pre_merge_checks` 出现固定 label，`status=passed`，`checked_versions` 与当前产出交付一致。
  - 提交 `reject`/`conditional`（含 must_fix）→ 固定 label 写 `failed`。
  - PM Office/human 直接调用 `applyPreMergeCheck(label=独立复核, status=passed)` → 拒绝；调用 `status=pending` → 允许（人工打回）。
  - 产出工作项新交付后 → 固定 label 的 `effectivePreMergeChecks` 读出 `stale=true`（复用现有版本判断逻辑的回归测试）。
- **卡④**：
  - `coder`/`independent_reviewer` 调用 `update_card(risk_tags=...)` → 拒绝（`forbidden_tool`/`unauthorized`）；PM/human 调用 → 允许。
  - 打了 `risk_tags` 但没有 `independent_reviewer` 验证项的卡，主产出负责人提交完成申请 → 拒绝，中文错误提示；补上验证项（未必通过）后仍按现有"必需项须全部成功终态"规则判断。
  - `completion.reviewer=human` 的模板（如 `design`）打 `risk_tags` → 不受本条硬门影响（回归，确认没有误伤既有人验收路径）。
- **卡⑤**（核心）：
  - `risk_tags=["permission"]`、独立复核 passed 非 stale、合并检查 passed、其它验证项通过、无 must_fix → PM Ops 可选 `merge`。
  - 同上但卡上存在一条 `category=permission` 的 Decision 关联该卡 → `mergeNeedsHuman` 命中，仍交人（即使 `risk_tags` 和独立复核都满足）——这是用户 2026-11-13 已确认的优先级（业务拍板优先于 `risk_tags`），不是待定行为，测试断言应明确写出这层含义，不只是"行为不变"。
  - 同上但 `card.sensitive=true` → 仍交人（回归 C-65）。
  - 同上但独立复核的 Review 因新交付变为 stale → 不满足新分支，交人。
  - 同上但 `independent_reviewer` 验证项不存在（例如卡④的硬门被绕过的边界情况，理论上不该发生，仍要测防御性校验）→ 不满足新分支，交人。
  - `risk_tags` 为空的普通卡 → 行为与改动前完全一致（回归全套现有不变量 23 契约测试）。
  - 已标记敏感的卡，即使之前独立复核已 passed → 新分支不生效（回归 ADR 威胁分析第 6 条）。
- **卡⑥**：部署步骤的验收用 `whoami` 核对二郎神 Assignment 的工具清单与角色定义一致；无自动化测试，走人工验收 checklist。
- **卡⑦**：`pm-practice-distillation.md` 一类的文档一致性测试（如果仓库已有"测试读取文档与角色规则一致"的机制，复用；没有则只做人工核对)。
- **卡⑧**：
  - `compileAssignmentLaunch` 对声明了"额外 MCP 服务器"的角色，三种 Harness 各自生成正确的 `mcp.json`/`config.toml` 片段（stdio 形式，不含 `url`/`bearer_token_env_var`）。
  - 未声明该能力的角色（如 `coder`）编译结果不含 Playwright 相关文件/配置（回归，确认不泄漏到无关角色）。
  - 灰度开关默认关闭时，界面卡合并确认行为与改动前一致（回归 C-86）。
  - 浏览器可执行文件路径环境变量正确指向配置的共享安装路径（契约测试或集成测试，视实现方式）。
  - 全程改了 `packages/domain`（卡①的轮次上限校验、②③④⑤，含测试文件）必须跑 `pnpm --filter @cardigan/domain test:types`，而不是只跑 `vitest`；根目录 `pnpm test` 会先跑这一步，失败时后面测试全部不执行。

## 6. 用户已确认的拍板点（2026-11-13，按建议）

本计划初稿列出的 6 项开放问题，用户已逐项确认，详见 ADR 0006"已确认的细节"一节，摘要：

1. `risk_tags` 枚举固定为 `security`/`permission`/`numeric_rule` 三个值，不加第四类；"数据迁移/并发"归入 `security`。
2. D12 `permission` 业务拍板类别与 `risk_tags` 的"权限"代码分类同卡同时命中时，**业务拍板优先，仍交人**——按卡⑤测试清单执行，不是待验证的设计选项。
3. 独立复核与 `code_review` 的职责边界先按 ADR 决定 1 给出的粗边界上线，上线后用首批真实案例校准 Core Prompt，结论写进卡⑦，不回头改 ADR。
4. 卡⑧**不**要求上线前有防火墙/网络访问限制——Agent 本来就有 shell、浏览器不增加新的网络能力，边界交给 Workbench 密码和 Card MCP Token 两层既有鉴权，浏览器侧只保留 Core Prompt 里"不得访问生产 Workbench"的约定（见卡⑧改动范围列）。
5. 界面卡自动合并灰度标准：先跑 5 张界面卡、张良逐张抽查、5 张都没漏判才打开开关（见卡⑧）。
6. 独立复核审核轮次上限固定为 2，连续 2 轮不通过即升级给人（见卡①）。

## 7. 上线后的观察指标

- **复核耗时**：从 `independent_reviewer` 工作项进入 `ready`（产出已交付）到 `submit_review` 的时间分布，按卡的改动行数/是否跑了测试（C-91 可写构建目录）分组。
- **误放过率的抽查方式**：张良（PM Office）按固定比例（建议初期 100%，稳定后降到 20–30%）抽查已经由新分支代确认合并的卡片，事后人工复判独立复核结论是否可靠；抽查结论记入卡片时间线，作为后续调整"审核轮次上限""Core Prompt 聚焦范围"的依据。
- **Opus 复核的日成本估算**：

  **数据来源**：对 `cardigan.db`（只读）按 `events.type='decision_requested'` 关联 `decisions.trigger='merge_confirmation'` 且 `human_required_reason is not null`，统计 2026-11-10 至 2026-11-13（近 3 天）落在这个条件的卡片，共 **33 张**（不同卡片去重）。按 `human_required_reason` 文本人工分类：

  | 类别 | 卡片数（样本，3 天） | 说明 |
  |---|---|---|
  | 安全/权限相关（鉴权、SSH、凭据、Token 范围、访问控制） | 约 16 | C-107/108/110/111/118/119/127/161/164/167/87/91/94/95/60/66 等 |
  | 数值规则（系统上限、超时、自动合并分钟数等） | 约 4 | C-168/177/178/179 |
  | 其它（需求范围变化、用户可见界面改动、真实检查失败升级等，**不在本次自动合并范围内**） | 约 13 | C-57/59/64/70/71/73/74/76/75/79/103/105/172 等 |

  即 3 天内约 **20/33（约 60%）** 的"交人确认"卡片属于本 ADR 想要自动化的三类，折合约 **6–7 张/天**。**重要说明**：这是 Cardigan 自举开发自身（dogfooding）期间的采样，节奏明显高于一般项目的日常开发速度，不能直接当作其它项目的预期负载，上线后应按各项目实际卡量重新估算。

  **单次复核成本估算**（Claude Opus 5.5，$4/百万输入 token、$20/百万输出 token，定价据 `claude-api` 技能查询 2026-10-06 缓存价目）：

  | 场景 | 假设 | 输入 token（计费口径，含多轮对话重发） | 输出 token | 估算成本 |
  |---|---|---|---|---|
  | 轻量复核（小改动，不跑测试） | 读卡片、少量文件 diff、提交结论 | 约 3–5 万 | 约 2–4 千 | 约 $0.15–$0.3 |
  | 重度复核（大改动，C-91 可写构建目录跑测试，含界面卡 1–2 轮截图） | 多次工具往返、测试输出、若干截图（每张视口screenshot 约 1,000–1,500 token） | 约 15–30 万 | 约 8–15 千 | 约 $0.8–$1.8 |

  取中位数约 **$0.6／次**，按 3 天观察到的量级（约 6–7 张/天）估算，**日成本约 $4–$10／天**（低量日约 $2，高量日或多张走重度复核约 $15 以上）。**本估算未经实测**，依据是定价表与一般 Claude Code 工具调用场景下的经验性 token 量级类比，不是对 Cardigan 复核任务的实测遥测；建议卡⑥部署上线后，用前 1–2 周的真实 Run 记录（`response.usage`／Run 的 token 统计，如果 Cardigan 已记录）校准这个估算，并据此决定是否需要给复核设置预算上限（参照 P2v-12 出图预算 `image_gen_budget_usd` 的先例，必要时同样走 `spending` 类 Decision）。

  **计费口径说明**：上面的美元数按 Anthropic 官方第一方定价表（Opus 5.5 $4/$20 每百万 token）粗算，仅作量级参考。Cardigan 里实际跑的 Claude Agent（包括二郎神）经 **sensenjoy 中转**（用户账户额度），计费规则和实际单价以中转账户为准，可能与官方定价表不完全一致；本计划给出的 $4–$10/天是"按官方价目估算的参考量级"，不是对中转账户账单的预测，上线后应直接核对中转账户的实际扣费记录来校准。

## 8. 已知风险

- **`risk_tags` 分类依赖 PM 的判断力**：和今天"安全相关改动"全凭 PM Core Prompt 判断的现状本质相同，只是把判断结果结构化、可审计（写进字段）了，并不会自动提高分类准确率；分类错误（该打标没打、不该打却打了）仍然可能发生，靠张良的抽查机制兜底，不是完全自动的保证。
- **独立复核本身可能误判**（放过了真实的安全/权限问题）：这是把"人工复核"换成"Opus 复核"必然引入的风险，缓解依赖 Core Prompt 的聚焦指导、PM Ops 对 `risk_tags` 分类的把关、以及张良的抽查比例；不是本计划能完全消除的风险，需要用户知悉并接受"抽查而非逐一复核"的权衡。
- **两套截图机制并存可能造成约定漂移**：`apps/web/test-support/` 的 CDP 脚手架（CI 用）和卡⑧的 Playwright MCP（Agent 交互用）各自维护视口/主题约定，未来若一方改了 390px 断点或主题切换方式，另一方不会自动同步，需要靠代码评审人工比对。
- **浏览器的网络边界靠约定 + 既有鉴权，不是网络层硬隔离**（2026-11-13 已确认取舍，非待办风险，记录以备查）：卡⑧不要求主机防火墙限制 `agent` 账号的网络访问——因为 Agent 本来就有 shell、浏览器不增加新的网络能力，真正挡住的是 Workbench 密码和 Card MCP Token。残余风险是"复核员的 Core Prompt 没有遵守'不得访问生产 Workbench'的约定"，但由于访问那两个入口都会在鉴权那一步被拒绝，实际能造成的后果顶多是"截到一个打不开的登录页，得出误导性的核对结论"，不是真正的数据泄露；按现有安全模型对"Agent 有 shell 时可能做错误操作"的一贯处理方式接受，不单独加固。
- **Opus 成本估算粗糙**：如实现后实际 token 用量显著高于估算（例如大型 PR 的 diff 远超预期，或复核员反复多轮才下结论），日成本可能数倍于本计划估算值；建议上线初期用小流量观察，确认成本可控后再扩大 `risk_tags` 的打标范围。
- **卡⑤（不变量 23 改写）是全部效果的收口点，风险集中**：如果卡⑤的实现和 ADR 文字出现偏差（例如误把 `risk_tags` 判断放在 `mergeNeedsHuman` 内部而覆盖了 D12 的强制交人），会造成"该交人的卡被自动合并"这类严重后果；审核时应重点比对 ADR 决定 4 的建议文字与实际代码逐条核对，并要求契约测试覆盖"同时命中 risk_tags 和 D12"的边界场景（测试清单卡⑤已列出）。
