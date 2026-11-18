import { HOST_OPS_ROLE_TOOLS, validateRole } from "@cardigan/domain";
import { expect, test } from "vitest";
import { compileAssignmentLaunch } from "./assignment.js";
import {
  AGENT_PROTOCOL,
  composeRolePrompt,
  convertLegacyRole,
  SHARED_BOUNDARIES,
} from "./prompt.js";
import {
  corePromptFor,
  defaultRoleDefinition,
  instructionsFor,
} from "./role-pack.js";
import { parseLaunchConfig } from "./schema.js";

test.each([
  "coder",
  "frontend_engineer",
  "reviewer",
  "pm",
  "design_director",
  "independent_reviewer",
] as const)("%s defaults grant valid attachment read permission", (id) => {
  const role = defaultRoleDefinition(id, {
    harness: "codex",
    launch_profile_ref: "fixture",
  });
  expect(role.allowed_tools).toContain("read_attachment");
  expect(role.instructions).toContain("元数据不等于已阅读证据");
  expect(role.instructions).toContain("download-attachment.js");
  expect(role.instructions).toContain("next_offset");
  expect(validateRole(role).ok).toBe(true);
});

test.each([
  "reviewer",
  "designer",
  "tester",
  "pm",
  "coder",
  "frontend_engineer",
  "host_ops",
  "ui_ux_designer",
  "design_director",
  "independent_reviewer",
] as const)(
  "%s default tools include withdrawal exactly when they include review submission",
  (id) => {
    const role = defaultRoleDefinition(id, {
      harness: "codex",
      launch_profile_ref: "fixture",
    });
    expect(role.allowed_tools.includes("withdraw_review")).toBe(
      role.allowed_tools.includes("submit_review"),
    );
    expect(validateRole(role).ok).toBe(true);
  },
);

test.each([
  "pm",
  "coder",
  "frontend_engineer",
  "reviewer",
  "designer",
  "tester",
  "host_ops",
  "ui_ux_designer",
  "design_director",
  "independent_reviewer",
] as const)(
  "converts the default %s format without carrying system sections",
  (id) => {
    const old = corePromptFor(id, "Display name");
    const converted = convertLegacyRole({ core_prompt: old });
    expect(converted.warnings).toEqual([]);
    expect(converted.instructions).toBe(instructionsFor(id, "Display name"));
    expect(composeRolePrompt(converted.instructions)).toBe(old);
    // Historical protocol text is replaced, not appended to the new system text.
    const historical = old.replace(AGENT_PROTOCOL[0], "Older start protocol.");
    expect(convertLegacyRole({ core_prompt: historical })).toEqual(converted);
  },
);

test("host_ops defaults describe the operations boundary without granting PM or work-item powers", () => {
  const role = defaultRoleDefinition("host_ops", {
    harness: "codex",
    launch_profile_ref: "fixture",
  });
  expect(validateRole(role).ok).toBe(true);
  expect(role).toMatchObject({
    kind: "standing",
    worktree: "none",
    capabilities: [],
    allowed_tools: HOST_OPS_ROLE_TOOLS,
  });
  const prompt = corePromptFor("host_ops");
  for (const phrase of [
    "PM Ops",
    "不派活",
    "不建卡",
    "不审核",
    "Assignment、Run、Card 编号",
    "不按员工名字",
    "默认填 human，人已开启授权的类别和其它事项填 role:pm",
    "尚不可用",
  ])
    expect(prompt).toContain(phrase);
  for (const rule of [...SHARED_BOUNDARIES, ...AGENT_PROTOCOL])
    expect(prompt.split(rule)).toHaveLength(2);
});

test("unknown legacy structure is preserved with a warning; explicit instructions are left alone", () => {
  const unknown =
    "Custom body\n\n## 协作规则\nCustom prose, not the pack format.\n";
  expect(convertLegacyRole({ core_prompt: unknown })).toMatchObject({
    instructions: unknown,
    warnings: [expect.stringContaining("可能")],
  });
  expect(
    convertLegacyRole({
      core_prompt: unknown,
      instructions: "Already converted",
    }),
  ).toEqual({ instructions: "Already converted", warnings: [] });
});

test.each(["claude-code", "codex", "pi"] as const)(
  "%s compiles instructions once and leaves the full legacy output unchanged",
  (harness) => {
    const common = {
      assignment: { assignment_id: "A-1", run_id: "R-1" },
      launch: parseLaunchConfig({
        profiles: { fixture: { harness, model: "fixture" } },
      }),
      mcp: { url: "http://localhost/mcp" },
      run_dir: "/tmp/role-run",
      work_dir: "/tmp/role-work",
      first_prompt: "[bell] asg=A-1 run=R-1",
      secrets: {},
    };
    const source = defaultRoleDefinition("coder", {
      harness,
      launch_profile_ref: "fixture",
    });
    const role = {
      role_id: "coder",
      harness,
      launch_profile: "fixture",
      allowed_tools: source.allowed_tools,
      worktree: source.worktree,
    };
    const modern = compileAssignmentLaunch({
      ...common,
      role: {
        ...role,
        instructions: source.instructions as string,
        core_prompt: "ignored",
      },
    });
    const legacy = compileAssignmentLaunch({
      ...common,
      role: { ...role, core_prompt: corePromptFor("coder") },
    });
    expect(modern).toEqual(legacy);
    const core =
      modern.files.find((file) => file.path.endsWith("/core.md"))?.content ??
      "";
    for (const rule of [...SHARED_BOUNDARIES, ...AGENT_PROTOCOL])
      expect(core.split(rule)).toHaveLength(2);
    expect(core.split("## 协作规则")).toHaveLength(2);
    expect(core.split("## 协议（每个 Run 都要遵守）")).toHaveLength(2);
    // Full old prompts, individual headings and copied rule lines are all rejected
    // before any harness-specific files can be generated for a new-format role.
    for (const embedded of [
      corePromptFor("coder"),
      "## 协作规则",
      "## 协议（每个 Run 都要遵守）",
      ...SHARED_BOUNDARIES,
      ...AGENT_PROTOCOL,
    ]) {
      expect(() =>
        compileAssignmentLaunch({
          ...common,
          role: { ...role, instructions: `Custom role.\n${embedded}` },
        }),
      ).toThrow("instructions 不得包含");
    }
    expect(() => composeRolePrompt(corePromptFor("coder"))).toThrow(
      "instructions 不得包含",
    );
    const converted = convertLegacyRole({
      core_prompt: corePromptFor("coder"),
    });
    expect(
      compileAssignmentLaunch({
        ...common,
        role: { ...role, instructions: converted.instructions },
      }),
    ).toEqual(legacy);
    // Compare to the original compiler's observable behavior for a custom prompt.
    const custom = "Legacy content\n\n## Custom heading\nVerbatim body  \n";
    const unchanged = compileAssignmentLaunch({
      ...common,
      role: { ...role, core_prompt: custom },
    });
    expect(
      unchanged.files.find((file) => file.path.endsWith("/core.md"))?.content,
    ).toBe(custom);
    const withEmployee = compileAssignmentLaunch({
      ...common,
      employee: {
        launch_profile_ref: null,
        identity: { name: "Alice", title: "Coder", bio: "Builds things" },
      },
      role: { ...role, instructions: source.instructions as string },
    });
    const named =
      withEmployee.files.find((file) => file.path.endsWith("/core.md"))
        ?.content ?? "";
    expect(named).toContain('你是 "Alice"');
    for (const rule of [...SHARED_BOUNDARIES, ...AGENT_PROTOCOL])
      expect(named.split(rule)).toHaveLength(2);
  },
);
