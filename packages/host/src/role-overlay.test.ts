import {
  type Assignment,
  composeRoleOverlay,
  type Role,
  type RoleDefinition,
  type RoleOverlayRules,
} from "@cardigan/domain";
import { defaultRoleDefinition } from "@cardigan/roles";
import { getRoleVersion, Store, writeRole } from "@cardigan/store";
import { expect, test } from "vitest";
import {
  deploymentRolePolicyHash,
  idleRolePolicies,
  upgradeDeployedRoles,
} from "./deployment-roles.js";
import {
  composeOverlaySource,
  deriveOverlayRules,
  syncProjectOverlayRoles,
} from "./role-overlay.js";

const launch = { harness: "codex" as const, launch_profile_ref: "fixture" };
const TIME_RULE = "时间点约束：只认交付时刻的基线和证据。";
/** A release that changed no default role. */
const STABLE = {
  changedRoles: [],
  previousDefaults: {},
  profiles: () => new Set(["fixture"]),
};

function withStore(run: (store: Store, project: string) => void) {
  const store = Store.open({ dbPath: ":memory:" });
  try {
    store.createProject({ id: "sensen" });
    run(store, "sensen");
  } finally {
    store.close();
  }
}
function put(store: Store, project: string, role: RoleDefinition, v: number) {
  store.uow.run((tx) =>
    writeRole(tx, project, { core_prompt: "", ...role, version: v } as Role, {
      mode: v === 1 ? "add" : "update",
    }),
  );
}
const events = (store: Store, project: string, type: string) =>
  store.uow.read((tx) =>
    tx.events.listAfter(project, undefined, 0).filter((e) => e.type === type),
  );
/** An overlay version composed from an older pack, as a previous release wrote it. */
function olderOverlay(
  id: "pm" | "reviewer",
  rules: RoleOverlayRules,
  older: Partial<RoleDefinition>,
): RoleDefinition {
  const base = { ...defaultRoleDefinition(id, launch), ...older };
  const composed = { ...base, ...composeRoleOverlay(base, rules) };
  return {
    ...composed,
    default_overlay: {
      ...rules,
      base_hash: deploymentRolePolicyHash(base),
      composed_hash: deploymentRolePolicyHash(composed),
    },
  };
}

test("C-613 a customised role that reads losslessly migrates once, keeping its rules", () =>
  withStore((store, project) => {
    const pack = defaultRoleDefinition("reviewer", launch);
    const before: RoleDefinition = {
      ...pack,
      instructions: `${pack.instructions}\n\n${TIME_RULE}`,
      allowed_tools: [...pack.allowed_tools, "list_needs_you"],
    };
    put(store, project, before, 1);
    syncProjectOverlayRoles(store, project, STABLE);
    syncProjectOverlayRoles(store, project, STABLE);
    const after = store.uow.read((tx) =>
      getRoleVersion(tx, project, "reviewer"),
    );
    expect(after?.version).toBe(2);
    // Content is unchanged; only the structure is new.
    expect(deploymentRolePolicyHash(after as Role)).toBe(
      deploymentRolePolicyHash(before),
    );
    expect(after?.default_overlay).toMatchObject({
      base_role_id: "reviewer",
      append_instructions: TIME_RULE,
      extra_tools: ["list_needs_you"],
      removed_tools: [],
      base_hash: deploymentRolePolicyHash(pack),
      composed_hash: deploymentRolePolicyHash(before),
    });
    const [migrated] = events(store, project, "host_role_overlay_migrated");
    expect(migrated?.payload).toMatchObject({
      role_id: "reviewer",
      from_version: 1,
      to_version: 2,
      migrated: {
        before_hash: deploymentRolePolicyHash(before),
        after_hash: deploymentRolePolicyHash(before),
        moved: false,
        overlay: { appended_paragraphs: 1, extra_tools: ["list_needs_you"] },
      },
    });
    expect(events(store, project, "host_role_overlay_migrated")).toHaveLength(
      1,
    );
    expect(store.uow.read((tx) => tx.human_actions.list(project))).toEqual([]);
  }));

test("C-613 a new pack is recomposed with project rules, the idle PM rotates, and no human action opens", () =>
  withStore((store, project) => {
    const pack = defaultRoleDefinition("pm", launch);
    const rules: RoleOverlayRules = {
      base_role_id: "pm",
      append_instructions: "Local PM policy",
      extra_tools: [],
      removed_tools: ["create_card"],
    };
    // The older pack lacked get_check_log: a new default tool must arrive.
    const v1 = olderOverlay("pm", rules, {
      instructions: "Earlier instructions",
      allowed_tools: pack.allowed_tools.filter((t) => t !== "get_check_log"),
    });
    put(store, project, v1, 1);
    const previous: Assignment = {
      id: "A-50" as never,
      scope: "standing",
      standing_mode: "ops",
      role_id: "pm",
      role_version: 1,
      status: "active",
      runtime_state: "not_provisioned",
      machine_id: "local",
      runtime_ref: null,
      mcp_token_id: "fixture",
      created_at: "2026-01-01T00:00:00.000Z",
    };
    store.uow.run((tx) => tx.assignments.put(project, previous));
    // No supervisor fingerprint and no changed list: overlays need neither.
    const next = upgradeDeployedRoles(
      store,
      project,
      [],
      {},
      new Set(["fixture"]),
    );
    store.uow.read((tx) => {
      const role = getRoleVersion(tx, project, "pm");
      expect(role?.version).toBe(2);
      expect(role?.instructions).toBe(
        `${pack.instructions}\n\nLocal PM policy`,
      );
      expect(role?.allowed_tools).toContain("get_check_log");
      expect(role?.allowed_tools).not.toContain("create_card");
      expect(role?.default_overlay).toMatchObject({
        ...rules,
        base_hash: deploymentRolePolicyHash(pack),
        composed_hash: deploymentRolePolicyHash(role as Role),
      });
      expect(tx.human_actions.list(project)).toEqual([]);
      expect(tx.assignments.get(project, previous.id)?.status).toBe("released");
      expect(next && tx.assignments.get(project, next)).toMatchObject({
        role_version: 2,
        standing_mode: "ops",
      });
      expect(idleRolePolicies(tx, project).get("pm")).toMatchObject({
        matches: true,
        published: true,
      });
    });
    const [upgraded] = events(store, project, "host_role_upgraded");
    expect(upgraded?.payload).toMatchObject({
      role_id: "pm",
      from_version: 1,
      to_version: 2,
      overlay: { removed_tools: ["create_card"] },
    });
    const [receipt] = events(store, project, "host_role_pack_published");
    expect(
      (
        receipt?.payload as
          | { roles: Record<string, { disposition: string }> }
          | undefined
      )?.roles.pm?.disposition,
    ).toBe("matched");
    upgradeDeployedRoles(store, project, ["pm"], {}, new Set(["fixture"]));
    expect(store.uow.read((tx) => getRoleVersion(tx, project, "pm"))).toEqual(
      expect.objectContaining({ version: 2 }),
    );
  }));

test("C-613 an overlay edited by hand, or conflicting with the pack, keeps its version and only notifies PM", () =>
  withStore((store, project) => {
    const rules: RoleOverlayRules = {
      base_role_id: "reviewer",
      append_instructions: TIME_RULE,
      extra_tools: [],
      removed_tools: [],
    };
    const v1 = olderOverlay("reviewer", rules, { instructions: "Older" });
    put(store, project, { ...v1, instructions: "Hand edit" }, 1);
    // publish_artifact is never valid on a reviewer: the composition fails validation.
    const conflict = olderOverlay(
      "reviewer",
      { ...rules, base_role_id: "reviewer", extra_tools: ["publish_artifact"] },
      { instructions: "Older" },
    );
    put(store, project, { ...conflict, role_id: "tester" }, 1);
    syncProjectOverlayRoles(store, project, STABLE);
    syncProjectOverlayRoles(store, project, STABLE);
    store.uow.read((tx) => {
      expect(getRoleVersion(tx, project, "reviewer")?.version).toBe(1);
      expect(getRoleVersion(tx, project, "tester")?.version).toBe(1);
      expect(tx.human_actions.list(project)).toEqual([]);
    });
    const notices = events(store, project, "host_role_upgrade_deferred").map(
      (e) => (e.payload as { notice: string }).notice,
    );
    expect(notices).toHaveLength(2);
    expect(notices.join("\n")).toContain("在项目附加规则之外另有改动");
    expect(notices.join("\n")).toContain("与项目附加规则冲突");
  }));

test("C-613 a stale customised role is not migrated; only other projects get the notice", () =>
  withStore((store, project) => {
    const pack = defaultRoleDefinition("host_ops", launch);
    put(
      store,
      project,
      { ...pack, instructions: "Earlier default\n\nSSH 说明" },
      1,
    );
    // A missing default tool may be an older pack: it is never read as a removal.
    const reviewer = defaultRoleDefinition("reviewer", launch);
    put(
      store,
      project,
      {
        ...reviewer,
        instructions: `${reviewer.instructions}\n\n${TIME_RULE}`,
        allowed_tools: reviewer.allowed_tools.filter(
          (t) => t !== "project_snapshot",
        ),
      },
      1,
    );
    syncProjectOverlayRoles(store, project, STABLE);
    store.uow.read((tx) => {
      expect(getRoleVersion(tx, project, "host_ops")?.version).toBe(1);
      expect(getRoleVersion(tx, project, "reviewer")?.version).toBe(1);
    });
    const [notice, toolNotice] = events(
      store,
      project,
      "host_role_upgrade_deferred",
    );
    expect(
      (toolNotice?.payload as { notice?: string } | undefined)?.notice,
    ).toContain("缺少默认包工具 project_snapshot");
    expect(
      (notice?.payload as { notice?: string } | undefined)?.notice,
    ).toContain(
      `cardigan role overlay host_ops --project ${project} --dry-run`,
    );
    store.createProject({ id: "cardigan" });
    put(
      store,
      "cardigan",
      { ...pack, instructions: "Earlier default\n\nSSH 说明" },
      1,
    );
    upgradeDeployedRoles(store, "cardigan", [], {}, new Set(["fixture"]));
    expect(events(store, "cardigan", "host_role_upgrade_deferred")).toEqual([]);
  }));

test("C-613 derivation keeps every project paragraph and tool; a foreign base is explicit", () => {
  const pack = defaultRoleDefinition("reviewer", launch);
  const [first, ...rest] = (pack.instructions ?? "").split("\n\n");
  const interleaved = {
    ...pack,
    core_prompt: "",
    version: 3,
    instructions: [first, TIME_RULE, ...rest].join("\n\n"),
    allowed_tools: [...pack.allowed_tools, "withdraw_review" as const],
  } as Role;
  const derived = deriveOverlayRules(interleaved, "reviewer");
  expect(derived).toMatchObject({
    rules: { append_instructions: TIME_RULE, extra_tools: [] },
    missing: [],
    mismatched: [],
    moved: true,
  });
  const release = {
    ...interleaved,
    role_id: "release_ops",
    kind: "standing",
  } as Role;
  expect(deriveOverlayRules(release, "release_ops")).toBeUndefined();
  expect(deriveOverlayRules(release, "reviewer")?.mismatched).toContain("kind");
  const composed = composeOverlaySource(release, {
    base_role_id: "reviewer",
    append_instructions: TIME_RULE,
    extra_tools: [],
    removed_tools: [],
  });
  expect(composed).toMatchObject({
    role_id: "release_ops",
    kind: "verify",
    default_overlay: { base_role_id: "reviewer" },
  });
});

test("C-613 V-3025: an untouched previous default whose pack withdrew a tool upgrades on the default path, not into an overlay", () =>
  withStore((store) => {
    store.createProject({ id: "cardigan" });
    const pack = defaultRoleDefinition("reviewer", launch);
    // The previous pack granted list_needs_you; this release withdrew it.
    const previous = {
      ...pack,
      allowed_tools: [...pack.allowed_tools, "list_needs_you" as const],
    };
    put(store, "cardigan", previous, 1);
    upgradeDeployedRoles(
      store,
      "cardigan",
      ["reviewer"],
      { reviewer: deploymentRolePolicyHash(previous) },
      new Set(["fixture"]),
    );
    const role = store.uow.read((tx) =>
      getRoleVersion(tx, "cardigan", "reviewer"),
    );
    expect(role?.version).toBe(2);
    expect(role?.default_overlay).toBeUndefined();
    expect(role?.allowed_tools).not.toContain("list_needs_you");
    expect(events(store, "cardigan", "host_role_overlay_migrated")).toEqual([]);
  }));

test("C-613 V-3025/V-3026: other projects upgrade an untouched previous default and never guess a just-changed role", () =>
  withStore((store, project) => {
    const reviewer = defaultRoleDefinition("reviewer", launch);
    const tester = defaultRoleDefinition("tester", launch);
    const previous = {
      ...reviewer,
      allowed_tools: [...reviewer.allowed_tools, "list_needs_you" as const],
    };
    put(store, project, previous, 1);
    // Looks like default + a project tool, but this release changed tester.
    put(
      store,
      project,
      {
        ...tester,
        allowed_tools: [...tester.allowed_tools, "list_needs_you" as const],
      },
      1,
    );
    syncProjectOverlayRoles(store, project, {
      ...STABLE,
      changedRoles: ["reviewer", "tester"],
      // tester: no fingerprint of the previous default is available.
      previousDefaults: { reviewer: deploymentRolePolicyHash(previous) },
    });
    store.uow.read((tx) => {
      const upgraded = getRoleVersion(tx, project, "reviewer");
      expect(upgraded?.version).toBe(2);
      expect(upgraded?.default_overlay).toBeUndefined();
      expect(upgraded?.allowed_tools).not.toContain("list_needs_you");
      expect(getRoleVersion(tx, project, "tester")?.version).toBe(1);
      expect(tx.human_actions.list(project)).toEqual([]);
    });
    expect(events(store, project, "host_role_upgraded")).toHaveLength(1);
    const notices = events(store, project, "host_role_upgrade_deferred").map(
      (e) => (e.payload as { notice: string }).notice,
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("tester");
    expect(notices[0]).toContain("本次部署改动了它的默认包");
  }));

const opsAssignment = (role_version: number): Assignment => ({
  id: "A-60" as never,
  scope: "standing",
  standing_mode: "ops",
  role_id: "pm",
  role_version,
  status: "active",
  runtime_state: "not_provisioned",
  machine_id: "local",
  runtime_ref: null,
  mcp_token_id: "fixture",
  created_at: "2026-01-01T00:00:00.000Z",
});

test("C-613 V-3026: a previous default plus project rules is proven by its exact hash and recomposed, with no human action", () =>
  withStore((store) => {
    store.createProject({ id: "cardigan" });
    const pack = defaultRoleDefinition("reviewer", launch);
    // The previous pack lacked get_check_log and still granted list_needs_you.
    const previous: RoleDefinition = {
      ...pack,
      instructions: "Older reviewer instructions",
      allowed_tools: [
        ...pack.allowed_tools.filter((t) => t !== "get_check_log"),
        "list_needs_you",
      ],
    };
    put(
      store,
      "cardigan",
      {
        ...previous,
        instructions: `${previous.instructions}\n\n${TIME_RULE}`,
        allowed_tools: [...previous.allowed_tools, "issue_instruction"],
      },
      1,
    );
    upgradeDeployedRoles(
      store,
      "cardigan",
      ["reviewer"],
      { reviewer: deploymentRolePolicyHash(previous) },
      new Set(["fixture"]),
    );
    store.uow.read((tx) => {
      const role = getRoleVersion(tx, "cardigan", "reviewer");
      expect(role?.version).toBe(2);
      expect(role?.instructions).toBe(`${pack.instructions}\n\n${TIME_RULE}`);
      expect(role?.allowed_tools).toEqual(
        expect.arrayContaining(["get_check_log", "issue_instruction"]),
      );
      expect(role?.allowed_tools).not.toContain("list_needs_you");
      expect(role?.default_overlay).toMatchObject({
        append_instructions: TIME_RULE,
        extra_tools: ["issue_instruction"],
        removed_tools: [],
      });
      expect(tx.human_actions.list("cardigan")).toEqual([]);
    });
    const [upgraded] = events(store, "cardigan", "host_role_upgraded");
    expect(upgraded?.payload).toMatchObject({
      to_version: 2,
      migrated: { overlay: { extra_tools: ["issue_instruction"] } },
    });
  }));

test("C-613 V-3026: a missing launch profile keeps the role and the standing session", () =>
  withStore((store, project) => {
    const rules: RoleOverlayRules = {
      base_role_id: "pm",
      append_instructions: "Local PM policy",
      extra_tools: [],
      removed_tools: [],
    };
    const v1 = olderOverlay("pm", rules, { instructions: "Earlier" });
    put(store, project, { ...v1, launch_profile_ref: "missing-profile" }, 1);
    store.uow.run((tx) => tx.assignments.put(project, opsAssignment(1)));
    upgradeDeployedRoles(store, project, ["pm"], {}, new Set(["fixture"]));
    store.uow.read((tx) => {
      expect(getRoleVersion(tx, project, "pm")?.version).toBe(1);
      expect(tx.assignments.get(project, "A-60" as never)?.status).toBe(
        "active",
      );
    });
    const [notice] = events(store, project, "host_role_upgrade_deferred");
    expect(
      (notice?.payload as { notice?: string } | undefined)?.notice,
    ).toContain("missing-profile");
  }));

test("C-613 V-3026: a migration that moves project text rotates the idle standing session", () =>
  withStore((store, project) => {
    const pack = defaultRoleDefinition("pm", launch);
    const [first, ...rest] = (pack.instructions ?? "").split("\n\n");
    put(
      store,
      project,
      {
        ...pack,
        instructions: [first, "Local PM policy", ...rest].join("\n\n"),
      },
      1,
    );
    store.uow.run((tx) => tx.assignments.put(project, opsAssignment(1)));
    const next = upgradeDeployedRoles(
      store,
      project,
      [],
      {},
      new Set(["fixture"]),
    );
    store.uow.read((tx) => {
      expect(getRoleVersion(tx, project, "pm")?.instructions).toBe(
        `${pack.instructions}\n\nLocal PM policy`,
      );
      expect(tx.assignments.get(project, "A-60" as never)?.status).toBe(
        "released",
      );
      expect(next && tx.assignments.get(project, next)?.role_version).toBe(2);
    });
    const [upgraded] = events(store, project, "host_role_upgraded");
    expect(upgraded?.payload).toMatchObject({ migrated: { moved: true } });
  }));

test("C-613 V-3026: a repeated project paragraph is kept every time it occurs", () => {
  const pack = defaultRoleDefinition("pm", launch);
  const [first, ...rest] = (pack.instructions ?? "").split("\n\n");
  const role = {
    ...pack,
    core_prompt: "",
    version: 1,
    instructions: [first, "Twice", "Twice", ...rest].join("\n\n"),
  } as Role;
  expect(deriveOverlayRules(role, "pm")).toMatchObject({
    rules: { append_instructions: "Twice\n\nTwice" },
    missing: [],
    moved: true,
  });
});
