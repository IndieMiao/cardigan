/** V12b: read-only template and role catalog for the standing PM. */
import { expect, test } from "vitest";
import type { Actor } from "../entities.js";
import {
  ROLE_TOOL_ALLOWLISTS,
  type Role,
  STANDING_ROLE_TOOLS,
} from "../role.js";
import {
  artifactCardTemplate,
  type CardTemplate,
  developmentCardTemplate,
} from "../templates.js";
import type { CommandState } from "./core.js";
import { listRoles, listTemplates } from "./queries.js";
import { createRole } from "./role.js";
import { manageCardTemplate } from "./templates.js";
import { actor, fixture, human, ports, role, value } from "./test-fixtures.js";

const standingPm = actor(4, "pm");
const custom = (version: number, status: CardTemplate["status"]) =>
  ({
    ...artifactCardTemplate,
    id: "custom",
    title: `Custom v${version}`,
    builtin: false,
    version,
    status,
  }) satisfies CardTemplate;
const fullRole = (
  role_id: string,
  version: number,
  extra: Partial<Role> = {},
): Role & { role_version: number } => ({
  ...role(role_id),
  role_version: version,
  version,
  display_name: `${role_id} v${version}`,
  kind: "produce",
  core_prompt: "SECRET CORE PROMPT",
  instructions: "SECRET INSTRUCTIONS",
  harness: "claude-code",
  launch_profile_ref: "fixture-profile",
  abilities: ["draw"],
  worktree: "write",
  required_machine_tags: ["gpu"],
  ...extra,
});
const state = (): CommandState => ({
  ...fixture(),
  card_templates: [custom(1, "active"), custom(2, "active")],
  roles: [
    ...fixture().roles,
    fullRole("designer", 1),
    fullRole("designer", 2, { capabilities: ["design"] }),
    fullRole("retired", 1),
    fullRole("retired", 2, { status: "inactive" }),
  ],
});

test("list_templates returns the latest active version of every template", () => {
  const before = state();
  const effect = value(listTemplates(before, standingPm));
  const templates = effect.data.templates;
  expect(templates.map((t) => [t.id, t.version, t.builtin])).toEqual([
    ["artifact", 1, true],
    ["custom", 2, false],
    ["design", 1, true],
    ["dev", 1, true],
    ["general", 1, true],
  ]);
  expect(templates.find((t) => t.id === "dev")).toEqual({
    id: "dev",
    version: 1,
    title: developmentCardTemplate.title,
    description: developmentCardTemplate.description,
    builtin: true,
    requires_repo: true,
    merge: "confirm",
    primary_work_item_key: "development",
    work_items: developmentCardTemplate.work_items.map((w) => ({
      key: w.key,
      title: w.title,
      role_id: w.role_id,
      kind: w.kind,
      required: w.required,
    })),
  });
  expect(effect.changes).toEqual([]);
  expect(effect.events).toEqual([]);
  expect(effect.timeline).toEqual([]);
});

test("list_templates hides a template whose latest version is inactive", () => {
  const s = {
    ...state(),
    card_templates: [custom(1, "active"), custom(2, "inactive")],
  };
  const ids = value(listTemplates(s, standingPm)).data.templates.map(
    (t) => t.id,
  );
  expect(ids).not.toContain("custom");
});

test("list_roles returns the latest active role without prompts or launch policy", () => {
  const effect = value(listRoles(state(), standingPm));
  const roles = effect.data.roles;
  expect(roles.map((r) => r.role_id)).toEqual([
    "coder",
    "designer",
    "pm",
    "reviewer",
  ]);
  expect(roles.find((r) => r.role_id === "designer")).toEqual({
    role_id: "designer",
    version: 2,
    display_name: "designer v2",
    kind: "produce",
    capabilities: ["design"],
    required_machine_tags: ["gpu"],
    worktree: "write",
    abilities: ["draw"],
  });
  // Legacy references carry only the RoleReference fields.
  expect(roles.find((r) => r.role_id === "coder")).toEqual({
    role_id: "coder",
    version: 1,
    capabilities: ["coder"],
  });
  const text = JSON.stringify(effect.data);
  for (const hidden of [
    "SECRET",
    "fixture-profile",
    "allowed_tools",
    "harness",
  ])
    expect(text).not.toContain(hidden);
  expect(effect.changes).toEqual([]);
  expect(effect.events).toEqual([]);
});

test("catalog queries only serve the project-scoped PM and the human", () => {
  for (const query of [listTemplates, listRoles]) {
    expect(query(state(), human).ok).toBe(true);
    expect(query(state(), actor())).toMatchObject({
      ok: false,
      error: { code: "forbidden_tool" },
    });
    // A work-item PM (acceptance) is not project-scoped.
    expect(query(state(), actor(3, "pm"))).toMatchObject({
      ok: false,
      error: { code: "unauthorized" },
    });
    const other: Actor = { kind: "human", project_id: "another-project" };
    expect(query(state(), other)).toMatchObject({
      ok: false,
      error: { code: "unauthorized" },
    });
  }
});

test("a standing PM whose role version lacks the tools is rejected", () => {
  const s = {
    ...state(),
    roles: state().roles.map((r) =>
      r.role_id === "pm"
        ? {
            ...r,
            allowed_tools: r.allowed_tools.filter(
              (t) => t !== "list_templates" && t !== "list_roles",
            ),
          }
        : r,
    ),
  };
  for (const query of [listTemplates, listRoles])
    expect(query(s, standingPm)).toMatchObject({
      ok: false,
      error: { code: "forbidden_tool" },
    });
});

test("only standing roles may be granted the catalog tools", () => {
  for (const tool of ["list_templates", "list_roles"] as const) {
    expect(STANDING_ROLE_TOOLS).toContain(tool);
    expect(ROLE_TOOL_ALLOWLISTS.standing).toContain(tool);
    expect(ROLE_TOOL_ALLOWLISTS.produce).not.toContain(tool);
    expect(ROLE_TOOL_ALLOWLISTS.verify).not.toContain(tool);
  }
});

test("reading the catalog does not let the standing PM create templates or roles", () => {
  const s = state();
  expect(
    manageCardTemplate(
      s,
      standingPm,
      { action: "add", definition: { ...artifactCardTemplate, id: "new" } },
      ports(),
    ),
  ).toMatchObject({ ok: false, error: { code: "forbidden_tool" } });
  for (const action of ["update", "deactivate", "activate"] as const)
    expect(
      manageCardTemplate(
        s,
        standingPm,
        action === "update"
          ? {
              action,
              definition: { ...custom(2, "active"), title: "Changed" },
            }
          : { action, template_id: "custom" },
        ports(),
      ),
    ).toMatchObject({ ok: false, error: { code: "forbidden_tool" } });
  const { version: _v, status: _s, ...definition } = fullRole("drafted", 1);
  expect(
    createRole(
      { project_id: s.project_id, roles: [] },
      standingPm,
      definition,
      ports(),
    ),
  ).toMatchObject({ ok: false, error: { code: "forbidden_tool" } });
});
