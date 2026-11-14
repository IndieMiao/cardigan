import {
  HOST_OPS_ROLE_TOOLS,
  ROLE_TOOL_ALLOWLISTS,
  validateRole,
} from "@cardigan/domain";
import { describe, expect, test } from "vitest";
import {
  DEFAULT_ROLE_KINDS,
  DEFAULT_ROLE_LAUNCH,
  type DefaultRoleId,
  defaultRoleDefinition,
  HOST_OPS_OFFICE_MENTION_RULES,
  HUMAN_ACTION_MERGE_RULE,
  instructionsFor,
  isDefaultRoleId,
  PM_DECISION_SUGGESTION_RULE,
  PM_OFFICE_MENTION_FIRST_LINE_RULE,
  PM_OFFICE_MENTION_RULES,
  PM_PLAIN_SUMMARY_RULE,
  PM_PRE_MERGE_CHECK_RULE,
  PRODUCER_PLAIN_CHANGE_RULE,
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

describe("C-226 PM Ops read-only subagent checks", () => {
  const body = instructionsFor("pm");
  const ops = body.split("## PM Ops（后台）")[1] ?? "";

  test("delegation is scoped to Claude Code Ops and falls back to the parent", () => {
    for (const rule of [
      "只适用于 PM Ops 且当前 harness 为 Claude Code（claude-code）",
      "一轮涉及 2 张及以上卡片，或单卡核对量大",
      "每张卡或每项独立核对开一个只读子 Agent",
      "遵守主机并发上限",
      "非 Claude Code harness 不适用，由本人核对",
      "不适用于 PM Office 或工作项级 PM",
      "超时、失败或工具不可用时，由本人接手",
    ])
      expect(ops).toContain(rule);
    expect(body.split("## PM Ops（后台）")[0]).not.toContain(
      "只读子 Agent 并行核对",
    );
    for (const role of Object.keys(DEFAULT_ROLE_KINDS) as DefaultRoleId[])
      if (role !== "pm")
        expect(instructionsFor(role)).not.toContain("只读子 Agent 并行核对");
  });

  test("the child allowlist contains only the five existing read tools", () => {
    const allowlist = ops.split("工具白名单仅为 ")[1]?.split("，且")[0] ?? "";
    const tools = [...allowlist.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    expect(tools).toEqual([
      "get_card",
      "get_updates",
      "read_attachment",
      "project_snapshot",
      "list_needs_you",
    ]);
    const role = defaultRoleDefinition("pm", launch);
    expect(role.allowed_tools).toEqual(expect.arrayContaining(tools));
    for (const rule of [
      "只能使用当前身份已有的工具",
      "禁止调用白名单外的工具",
      "不得通过 CLI、HTTP、文件写入或再委派绕过限制",
      "不得读取或打印凭据、环境变量值",
    ])
      expect(ops).toContain(rule);
  });

  test("writes and Run protocol stay with the parent despite the shared identity", () => {
    const writes =
      ops
        .split("子 Agent 只返回结论和证据，不执行任何写操作：")[1]
        ?.split("\n")[0] ?? "";
    for (const tool of [
      "assign",
      "resolve_delegated_decision",
      "request_decision",
      "post_comment",
      "update_card",
      "ack_events",
      "finish_run",
    ])
      expect(writes).toContain(`\`${tool}\``);
    expect(writes).toContain("确认或退回");
    expect(writes).toContain("全部由 PM Ops 本人看过结论后执行");
    expect(writes).toContain("ACK、心跳和结束操作也只由本人负责");
    for (const rule of [
      "共用 Token 和 Assignment 身份",
      "只靠规则约束只读",
      "误写会记在本人名下",
      "不能声称已有技术隔离",
      "发现越界立即停止该子 Agent",
    ])
      expect(ops).toContain(rule);
  });

  test("reports require versioned evidence and a fresh parent check before writes", () => {
    for (const rule of [
      "结论、证据和未核事项",
      "交付编号和完整 SHA",
      "审核编号及其绑定的交付",
      "时间线条目或事件 seq",
      "员工当前及历史 Assignment（含已释放）",
      "附件编号与相关原文",
      "没读到的标为“未核”",
      "本人须核对返回的证据原文",
      "写操作前重新读取 `get_card` / `get_updates` 的当前记录",
      "不能直接当作已核实事实写入时间线",
      "过期或不一致的结论要重新核对",
    ])
      expect(ops).toContain(rule);
  });
});

test("host operations keeps v3 outage safeguards and C-200 context guidance without new tools", () => {
  const role = defaultRoleDefinition("host_ops", launch);
  expect([...role.allowed_tools].sort()).toEqual(
    [...HOST_OPS_ROLE_TOOLS].sort(),
  );
  const body = instructionsFor("host_ops");
  for (const rule of [
    "10 分钟内有 3 个及以上",
    "先不重启",
    "有会话恢复活动或新 Run 正常开始工作",
    "每个会话只恢复一次",
    "恢复后 15 分钟内再次失活",
    "Agent 仍在改代码或跑测试时不能重启",
    "context_session_id",
    "20%",
    "15%",
    "审计",
  ])
    expect(body).toContain(rule);
});

describe("default role kinds (p2v-12 §2.3)", () => {
  test("every default role has an explicit kind", () => {
    expect(DEFAULT_ROLE_KINDS).toEqual({
      pm: "standing",
      host_ops: "standing",
      coder: "produce",
      ui_ux_designer: "produce",
      reviewer: "verify",
      independent_reviewer: "verify",
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
      capabilities: ["produce", "browser"],
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
      capabilities: ["verify", "browser"],
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
      independent_reviewer: {
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

test("P2a-14: independent reviewer has only the planned verify tools and boundaries", () => {
  const role = defaultRoleDefinition("independent_reviewer", launch);
  expect(role).toMatchObject({
    display_name: "独立复核",
    kind: "verify",
    capabilities: ["verify", "browser"],
    worktree: "readonly",
  });
  // An exact allowlist also excludes delivery, PM and host_ops tools.
  expect([...role.allowed_tools].sort()).toEqual(
    [
      ...BASE_TOOLS,
      "read_attachment",
      "submit_review",
      "withdraw_review",
    ].sort(),
  );
  expect(validateRole(role).ok).toBe(true);
  for (const phrase of [
    "安全、权限和数值规则",
    "不复查 `code_review` 已覆盖",
    "`target_sha` 必须等于交付的 `subject`",
    "有阻塞问题必须标为 must_fix 并退回",
    "轮数用完仍未通过即进入 waiting_decision 交人处理",
    "不能与实现者或同卡其它审核者是同一员工",
    "可写构建目录",
    "worker 数不超过主机限流配置的上限",
  ])
    expect(role.instructions).toContain(phrase);
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
    "PM Ops 设 pending，PM Office 或人设 passed 或 failed",
  );
  expect(PM_PRE_MERGE_CHECK_RULE).toContain(
    "固定名称“独立复核”的结论只能由 `independent_reviewer` 的 `submit_review` 投影",
  );
  expect(PM_PRE_MERGE_CHECK_RULE).toContain("系统不会自动完成");
});

test("C-192: pm hands matters to the human with a suggestion, reason and prefilled return reason", () => {
  const body = instructionsFor("pm");
  expect(body.split(PM_DECISION_SUGGESTION_RULE).length - 1).toBe(1);
  for (const phrase of [
    "`decider=human`",
    "`escalate`",
    "必须带 `suggestion`",
    "`rationale`",
    "`return_reason`",
    "按建议处理",
    "已过期",
  ])
    expect(PM_DECISION_SUGGESTION_RULE).toContain(phrase);
  for (const role of ["coder", "reviewer"] as const)
    expect(instructionsFor(role)).not.toContain(PM_DECISION_SUGGESTION_RULE);
});

test("deployment instructions keep host ops read-only and preserve context-patrol rules", () => {
  const role = defaultRoleDefinition("host_ops", launch);
  expect(role.allowed_tools).toEqual(HOST_OPS_ROLE_TOOLS);
  expect(role.instructions).toContain(
    "host_ops_read_diagnostics 的 deployment",
  );
  expect(role.instructions).toContain(
    "不能触发部署、重启 server、选要部署的代码或修改主机配置",
  );
  expect(role.instructions).toContain("PM Ops 与 PM Office");
  expect(role.instructions).toContain("context_tokens / context_window_size");
  expect(role.instructions).toContain("context_session_id");
});

test("C-202: pm writes plain summaries with the Q-337 example; producers write the completion's plain change note", () => {
  const pm = instructionsFor("pm");
  expect(pm.split(PM_PLAIN_SUMMARY_RULE).length - 1).toBe(1);
  for (const phrase of [
    "`plain_summary`",
    "`decider=human`",
    "`escalate`",
    "`changed`",
    "`impact`",
    "`risk`",
    "没有就写“无”",
    "详细信息",
    "改写会留审计",
    "开了截图核对开关后，界面卡的截图核对只能由二郎神给结论，PM 只有在它通过时才能代确认合并",
    "开关默认关着，现在行为不变",
    "改了 pm 和独立复核员的角色规则",
  ])
    expect(PM_PLAIN_SUMMARY_RULE).toContain(phrase);
  for (const role of ["coder", "ui_ux_designer"] as const) {
    const body = instructionsFor(role);
    expect(body.split(PRODUCER_PLAIN_CHANGE_RULE).length - 1).toBe(1);
    expect(body).not.toContain(PM_PLAIN_SUMMARY_RULE);
  }
  for (const phrase of [
    "`kind=card_completion`",
    "`plain_summary`",
    "没有就写“无”",
    "`decider=human`",
  ])
    expect(PRODUCER_PLAIN_CHANGE_RULE).toContain(phrase);
  expect(instructionsFor("reviewer")).not.toContain(PRODUCER_PLAIN_CHANGE_RULE);
});

test("C-263: pm and host_ops mention PM Office only when it has to act or answer", () => {
  const pm = instructionsFor("pm");
  for (const rule of PM_OFFICE_MENTION_RULES) expect(pm).toContain(`- ${rule}`);
  for (const phrase of [
    "只用于需要它动手或回答的事项",
    "截图核对",
    "收尾记录",
    "状态同步",
    "已解决的更正",
    "不 @ PM Office",
    "不重复 @",
  ])
    expect(PM_OFFICE_MENTION_RULES.join("\n")).toContain(phrase);

  const hostOps = instructionsFor("host_ops");
  for (const rule of HOST_OPS_OFFICE_MENTION_RULES)
    expect(hostOps).toContain(`- ${rule}`);
  for (const phrase of [
    "人工重启监督器",
    "C-201#203",
    "没有部署记录",
    "写明时间和停服时长",
    "记为“已解释”",
    "才在 C-201 回帖询问",
    "不再 @ PM Office",
    "真正需要人工说明或动手时",
  ])
    expect(HOST_OPS_OFFICE_MENTION_RULES.join("\n")).toContain(phrase);

  expect(PM_OFFICE_MENTION_FIRST_LINE_RULE).toContain(
    "第一行写清要做什么、对哪个版本",
  );
  expect(PM_OFFICE_MENTION_FIRST_LINE_RULE).toContain(
    "请截图核对 D-xxx（sha）",
  );
  for (const body of [pm, hostOps])
    expect(body).toContain(`- ${PM_OFFICE_MENTION_FIRST_LINE_RULE}`);
  for (const role of ["coder", "reviewer", "independent_reviewer"] as const)
    expect(instructionsFor(role)).not.toContain(
      PM_OFFICE_MENTION_FIRST_LINE_RULE,
    );
});
