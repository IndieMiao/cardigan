/** PL.1 remains historical; Flow Lite supersedes the pinned decision and action rules. */
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import {
  compileAssignmentLaunch,
  corePromptFor,
  firstPrompt,
  P2A_PM_DECISION_RULES,
  P2A_PM_OPS_RULES,
  P2A_PM_PLANNING_RULES,
  PM_CARD_DEPENDENCY_RULE,
  PM_DECISION_RULES,
  PM_DELEGATION_RULES,
  PM_FLOW_LITE_RULES,
  PM_OFFICE_REPORTING_RULES,
  PM_OPS_EVENT_RULES,
  PM_PLANNING_RULES,
  PM_TEMPLATE_RULES,
  PM_VERIFICATION_RULES,
  parseLaunchConfig,
  VERIFIER_MUST_FIX_RULES,
} from "./index.js";

const section =
  readFileSync(
    new URL(
      "../../../docs/research/pm-practice-distillation.md",
      import.meta.url,
    ),
    "utf8",
  )
    .split("## 5 ")[1]
    ?.split("## 6 ")[0] ?? "";
/**
 * Flow Lite (user decision 2026-11-16) supersedes approved §5 wording: PM
 * now settles numeric and other configurable details itself, and only
 * credential or external-account prerequisites hold a merge. The research
 * document stays as history; the replacement is pinned here independently.
 */
const SUPERSEDED_RULES: ReadonlyMap<string, string> = new Map([
  [
    "只认控制面里的记录：执行者在终端里说的话、同伴的转述、计划时间，都不算交付，也不算批准。转述之前先查当前的实际状态。",
    "系统已核过的 SHA、候选树、审核结论和检查结果直接使用控制面记录，不重复核验、不再复述；出现证据冲突或业务异常时才查原文。执行者口头说完成、同伴转述、计划时间不算交付或批准。",
  ],
  [
    "人批准的事要跟到落地，落地后在时间线里回报。",
    "人批准的事要跟到落地；有实质变更记录时由系统记落实进展，没有记录时才补一句结果，不复述已有系统结果。",
  ],
  [
    '界面文字、提示语、按钮样式等交互细节由 PM 代拍：直接定下来，把结论和理由写在卡片上，并注明依据 Q-279。会改变系统行为的数值和规则（例如上限、超时、自动合并分钟数）、花钱、账号、权限、删除数据、安全、对外发布、需求范围变化，仍由人来定；拿不准就交人，不替人定。还没定的，在工作项里标"待定"，实现做成可以配置。',
    "界面文字、提示语、按钮样式等交互细节，以及数值、阈值、间隔等可配置细节，由 PM 代拍：直接定下来，把结论和理由写在卡片上。只有“交人边界”一节里未授权的五类交人。",
  ],
  [
    "事项不完成就不应该合并时（例如需要人提供或轮换凭据、人确认安全或权限取舍、人在仓库外完成某个前置操作），`request_human_action` 必须传 `blocks_merge=true`；只是请人看看、知会或可以事后补做的，不设。",
    "只有凭据或外部账号这类前置操作（例如需要人提供或轮换凭据、在外部账号后台完成配置）不完成就不能合并时，`request_human_action` 才传 `blocks_merge=true` 并填写 `prerequisite=credential|external_account`；现场验证、实测、请人看看、知会或可以事后补做的，默认不挡合并，作为合并后的跟进项。",
  ],
  [
    "同一交付被驳回两次以上时，先判断原因（需求不清、能力不匹配、环境问题），再决定返工、换人还是升级。",
    "同一验证项连续第 4 次驳回时，先判断原因（需求不清、能力不匹配、环境问题），再决定返工、换人还是升级。",
  ],
]);
const supersede = (text: string) =>
  [...SUPERSEDED_RULES].reduce(
    (current, [old, next]) => current.replace(old, next),
    text,
  );
const blocks = [...section.matchAll(/```markdown\n([\s\S]*?)\n```/g)].map(
  (match) => supersede(match[1] as string),
);
const rules = blocks.flatMap((block) =>
  block
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2)),
);
const exportedRules = [
  ...PM_VERIFICATION_RULES,
  ...PM_PLANNING_RULES,
  ...PM_DECISION_RULES,
  ...PM_DELEGATION_RULES,
  ...PM_OFFICE_REPORTING_RULES,
  ...PM_OPS_EVENT_RULES,
];

const independentReviewSection =
  readFileSync(new URL("../../../AGENTS.md", import.meta.url), "utf8")
    .split("## 独立复核\n")[1]
    ?.split("\n## ")[0]
    ?.trim() ?? "";

// Office and Ops share the role body; their launch tool scopes differ.
const launch = parseLaunchConfig({
  providers: { local: { harness: "pi" } },
  profiles: { pm: { harness: "pi", provider: "local", model: "test-model" } },
});
const modePrompts = ["office", "ops"].map((mode) => {
  const compiled = compileAssignmentLaunch({
    assignment: { assignment_id: "A-1", run_id: "R-1" },
    role: {
      role_id: "pm",
      harness: "pi",
      launch_profile: "pm",
      worktree: "none",
      core_prompt: corePromptFor("pm"),
      allowed_tools: [
        "whoami",
        "get_updates",
        ...(mode === "office" ? ["record_decision"] : []),
      ],
    },
    launch,
    mcp: { url: "http://localhost/mcp" },
    run_dir: "/run/cardigan/test",
    work_dir: "/run/cardigan/test",
    first_prompt: firstPrompt({ assignment_id: "A-1", run_id: "R-1" }),
    secrets: {},
  });
  return {
    mode,
    prompt: compiled.files.find((file) => file.path.endsWith("/core.md"))
      ?.content,
  };
});

test("PL.1 preserves historical rules and applies the three Flow Lite replacements in order", () => {
  expect(blocks).toHaveLength(3);
  // Each superseded rule must still exist in the source, so the pin cannot go stale.
  for (const old of SUPERSEDED_RULES.keys()) expect(section).toContain(old);
  expect(rules).toHaveLength(24);
  expect(
    exportedRules.filter(
      (line) =>
        line !== PM_VERIFICATION_RULES[0] && line !== PM_DECISION_RULES[0],
    ),
  ).toEqual(rules);
});

test.each(modePrompts)(
  "Flow Lite $mode overrides merge and review gates while preserving other owners",
  ({ prompt }) => {
    for (const phrase of [
      "工作项级 PM 只负责自己的完成验收",
      "流程版本 ≥2 的合并检查 failed/timed_out",
      "版本 1 仍按下文旧检查失败路径由 PM 处理",
      "executor_unreachable/interrupted 不算代码失败、不自动退回",
      "系统对全部在途卡",
      "不受 `flow_version` 或 `FLOW_VERSION_MAX` 限制",
      "未开启时由 PM Ops 确认",
      "显式 off 停止系统代确认",
      "自动合并暂停只由人解除",
      "流程版本 ≥5 的就绪验证项始终由系统自动指派",
      "流程版本 ≤4 才按该开关处理",
      "todo 卡片首个产出项由系统沿用 C-225 自动指派",
      "催办仍按人的 `system_reminders` 开关与完整策略执行",
      "所有流程版本的普通审核与独立复核只计驳回",
      "轮数用完由系统自动加到当前所需额度",
      "同一验证项连续第 4 次驳回时暂停并交 PM 排查",
      "pass 或 conditional 重置连续计数",
      "系统汇总缺必需独立复核项、无合格审核员工、执行器不可达",
      "产出方失活或需规划时 PM 接手",
      "只有手改与默认包冲突才交人",
      "缺少上一默认包指纹时保留当前版本并知会 PM 排查",
      "空闲时自动轮换",
    ])
      expect(prompt).toContain(phrase);
    for (const obsolete of [
      "独立复核继续按 C-301",
      "额度未设或耗尽",
      "仅流程版本 ≤3 的旧卡：合并确认",
      "同一交付被驳回两次以上",
      "权限类永不代拍",
    ])
      expect(prompt).not.toContain(obsolete);
  },
);

test("Flow Lite preserves template selection, acceptance evidence and explicit delegation", () => {
  const pm = corePromptFor("pm");
  for (const phrase of [
    "第五级流程已开放且项目已登记相应模板时",
    "工程卡选 `dev@2`，产品卡选 `product@1`，界面卡默认选 `ui@1`",
    "旧卡继续按固定模板验收",
    "不自行登记、升级或改写旧卡",
    "人的授权不增加 Agent 执行权限",
    "不允许修改生产偏好或推翻人的既有决定",
    "人已开启授权的类别由 PM Ops 按授权处理并知会",
    "没有授权时确认直接交给人，你不能代确认",
  ])
    expect(pm).toContain(phrase);
  expect(pm).not.toContain("四类高风险永不代拍");
  const reviewer = corePromptFor("reviewer");
  expect(reviewer).toContain("逐条对照卡片和工作项的验收标准");
  expect(reviewer).toContain("对应行为、证据和未覆盖项，不能只写通过");
  expect(reviewer).toContain("`product@1` 保留工作项 PM 完成验收");
});

test.each(rules.map((rule, index) => ({ rule, number: index + 1 })))(
  "PL.1 rule $number is present in both PM modes and absent from coder and reviewer",
  ({ rule }) => {
    expect(corePromptFor("pm")).toContain(`- ${rule}`);
    for (const { mode, prompt } of modePrompts)
      expect(prompt, mode).toContain(`- ${rule}`);
    for (const role of ["coder", "reviewer"] as const)
      expect(corePromptFor(role), role).not.toContain(rule);
  },
);

const templateSection = [
  "## 选模板",
  "",
  ...PM_TEMPLATE_RULES.map((line) => `- ${line}`),
  "",
  "",
].join("\n");

test("V12b template rules follow planning in the PM prompt only", () => {
  const prompt = corePromptFor("pm");
  const section = prompt.indexOf(templateSection);
  expect(section).toBeGreaterThan(prompt.indexOf("## 拆卡和派活"));
  expect(section).toBeLessThan(prompt.indexOf("## 拍板和汇报"));
  for (const { mode, prompt: launched } of modePrompts)
    expect(launched, mode).toContain(templateSection);
  for (const tool of ["list_templates", "list_roles"]) {
    expect(prompt).toContain(`\`${tool}\``);
    for (const role of ["coder", "reviewer"] as const)
      expect(corePromptFor(role), role).not.toContain(tool);
  }
  expect(PM_TEMPLATE_RULES.join("")).toContain("不能自己创建或修改模板和角色");
});

test("PL.1 places the three source blocks in their prescribed sections", () => {
  // C-86 appends P2a rules to section ends; strip them so the PL.1 blocks stay contiguous.
  const p2a = new Set(
    [
      PM_VERIFICATION_RULES[0],
      PM_DECISION_RULES[0],
      PM_CARD_DEPENDENCY_RULE,
      ...P2A_PM_PLANNING_RULES,
      ...P2A_PM_DECISION_RULES,
      ...P2A_PM_OPS_RULES,
    ].map((line) => `- ${line}`),
  );
  // V12b inserts its own section after planning; strip it the same way.
  const prompt = corePromptFor("pm")
    .replace(templateSection, "")
    .replace(`## 独立复核\n\n${independentReviewSection}\n\n`, "")
    .split("\n")
    .filter((line) => !p2a.has(line))
    .join("\n");
  const common = prompt.indexOf(blocks[0] as string);
  const office = prompt.indexOf("## PM Office（前台）");
  const ops = prompt.indexOf("## PM Ops（后台）");
  expect(common).toBeGreaterThan(prompt.indexOf("## 打断规则"));
  expect(common).toBeLessThan(office);
  expect(
    prompt
      .slice(office, ops)
      .trimEnd()
      .endsWith(blocks[1] as string),
  ).toBe(true);
  expect(
    prompt
      .slice(ops, prompt.indexOf("## 本地自测与远程检查"))
      .trimEnd()
      .endsWith(blocks[2] as string),
  ).toBe(true);
});

test("C-37 PM instructions explain authorization limits, action triage and implementation responsibility", () => {
  const prompt = corePromptFor("pm");
  for (const rule of [
    "resolve_delegated_decision",
    "proxy_authority",
    "triage_human_action",
    "主机操作",
    "属于“交人边界”五类且未授权，或后果超出授权的，传 escalate=true 交人",
    "合并确认默认由你代确认",
    "拍板解决后必须执行所选方案，并在卡片时间线写一句执行结果",
    "30 分钟未落实提醒",
  ])
    expect(prompt).toContain(rule);
});

test("C-49 PM instructions cover merge confirmation preconditions and notices", () => {
  const prompt = corePromptFor("pm");
  for (const rule of [
    "merge_blockers",
    "合并闸门检查通过、所有验证项通过、没有未处理的 must_fix",
    "只能 hold、request_changes",
    "命中高危路径的卡须同卡必需独立复核通过",
    "必须传 notice（知会）",
    "常规合并一句话即可",
    "改了什么、对人有什么影响、需要注意的风险或后续",
  ])
    expect(prompt).toContain(rule);
});

test("Flow Lite independent-review rules agree with AGENTS.md in both PM modes", () => {
  expect(independentReviewSection.split("\n- ")).toHaveLength(4);
  for (const prompt of [
    corePromptFor("pm"),
    ...modePrompts.map((p) => p.prompt),
  ]) {
    expect(prompt?.split("## 独立复核\n")[1]?.split("\n## ")[0]?.trim()).toBe(
      independentReviewSection,
    );
  }
  for (const role of ["coder", "reviewer"] as const)
    expect(corePromptFor(role), role).not.toContain(independentReviewSection);
});

test("Flow Lite requires independent review only for high-risk paths and keeps the real safeguards", () => {
  for (const rule of [
    "命中高危路径（项目偏好 `high_risk_paths`）或人标记为高危的卡",
    "`kind=verify`、`role_id=independent_reviewer`、`required=true`",
    "`target_work_item_id` 指向被审产出项",
    "其它卡只需代码审核",
    "只作分类、统计和知会，不单独触发独立复核",
    "独立复核员不能是本次被审交付的作者，不追溯历史 Assignment",
    "不得为绕开独立复核拆卡、删标签、把复核项改为可选或取消复核",
    "绑定当前交付编号和完整 SHA",
    "只有系统验证代码树或作者差异等价并记录有效沿用依据，才沿用原结论",
    "评论、普通核对项或人工设 passed 都不能代替",
  ])
    expect(independentReviewSection).toContain(rule);
  for (const gone of [
    "PM Ops 代确认合并须同时满足",
    "pm_confirm_human_decided_merges",
    "decision_evidence",
    "非 human 验收模板",
    "当前及历史 Assignment",
  ])
    expect(independentReviewSection).not.toContain(gone);
});

test("Flow Lite hands only five categories to the human and lets PM settle details", () => {
  const agents = readFileSync(
    new URL("../../../AGENTS.md", import.meta.url),
    "utf8",
  );
  const five = "花钱、凭据和账号、删除真实数据、对外发布、人标记为敏感的卡";
  expect(agents).toContain(`默认交人的只剩五类：${five}`);
  expect(agents).toContain("人可以在项目偏好里逐类开启授权");
  expect(agents).toContain("项目开启自动合并（`auto_merge`）时");
  expect(agents).toContain("实现卡不修改 `docs/development-plan.md` 正文");
  for (const prompt of [
    corePromptFor("pm"),
    ...modePrompts.map((p) => p.prompt),
  ]) {
    for (const rule of PM_FLOW_LITE_RULES)
      expect(prompt).toContain(`- ${rule}`);
    expect(prompt).toContain(`默认交给人的只有五类：${five}`);
    expect(prompt).toContain(
      "这一类（包括合并确认）由你或系统按授权处理并知会人",
    );
    for (const gone of [
      "拿不准就交人",
      "四类高风险永不代拍",
      "即使归在 feature_detail，也传 escalate=true 交人",
      "一律不代拍",
      "PM 不能自行 `raise_limit`",
      "C-310",
      "role_rule_basis",
      "decision_evidence",
      "原有强制交人边界照常执行",
      "强制交人",
      "永不代拍",
      "必须由人亲自确认",
      "当前及历史 Assignment",
      "独立复核永不自动加轮",
      "每次由人在工作台或本机命令行亲自确认",
    ])
      expect(prompt).not.toContain(gone);
  }
  const rules = PM_FLOW_LITE_RULES.join("\n");
  for (const phrase of [
    "由作者或你选一个可配置的默认值，写在卡上知会，不交人拍板",
    "是否分阶段交付由你决定",
    "验收标准不超过 5 条，写可观察的结果，不写实现合同",
    "不把已授权的事项再升级给人",
    "实现卡不要求修改 `docs/development-plan.md` 正文",
  ])
    expect(rules).toContain(phrase);
  for (const role of ["coder", "reviewer"] as const)
    expect(corePromptFor(role), role).not.toContain(PM_FLOW_LITE_RULES[0]);
});

test("C-66 PM instructions cover returning or rechecking failed merge checks", () => {
  const prompt = corePromptFor("pm");
  for (const rule of [
    "failed_merge_checks",
    "先看失败用例和本卡改动的关系",
    "选 request_changes 退回修改",
    "修复方向",
    "选 recheck 重新检查一次",
    "重新检查再失败就退回",
    "哪张卡、检查失败的原因、已退回或已重新检查",
  ])
    expect(prompt).toContain(rule);
});

test("C-115 PM instructions limit human-only merge handling to structured timeout rechecks", () => {
  const prompt = corePromptFor("pm");
  for (const rule of [
    "交给人之前先等当前完成申请的闸门检查通过",
    "只能重新检查明确的超时失败，不能退回修改，也不能代确认合并",
    "只有 recheck 时不能选其他动作",
    "整体或步骤 timed_out，且不能混有 failed/interrupted",
    "日志里出现 timeout 不够",
    "重查仍须 rationale 和 notice",
    "检查结束后自动重新出现在人的 Needs You 待拍板",
    "waiting_merge_checks 是等检查的人工确认，decider 不变",
  ])
    expect(prompt).toContain(rule);
  expect(prompt).not.toContain("你不能退回或重新检查");
});

test("C-171 PM instructions describe how failed human merge checks show in Needs You", () => {
  const prompt = corePromptFor("pm");
  for (const rule of [
    "检查还没出结果（无结果、排队、运行中）时不进入人的 Needs You 待拍板，只计入等待汇总",
    "检查已结束未通过（失败、超时、中断、执行器不可达）时，交人的确认会列进人的 Needs You 待拍板并标出检查结果",
    "交给人之前先等当前完成申请的闸门检查通过",
  ])
    expect(prompt).toContain(rule);
  expect(prompt).not.toContain("检查未通过时不进入人的 Needs You");
  expect(prompt).not.toContain("只显示等待数量");
});

test("C-65 and Flow Lite: sensitive cards' merges go to the human unless authorized", () => {
  const prompt = corePromptFor("pm");
  for (const rule of [
    "默认交给人的只有：被人标为敏感的卡",
    "没有授权时确认直接交给人，你不能代确认",
    "不能设置或取消敏感标记",
    "人也可能直接处理你手上的合并确认",
  ])
    expect(prompt).toContain(rule);
});

test("D12 requires explicit delegation for the five default human categories", () => {
  expect(corePromptFor("pm")).toContain(
    "“交人边界”的五类没有授权时由人确认（Workbench 或本机 CLI）",
  );
  expect(corePromptFor("pm")).toContain(
    "PM Office、PM Ops 和其他 Agent 不能代拍或转录；人已开启授权的类别由 PM Ops 按授权处理并知会",
  );
});

test("C-37 criterion 11 makes PM explain human handoffs and complete authorized process work itself", () => {
  const prompt = corePromptFor("pm");
  for (const phrase of [
    "title（一句话标题）",
    "summary（这是什么）",
    "why_human（为什么必须由人做）",
    "instructions（编号步骤：点哪里或执行什么命令）",
    "expected_outcome（做完会怎样）",
    "标题不要照抄接口名",
    "纯流程事项在现有权限内能完成的自己处理并记录结果，不交给人",
  ])
    expect(prompt).toContain(phrase);
});

test("C-212 tells PM to defer untimely handoffs, triage host operators and keep handoffs short", () => {
  const prompt = corePromptFor("pm");
  for (const phrase of [
    // Readiness instead of "do this later" prose.
    "用 `ready_when` 写成就绪条件",
    "不要在正文里写“等……之后再做”让人自己判断",
    "disposition=release",
    "也可以先不发起，等能做时再开",
    // Readiness never hides a merge-holding item.
    "挡合并或挡工作的事项照样挡着，卡片一提交完成申请就会显示",
    "不能用就绪条件藏起要交人的事项",
    // host vs human, and the two host tiers.
    "用 `host_operator` 写清谁执行",
    "的填 external，不叫醒 host_ops",
    "应分 host、external，不分 human",
    // Short handoffs.
    "todo（一句话“你要做什么”）",
    "人默认只看到标题、todo、步骤和“确认已完成”，其余折叠",
  ])
    expect(prompt).toContain(phrase);
});

// C-86 wording plus C2a planning rules, copied independently of role-pack.ts.
const P2A_DRAFT = {
  planning: [
    '写卡时的测试范围，要包含"可能对改动断言了旧行为"的相关包，不要只列改动本身所在的包；检查失败按下文版本分工处理：新版由系统退回作者，旧版由 PM 判断退回或重查，不重复接管。',
    "卡片的测试范围写成本地相关测试 + 远程预检通过，不再要求员工本地运行全量 `pnpm test`；列出相关测试文件、直接调用方和可能断言旧行为的相关包。按卡片固定的流程版本区分：流程版本 ≥3 且启用合并闸门的 Git 交付先通过同 SHA 预检；流程版本 ≤2 的旧卡沿用已有交付与审核门禁，全量结果看远程合并检查。缺少工具或检查环境时报告阻塞，不把本地自报当作通过预检，不自行升级角色或流程版本。",
    "产品拍板在建卡或开工时以来源拍板问清，不把未决事项留到合并时默认批准；只有“交人边界”一节里未授权的五类交人。",
    "风险标签在建卡时就打，不等合并前再补；改部署监督器或数据库迁移的卡在建卡时打 `security`，需要敏感标记时请人设置，不自行设置或取消敏感标记。风险标签只作分类，是否必须独立复核按“独立复核”一节看高危路径。",
  ],
  decision: [
    "收到 30 分钟未落实异常时再跟进；实质变更或引用原决定的结果回帖是落实记录，ACK 不是。已有记录由系统汇总，不另写重复确认。",
  ],
  ops: [
    "流程版本 ≥5 的就绪验证项始终由系统自动指派，不受 `system_auto_assign_verifiers` 开关影响；流程版本 ≤4 才按该开关处理，未设置时关闭，关闭时由 PM Ops 先用 `get_card` 确认可审交付已存在再指派。系统负责指派时，PM Ops 不与系统重复指派；无人可派时查看各候选的排除原因，按现行释放、取消重建或模板验证项替换流程处理，不重绑已有 Assignment。todo 卡片首个产出项由系统沿用 C-225 自动指派；backlog 不启动，人工暂停、依赖、合格员工和终身 Assignment 边界保持。PM 只处理自动指派异常及后续需要规划的产出项。需要暂缓时，通过 `update_work_item` 设置 `manual_assign=true`，系统自动指派和催办都会跳过；恢复自动处理时清除标记。催办仍按人的 `system_reminders` 开关与完整策略执行，不自行配置次数、时间或手工重复催办。",
    "卡片上出现没有提醒自己、但也没有被任何 Assignment 认领的人类评论时，主动看一眼并回应，不要只处理提醒自己的事件。",
  ],
};

test("C-86 and C2a append planning and operations rules at the end of their sections", () => {
  expect([...P2A_PM_PLANNING_RULES]).toEqual(P2A_DRAFT.planning);
  expect([...P2A_PM_DECISION_RULES]).toEqual(P2A_DRAFT.decision);
  expect([...P2A_PM_OPS_RULES]).toEqual(P2A_DRAFT.ops);
  const prompt = corePromptFor("pm");
  const bullets = (lines: string[]) => lines.map((l) => `- ${l}`).join("\n");
  const sectionOf = (heading: string) => {
    const start = prompt.indexOf(heading);
    const next = prompt.indexOf("\n## ", start + heading.length);
    return prompt.slice(start, next === -1 ? undefined : next).trimEnd();
  };
  expect(
    sectionOf("## 拆卡和派活").endsWith(
      bullets([...PM_PLANNING_RULES, ...P2A_DRAFT.planning]),
    ),
  ).toBe(true);
  expect(
    sectionOf("## 拍板和汇报").endsWith(
      bullets([...PM_DECISION_RULES, ...P2A_DRAFT.decision]),
    ),
  ).toBe(true);
  expect(
    sectionOf("## PM Ops（后台）").endsWith(
      bullets([...PM_OPS_EVENT_RULES, ...P2A_DRAFT.ops]),
    ),
  ).toBe(true);
  for (const { mode, prompt: modePrompt } of modePrompts)
    for (const rule of Object.values(P2A_DRAFT).flat())
      expect(modePrompt, mode).toContain(`- ${rule}`);
  for (const role of ["coder", "reviewer"] as const)
    for (const rule of Object.values(P2A_DRAFT).flat())
      expect(corePromptFor(role), role).not.toContain(rule);
});

test("C2a role instructions and development-plan body agree on testing and human boundaries", () => {
  const plan =
    readFileSync(
      new URL("../../../docs/development-plan.md", import.meta.url),
      "utf8",
    )
      .split("### 10.4 初始角色建议")[1]
      ?.split("## 11.")[0] ?? "";
  const prompt = corePromptFor("pm");
  for (const phrase of [
    "本地相关测试 + 远程预检通过",
    "直接调用方和可能断言旧行为的相关包",
    "产品",
    "建卡或开工时以来源拍板问清",
    "不作为审核或合并依据",
    "绑定 `run_id`、SHA 和候选树",
    "部署监督器或数据库迁移",
    "需要敏感标记时请人设置",
  ]) {
    expect(prompt).toContain(phrase);
    expect(plan).toContain(phrase);
  }
  expect(prompt).toContain("不自行设置或取消敏感标记");
  for (const phrase of [
    "流程版本 ≥3 且启用合并闸门的 Git 交付",
    "流程版本 ≤2 的旧卡",
    "报告阻塞",
  ]) {
    expect(prompt).toContain(phrase);
    expect(plan).toContain(phrase);
  }
  for (const phrase of [
    "C-298 已正式合入",
    "本卡只补角色正文，不增加实际工具权限",
    "当前流程上限仍为 2",
    "A2b 的交付硬门由对应任务实现",
    "cardigan role upgrade <角色> --from-default",
    "本轮不执行角色升级或实际项目版本启用",
  ])
    expect(plan).toContain(phrase);
  const coder = corePromptFor("coder");
  for (const phrase of [
    "`request_check({work_item_id, idempotency_key})`",
    "`get_check_log({card_id, attempt_id, offset?, limit?})`",
    "`request_recheck({card_id, reason, idempotency_key})`",
    "不能用 `request_recheck` 重跑预检",
    "每组 SHA 只能使用一次",
  ]) {
    expect(coder).toContain(phrase);
    expect(plan).toContain(phrase);
  }
  for (const role of ["reviewer", "independent_reviewer"] as const) {
    expect(corePromptFor(role)).toContain("只审核已有通过预检的 SHA");
    expect(plan).toContain("只审核已有通过预检的 SHA");
  }
});

test("C-268 PM Ops checks design-director implementation reviews before UI-card merge confirmation", () => {
  const prompt = corePromptFor("pm");
  for (const phrase of [
    "待合并时核对设计总监对当前交付的必需验证项、截图证据和测量结论",
    "再按现有合并条件确认或退回",
    "上述未授权交人的卡片和已交人的确认，只能重新检查明确的超时失败，不能退回修改，也不能代确认合并",
    "默认交给人的只有：被人标为敏感的卡；与本卡相关的花钱、凭据和账号、删除真实数据拍板；对外发布；已明确交人的确认",
    "人对相应类别开启授权后，由你按授权确认并在 notice 写明依据",
  ])
    expect(prompt).toContain(phrase);
  expect(prompt).not.toContain("用户可见的大改动");
  // Generic role pack: never hard-code a specific employee as PM Office.
  expect(prompt).not.toContain("张良");
  // Employee-name mentions never reach a standing Assignment (§6.5), so the
  // PM Office must be addressed by its Assignment id.
  expect(prompt).not.toContain("按其当前员工名提及");
});

test("C-86 and Flow Lite: verifiers block only on correctness, security and missing tests", () => {
  for (const role of [
    "reviewer",
    "independent_reviewer",
    "design_director",
  ] as const) {
    const body = corePromptFor(role);
    for (const rule of VERIFIER_MUST_FIX_RULES)
      expect(body.split(`- ${rule}`).length - 1, role).toBe(1);
    expect(body, role).not.toContain(
      "第二轮起只复查上一轮的问题是否修好；要新开问题必须是 critical 并带 proof",
    );
  }
  const rules = VERIFIER_MUST_FIX_RULES.join("\n");
  for (const phrase of [
    "只有正确性缺陷（含错误被吞）、安全漏洞、新增行为缺测试可以标 `must_fix`",
    "写成建议（`must_fix=false`），不挡合并",
    "第一轮一次收齐问题，不追加卡片范围以外的要求",
    "重交时只看增量和上轮问题是否修好",
  ])
    expect(rules).toContain(phrase);
  for (const role of ["pm", "coder"] as const)
    expect(corePromptFor(role), role).not.toContain(VERIFIER_MUST_FIX_RULES[0]);
});

test("C-110: PM instructions use the replacement command for verifier handoffs", () => {
  const prompt = corePromptFor("pm");
  for (const rule of [
    "replace_verification_work_item",
    "验证项换人",
    "已有工作项不能改绑 Assignment",
    "待合并卡先按现有流程退回修改",
  ])
    expect(prompt).toContain(rule);
});

test("C-169 superseded by Flow Lite: PM decides configurable details, credentials require explicit delegation", () => {
  const details = PM_DECISION_RULES.find((rule) => rule.includes("可配置细节"));
  expect(details).toContain("只有“交人边界”一节里未授权的五类交人");
  expect(PM_DECISION_RULES.join("")).not.toContain("仍由人来定");
  expect(PM_FLOW_LITE_RULES[0]).toContain("凭据和账号");
});
