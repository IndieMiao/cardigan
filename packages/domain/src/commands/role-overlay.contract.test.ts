import { expect, test } from "vitest";
import type { Actor } from "../entities.js";
import { type Role, type RoleOverlay, STANDING_ROLE_TOOLS } from "../role.js";
import {
  composeRoleOverlay,
  createRole,
  type RoleCommandState,
  type RoleDefinition,
  updateRole,
  upgradeRole,
  upgradeRoleAfterDeployment,
  validateRole,
} from "./role.js";
import { human, ports, value } from "./test-fixtures.js";

const system: Actor = { kind: "system", project_id: human.project_id };
const pack: RoleDefinition = {
  role_id: "pm",
  display_name: "pm",
  kind: "standing",
  instructions: "默认包 PM 说明。",
  harness: "codex",
  launch_profile_ref: "codex-agent",
  allowed_tools: STANDING_ROLE_TOOLS.filter((t) => t !== "publish_artifact"),
  capabilities: ["verify"],
  abilities: [],
  worktree: "readonly",
  required_machine_tags: [],
};
const rules = {
  base_role_id: "pm",
  append_instructions: "项目规则：外发前先核对版本号。",
  extra_tools: ["publish_artifact" as const],
  removed_tools: ["create_card" as const],
};
const overlay = (composed: string): RoleOverlay => ({
  ...rules,
  base_hash: "base-1",
  composed_hash: composed,
});

function composed(source: RoleDefinition, o: RoleOverlay): RoleDefinition {
  return { ...source, ...composeRoleOverlay(source, o), default_overlay: o };
}

function projectPm(): { state: RoleCommandState; role: Role } {
  const role = value(
    createRole(
      { project_id: human.project_id, roles: [] },
      human,
      {
        ...composed(pack, overlay("c-1")),
        display_name: "项目经理",
        harness: "claude-code",
        launch_profile_ref: "claude-pm",
        abilities: ["规划"],
      },
      ports(),
    ),
  ).data;
  return { state: { project_id: human.project_id, roles: [role] }, role };
}

test("C-613 compose appends project text and tools; explicit removals win", () => {
  const result = composeRoleOverlay(pack, rules);
  expect(result.instructions).toBe(
    "默认包 PM 说明。\n\n项目规则：外发前先核对版本号。",
  );
  expect(result.allowed_tools).toContain("publish_artifact");
  expect(result.allowed_tools).not.toContain("create_card");
  // A tool the pack adds later is picked up unless removed.
  const later = composeRoleOverlay(
    { ...pack, allowed_tools: [...pack.allowed_tools, "create_card"] },
    rules,
  );
  expect(later.allowed_tools).not.toContain("create_card");
  expect(
    composeRoleOverlay(pack, { ...rules, append_instructions: "  " })
      .instructions,
  ).toBe(pack.instructions);
});

test("C-613 a version stores and validates its overlay", () => {
  const { role } = projectPm();
  expect(role.default_overlay).toEqual(overlay("c-1"));
  for (const bad of [
    { ...overlay("c"), extra_tools: ["no_such_tool"] },
    { ...overlay("c"), removed_tools: ["publish_artifact"] },
    { ...overlay("c"), base_hash: "" },
    { ...overlay("c"), base_role_id: "Bad Id" },
    // Derived from submit_review: a lone removal would silently not apply.
    { ...overlay("c"), removed_tools: ["withdraw_review"] },
  ])
    expect(
      validateRole({
        ...composed(pack, overlay("c")),
        default_overlay: bad as never,
      }).ok,
    ).toBe(false);
});

test("C-613 deployment recomposes a new pack with the same project rules", () => {
  const { state, role } = projectPm();
  const next = {
    ...pack,
    instructions: "新默认包 PM 说明。",
    allowed_tools: [...pack.allowed_tools, "send_owner_message" as const],
  };
  const result = value(
    upgradeRoleAfterDeployment(
      state,
      system,
      "pm",
      composed(next, { ...overlay("c-2"), base_hash: "base-2" }),
      ports(),
    ),
  );
  const saved = result.effect?.data;
  expect(saved?.version).toBe(role.version + 1);
  expect(saved?.instructions).toBe(
    "新默认包 PM 说明。\n\n项目规则：外发前先核对版本号。",
  );
  expect(saved?.allowed_tools).toEqual(
    expect.arrayContaining(["send_owner_message", "publish_artifact"]),
  );
  expect(saved?.allowed_tools).not.toContain("create_card");
  expect(saved).toMatchObject({
    harness: "claude-code",
    launch_profile_ref: "claude-pm",
    display_name: "项目经理",
    abilities: ["规划"],
    default_overlay: { composed_hash: "c-2", base_hash: "base-2" },
  });
});

test("C-613 same composition is unchanged; a new overlay alone is a new version", () => {
  const { state, role } = projectPm();
  const same = value(
    upgradeRole(state, human, "pm", composed(pack, overlay("c-1")), ports()),
  );
  expect(same.unchanged).toBe(true);
  const rehashed = value(
    upgradeRole(state, human, "pm", composed(pack, overlay("c-9")), ports()),
  );
  expect(rehashed.unchanged).toBe(false);
  if (!rehashed.unchanged)
    expect(rehashed.effect.data.version).toBe(role.version + 1);
});

test("C-613 a plain default upgrade ends the overlay instead of keeping stale hashes", () => {
  const { state } = projectPm();
  const result = value(upgradeRole(state, human, "pm", pack, ports()));
  expect(result.unchanged).toBe(false);
  if (!result.unchanged) {
    expect(result.effect.data.default_overlay).toBeUndefined();
    expect(result.effect.data.instructions).toBe(pack.instructions);
  }
});

test("C-613 an ordinary edit keeps the overlay record, so the host can see the hand edit", () => {
  const { state } = projectPm();
  const edited = value(
    updateRole(state, human, "pm", { instructions: "手改说明。" }, ports()),
  ).data;
  expect(edited.default_overlay).toEqual(overlay("c-1"));
});

test("C-613 a conflicting composition is rejected by the same validation", () => {
  const { state } = projectPm();
  const bad = composed(
    { ...pack, kind: "verify", worktree: "readonly" },
    overlay("c-3"),
  );
  expect(upgradeRoleAfterDeployment(state, system, "pm", bad, ports()).ok).toBe(
    false,
  );
});
