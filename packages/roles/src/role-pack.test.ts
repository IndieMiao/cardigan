import { ROLE_TOOL_ALLOWLISTS, validateRole } from "@cardigan/domain";
import { describe, expect, test } from "vitest";
import {
  DEFAULT_ROLE_KINDS,
  DEFAULT_ROLE_LAUNCH,
  type DefaultRoleId,
  defaultRoleDefinition,
  HUMAN_ACTION_MERGE_RULE,
  instructionsFor,
  isDefaultRoleId,
  PM_PRE_MERGE_CHECK_RULE,
  REVIEWER_PRE_MERGE_CHECK_RULE,
} from "./role-pack.js";

const launch = { harness: "codex", launch_profile_ref: "fixture" } as const;
const BASE_TOOLS = [
  "whoami",
  "get_card",
  "get_updates",
  "ack_events",
  "post_comment",
  "heartbeat",
  "finish_run",
  "report_blocker",
  "request_human_action",
  "request_decision",
  "upload_attachment",
];

describe("default role kinds (p2v-12 §2.3)", () => {
  test("every default role has an explicit kind", () => {
    expect(DEFAULT_ROLE_KINDS).toEqual({
      pm: "standing",
      host_ops: "standing",
      coder: "produce",
      ui_ux_designer: "produce",
      reviewer: "verify",
      designer: "verify",
      tester: "verify",
      design_director: "verify",
    });
    for (const [id, kind] of Object.entries(DEFAULT_ROLE_KINDS)) {
      expect(isDefaultRoleId(id)).toBe(true);
      expect(defaultRoleDefinition(id as DefaultRoleId, launch).kind).toBe(
        kind,
      );
    }
  });

  test("ui_ux_designer is a producer with exactly the planned tools", () => {
    const role = defaultRoleDefinition("ui_ux_designer", launch);
    expect(role).toMatchObject({
      role_id: "ui_ux_designer",
      display_name: "UI/UX 设计师",
      kind: "produce",
      capabilities: ["produce"],
      worktree: "write",
    });
    expect([...role.allowed_tools].sort()).toEqual(
      [...BASE_TOOLS, "submit_delivery"].sort(),
    );
    // Plan §2.3 grants no attachment reading to the designer (C-104 V-476).
    expect(role.allowed_tools).not.toContain("read_attachment");
    expect(role.allowed_tools).not.toContain("submit_review");
    expect(role.allowed_tools).not.toContain("withdraw_review");
    for (const tool of role.allowed_tools)
      expect(ROLE_TOOL_ALLOWLISTS.produce).toContain(tool);
    expect(validateRole(role).ok).toBe(true);
  });

  test("design_director is a verifier with exactly the planned tools", () => {
    const role = defaultRoleDefinition("design_director", launch);
    expect(role).toMatchObject({
      role_id: "design_director",
      display_name: "设计总监",
      kind: "verify",
      capabilities: ["verify"],
      worktree: "readonly",
    });
    expect([...role.allowed_tools].sort()).toEqual(
      [
        ...BASE_TOOLS,
        "read_attachment",
        "submit_review",
        "withdraw_review",
      ].sort(),
    );
    expect(role.allowed_tools).not.toContain("submit_delivery");
    for (const tool of role.allowed_tools)
      expect(ROLE_TOOL_ALLOWLISTS.verify).toContain(tool);
    expect(validateRole(role).ok).toBe(true);
  });

  test("existing default roles keep their kind, worktree and tools", () => {
    expect(defaultRoleDefinition("designer", launch)).toMatchObject({
      kind: "verify",
      worktree: "readonly",
      capabilities: ["verify"],
    });
    expect(
      defaultRoleDefinition("designer", launch).allowed_tools,
    ).not.toContain("read_attachment");
    expect(defaultRoleDefinition("coder", launch)).toMatchObject({
      kind: "produce",
      worktree: "write",
    });
  });

  test("the design roles default to cross-model launch settings", () => {
    expect(DEFAULT_ROLE_LAUNCH).toEqual({
      ui_ux_designer: { harness: "codex", launch_profile_ref: "codex-astra" },
      design_director: {
        harness: "claude-code",
        launch_profile_ref: "claude-opus",
      },
    });
  });

  test("design role prompts describe their own work only", () => {
    const designer = defaultRoleDefinition("ui_ux_designer", launch);
    expect(designer.instructions).toContain("`kind=design`");
    expect(designer.instructions).toContain("`kind=card_completion`");
    expect(designer.instructions).not.toContain("`submit_review`");
    expect(designer.instructions).not.toContain("`read_attachment`");
    const director = defaultRoleDefinition("design_director", launch);
    expect(director.instructions).toContain("`read_attachment`");
    expect(director.instructions).toContain("不是代码实现");
    expect(director.instructions).not.toContain("`submit_delivery`");
  });
});

// C-162: wording copied independently of role-pack.ts.
const MERGE_RULE =
  "事项不完成就不应该合并时（例如需要人提供或轮换凭据、人确认安全或权限取舍、人在仓库外完成某个前置操作），`request_human_action` 必须传 `blocks_merge=true`；只是请人看看、知会或可以事后补做的，不设。";

test("C-162: every default role says when request_human_action must hold the merge, in one wording", () => {
  expect(HUMAN_ACTION_MERGE_RULE).toBe(MERGE_RULE);
  for (const role of Object.keys(DEFAULT_ROLE_KINDS) as DefaultRoleId[]) {
    const body = instructionsFor(role);
    expect(body, role).toContain("`request_human_action`");
    // Each prompt states the rule exactly once, right where the tool is named.
    expect(body.split(MERGE_RULE).length - 1, role).toBe(1);
    for (const line of body
      .split("\n")
      .filter((l) => l.includes("request_human_action")))
      expect(
        line.includes(MERGE_RULE) ||
          body.split("\n")[body.split("\n").indexOf(line) + 1] ===
            `- ${MERGE_RULE}`,
        `${role}: ${line}`,
      ).toBe(true);
  }
});

test("C-179: pm and reviewer route pre-merge reviews through pre-merge checks, not merge-blocking human actions", () => {
  for (const [role, rule] of [
    ["pm", PM_PRE_MERGE_CHECK_RULE],
    ["reviewer", REVIEWER_PRE_MERGE_CHECK_RULE],
  ] as const) {
    const body = instructionsFor(role);
    expect(body.split(rule).length - 1, role).toBe(1);
    expect(rule).toContain("截图核对、独立安全审核");
    expect(rule).toContain("合并前核对项");
    expect(rule).toContain("只有确实要人在系统外动手的事，才开人工待办");
  }
  expect(PM_PRE_MERGE_CHECK_RULE).toContain(
    "PM Ops 设 pending，PM Office 设 passed 或 failed",
  );
  expect(PM_PRE_MERGE_CHECK_RULE).toContain("系统不会自动完成");
});
