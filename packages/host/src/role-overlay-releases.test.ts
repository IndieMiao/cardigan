import type { Card, Role, RoleDefinition, ToolName } from "@cardigan/domain";
import { defaultRoleDefinition } from "@cardigan/roles";
import { getRoleVersion, Store, writeRole } from "@cardigan/store";
import { afterEach, expect, test, vi } from "vitest";
import {
  deploymentRolePolicyHash,
  upgradeDeployedRoles,
} from "./deployment-roles.js";
import { syncProjectOverlayRoles } from "./role-overlay.js";
import {
  DEFAULTS_EVENT,
  knownDefault,
  knownDefaults,
  readOnOlderDefault,
  recordDefault,
} from "./role-provenance.js";

/**
 * C-613 Q-1197: successive releases, each with its own default pack. The
 * reviewer default of the running "release" is replaced here, everything
 * else is the real deployment pass.
 */
const release = vi.hoisted(() => ({
  reviewer: undefined as Partial<RoleDefinition> | undefined,
}));
vi.mock("@cardigan/roles", async (load) => {
  const real = await load<typeof import("@cardigan/roles")>();
  return {
    ...real,
    defaultRoleDefinition: ((id, launch) => {
      const role = real.defaultRoleDefinition(id, launch);
      return id === "reviewer" && release.reviewer
        ? { ...role, ...release.reviewer }
        : role;
    }) as typeof real.defaultRoleDefinition,
  };
});
afterEach(() => {
  release.reviewer = undefined;
});

const launch = { harness: "codex" as const, launch_profile_ref: "fixture" };
const LOCAL = "LOCAL：项目自己的审核约束。";
const valid = { profiles: () => new Set(["fixture"]) };
const broken = { profiles: () => new Set<string>() };

const real = defaultRoleDefinition("reviewer", launch);
const without = (tools: readonly ToolName[], drop: ToolName) =>
  tools.filter((t) => t !== drop);
/** P1 grants list_needs_you and lacks read_attachment. */
const P1: Partial<RoleDefinition> = {
  instructions: "Reviewer default, release 1",
  allowed_tools: [
    ...without(real.allowed_tools, "read_attachment"),
    "list_needs_you",
  ],
};
/** P2 withdraws list_needs_you. */
const P2: Partial<RoleDefinition> = {
  instructions: "Reviewer default, release 2",
  allowed_tools: without(real.allowed_tools, "read_attachment"),
};
/** P3 keeps it withdrawn and adds read_attachment. */
const P3: Partial<RoleDefinition> = {
  instructions: "Reviewer default, release 3",
  allowed_tools: [...real.allowed_tools],
};
const pack = (p: Partial<RoleDefinition>) => ({ ...real, ...p });

function withStore(run: (store: Store) => void) {
  const store = Store.open({ dbPath: ":memory:" });
  try {
    for (const id of ["sensen", "other", "cardigan"])
      store.createProject({ id });
    run(store);
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
const reviewer = (store: Store, project: string) =>
  store.uow.read((tx) => getRoleVersion(tx, project, "reviewer"));
const types = (store: Store, project: string, type: string) =>
  store.uow.read((tx) =>
    tx.events.listAfter(project, undefined, 0).filter((e) => e.type === type),
  );

test("C-613 V-3034:1 / V-3037:3 P1 → P2 deferred → P3: a tool P2 withdrew never becomes a project grant", () =>
  withStore((store) => {
    // Release 1: sensen's reviewer is the plain P1 default.
    release.reviewer = P1;
    put(store, "sensen", pack(P1), 1);
    syncProjectOverlayRoles(store, "sensen", valid);
    expect(reviewer(store, "sensen")?.version).toBe(1);
    // The project appends its rule and a tool of its own.
    put(
      store,
      "sensen",
      {
        ...pack(P1),
        instructions: `${P1.instructions}\n\n${LOCAL}`,
        allowed_tools: [...(P1.allowed_tools ?? []), "create_card"],
      },
      2,
    );
    // Release 2: the launch profile is broken; the role is deferred.
    release.reviewer = P2;
    syncProjectOverlayRoles(store, "sensen", broken);
    expect(reviewer(store, "sensen")?.version).toBe(2);
    expect(
      types(store, "sensen", "host_role_upgrade_deferred").map(
        (e) => (e.payload as { key: string }).key,
      ),
    ).toEqual([expect.stringMatching(/^missing-profile:reviewer:2:/u)]);
    // Release 3: P2 is now an older record too; it must not win.
    release.reviewer = P3;
    syncProjectOverlayRoles(store, "sensen", valid);
    syncProjectOverlayRoles(store, "sensen", valid);
    const role = reviewer(store, "sensen");
    expect(role?.version).toBe(3);
    expect(role?.instructions).toBe(`${P3.instructions}\n\n${LOCAL}`);
    expect(role?.allowed_tools).not.toContain("list_needs_you");
    expect(role?.allowed_tools).toEqual(
      expect.arrayContaining(["read_attachment", "create_card"]),
    );
    expect(role?.default_overlay).toMatchObject({
      append_instructions: LOCAL,
      extra_tools: ["create_card"],
      removed_tools: [],
      base_hash: deploymentRolePolicyHash(pack(P3)),
    });
    expect(store.uow.read((tx) => tx.human_actions.list("sensen"))).toEqual([]);
  }));

test("C-613 V-3037:2① cardigan takes the new default for a recorded older default after a deferral, with no human action", () =>
  withStore((store) => {
    release.reviewer = P1;
    put(store, "cardigan", pack(P1), 1);
    upgradeDeployedRoles(store, "cardigan", [], {}, new Set(["fixture"]));
    // Release 2 changed reviewer, but its launch profile is missing.
    release.reviewer = P2;
    upgradeDeployedRoles(
      store,
      "cardigan",
      ["reviewer"],
      { reviewer: deploymentRolePolicyHash(pack(P1)) },
      new Set(),
    );
    expect(reviewer(store, "cardigan")?.version).toBe(1);
    // The retry lists no change and the supervisor now reports P2 itself.
    upgradeDeployedRoles(
      store,
      "cardigan",
      [],
      { reviewer: deploymentRolePolicyHash(pack(P2)) },
      new Set(["fixture"]),
    );
    const role = reviewer(store, "cardigan");
    expect(role?.version).toBe(2);
    expect(role?.default_overlay).toBeUndefined();
    expect(deploymentRolePolicyHash(role as Role)).toBe(
      deploymentRolePolicyHash(pack(P2)),
    );
    expect(role?.allowed_tools).not.toContain("list_needs_you");
    expect(store.uow.read((tx) => tx.human_actions.list("cardigan"))).toEqual(
      [],
    );
  }));

test("C-613 records are read from the project's own stream only: other projects, cards and non-system writers are ignored", () =>
  withStore((store) => {
    const at = "2026-01-01T00:00:00.000Z";
    store.uow.run((tx) => {
      tx.cards.put("sensen", {
        id: "C-1",
        project_id: "sensen",
        title: "Card",
        goal: "Card",
        acceptance_criteria: ["Card"],
        source: { kind: "quote", text: "Fixture" },
        base_branch: "main",
        status: "in_progress",
        priority: 0,
        template: "dev",
        merge_policy: "confirm",
        out_of_scope: [],
        related_cards: [],
        created_by: "human",
        created_at: at,
      } as unknown as Card);
      // A genuine record, but in another project.
      recordDefault(tx, "other", "reviewer", pack(P1), "pack", at);
      // Forged records in sensen's stream.
      const forge = (
        actor: { kind: "system" | "human"; project_id: string },
        card_id?: string,
      ) =>
        tx.events.append("sensen", {
          id: tx.ids.nextEventId(),
          seq: tx.ids.nextEventSequence("sensen"),
          type: DEFAULTS_EVENT,
          actor: actor as never,
          ...(card_id ? { card_id: card_id as never } : {}),
          created_at: at,
          payload: JSON.parse(
            JSON.stringify({
              role_id: "reviewer",
              source: "pack",
              known: knownDefault(pack(P1)),
            }),
          ),
        });
      forge({ kind: "human", project_id: "sensen" });
      forge({ kind: "system", project_id: "other" });
      forge({ kind: "system", project_id: "sensen" }, "C-1");
    });
    expect(
      store.uow.read((tx) => knownDefaults(tx, "sensen").get("reviewer")),
    ).toBeUndefined();
    const custom = {
      ...pack(P1),
      instructions: `${P1.instructions}\n\n${LOCAL}`,
    };
    for (const project of ["sensen", "other"]) put(store, project, custom, 1);
    release.reviewer = P3;
    syncProjectOverlayRoles(store, "sensen", valid);
    syncProjectOverlayRoles(store, "other", valid);
    // Only the project that recorded P1 itself migrates.
    expect(reviewer(store, "sensen")?.version).toBe(1);
    expect(reviewer(store, "other")).toMatchObject({
      version: 2,
      default_overlay: { append_instructions: LOCAL },
    });
  }));

test("C-613 among several older records the reading with the least extra content wins; a tie goes to the newer record", () => {
  const base = without(real.allowed_tools, "read_attachment");
  const text = "Shared reviewer default";
  const k = (tools: readonly ToolName[]) =>
    knownDefault({ ...real, instructions: text, allowed_tools: [...tools] });
  const withY = k([...base, "list_needs_you"]);
  const withZ = k([...base, "create_card"]);
  const plain = k(base);
  const role = {
    ...real,
    core_prompt: "",
    version: 1,
    instructions: `${text}\n\n${LOCAL}`,
    allowed_tools: [...base],
  } as Role;
  const current = pack(P3);
  // Fewest items wins over recency: plain needs no removal.
  expect(
    readOnOlderDefault(role, current, [plain, withY])?.known.policy_hash,
  ).toBe(plain.policy_hash);
  expect(
    readOnOlderDefault(role, current, [withY, plain])?.known.policy_hash,
  ).toBe(plain.policy_hash);
  // An equal count: the newer record (later in the list) wins, every time.
  const tie = readOnOlderDefault(role, current, [withY, withZ]);
  expect(tie?.known.policy_hash).toBe(withZ.policy_hash);
  expect(tie?.rules.removed_tools).toEqual(["create_card"]);
  expect(readOnOlderDefault(role, current, [withY, withZ])).toEqual(tie);
  expect(
    readOnOlderDefault(role, current, [withZ, withY])?.rules.removed_tools,
  ).toEqual(["list_needs_you"]);
});

test("C-613 a rerun of one release with several records reaches the same version and writes nothing more", () =>
  withStore((store) => {
    const at = "2026-01-01T00:00:00.000Z";
    store.uow.run((tx) => {
      recordDefault(tx, "sensen", "reviewer", pack(P1), "pack", at);
      recordDefault(tx, "sensen", "reviewer", pack(P2), "pack", at);
    });
    put(
      store,
      "sensen",
      { ...pack(P1), instructions: `${P1.instructions}\n\n${LOCAL}` },
      1,
    );
    release.reviewer = P3;
    syncProjectOverlayRoles(store, "sensen", valid);
    const first = store.uow.read((tx) =>
      tx.events.listAfter("sensen", undefined, 0),
    );
    syncProjectOverlayRoles(store, "sensen", valid);
    expect(
      store.uow.read((tx) => tx.events.listAfter("sensen", undefined, 0)),
    ).toEqual(first);
    expect(reviewer(store, "sensen")).toMatchObject({
      version: 2,
      default_overlay: { append_instructions: LOCAL, extra_tools: [] },
    });
    expect(reviewer(store, "sensen")?.allowed_tools).not.toContain(
      "list_needs_you",
    );
  }));

/** A pre-C-613 publication receipt: its matched entry seeds a hash-only record. */
function seedReceipt(store: Store, project: string, role: RoleDefinition) {
  store.uow.run((tx) =>
    tx.events.append(project, {
      id: tx.ids.nextEventId(),
      seq: tx.ids.nextEventSequence(project),
      type: "host_role_pack_published",
      actor: { kind: "system", project_id: project },
      created_at: "2026-01-01T00:00:00.000Z",
      payload: {
        pack_hash: "older-pack",
        roles: {
          reviewer: {
            version: 1,
            policy_hash: deploymentRolePolicyHash(role),
            disposition: "matched",
          },
        },
      },
    }),
  );
}
const TITLE = "项目的报表标题";
/** Q-1204 fixtures: R1's second paragraph and list_needs_you are withdrawn by R2. */
const R1: Partial<RoleDefinition> = {
  instructions: "单页报表\n\n已废弃的报表格式",
  allowed_tools: P1.allowed_tools,
};
const R2: Partial<RoleDefinition> = {
  instructions: "单页报表",
  allowed_tools: P2.allowed_tools,
};
const R3: Partial<RoleDefinition> = {
  instructions: "两页报表",
  allowed_tools: P3.allowed_tools,
};
const stream = (store: Store) =>
  store.uow.read((tx) => tx.events.listAfter("sensen", undefined, 0));

test("C-613 V-3073:2 ②-a/②-b an exact hit on a hash-only default is remembered with its content, so a deferral and a later project edit never keep what the pack withdrew", () =>
  withStore((store) => {
    seedReceipt(store, "sensen", pack(R1));
    put(store, "sensen", pack(R1), 1);
    // Release 2 withdraws a paragraph and a tool; the profile is broken.
    release.reviewer = R2;
    syncProjectOverlayRoles(store, "sensen", broken);
    expect(reviewer(store, "sensen")?.version).toBe(1);
    expect(
      store.uow.read((tx) => knownDefaults(tx, "sensen").get("reviewer")?.[0]),
    ).toEqual(knownDefault(pack(R1)));
    // The project then appends its own paragraph to v1.
    put(
      store,
      "sensen",
      { ...pack(R1), instructions: `${R1.instructions}\n\n${TITLE}` },
      2,
    );
    release.reviewer = R3;
    syncProjectOverlayRoles(store, "sensen", valid);
    const first = stream(store);
    // ②-d: a rerun of the release writes nothing more.
    syncProjectOverlayRoles(store, "sensen", valid);
    expect(stream(store)).toEqual(first);
    const role = reviewer(store, "sensen");
    expect(role?.version).toBe(3);
    expect(role?.instructions).toBe(`${R3.instructions}\n\n${TITLE}`);
    expect(role?.allowed_tools).not.toContain("list_needs_you");
    expect(role?.default_overlay).toMatchObject({
      append_instructions: TITLE,
      extra_tools: [],
      removed_tools: [],
    });
    expect(store.uow.read((tx) => tx.human_actions.list("sensen"))).toEqual([]);
  }));

test("C-613 V-3073:2 ②-c a hash-only default the role never equalled is proven before choosing, so a newer content record cannot claim the withdrawn content", () =>
  withStore((store) => {
    const at = "2026-01-01T00:00:00.000Z";
    seedReceipt(store, "sensen", pack(R1));
    store.uow.run((tx) =>
      recordDefault(tx, "sensen", "reviewer", pack(R2), "pack", at),
    );
    // The role was R1 plus a project paragraph from the start.
    put(
      store,
      "sensen",
      { ...pack(R1), instructions: `${R1.instructions}\n\n${LOCAL}` },
      1,
    );
    release.reviewer = R3;
    syncProjectOverlayRoles(store, "sensen", valid);
    const first = stream(store);
    syncProjectOverlayRoles(store, "sensen", valid);
    expect(stream(store)).toEqual(first);
    const role = reviewer(store, "sensen");
    expect(role?.version).toBe(2);
    expect(role?.instructions).toBe(`${R3.instructions}\n\n${LOCAL}`);
    expect(role?.allowed_tools).not.toContain("list_needs_you");
    expect(role?.default_overlay).toMatchObject({
      append_instructions: LOCAL,
      extra_tools: [],
      removed_tools: [],
    });
    // The proof joined the seed with its content.
    expect(
      store.uow.read((tx) => knownDefaults(tx, "sensen").get("reviewer")),
    ).toEqual(
      expect.arrayContaining([knownDefault(pack(R1)), knownDefault(pack(R2))]),
    );
  }));
