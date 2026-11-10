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

test.each(["pm", "coder", "reviewer", "designer", "tester"] as const)(
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
