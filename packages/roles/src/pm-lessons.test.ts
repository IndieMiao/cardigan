/** PL.1: the approved §5 wording is the independent source of truth. */
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import {
  compileAssignmentLaunch,
  corePromptFor,
  firstPrompt,
  P2A_PM_DECISION_RULES,
  P2A_PM_OPS_RULES,
  P2A_PM_PLANNING_RULES,
  PM_DECISION_RULES,
  PM_DELEGATION_RULES,
  PM_OFFICE_REPORTING_RULES,
  PM_OPS_EVENT_RULES,
  PM_PLANNING_RULES,
  PM_TEMPLATE_RULES,
  PM_VERIFICATION_RULES,
  parseLaunchConfig,
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
const blocks = [...section.matchAll(/```markdown\n([\s\S]*?)\n```/g)].map(
  (match) => match[1] as string,
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
    ?.split("\n## 工作流程")[0]
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

test("PL.1 exports all 24 approved rules verbatim and in order", () => {
  expect(blocks).toHaveLength(3);
  expect(rules).toHaveLength(24);
  expect(exportedRules).toEqual(rules);
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
      .slice(ops, prompt.indexOf("## 协作规则"))
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
    "四类高风险永不代拍",
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
    "或需求范围变化时，确认直接交人",
    "必须传 notice（知会）",
    "常规合并一句话即可",
    "改了什么、对人有什么影响、需要注意的风险或后续",
  ])
    expect(prompt).toContain(rule);
});

test("C-190 independent-review rules agree with AGENTS.md in both PM modes", () => {
  expect(independentReviewSection.split("\n- ")).toHaveLength(7);
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

test("C-190 PM rules require same-card risk classification, independent review and version evidence", () => {
  for (const rule of [
    "`update_card` 设置 `risk_tags`",
    "数据迁移或并发高风险路径用 `security`",
    "鉴权或访问控制用 `permission`",
    "数值和行为规则用 `numeric_rule`",
    "`kind=verify`、`role_id=independent_reviewer`、`required=true`",
    "`target_work_item_id` 指向本卡被审产出项，不传 `max_review_rounds`，按项目偏好取值（默认 3）",
    "非 human 验收模板",
    "不能用已知遗留豁免",
    "当前及历史 Assignment（含已释放）",
    "不得为了绕开独立复核，把同一个改动拆成两张卡",
    "不得删标签、把复核项改为可选或取消复核来绕过要求",
    "PM Office、PM Ops 和 human 均不能直接写 passed/failed，只能设 pending",
    "设 pending 也不等于撤回 Review",
    "Review 未撤回、未过期且交付编号和 SHA 均匹配",
    "所有未取消验证项通过（包括可选项）、无未处理 must_fix",
    "提交 notice 知会",
    "实际发布仍须批次全量检查通过",
  ])
    expect(independentReviewSection).toContain(rule);
});

test("C-190 replaces the numeric transition without expanding decision delegation or reviving invalid confirmations", () => {
  for (const prompt of [
    corePromptFor("pm"),
    ...modePrompts.map((p) => p.prompt),
  ]) {
    const ops = prompt?.split("## PM Ops（后台）")[1]?.split("## 协作规则")[0];
    for (const condition of [
      "仅核对人的数值拍板不能替代独立复核",
      "原数值规则过渡办法不再适用",
      "不授权 PM 决定新的数值或行为规则",
      "业务拍板优先，仍交人",
      "需求范围变化、`sensitive`、`human_required_reason` 优先于标签和复核",
      "对外发布、角色规则改动仍交人，角色规则改动按 Q-279 执行",
      "PM 代确认偏好关闭、没有活跃 PM Ops 或风险复核资格不满足时同样交人",
      "PM 不得代拍或转录强制交人的确认",
      "不合格的未决 PM 确认转交人",
      "未发布的旧代理确认失效并重新请人确认",
      "资格恢复不会复活旧确认",
      "新交付须重新复核",
      "超时代批也不能绕过",
    ])
      expect(prompt).toContain(condition);
    expect(ops).not.toContain("P2a-14 上线前的过渡规则");
    expect(ops).not.toContain("安全相关改动、对外发布");
    expect(ops).toContain(
      "轮数用完仍未通过进入 `waiting_decision` 后必须交人，PM 不能自行 `raise_limit`",
    );
    expect(ops).toContain(
      "会改变系统行为的数值和规则（例如上限、超时、自动合并分钟数）即使归在 feature_detail，也传 escalate=true 交人",
    );
  }
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

test("C-65 PM instructions hand sensitive cards' merges to the human", () => {
  const prompt = corePromptFor("pm");
  for (const rule of [
    "被人标为敏感的卡，确认直接交给人",
    "不能设置或取消敏感标记",
    "人也可能直接处理你手上的合并确认",
  ])
    expect(prompt).toContain(rule);
});

test("D12 allows a human at Workbench or local CLI, never PM or Agent proxy confirmation", () => {
  expect(corePromptFor("pm")).toContain(
    "四类只能由人确认（Workbench 或本机 CLI）",
  );
  expect(corePromptFor("pm")).toContain(
    "PM Office、PM Ops 和其他 Agent 不能代拍或转录",
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
    "不能用就绪条件藏起强制交人的事项",
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

// C-86: draft §4 wording, copied independently of role-pack.ts.
const P2A_DRAFT = {
  planning: [
    '写卡时的测试范围，要包含"可能对改动断言了旧行为"的相关包，不要只列改动本身所在的包；闸门检查失败后，先判断是真实回归还是偶发，再决定退回修改还是重新检查。',
  ],
  decision: [
    '拍板解决、ACK 提醒或收到"30 分钟未落实"提醒之后，必须在卡片时间线产生一条可验证的落实记录（建卡、取消卡片、合并、或写明"评估后决定不做"并说明理由）；仅确认收到提醒不算落实，没有产生记录就继续按提醒节奏升级。',
  ],
  ops: [
    "项目开启 `system_auto_assign_verifiers` 后，验证型工作项（含完成申请的 PM 验收）由系统在有可审交付时自动指派，PM Ops 不与系统重复指派；查看系统未能指派的项，判断换人、补员工或交人。开关关闭时，指派前先用 `get_card` 确认可审交付已存在。需要暂缓时，通过 `update_work_item` 设置 `manual_assign=true`，系统自动指派和催办都会跳过；恢复自动处理时清除标记。",
    "卡片上出现没有提醒自己、但也没有被任何 Assignment 认领的人类评论时，主动看一眼并回应，不要只处理提醒自己的事件。",
  ],
};

test("C-86 appends the four P2a rules verbatim at the end of their sections", () => {
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

test("C-268 PM Ops checks design-director implementation reviews before UI-card merge confirmation", () => {
  const prompt = corePromptFor("pm");
  for (const phrase of [
    "待合并时核对设计总监对当前交付的必需验证项、截图证据和测量结论",
    "再按现有合并条件确认或退回",
    "上述强制交人的卡片和已交人的确认，只能重新检查明确的超时失败，不能退回修改，也不能代确认合并",
    "仍交给人的包括被人标为敏感的卡、与合并相关的 D12 四类业务拍板、对外发布、需求范围变化、角色规则改动、已强制交人的确认，以及不满足独立复核资格的风险标签卡",
  ])
    expect(prompt).toContain(phrase);
  expect(prompt).not.toContain("用户可见的大改动");
  // Generic role pack: never hard-code a specific employee as PM Office.
  expect(prompt).not.toContain("张良");
  // Employee-name mentions never reach a standing Assignment (§6.5), so the
  // PM Office must be addressed by its Assignment id.
  expect(prompt).not.toContain("按其当前员工名提及");
});

test("C-86 reviewers treat swallowed errors and missing tests as must_fix", () => {
  expect(corePromptFor("reviewer")).toContain(
    "评审中涉及“错误被吞、没有测试”的问题，即使看起来是 minor，也按 must_fix 处理。",
  );
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

test("C-169 PM rules keep security decisions with the human", () => {
  const humanList = PM_DECISION_RULES.find((rule) =>
    rule.includes("仍由人来定"),
  );
  expect(humanList).toContain("删除数据、安全、对外发布");
  const prompt = corePromptFor("pm");
  expect(prompt).toContain(
    "涉及安全的事项（例如凭据、鉴权、安全取舍）一律不代拍，同样传 escalate=true 交人",
  );
});
