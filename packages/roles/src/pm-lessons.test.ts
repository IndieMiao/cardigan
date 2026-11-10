/** PL.1: the approved §5 wording is the independent source of truth. */
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import {
  compileAssignmentLaunch,
  corePromptFor,
  firstPrompt,
  PM_DECISION_RULES,
  PM_DELEGATION_RULES,
  PM_OFFICE_REPORTING_RULES,
  PM_OPS_EVENT_RULES,
  PM_PLANNING_RULES,
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

test("PL.1 places the three source blocks in their prescribed sections", () => {
  const prompt = corePromptFor("pm");
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
    "需求范围变化时，确认直接交人",
    "必须传 notice（知会）",
    "常规合并一句话即可",
    "改了什么、对人有什么影响、需要注意的风险或后续",
  ])
    expect(prompt).toContain(rule);
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
    "你不能退回或重新检查",
  ])
    expect(prompt).toContain(rule);
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
    "instructions（点哪里或执行什么命令）",
    "expected_outcome（做完会怎样）",
    "标题不要照抄接口名",
    "纯流程事项在现有权限内能完成的自己处理并记录结果，不交给人",
  ])
    expect(prompt).toContain(phrase);
});
