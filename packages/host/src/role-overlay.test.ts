import {
  type Assignment,
  composeRoleOverlay,
  type Role,
  type RoleDefinition,
  type RoleOverlayRules,
  type Run,
} from "@cardigan/domain";
import { defaultRoleDefinition } from "@cardigan/roles";
import { getRoleVersion, Store, writeRole } from "@cardigan/store";
import { expect, test } from "vitest";
import {
  deploymentRolePolicyHash,
  idleRolePolicies,
  rotateIdleDeployedRoles,
  upgradeDeployedRoles,
} from "./deployment-roles.js";
import {
  composeOverlaySource,
  deriveOverlayRules,
  syncProjectOverlayRoles,
} from "./role-overlay.js";
import { weakRolePolicyHash } from "./role-policy-hash.js";
import { knownDefaults, recordDefault } from "./role-provenance.js";

const launch = { harness: "codex" as const, launch_profile_ref: "fixture" };
const TIME_RULE = "时间点约束：只认交付时刻的基线和证据。";
/** A deployment whose launch profile is valid. */
const STABLE = { profiles: () => new Set(["fixture"]) };

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
const notices = (store: Store, project: string) =>
  events(store, project, "host_role_upgrade_deferred").map(
    (e) => (e.payload as { notice: string }).notice,
  );
/** An earlier release recorded this default for the project. */
function record(
  store: Store,
  project: string,
  id: string,
  role: RoleDefinition,
) {
  store.uow.run((tx) =>
    recordDefault(tx, project, id, role, "pack", "2026-01-01T00:00:00.000Z"),
  );
}
/** A pre-C-613 publication receipt: its matched entries seed hash-only records. */
function seedReceipt(
  store: Store,
  project: string,
  hashes: Record<string, string>,
) {
  store.uow.run((tx) =>
    tx.events.append(project, {
      id: tx.ids.nextEventId(),
      seq: tx.ids.nextEventSequence(project),
      type: "host_role_pack_published",
      actor: { kind: "system", project_id: project },
      created_at: "2026-01-01T00:00:00.000Z",
      payload: {
        pack_hash: "older-pack",
        roles: Object.fromEntries(
          Object.entries(hashes).map(([id, policy_hash]) => [
            id,
            { version: 1, policy_hash, disposition: "matched" },
          ]),
        ),
      },
    }),
  );
}
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

test("C-613 a customised role built on a recorded older default migrates once, keeping its rules", () =>
  withStore((store, project) => {
    const pack = defaultRoleDefinition("reviewer", launch);
    const older = { ...pack, instructions: "Older reviewer text" };
    const before: RoleDefinition = {
      ...older,
      instructions: `${older.instructions}\n\n${TIME_RULE}`,
      allowed_tools: [...pack.allowed_tools, "list_needs_you"],
    };
    put(store, project, before, 1);
    // Nothing older is recorded yet: the extra content is not guessed.
    syncProjectOverlayRoles(store, project, STABLE);
    expect(
      store.uow.read((tx) => getRoleVersion(tx, project, "reviewer")?.version),
    ).toBe(1);
    expect(notices(store, project)).toEqual([
      expect.stringContaining("没有可核对的更早默认包记录"),
    ]);
    record(store, project, "reviewer", older);
    syncProjectOverlayRoles(store, project, STABLE);
    syncProjectOverlayRoles(store, project, STABLE);
    const after = store.uow.read((tx) =>
      getRoleVersion(tx, project, "reviewer"),
    );
    expect(after?.version).toBe(2);
    expect(after?.instructions).toBe(`${pack.instructions}\n\n${TIME_RULE}`);
    expect(after?.default_overlay).toMatchObject({
      base_role_id: "reviewer",
      append_instructions: TIME_RULE,
      extra_tools: ["list_needs_you"],
      removed_tools: [],
      base_hash: deploymentRolePolicyHash(pack),
      composed_hash: deploymentRolePolicyHash(after as Role),
    });
    const upgraded = events(store, project, "host_role_upgraded");
    expect(upgraded).toHaveLength(1);
    expect(upgraded[0]?.payload).toMatchObject({
      role_id: "reviewer",
      from_version: 1,
      to_version: 2,
      migrated: {
        before_hash: deploymentRolePolicyHash(before),
        after_hash: deploymentRolePolicyHash(after as Role),
        overlay: { appended_paragraphs: 1, extra_tools: ["list_needs_you"] },
      },
    });
    expect(store.uow.read((tx) => tx.human_actions.list(project))).toEqual([]);
  }));

test("C-613 this release's own default is no older evidence, and a rerun reaches the same notice", () =>
  withStore((store, project) => {
    const pack = defaultRoleDefinition("reviewer", launch);
    put(
      store,
      project,
      { ...pack, instructions: `${pack.instructions}\n\n${TIME_RULE}` },
      1,
    );
    syncProjectOverlayRoles(store, project, STABLE);
    syncProjectOverlayRoles(store, project, STABLE);
    expect(
      store.uow.read((tx) => getRoleVersion(tx, project, "reviewer")?.version),
    ).toBe(1);
    expect(notices(store, project)).toEqual([
      expect.stringContaining("没有可核对的更早默认包记录"),
    ]);
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

test("C-613 other projects upgrade a recorded older default without the supervisor, and never guess an unrecorded one", () =>
  withStore((store, project) => {
    const reviewer = defaultRoleDefinition("reviewer", launch);
    const tester = defaultRoleDefinition("tester", launch);
    const previous = {
      ...reviewer,
      allowed_tools: [...reviewer.allowed_tools, "list_needs_you" as const],
    };
    record(store, project, "reviewer", previous);
    put(store, project, previous, 1);
    // Looks like default + a project tool, but no older tester is recorded.
    put(
      store,
      project,
      {
        ...tester,
        allowed_tools: [...tester.allowed_tools, "list_needs_you" as const],
      },
      1,
    );
    syncProjectOverlayRoles(store, project, STABLE);
    syncProjectOverlayRoles(store, project, STABLE);
    store.uow.read((tx) => {
      const upgraded = getRoleVersion(tx, project, "reviewer");
      expect(upgraded?.version).toBe(2);
      expect(upgraded?.default_overlay).toBeUndefined();
      expect(upgraded?.allowed_tools).not.toContain("list_needs_you");
      expect(getRoleVersion(tx, project, "tester")?.version).toBe(1);
      expect(tx.human_actions.list(project)).toEqual([]);
    });
    expect(events(store, project, "host_role_upgraded")).toHaveLength(1);
    expect(notices(store, project)).toEqual([
      expect.stringContaining("tester"),
    ]);
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

test("C-613 V-3026: an older default known only by a receipt hash is proven, recomposed and remembered", () =>
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
    seedReceipt(store, "cardigan", {
      reviewer: deploymentRolePolicyHash(previous),
    });
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
    upgradeDeployedRoles(store, "cardigan", [], {}, new Set(["fixture"]));
    upgradeDeployedRoles(store, "cardigan", [], {}, new Set(["fixture"]));
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
      // The proof joined the record with its content.
      expect(knownDefaults(tx, "cardigan").get("reviewer")?.[0]).toMatchObject({
        policy_hash: deploymentRolePolicyHash(previous),
        content: { allowed_tools: previous.allowed_tools },
      });
    });
    expect(events(store, "cardigan", "host_role_upgraded")).toHaveLength(1);
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

test("C-613 V-3026: project text interleaved in a recorded older default moves after the new default and rotates the idle session", () =>
  withStore((store, project) => {
    const pack = defaultRoleDefinition("pm", launch);
    const older = { ...pack, instructions: "Older first\n\nOlder second" };
    record(store, project, "pm", older);
    put(
      store,
      project,
      {
        ...older,
        instructions: "Older first\n\nLocal PM policy\n\nOlder second",
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

test("C-613 V-3028: a proof made during a deferral is reused by the retry instead of guessing again", () =>
  withStore((store, project) => {
    const pack = defaultRoleDefinition("reviewer", launch);
    const previous = { ...pack, instructions: "Older reviewer text" };
    seedReceipt(store, project, {
      reviewer: deploymentRolePolicyHash(previous),
    });
    put(
      store,
      project,
      { ...previous, instructions: `Older reviewer text\n\n${TIME_RULE}` },
      1,
    );
    syncProjectOverlayRoles(store, project, { profiles: () => new Set() });
    expect(
      store.uow.read((tx) => getRoleVersion(tx, project, "reviewer")?.version),
    ).toBe(1);
    expect(
      events(store, project, "host_role_defaults_recorded").filter(
        (e) => (e.payload as { source?: string }).source === "proof",
      ),
    ).toHaveLength(1);
    syncProjectOverlayRoles(store, project, STABLE);
    const role = store.uow.read((tx) =>
      getRoleVersion(tx, project, "reviewer"),
    );
    expect(role?.version).toBe(2);
    expect(role?.default_overlay).toMatchObject({
      append_instructions: TIME_RULE,
      extra_tools: [],
    });
  }));

test("C-613 V-3028: a tool the project pre-added before the pack adopted it now follows the default, and other new tools arrive", () =>
  withStore((store) => {
    store.createProject({ id: "cardigan" });
    const pack = defaultRoleDefinition("reviewer", launch);
    const previous: RoleDefinition = {
      ...pack,
      instructions: "Older reviewer instructions",
      allowed_tools: pack.allowed_tools.filter(
        (t) => t !== "get_check_log" && t !== "read_attachment",
      ),
    };
    seedReceipt(store, "cardigan", {
      reviewer: deploymentRolePolicyHash(previous),
    });
    put(
      store,
      "cardigan",
      {
        ...previous,
        instructions: `${previous.instructions}\n\n${TIME_RULE}`,
        allowed_tools: [...previous.allowed_tools, "get_check_log"],
      },
      1,
    );
    upgradeDeployedRoles(store, "cardigan", [], {}, new Set(["fixture"]));
    store.uow.read((tx) => {
      const role = getRoleVersion(tx, "cardigan", "reviewer");
      expect(role?.version).toBe(2);
      expect(role?.allowed_tools).toEqual(
        expect.arrayContaining(["get_check_log", "read_attachment"]),
      );
      expect(role?.default_overlay).toMatchObject({
        append_instructions: TIME_RULE,
        extra_tools: [],
      });
      expect(tx.human_actions.list("cardigan")).toEqual([]);
    });
  }));

test("C-613 V-3037:2② a plain older default with machine requirements upgrades from the record; a weak supervisor fingerprint alone proves nothing and opens no human action", () =>
  withStore((store) => {
    store.createProject({ id: "cardigan" });
    const pack = defaultRoleDefinition("frontend_engineer", launch);
    const previous = {
      ...pack,
      allowed_tools: pack.allowed_tools.filter((t) => t !== "get_check_log"),
    };
    put(store, "cardigan", previous, 1);
    const deploy = () =>
      upgradeDeployedRoles(
        store,
        "cardigan",
        ["frontend_engineer"],
        { frontend_engineer: weakRolePolicyHash(previous) },
        new Set(["fixture"]),
      );
    deploy();
    store.uow.read((tx) => {
      expect(getRoleVersion(tx, "cardigan", "frontend_engineer")?.version).toBe(
        1,
      );
      expect(tx.human_actions.list("cardigan")).toEqual([]);
    });
    expect(notices(store, "cardigan")).toEqual([
      expect.stringContaining("没有可核对的已记录默认包"),
    ]);
    record(store, "cardigan", "frontend_engineer", previous);
    deploy();
    store.uow.read((tx) => {
      const role = getRoleVersion(tx, "cardigan", "frontend_engineer");
      expect(role?.version).toBe(2);
      expect(role?.allowed_tools).toContain("get_check_log");
      expect(role?.required_capabilities).toEqual(["browser.chromium"]);
      expect(tx.human_actions.list("cardigan")).toEqual([]);
    });
  }));

function audit(store: Store, project: string, payload: object) {
  store.uow.run((tx) =>
    tx.events.append(project, {
      id: tx.ids.nextEventId(),
      seq: tx.ids.nextEventSequence(project),
      type: "host_role_upgraded",
      actor: { kind: "system", project_id: project },
      created_at: "2026-01-01T00:00:00.000Z",
      payload: { role_id: "pm", ...payload },
    }),
  );
}
const status = (store: Store, project: string) =>
  store.uow.read((tx) => tx.assignments.get(project, "A-60" as never)?.status);

test("C-613 V-3037:1 a version edited by hand after an audited upgrade is not rotated to", () =>
  withStore((store, project) => {
    const pack = defaultRoleDefinition("pm", launch);
    put(store, project, { ...pack, instructions: "Earlier" }, 1);
    put(store, project, pack, 2);
    audit(store, project, { from_version: 1, to_version: 2 });
    store.uow.run((tx) => tx.assignments.put(project, opsAssignment(1)));
    // A person edits the text, or the launch profile, after v2.
    put(store, project, { ...pack, instructions: "Hand edit" }, 3);
    expect(
      rotateIdleDeployedRoles(
        store,
        project,
        undefined,
        () => new Set(["fixture", "other"]),
      ),
    ).toBeUndefined();
    expect(status(store, project)).toBe("active");
    put(store, project, { ...pack, launch_profile_ref: "other" }, 4);
    upgradeDeployedRoles(store, project, [], {}, new Set(["fixture", "other"]));
    expect(status(store, project)).toBe("active");
    expect(events(store, project, "standing_pm_rotated")).toEqual([]);
  }));

test("C-613 V-3037:1 a system metadata-only version carries the audit and rotates; an invalid profile keeps the session", () =>
  withStore((store, project) => {
    const pack = defaultRoleDefinition("pm", launch);
    // The older default lacked get_check_log; v2 (audited) took it with the
    // project's rule, so v2 equals the new default plus that rule.
    const older = {
      ...pack,
      allowed_tools: pack.allowed_tools.filter((t) => t !== "get_check_log"),
    };
    record(store, project, "pm", older);
    put(store, project, { ...pack, instructions: "Earlier" }, 1);
    put(
      store,
      project,
      { ...pack, instructions: `${pack.instructions}\n\nLocal PM policy` },
      2,
    );
    audit(store, project, { from_version: 1, to_version: 2 });
    store.uow.run((tx) => tx.assignments.put(project, opsAssignment(1)));
    // The deployment pass reads v2 as the older default plus the rule: the
    // new version only adds overlay metadata.
    syncProjectOverlayRoles(store, project, STABLE);
    const [carried] = events(store, project, "host_role_upgraded").slice(1);
    expect(carried?.payload).toMatchObject({
      from_version: 2,
      to_version: 3,
      metadata_only: true,
    });
    expect(events(store, project, "host_role_overlay_migrated")).toEqual([]);
    // In a deployment the profile is checked; a broken one keeps the session.
    rotateIdleDeployedRoles(store, project, undefined, () => new Set());
    expect(status(store, project)).toBe("active");
    expect(notices(store, project)).toEqual([
      expect.stringContaining("不存在或未通过校验"),
    ]);
    // V-3073:1 ①-a: the production patrol passes no profiles; the unchanged
    // profile name is no recovery, so the session stays and no alert repeats.
    rotateIdleDeployedRoles(store, project);
    rotateIdleDeployedRoles(store, project);
    expect(status(store, project)).toBe("active");
    expect(notices(store, project)).toHaveLength(1);
    expect(launchChecks(store, project)).toEqual([
      { role_id: "pm", role_version: 3, profile: "fixture", valid: false },
    ]);
    // ①-b: the next deployment finds the profile valid and the session idle:
    // it rotates there, once.
    const next = rotateIdleDeployedRoles(
      store,
      project,
      undefined,
      () => new Set(["fixture"]),
    );
    expect(status(store, project)).toBe("released");
    expect(
      store.uow.read(
        (tx) => next && tx.assignments.get(project, next)?.role_version,
      ),
    ).toBe(3);
    rotateIdleDeployedRoles(store, project);
    rotateIdleDeployedRoles(
      store,
      project,
      undefined,
      () => new Set(["fixture"]),
    );
    expect(events(store, project, "standing_pm_rotated")).toHaveLength(1);
    expect(launchChecks(store, project).map((c) => c.valid)).toEqual([
      false,
      true,
    ]);
    expect(notices(store, project)).toHaveLength(1);
  }));

const launchChecks = (store: Store, project: string) =>
  events(store, project, "host_role_launch_checked").map((e) => e.payload);
const busy = (store: Store, project: string, status: Run["status"]) =>
  store.uow.run((tx) =>
    tx.runs.put(project, {
      id: "R-60" as never,
      assignment_id: "A-60" as never,
      trigger_event_id: "00000000000000000000000001" as never,
      kind: "initial",
      status,
      role_version: 1,
      model: "fixture",
      agent_cli_version: "1",
      outcome: status === "completed" ? "completed" : null,
      summary: "",
    }),
  );

test("C-613 V-3073:1 ①-c/①-d a profile found valid while the session is busy rotates on a later patrol; another role rotates meanwhile", () =>
  withStore((store, project) => {
    const pm = defaultRoleDefinition("pm", launch);
    put(store, project, { ...pm, instructions: "Earlier" }, 1);
    put(store, project, pm, 2);
    audit(store, project, { from_version: 1, to_version: 2 });
    // ①-d: another standing role on its own, valid launch profile.
    const reviewer = defaultRoleDefinition("reviewer", {
      ...launch,
      launch_profile_ref: "other",
    });
    put(store, project, { ...reviewer, instructions: "Earlier" }, 1);
    put(store, project, reviewer, 2);
    audit(store, project, {
      role_id: "reviewer",
      from_version: 1,
      to_version: 2,
    });
    store.uow.run((tx) => {
      tx.assignments.put(project, opsAssignment(1));
      tx.assignments.put(project, {
        ...opsAssignment(1),
        id: "A-61" as never,
        role_id: "reviewer",
        standing_mode: undefined,
      });
    });
    const other = () =>
      store.uow.read((tx) => tx.assignments.get(project, "A-61" as never));
    // pm's profile is broken in this deployment; reviewer's is fine.
    rotateIdleDeployedRoles(
      store,
      project,
      undefined,
      () => new Set(["other"]),
    );
    rotateIdleDeployedRoles(store, project);
    expect(status(store, project)).toBe("active");
    expect(other()?.status).toBe("released");
    expect(events(store, project, "standing_role_rotated")).toHaveLength(1);
    // ①-c: the profile is restored, but pm is busy during the deployment.
    busy(store, project, "running");
    rotateIdleDeployedRoles(
      store,
      project,
      undefined,
      () => new Set(["fixture", "other"]),
    );
    rotateIdleDeployedRoles(store, project);
    expect(status(store, project)).toBe("active");
    expect(
      launchChecks(store, project).filter((c) => c.role_id === "pm"),
    ).toEqual([
      { role_id: "pm", role_version: 2, profile: "fixture", valid: false },
      { role_id: "pm", role_version: 2, profile: "fixture", valid: true },
    ]);
    // Once idle, a patrol reads the recorded "valid" and rotates once.
    busy(store, project, "completed");
    rotateIdleDeployedRoles(store, project);
    rotateIdleDeployedRoles(store, project);
    expect(status(store, project)).toBe("released");
    expect(events(store, project, "standing_pm_rotated")).toHaveLength(1);
    expect(events(store, project, "standing_role_rotated")).toHaveLength(1);
    expect(notices(store, project)).toEqual([
      expect.stringContaining("常驻角色 pm v2 的启动配置 fixture 不存在"),
    ]);
  }));

test("C-613 V-3037:1 between deployments a changed launch profile waits for the next deployment", () =>
  withStore((store, project) => {
    const pack = defaultRoleDefinition("pm", launch);
    put(store, project, { ...pack, instructions: "Earlier" }, 1);
    put(store, project, { ...pack, launch_profile_ref: "other" }, 2);
    audit(store, project, { from_version: 1, to_version: 2 });
    store.uow.run((tx) => tx.assignments.put(project, opsAssignment(1)));
    rotateIdleDeployedRoles(store, project);
    expect(status(store, project)).toBe("active");
    expect(notices(store, project)).toEqual([
      expect.stringContaining("下次部署核对后再轮换"),
    ]);
    rotateIdleDeployedRoles(
      store,
      project,
      undefined,
      () => new Set(["other"]),
    );
    expect(status(store, project)).toBe("released");
  }));
