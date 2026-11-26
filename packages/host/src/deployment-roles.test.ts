import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  type Assignment,
  type RoleDefinition,
  upgradeRole,
} from "@cardigan/domain";
import { DEFAULT_ROLE_KINDS, defaultRoleDefinition } from "@cardigan/roles";
import {
  getRoleVersion,
  listRoleVersions,
  persistRoleEffect,
  Store,
  writeRole,
} from "@cardigan/store";
import { expect, test } from "vitest";
import {
  parseRolePackSnapshot,
  ROLE_PACK_SNAPSHOT_SCRIPT,
} from "./deployment-node.js";
import {
  deploymentRolePolicyHash,
  rotateIdleDeployedRoles,
  upgradeDeployedRoles,
} from "./deployment-roles.js";
import { recordDefault } from "./role-provenance.js";

const now = "2026-01-01T00:00:00.000Z";

test.each([
  "manual",
  "unrecorded",
  "missing",
  "launch_only",
  "already_default",
] as const)(
  "deployment preserves hand-written rules and only compares managed policy fields: %s",
  async (mode) => {
    const dataDir = await mkdtemp(join(tmpdir(), "cg-role-manual-"));
    const store = Store.open({ dataDir });
    const project = "fixture";
    try {
      store.createProject({ id: project });
      const nextDefault = defaultRoleDefinition("host_ops", {
        harness: "codex",
        launch_profile_ref: "fixture",
      });
      const oldDefault = {
        ...nextDefault,
        instructions: "Earlier default instructions",
      };
      const manual =
        mode === "manual" || mode === "unrecorded" || mode === "missing";
      const current =
        mode === "already_default"
          ? nextDefault
          : {
              ...oldDefault,
              instructions: manual
                ? `${oldDefault.instructions}\nManually retained upstream-outage rule`
                : oldDefault.instructions,
              // Project launch fields and tool order are deliberately not default-pack policy changes.
              harness: "pi" as const,
              launch_profile_ref: "project-host-ops",
              display_name: "Project operations",
              abilities: ["project-specialty"],
              required_machine_tags: ["project-tag"],
              allowed_tools: [...oldDefault.allowed_tools].reverse(),
            };
      const a: Assignment = {
        id: "A-50" as never,
        scope: "standing",
        role_id: "host_ops",
        role_version: 2,
        status: "active",
        runtime_state: "not_provisioned",
        machine_id: "local",
        runtime_ref: null,
        mcp_token_id: "fixture",
        created_at: "2026-01-01T00:00:00.000Z",
      };
      const token = store.uow.run((tx) => {
        writeRole(
          tx,
          project,
          { ...oldDefault, core_prompt: "", version: 1 },
          { mode: "add" },
        );
        writeRole(
          tx,
          project,
          { ...current, core_prompt: "", version: 2 },
          { mode: "update" },
        );
        tx.assignments.put(project, a);
        // C-603/C-613: an earlier deployment recorded its default; only then
        // is a mismatch a manual edit for a person to review.
        if (mode === "manual" || mode === "launch_only")
          recordDefault(tx, project, "host_ops", oldDefault, "pack", now);
        return tx.issueToken({
          project_id: project,
          assignment_id: a.id,
          role: { role_version: 2, allowed_tools: current.allowed_tools },
        });
      });
      const baseline =
        mode === "missing"
          ? {}
          : { host_ops: deploymentRolePolicyHash(oldDefault) };
      const before = store.uow.read((tx) =>
        getRoleVersion(tx, project, "host_ops"),
      );
      upgradeDeployedRoles(
        store,
        project,
        ["host_ops"],
        baseline,
        new Set(["fixture", "project-host-ops"]),
      );
      upgradeDeployedRoles(
        store,
        project,
        ["host_ops"],
        baseline,
        new Set(["fixture", "project-host-ops"]),
      );
      store.uow.read((tx) => {
        const after = getRoleVersion(tx, project, "host_ops");
        if (mode === "launch_only") {
          expect(after).toMatchObject({
            version: 3,
            instructions: nextDefault.instructions,
            harness: "pi",
            launch_profile_ref: "project-host-ops",
            display_name: "Project operations",
            abilities: ["project-specialty"],
            required_machine_tags: ["project-tag"],
          });
        } else expect(after).toEqual(before);
        if (mode === "launch_only")
          expect(tx.assignments.get(project, a.id)?.status).toBe("released");
        else expect(tx.assignments.get(project, a.id)).toEqual(a);
        const actions = tx.human_actions.list(project);
        expect(actions).toHaveLength(mode === "manual" ? 1 : 0);
        if (mode === "missing" || mode === "unrecorded")
          expect(
            tx.events
              .listAfter(project, undefined, 0)
              .filter((e) => e.type === "host_role_upgrade_deferred")
              .map((e) => (e.payload as { notice: string }).notice),
          ).toEqual([expect.stringContaining("没有可核对的已记录默认包")]);
        if (mode === "manual") {
          expect(actions[0]).toMatchObject({ status: "open", triage: "human" });
          expect(actions[0]?.instructions).toContain(
            mode === "manual"
              ? "当前版本有手工改动"
              : "缺少上一次已部署默认版本",
          );
          expect(actions[0]?.instructions).toContain("--dry-run");
          expect(actions[0]?.instructions).toContain('"field":"instructions"');
          const events = tx.events
            .listAfter(project, undefined, 0)
            .map((e) => e.type);
          for (const event of [
            "role_updated",
            "host_role_upgraded",
            "standing_pm_rotated",
          ])
            expect(events).not.toContain(event);
        }
      });
      if (mode === "manual") {
        store.uow.run((tx) =>
          writeRole(
            tx,
            project,
            { ...nextDefault, core_prompt: "", version: 3 },
            { mode: "update" },
          ),
        );
        rotateIdleDeployedRoles(store, project);
        rotateIdleDeployedRoles(store, project);
        store.uow.read((tx) => {
          const [action] = tx.human_actions.list(project);
          expect(action).toMatchObject({
            status: "done",
            result: { text: expect.stringContaining("host_ops") },
          });
          expect(
            tx.events
              .listAfter(project, undefined, 0)
              .filter((e) => e.type === "human_action_completed"),
          ).toMatchObject([
            {
              actor: { kind: "system" },
              payload: {
                human_action_id: action?.id,
                result: action?.result?.text,
              },
            },
          ]);
        });
      }
      expect(!!store.verifyToken(token.token)).toBe(mode !== "launch_only");
    } finally {
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);

test.each(["safe", "widening", "manual"] as const)(
  "deployment role upgrade and PM rotation: %s",
  async (mode) => {
    const widening = mode === "widening";
    const blocked = mode === "manual";
    const dataDir = await mkdtemp(join(tmpdir(), "cg-deployment-roles-"));
    const store = Store.open({ dataDir });
    try {
      const project = "fixture";
      store.createProject({ id: project });
      const source = defaultRoleDefinition("pm", {
        harness: "codex",
        launch_profile_ref: "fixture",
      });
      const oldDefault = {
        ...source,
        instructions: "Earlier instructions",
        allowed_tools: widening
          ? source.allowed_tools.filter((t) => t !== "get_card")
          : source.allowed_tools,
      };
      const baseline = { pm: deploymentRolePolicyHash(oldDefault) };
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
      store.uow.run((tx) => {
        writeRole(
          tx,
          project,
          {
            ...source,
            core_prompt: "",
            instructions:
              mode === "manual"
                ? "Earlier instructions\nLocal PM policy"
                : "Earlier instructions",
            version: 1,
            allowed_tools: widening
              ? source.allowed_tools.filter((t) => t !== "get_card")
              : source.allowed_tools,
          },
          { mode: "add" },
        );
        tx.assignments.put(project, previous);
        recordDefault(tx, project, "pm", oldDefault, "pack", now);
        tx.issueToken({
          project_id: project,
          assignment_id: previous.id,
          role: { role_version: 1, allowed_tools: source.allowed_tools },
        });
      });
      // A hand edit the supervisor does not list is left alone.
      if (blocked) {
        expect(
          upgradeDeployedRoles(
            store,
            project,
            [],
            baseline,
            new Set(["fixture", "project-host-ops"]),
          ),
        ).toBeUndefined();
        expect(
          store.uow.read((tx) => getRoleVersion(tx, project, "pm")?.version),
        ).toBe(1);
      }
      const next = upgradeDeployedRoles(
        store,
        project,
        ["pm"],
        baseline,
        new Set(["fixture", "project-host-ops"]),
      );
      store.uow.read((tx) => {
        expect(getRoleVersion(tx, project, "pm")?.version).toBe(
          blocked ? 1 : 2,
        );
        expect(tx.assignments.get(project, previous.id)?.status).toBe(
          blocked ? "active" : "released",
        );
        if (blocked) {
          expect(next).toBeUndefined();
          expect(tx.human_actions.list(project)).toHaveLength(1);
          expect(tx.human_actions.list(project)[0]).toMatchObject({
            triage: "human",
            status: "open",
          });
          expect(tx.human_actions.list(project)[0]?.instructions).toContain(
            mode === "manual" ? "当前版本有手工改动" : "get_card",
          );
        } else {
          expect(next).toBeDefined();
          if (!next) throw new Error("Expected replacement Ops");
          expect(tx.assignments.get(project, next)).toMatchObject({
            role_version: 2,
            standing_mode: "ops",
          });
          expect(
            tx.events.listAfter(project, undefined, 0).map((e) => e.type),
          ).toEqual(
            expect.arrayContaining([
              "role_updated",
              "host_role_upgraded",
              "standing_pm_rotated",
            ]),
          );
        }
      });
      upgradeDeployedRoles(
        store,
        project,
        ["pm"],
        baseline,
        new Set(["fixture", "project-host-ops"]),
      );
      expect(
        store.uow.read((tx) => tx.human_actions.list(project)),
      ).toHaveLength(blocked ? 1 : 0);
    } finally {
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);

test("MC-2 deployed machine capabilities append a role version while keeping work assignments and tokens pinned", () => {
  const store = Store.open({ dbPath: ":memory:" });
  const project = "capability-upgrade";
  try {
    store.createProject({ id: project });
    const next = defaultRoleDefinition("frontend_engineer", {
      harness: "codex",
      launch_profile_ref: "fixture",
    });
    expect(next.required_capabilities).toEqual(["browser.chromium"]);
    const { required_capabilities: _new, ...old } = next;
    expect(
      deploymentRolePolicyHash({ ...old, required_capabilities: [] }),
    ).toBe(deploymentRolePolicyHash(old));
    const assignment: Assignment = {
      id: "A-1" as never,
      scope: "work_item",
      work_item_id: "W-1" as never,
      role_id: "frontend_engineer",
      role_version: 1,
      status: "active",
      runtime_state: "idle",
      runtime_ref: null,
      machine_id: "local",
      mcp_token_id: "fixture",
      created_at: "2026-01-01T00:00:00.000Z",
    };
    const issued = store.uow.run((tx) => {
      writeRole(
        tx,
        project,
        { ...old, version: 1, core_prompt: "" },
        { mode: "add" },
      );
      tx.assignments.put(project, assignment);
      recordDefault(tx, project, "frontend_engineer", old, "pack", now);
      return tx.issueToken({
        project_id: project,
        assignment_id: assignment.id,
        role: { role_version: 1, allowed_tools: old.allowed_tools },
      });
    });
    upgradeDeployedRoles(
      store,
      project,
      ["frontend_engineer"],
      {
        frontend_engineer: deploymentRolePolicyHash(old),
      },
      new Set(["fixture", "project-host-ops"]),
    );
    store.uow.read((tx) => {
      expect(getRoleVersion(tx, project, "frontend_engineer")).toMatchObject({
        version: 2,
        required_capabilities: ["browser.chromium"],
      });
      expect(
        getRoleVersion(tx, project, "frontend_engineer", 1)
          ?.required_capabilities,
      ).toBeUndefined();
      expect(tx.assignments.get(project, assignment.id)).toEqual(assignment);
    });
    expect(store.verifyToken(issued.token)?.role_version).toBe(1);
  } finally {
    store.close();
  }
});

type Requirements = readonly string[];
const deploymentCases: readonly {
  readonly name: string;
  /** How the previous default differs from the deployed one. */
  readonly previous: {
    readonly instructions?: string;
    readonly required_capabilities: Requirements;
  };
  /** A project edit after the CLI upgrade. */
  readonly edit?: {
    readonly instructions?: string;
    readonly required_capabilities?: Requirements;
  };
  readonly supervisor: "full" | "legacy";
  /**
   * What the trusted record knows of the previous default: the CLI recorded
   * it, a pre-record receipt matched it (a seed), or nothing does.
   */
  readonly record: "cli" | "seed" | "receipt_conflict" | "none";
  readonly outcome: "upgrade" | "conflict" | "unverified";
}[] = [
  {
    name: "CLI upgrade, current supervisor",
    previous: {
      instructions: "Earlier default instructions",
      required_capabilities: ["browser.chromium"],
    },
    supervisor: "full",
    record: "cli",
    outcome: "upgrade",
  },
  {
    name: "CLI upgrade, older supervisor",
    previous: {
      instructions: "Earlier default instructions",
      required_capabilities: ["browser.chromium"],
    },
    supervisor: "legacy",
    record: "cli",
    outcome: "upgrade",
  },
  {
    name: "CLI upgrade before the record existed",
    previous: {
      instructions: "Earlier default instructions",
      required_capabilities: ["browser.chromium"],
    },
    supervisor: "legacy",
    record: "receipt_conflict",
    outcome: "unverified",
  },
  {
    name: "hand-edited instructions",
    previous: {
      instructions: "Earlier default instructions",
      required_capabilities: ["browser.chromium"],
    },
    edit: { instructions: "Earlier default instructions\nProject review rule" },
    supervisor: "full",
    record: "cli",
    outcome: "conflict",
  },
  {
    name: "hand-added requirement the next default also adds",
    previous: {
      instructions: "Earlier default instructions",
      required_capabilities: [],
    },
    edit: { required_capabilities: ["browser.chromium"] },
    supervisor: "full",
    record: "cli",
    outcome: "conflict",
  },
  {
    name: "hand-added requirement the next default also adds, no record",
    previous: {
      instructions: "Earlier default instructions",
      required_capabilities: [],
    },
    edit: { required_capabilities: ["browser.chromium"] },
    supervisor: "full",
    record: "none",
    outcome: "unverified",
  },
  {
    name: "requirements cleared by hand, older supervisor fingerprint equals the version",
    previous: {
      instructions: "Earlier default instructions",
      required_capabilities: ["browser.chromium", "gpu"],
    },
    edit: { required_capabilities: [] },
    supervisor: "legacy",
    record: "seed",
    outcome: "conflict",
  },
  {
    name: "next default drops a requirement, older supervisor",
    previous: {
      instructions: "Earlier default instructions",
      required_capabilities: ["browser.chromium", "gpu"],
    },
    supervisor: "legacy",
    record: "cli",
    outcome: "upgrade",
  },
  {
    name: "next default only adds a requirement, older supervisor",
    previous: { required_capabilities: [] },
    supervisor: "legacy",
    record: "seed",
    outcome: "upgrade",
  },
  {
    name: "next default only adds a requirement, current supervisor",
    previous: { required_capabilities: [] },
    supervisor: "full",
    record: "cli",
    outcome: "upgrade",
  },
];

test.each(deploymentCases)(
  "a deployment upgrades only roles equal to a recorded default, the same on a rerun: $name",
  ({ previous, edit, supervisor, record, outcome }) => {
    const store = Store.open({ dbPath: ":memory:" });
    const project = "cli-upgrade";
    try {
      store.createProject({ id: project });
      const launch = {
        harness: "codex" as const,
        launch_profile_ref: "fixture",
      };
      const nextDefault = defaultRoleDefinition("design_director", launch);
      expect(nextDefault.required_capabilities).toEqual(["browser.chromium"]);
      const previousDefault = {
        ...nextDefault,
        ...previous,
        required_capabilities: [...previous.required_capabilities],
      };
      // A supervisor built before machine requirements omits them from its snapshot.
      const snapshot = (role: RoleDefinition) =>
        deploymentRolePolicyHash(
          supervisor === "full" ? role : { ...role, required_capabilities: [] },
        );
      const { required_capabilities: _, ...oldest } = {
        ...nextDefault,
        instructions: "Oldest default instructions",
      };
      const versions = store.uow.run((tx) => {
        writeRole(
          tx,
          project,
          { ...oldest, core_prompt: "", version: 1 },
          { mode: "add" },
        );
        // The receipt the previous release published, before the CLI upgrade.
        if (record === "seed" || record === "receipt_conflict")
          tx.events.append(project, {
            id: tx.ids.nextEventId(),
            seq: tx.ids.nextEventSequence(project),
            type: "host_role_pack_published",
            actor: { kind: "system", project_id: project },
            created_at: "2026-11-18T00:00:00.000Z",
            payload: {
              pack_hash: "previous-release",
              roles: {
                design_director:
                  record === "seed"
                    ? {
                        version: 1,
                        policy_hash: deploymentRolePolicyHash(previousDefault),
                        disposition: "matched",
                      }
                    : {
                        version: 1,
                        policy_hash: deploymentRolePolicyHash(oldest),
                        disposition: "conflict",
                      },
              },
            },
          });
        // Same writes as `cardigan role upgrade design_director --from-default`.
        const upgraded = upgradeRole(
          { project_id: project, roles: listRoleVersions(tx, project) },
          { kind: "human", project_id: project },
          "design_director",
          previousDefault,
          { ids: tx.ids, clock: { now: () => "2026-11-19T00:00:00.000Z" } },
        );
        if (!upgraded.ok || upgraded.value.unchanged)
          throw new Error("Expected a CLI upgrade");
        persistRoleEffect(tx, project, upgraded.value.effect);
        if (record === "cli")
          recordDefault(
            tx,
            project,
            "design_director",
            previousDefault,
            "cli",
            "2026-11-19T00:00:00.000Z",
          );
        if (edit)
          writeRole(
            tx,
            project,
            {
              ...previousDefault,
              ...edit,
              required_capabilities: [
                ...(edit.required_capabilities ??
                  previousDefault.required_capabilities),
              ],
              core_prompt: "",
              version: 3,
            },
            { mode: "update" },
          );
        return listRoleVersions(tx, project).length;
      });
      const before = store.uow.read((tx) =>
        getRoleVersion(tx, project, "design_director"),
      );
      const changed =
        snapshot(previousDefault) === snapshot(nextDefault)
          ? []
          : ["design_director"];
      const deploy = () =>
        upgradeDeployedRoles(
          store,
          project,
          changed,
          { design_director: snapshot(previousDefault) },
          new Set(["fixture"]),
        );
      const observe = () =>
        store.uow.read((tx) => {
          const events = tx.events.listAfter(project, undefined, 0);
          const latest = events
            .filter((e) => e.type === "host_role_pack_published")
            .at(-1)?.payload as {
            roles: Record<string, { disposition: string }>;
          };
          return {
            role: getRoleVersion(tx, project, "design_director"),
            disposition: latest.roles.design_director?.disposition,
            upgrades: events.filter((e) => e.type === "host_role_upgraded")
              .length,
            deferrals: events
              .filter((e) => e.type === "host_role_upgrade_deferred")
              .map((e) => (e.payload as { notice: string }).notice),
            actions: tx.human_actions
              .list(project)
              .map((a) => ({ status: a.status, instructions: a.instructions })),
          };
        });
      deploy();
      const first = observe();
      if (outcome === "upgrade") {
        expect(first.role?.version).toBe(versions + 1);
        expect(first.role && deploymentRolePolicyHash(first.role)).toBe(
          deploymentRolePolicyHash(nextDefault),
        );
        expect(first.upgrades).toBe(1);
        expect(first.actions).toEqual([]);
        expect(first.disposition).toBe("matched");
      } else {
        expect(first.role).toEqual(before);
        expect(first.upgrades).toBe(0);
        expect(first.disposition).toBe(outcome);
        if (outcome === "conflict") {
          expect(first.actions).toEqual([
            {
              status: "open",
              instructions: expect.stringContaining("当前版本有手工改动"),
            },
          ]);
          expect(first.deferrals).toEqual([]);
        } else {
          expect(first.actions).toEqual([]);
          expect(first.deferrals).toEqual([
            expect.stringContaining("没有可核对的已记录默认包"),
          ]);
        }
      }
      // The same release run again reaches the same conclusion (V-3008).
      deploy();
      expect(observe()).toEqual(first);
    } finally {
      store.close();
    }
  },
);

test("the supervisor's previous-pack snapshot hashes every default like the deployed release", async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [
    "--input-type=module",
    "-e",
    ROLE_PACK_SNAPSHOT_SCRIPT,
    fileURLToPath(new URL("../../roles/dist/index.js", import.meta.url)),
  ]);
  const launch = {
    harness: "codex" as const,
    launch_profile_ref: "deployment",
  };
  expect(parseRolePackSnapshot(stdout)).toEqual(
    Object.fromEntries(
      Object.keys(DEFAULT_ROLE_KINDS).map((id) => [
        id,
        deploymentRolePolicyHash(
          defaultRoleDefinition(id as keyof typeof DEFAULT_ROLE_KINDS, launch),
        ),
      ]),
    ),
  );
});
