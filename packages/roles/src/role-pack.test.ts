import {
  HOST_OPS_ROLE_TOOLS,
  ROLE_TOOL_ALLOWLISTS,
  STANDING_ROLE_TOOLS,
  validateRole,
} from "@cardigan/domain";
import { describe, expect, test } from "vitest";
import {
  corePromptFor,
  DEFAULT_ROLE_KINDS,
  DEFAULT_ROLE_LAUNCH,
  type DefaultRoleId,
  defaultRoleDefinition,
  HOST_OPS_OFFICE_MENTION_RULES,
  HUMAN_ACTION_MERGE_RULE,
  instructionsFor,
  isDefaultRoleId,
  MENTION_FIELD_RULE,
  PM_DECISION_SUGGESTION_RULE,
  PM_HOST_MATTERS_RULE,
  PM_OFFICE_MENTION_FIRST_LINE_RULE,
  PM_OFFICE_MENTION_RULES,
  PM_PLAIN_SUMMARY_RULE,
  PM_PRE_MERGE_CHECK_RULE,
  PM_UI_VERIFICATION_RULES,
  PRODUCER_PLAIN_CHANGE_RULE,
  REVIEWER_PRE_MERGE_CHECK_RULE,
} from "./role-pack.js";

const launch = { harness: "codex", launch_profile_ref: "fixture" } as const;

test("fast patch self-review is advisory and plan reading follows card scope", () => {
  for (const role of ["coder", "pm"] as const)
    expect(instructionsFor(role)).toContain(
      "按需查阅 `docs/development-plan.md`",
    );
  const coder = instructionsFor("coder");
  expect(coder).toContain("同会话启动子进程自审");
  expect(coder).toContain("自审只作参考，不是正式审核或门槛");
  expect(coder).toContain("仍须同 SHA 预检和最终合并检查");
});

test.each(Object.keys(DEFAULT_ROLE_KINDS) as DefaultRoleId[])(
  "C2a %s separates local diagnostics from trusted remote checks",
  (role) => {
    const body = instructionsFor(role);
    for (const phrase of [
      "卡片和既有权限允许范围",
      "增量构建、lint、deps、相关单测",
      "`vitest related` 或 `--changed`",
      "改 `packages/domain`（含测试）",
      "pnpm --filter @cardigan/domain test:types",
      "本地不跑全量测试和 e2e",
      "不作为审核或合并依据",
      "绑定 `run_id`、SHA 和候选树",
      "流程版本 ≤2 的旧卡继续沿用已有交付与审核门禁",
      "流程版本 ≥3 要求预检却缺工具或检查环境时报告阻塞",
      "不自行升级角色或流程版本",
      "不要设法绕过主机限流",
    ])
      expect(body, role).toContain(phrase);
    expect(body.split("本地自测只在")).toHaveLength(2);
    expect(body).not.toContain("全量检查交给合并检查");
  },
);

test("C2a author self-checks do not replace independent reviews", () => {
  expect(instructionsFor("coder")).toContain(
    "子 Agent 自检只是建议，不能代替正式代码审核或独立复核",
  );
  expect(instructionsFor("coder")).toContain("不因此改变审核员工隔离要求");
});

test("C2b authors hand completion to the system only on the fifth flow level", () => {
  const coder = instructionsFor("coder");
  expect(coder).toContain("流程版本 ≤4 时，主产出工作项的负责人可以提交");
  expect(coder).toContain("流程版本 ≥5 的 review 模板由系统");
  expect(coder).toContain("作者不手工提交");
  expect(coder).toContain("系统汇总不代替模板要求的完成验收或最终合并检查");
  expect(PRODUCER_PLAIN_CHANGE_RULE).toContain("流程版本 ≥5 的产出交付可填写");
  expect(PRODUCER_PLAIN_CHANGE_RULE).toContain("≤4 的产出交付不填它");
});

test("C2a author prechecks bind the committed SHA and preserve old-card behavior", () => {
  const body = instructionsFor("coder");
  for (const phrase of [
    "本卡固定的 `flow_version`，不按项目当前偏好推断",
    "流程版本 ≥3 且启用合并闸门的 Git 交付",
    "先本地 commit，再调用 `request_check({work_item_id, idempotency_key})`",
    "主机读取登记分支 HEAD，不接受自报 SHA、路径、命令或执行器",
    "只有本产出项当前 active Assignment 可请求",
    "已有排队或运行中的预检时等待结果，不重复请求",
    "本会话门铃",
    "`status=passed`、`head_sha` 与待交付完整 SHA 一致后再 `submit_delivery`",
    "新 commit 必须重新预检",
    "相同 SHA 不因基线前进而失去交付资格",
    "预检不能代替最新基线候选树的最终合并检查",
    "流程版本 ≤2 的旧卡不调用 `request_check`",
    "非 Git 交付或未启用合并闸门时沿用原规则",
    "不降级跳过预检，不自行升级角色、Token 或卡片版本",
  ])
    expect(body).toContain(phrase);
});

test("C2a author distinguishes precheck repair from same-version merge recheck", () => {
  const body = instructionsFor("coder");
  for (const phrase of [
    "`get_card.card.check_attempts`",
    "`get_check_log({card_id, attempt_id, offset?, limit?})`",
    "属于本卡的问题在原会话修复、commit",
    "新的幂等键 `request_check`",
    "不能用 `request_recheck` 重跑预检",
    "环境故障无法自行解决时报告阻塞",
    "`request_recheck({card_id, reason, idempotency_key})`",
    "流程版本 ≥2 的 A1 系统退回后的原版本合并重查",
    "只有本卡主产出项当前 active Assignment",
    "尚无新交付、整组产出 SHA 和受信树未变",
    "登记分支 HEAD 仍为原提交",
    "失败与本卡无关并写明理由和证据",
    "每组 SHA 只能使用一次",
    "审核沿用仍由服务端核验",
    "真实回归先修复并正常重新交付",
    "版本 1 不使用作者重查",
  ])
    expect(body).toContain(phrase);
});

test.each(["reviewer", "independent_reviewer"] as const)(
  "C2a %s reviews only the applicable prechecked SHA without acquiring producer tools",
  (role) => {
    const body = instructionsFor(role);
    for (const phrase of [
      "本卡固定的 `flow_version`",
      "流程版本 ≥3 且启用合并闸门的 Git 交付",
      "只审核已有通过预检的 SHA",
      "`get_card.card.prechecks`",
      "`status=passed`、`head_sha` 等于当前交付完整 SHA",
      "缺失、失败、仍在运行或 SHA 不符时报告阻塞",
      "流程版本 ≤2 的旧卡沿用原审核门禁",
      "非 Git 交付或未启用合并闸门时沿用原规则",
      "需要复现时本地只跑卡片允许的相关检查",
      "远程 run",
      "不替作者请求预检或重查",
      "预检通过不代替正式审核、独立复核或最终合并检查",
    ])
      expect(body).toContain(phrase);
    const tools = defaultRoleDefinition(role, launch).allowed_tools;
    expect(tools).toContain("get_check_log");
    expect(tools).not.toContain("request_check");
    expect(tools).not.toContain("request_recheck");
  },
);

const BASE_TOOLS = [
  "project_snapshot",
  "read_attachment",
  "get_check_log",
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

test("C-293 PM Ops assigns ready work and leaves capacity enforcement to the scheduler", () => {
  const body = instructionsFor("pm");
  const ops = body.split("## PM Ops（后台）")[1] ?? "";
  for (const rule of [
    "产出项及按旧版规则需 PM 指派的验证项就绪且有合格员工时即指派",
    "排队由系统调度器按并发上限处理",
    "PM 不另设人工并发限制，以系统上限为准",
    "不得依据评论或口头约定另设并发数量限制",
    "project_snapshot.run_capacity",
    "不把容量摘要作为压住就绪工作项的依据",
    "`total_running` 为含常驻的绝对全部",
    "`running` 为上限对应的非常驻占用",
    "常驻 PM Office/Ops 和 host_ops 不占额度、不排容量队列",
    "工作项级 PM 不豁免",
    "摘要不可用时写“未核”",
    "由人调整系统设置",
    "不自行修改容量或重启会话",
  ])
    expect(ops).toContain(rule);
  expect(defaultRoleDefinition("pm", launch).allowed_tools).toEqual(
    STANDING_ROLE_TOOLS,
  );
  // Flow Lite: role-rule changes are PM-handled and announced, no longer an Ops-only exception.
  expect(body).toContain("角色规则改动等其它事项由你或系统处理");
});

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

  test("reports preserve evidence while system-verified facts are not checked twice", () => {
    for (const rule of [
      "结论、证据和未核事项",
      "交付编号和完整 SHA",
      "审核编号及其绑定的交付",
      "时间线条目或事件 seq",
      "相关员工的 Assignment",
      "附件编号与相关原文",
      "没读到的标为“未核”",
      "建议不能代替正式审核",
      "系统已验证的身份、版本和检查事实不重新逐项核验",
      "只有异常、冲突或实际业务判断需要的原文才补读",
      "写操作由服务端按最新状态重核权限和目标",
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
    "以自身 Assignment 和当前 context_session_id 换会话",
    "未主动处理时系统会在空闲时自动换会话",
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
      [
        ...BASE_TOOLS,
        "submit_delivery",
        "request_recheck",
        "request_check",
      ].sort(),
    );
    // Plan §2.3 grants no attachment reading to the designer (C-104 V-476).
    expect(role.allowed_tools).toContain("read_attachment");
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
      [...BASE_TOOLS, "submit_review", "withdraw_review"].sort(),
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
    expect(defaultRoleDefinition("designer", launch).allowed_tools).toContain(
      "read_attachment",
    );
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
    expect(designer.instructions).toContain("`read_attachment`");
    const director = defaultRoleDefinition("design_director", launch);
    expect(director.instructions).toContain("`read_attachment`");
    expect(director.instructions).toContain("设计稿评审和界面实现验收");
    expect(director.instructions).not.toContain("`submit_delivery`");
  });
});

test("C-268: UI implementation reviews require versioned evidence within the existing verifier boundary", () => {
  const director = instructionsFor("design_director");
  for (const phrase of [
    "设计稿评审：先用 `read_attachment`",
    "可写构建目录里构建交付提交",
    "HEAD 与当前交付的完整 SHA 一致",
    "不得打开生产 Workbench",
    "不得读生产库",
    "不使用生产副本",
    "只起本地 Web，不跑派发、合并等后台循环",
    "非生产规模数据",
    "scrollWidth",
    "文案逐字核对",
    "`submit_review.attachments`",
    "上传失败不能声称证据已留存",
    "worker 数不超过主机限流配置的上限",
  ])
    expect(director).toContain(phrase);
  const pm = instructionsFor("pm");
  for (const rule of PM_UI_VERIFICATION_RULES) expect(pm).toContain(rule);
  for (const phrase of [
    "`role_id=design_director`",
    "`required=true`",
    "`target_work_item_id`",
    "`completion_criteria`",
    "新交付须重新验证",
    "独立复核员不能是本次交付的作者",
    "待上线后试行",
    "结论一致才在开发方案宣布正式切换",
    "不能清除旧项绕过门禁",
  ])
    expect(pm).toContain(phrase);
  expect(pm).not.toContain("请其做截图核对");
  expect(pm).not.toContain("界面卡改由独立复核员截图核对");
  expect(PM_UI_VERIFICATION_RULES.join("\n")).not.toContain("@");
});

test.each(["pm", "design_director"] as const)(
  "C-288: %s uses synthetic data with explicit source and scale",
  (role) => {
    const instructions = instructionsFor(role);
    for (const phrase of [
      "合成数据生成器（C-287 另卡交付）",
      "生成器交付前继续使用已有合成夹具",
      "不把新入口称为已可用",
      "结论必须标明数据来源和规模",
      "非生产规模数据",
    ])
      expect(instructions).toContain(phrase);
    expect(instructions).not.toContain("去敏快照");
  },
);

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
    [...BASE_TOOLS, "submit_review", "withdraw_review"].sort(),
  );
  expect(validateRole(role).ok).toBe(true);
  for (const phrase of [
    "命中高危路径或人标记为高危的卡",
    "安全、权限和数值规则",
    "不复查 `code_review` 已覆盖",
    "`target_sha` 必须等于交付的 `subject`",
    "有阻塞问题必须标为 must_fix 并退回",
    "轮数只计驳回；轮数用完由系统自动加轮，同一验证项连续第 4 次驳回暂停并交 PM",
    "复核员不能是本次交付的作者，不追溯历史 Assignment",
    "可写构建目录",
    "worker 数不超过主机限流配置的上限",
  ])
    expect(role.instructions).toContain(phrase);
});

// C-162: wording copied independently of role-pack.ts.
const MERGE_RULE =
  "只有凭据或外部账号这类前置操作（例如需要人提供或轮换凭据、在外部账号后台完成配置）不完成就不能合并时，`request_human_action` 才传 `blocks_merge=true` 并填写 `prerequisite=credential|external_account`；现场验证、实测、请人看看、知会或可以事后补做的，默认不挡合并，作为合并后的跟进项。";

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

test("C-265: host_ops re-measures performance read-only and never toggles timing itself", () => {
  const body = instructionsFor("host_ops");
  const duty = body.split("\n").find((line) => line.includes("性能复测"));
  expect(duty).toBeDefined();
  for (const term of [
    "tick_profile",
    "request_latency",
    "event_loop_delay",
    "p50",
    "p90",
    "p95",
    "基线",
    "只读",
    "只有人能改",
    "你不能自己打开或关闭",
  ])
    expect(duty).toContain(term);
  // The duty adds no tool: host_ops keeps exactly its whitelist.
  expect(defaultRoleDefinition("host_ops", launch).allowed_tools).toEqual(
    HOST_OPS_ROLE_TOOLS,
  );
});

test("C-263: pm and host_ops mention PM Office only when it has to act or answer", () => {
  const pm = instructionsFor("pm");
  for (const rule of PM_OFFICE_MENTION_RULES) expect(pm).toContain(`- ${rule}`);
  for (const phrase of [
    "只用于需要它动手或回答的事项",
    "界面验收有争议或设计总监无法完成",
    "收尾记录",
    "状态同步",
    "已解决的更正",
    "不提醒 PM Office",
    "不重复提醒",
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
    "不再提醒 PM Office",
    "真正需要人工说明或动手时",
  ])
    expect(HOST_OPS_OFFICE_MENTION_RULES.join("\n")).toContain(phrase);

  expect(PM_OFFICE_MENTION_FIRST_LINE_RULE).toContain(
    "第一行写清要做什么、对哪个版本",
  );
  expect(PM_OFFICE_MENTION_FIRST_LINE_RULE).toContain(
    "请截图核对 D-xxx（sha）",
  );
  expect(hostOps).toContain(`- ${PM_OFFICE_MENTION_FIRST_LINE_RULE}`);
  expect(pm).not.toContain(PM_OFFICE_MENTION_FIRST_LINE_RULE);
  expect(PM_OFFICE_MENTION_RULES.join("\n")).not.toContain("@");
  for (const role of ["coder", "reviewer", "independent_reviewer"] as const)
    expect(instructionsFor(role)).not.toContain(
      PM_OFFICE_MENTION_FIRST_LINE_RULE,
    );
});

test("C-269: default role text permits only the scoped command and C2b template versions", () => {
  // These exact code literals are not mentions. Names and Assignment IDs stay banned.
  for (const role of Object.keys(DEFAULT_ROLE_KINDS) as DefaultRoleId[]) {
    const prompt = corePromptFor(role, "显示名");
    expect(
      prompt
        .replaceAll("`pnpm --filter @cardigan/domain test:types`", "")
        .replaceAll("`dev@2`", "")
        .replaceAll("`product@1`", "")
        .replaceAll("`fast_patch@1`", ""),
      role,
    ).not.toContain("@");
  }
  for (const rules of [PM_OFFICE_MENTION_RULES, HOST_OPS_OFFICE_MENTION_RULES])
    expect(rules).toContain(MENTION_FIELD_RULE);
  expect(MENTION_FIELD_RULE).toContain("不要写 at 符号");
  expect(MENTION_FIELD_RULE).toContain("`mentions` 字段");
  expect(instructionsFor("pm")).toContain(`- ${MENTION_FIELD_RULE}`);
  expect(instructionsFor("host_ops")).toContain(`- ${MENTION_FIELD_RULE}`);
});

test("C-269: pm sends host matters to host_ops, not PM Office", () => {
  expect(PM_HOST_MATTERS_RULE).toContain(
    "交给主机运维（host_ops），不找 PM Office",
  );
  expect(instructionsFor("pm")).toContain(`- ${PM_HOST_MATTERS_RULE}`);
  expect(instructionsFor("host_ops")).not.toContain(PM_HOST_MATTERS_RULE);
});

test("Flow Lite: coder runs lint, affected tests with snapshots and deps before every delivery", () => {
  const body = instructionsFor("coder");
  for (const phrase of [
    "每次交付前必须跑 `pnpm lint`（biome）",
    "受影响包的测试（含快照：有变化时用 `-u` 更新并逐条核对差异只来自本次改动）",
    "`pnpm check:deps`",
    "命令和结果写进 `test_results`",
    "首次交付前也先预检一次",
    "不修改 `docs/development-plan.md` 正文，除非卡片明确要求",
  ])
    expect(body).toContain(phrase);
  for (const role of Object.keys(DEFAULT_ROLE_KINDS) as DefaultRoleId[])
    if (role !== "coder")
      expect(instructionsFor(role), role).not.toContain(
        "每次交付前必须跑 `pnpm lint`",
      );
});

test("C-370 PM instructions document explicit dependencies without granting work-item PM scheduling", () => {
  const prompt = corePromptFor("pm");
  for (const text of [
    "depends_on_cards",
    "传 [] 清空",
    "wait_for_dependencies=true",
    "early_start=true",
    "dependency_reason",
    "工作项 PM 不因此获得后台排期权限",
    "不自动追随替代卡",
  ])
    expect(prompt).toContain(text);
});
