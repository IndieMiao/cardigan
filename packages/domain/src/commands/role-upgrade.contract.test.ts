import { expect, test } from "vitest";
import type { Actor } from "../entities.js";
import { type Role, STANDING_ROLE_TOOLS } from "../role.js";
import {
  createRole,
  type RoleCommandState,
  type RoleDefinition,
  upgradeRole,
  upgradeRoleAfterDeployment,
} from "./role.js";
import { actor, human, ports, value } from "./test-fixtures.js";

/** A project pm created long ago, before the delegation tools existed. */
function projectPm(): { state: RoleCommandState; role: Role } {
  const role = value(
    createRole(
      { project_id: human.project_id, roles: [] },
      human,
      {
        role_id: "pm",
        display_name: "项目经理",
        kind: "standing",
        instructions: "旧版 PM 说明。",
        harness: "claude-code",
        launch_profile_ref: "claude-pm",
        allowed_tools: STANDING_ROLE_TOOLS.filter(
          (t) =>
            !["resolve_delegated_decision", "triage_human_action"].includes(t),
        ),
        capabilities: ["verify"],
        abilities: ["规划"],
        worktree: "readonly",
        required_machine_tags: ["gpu"],
      },
      ports(),
    ),
  ).data;
  return { state: { project_id: human.project_id, roles: [role] }, role };
}
/** Stand-in for the default pack (domain must not import @cardigan/roles). */
const pack: RoleDefinition = {
  role_id: "pm",
  display_name: "pm",
  kind: "standing",
  instructions: "默认包 PM 说明。",
  harness: "codex",
  launch_profile_ref: "codex-agent",
  allowed_tools: [...STANDING_ROLE_TOOLS],
  capabilities: ["verify"],
  abilities: [],
  worktree: "readonly",
  required_machine_tags: [],
};

test("upgrade appends a version with the pack policy and keeps project launch fields", () => {
  const { state, role } = projectPm();
  const result = value(upgradeRole(state, human, "pm", pack, ports()));
  expect(result.unchanged).toBe(false);
  if (result.unchanged) return;
  const next = result.effect.data;
  expect(next.version).toBe(role.version + 1);
  expect(next).toMatchObject({
    instructions: pack.instructions,
    allowed_tools: pack.allowed_tools,
    capabilities: pack.capabilities,
    kind: pack.kind,
    worktree: pack.worktree,
    harness: "claude-code",
    launch_profile_ref: "claude-pm",
    display_name: "项目经理",
    abilities: ["规划"],
    required_machine_tags: ["gpu"],
  });
  expect(result.diff.added_tools).toEqual([
    "resolve_delegated_decision",
    "triage_human_action",
  ]);
  expect(result.diff.removed_tools).toEqual([]);
  expect(result.diff.relaxations).toEqual([
    "新增工具 resolve_delegated_decision",
    "新增工具 triage_human_action",
  ]);
  expect(result.diff.fields.map((f) => f.field)).toEqual(["instructions"]);
  expect(result.effect.events.map((e) => e.type)).toEqual(["role_updated"]);
});

test("upgrade with identical content appends nothing", () => {
  const { state } = projectPm();
  const once = value(upgradeRole(state, human, "pm", pack, ports()));
  if (once.unchanged) throw new Error("expected a new version");
  const again = value(
    upgradeRole(
      { ...state, roles: [...state.roles, once.effect.data] },
      human,
      "pm",
      // Tool order is not a change.
      { ...pack, allowed_tools: [...pack.allowed_tools].reverse() },
      ports(),
    ),
  );
  expect(again.unchanged).toBe(true);
  expect("effect" in again).toBe(false);
});

test("upgrade lists narrowing and widening of worktree and capabilities", () => {
  const { state } = projectPm();
  const result = value(
    upgradeRole(
      state,
      human,
      "pm",
      { ...pack, worktree: "none", capabilities: ["review"] },
      ports(),
    ),
  );
  expect(result.diff.added_capabilities).toEqual(["review"]);
  expect(result.diff.removed_capabilities).toEqual(["verify"]);
  expect(result.diff.relaxations).toContain("新增能力 review");
  expect(result.diff.relaxations.some((r) => r.includes("worktree"))).toBe(
    false,
  );
});

test("upgrade is human-only and still goes through validateRole", () => {
  const { state } = projectPm();
  const pm: Actor = actor(4, "pm");
  for (const who of [pm, { kind: "system", project_id: human.project_id }]) {
    const result = upgradeRole(state, who as Actor, "pm", pack, ports());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("forbidden_tool");
  }
  const invalid = upgradeRole(
    state,
    human,
    "pm",
    // System prompt text is rejected by validateRole for every role write.
    { ...pack, instructions: "默认包说明。\n\n## 协作规则\n" },
    ports(),
  );
  expect(invalid.ok).toBe(false);
  if (!invalid.ok) expect(invalid.error.code).toBe("validation_failed");
  const missing = upgradeRole(
    state,
    human,
    "coder",
    { ...pack, role_id: "coder" },
    ports(),
  );
  expect(missing.ok).toBe(false);
  if (!missing.ok) expect(missing.error.code).toBe("not_found");
});

const system: Actor = { kind: "system", project_id: human.project_id };

test("deployment upgrades narrow or equal permissions and preserve project settings", () => {
  const { state, role } = projectPm();
  const source = {
    ...pack,
    allowed_tools: role.allowed_tools,
    worktree: "none" as const,
  };
  const result = value(
    upgradeRoleAfterDeployment(state, system, "pm", source, ports()),
  );
  expect(result.effect?.data).toMatchObject({
    version: 2,
    instructions: pack.instructions,
    worktree: "none",
    harness: role.harness,
    launch_profile_ref: role.launch_profile_ref,
  });
  expect(result.effect?.events[0]?.actor.kind).toBe("system");
  expect(result.diff.relaxations).toEqual([]);
  if (!result.effect) throw new Error("Expected upgrade");
  const next = result.effect.data;
  expect(
    value(
      upgradeRoleAfterDeployment(
        { ...state, roles: [...state.roles, next] },
        system,
        "pm",
        source,
        ports(),
      ),
    ).effect,
  ).toBeUndefined();
});

test("B9: deployed default packs may add valid tools; invalid role definitions still fail validation", () => {
  const { state } = projectPm();
  const allowed = value(
    upgradeRoleAfterDeployment(
      state,
      system,
      "pm",
      { ...pack, allowed_tools: pack.allowed_tools },
      ports(),
    ),
  );
  expect(allowed.effect?.data.version).toBe(2);
  expect(allowed.diff.relaxations.length).toBeGreaterThan(0);
  expect(
    upgradeRoleAfterDeployment(
      state,
      system,
      "pm",
      { ...pack, allowed_tools: ["invalid_tool" as never] },
      ports(),
    ).ok,
  ).toBe(false);
});

test("no Agent or foreign project can invoke deployment role upgrades", () => {
  const { state, role } = projectPm();
  for (const caller of [
    actor(1, "coder"),
    actor(4, "pm"),
    actor(5, "host_ops"),
    human,
    { kind: "system" as const, project_id: "foreign" },
  ]) {
    const result = upgradeRoleAfterDeployment(
      state,
      caller,
      "pm",
      { ...pack, allowed_tools: role.allowed_tools },
      ports(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("unauthorized");
  }
  expect(
    value(
      upgradeRoleAfterDeployment(
        { ...state, roles: [{ ...role, status: "inactive" }] },
        system,
        "pm",
        { ...pack, allowed_tools: role.allowed_tools },
        ports(),
      ),
    ).effect,
  ).toBeUndefined();
});
