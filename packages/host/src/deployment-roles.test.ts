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
import { ROLE_PACK_SNAPSHOT_SCRIPT } from "./deployment-node.js";
import {
  deploymentRolePolicyHash,
  rotateIdleDeployedRoles,
  upgradeDeployedRoles,
} from "./deployment-roles.js";

test.each(["manual", "missing", "launch_only", "already_default"] as const)(
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
      const manual = mode === "manual" || mode === "missing";
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
        if (mode === "missing")
          expect(
            tx.events
              .listAfter(project, undefined, 0)
              .filter((e) => e.type === "host_role_upgrade_deferred"),
          ).toHaveLength(1);
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
        tx.issueToken({
          project_id: project,
          assignment_id: previous.id,
          role: { role_version: 1, allowed_tools: source.allowed_tools },
        });
      });
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
  readonly receipt:
    | "default_hash"
    | "legacy_matched"
    | "legacy_conflict"
    | "none";
  readonly notice?: string;
}[] = [
  {
    name: "CLI upgrade, current supervisor",
    previous: {
      instructions: "Earlier default instructions",
      required_capabilities: ["browser.chromium"],
    },
    supervisor: "full",
    receipt: "none",
  },
  {
    name: "CLI upgrade, older supervisor, published receipt",
    previous: {
      instructions: "Earlier default instructions",
      required_capabilities: ["browser.chromium"],
    },
    supervisor: "legacy",
    receipt: "default_hash",
  },
  {
    name: "CLI upgrade, older supervisor, receipt without defaults",
    previous: {
      instructions: "Earlier default instructions",
      required_capabilities: ["browser.chromium"],
    },
    supervisor: "legacy",
    receipt: "legacy_conflict",
    notice: "无法确认当前机器要求是否为项目手改",
  },
  {
    name: "hand-edited instructions",
    previous: {
      instructions: "Earlier default instructions",
      required_capabilities: ["browser.chromium"],
    },
    edit: { instructions: "Earlier default instructions\nProject review rule" },
    supervisor: "full",
    receipt: "default_hash",
    notice: "当前版本有手工改动",
  },
  {
    name: "hand-added requirement the next default also adds",
    previous: {
      instructions: "Earlier default instructions",
      required_capabilities: [],
    },
    edit: { required_capabilities: ["browser.chromium"] },
    supervisor: "full",
    receipt: "default_hash",
    notice: "当前版本有手工改动",
  },
  {
    name: "hand-added requirement the next default also adds, no receipt",
    previous: {
      instructions: "Earlier default instructions",
      required_capabilities: [],
    },
    edit: { required_capabilities: ["browser.chromium"] },
    supervisor: "full",
    receipt: "none",
    notice: "无法确认当前机器要求是否为项目手改",
  },
  {
    name: "next default drops a requirement, older supervisor",
    previous: {
      instructions: "Earlier default instructions",
      required_capabilities: ["browser.chromium", "gpu"],
    },
    supervisor: "legacy",
    receipt: "default_hash",
  },
  {
    name: "next default only adds a requirement, older supervisor",
    previous: { required_capabilities: [] },
    supervisor: "legacy",
    receipt: "legacy_matched",
  },
  {
    name: "next default only adds a requirement, current supervisor",
    previous: { required_capabilities: [] },
    supervisor: "full",
    receipt: "none",
  },
];

test.each(deploymentCases)(
  "a deployment upgrades only roles matching a published default: $name",
  ({ previous, edit, supervisor, receipt, notice }) => {
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
        // Same write as `cardigan role upgrade design_director --from-default`.
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
        // The receipt the previous release published, before the CLI upgrade.
        const published = {
          default_hash: {
            version: 1,
            policy_hash: deploymentRolePolicyHash(oldest),
            disposition: "conflict",
            default_hash: deploymentRolePolicyHash(previousDefault),
          },
          legacy_matched: {
            version: 2,
            policy_hash: deploymentRolePolicyHash(previousDefault),
            disposition: "matched",
          },
          legacy_conflict: {
            version: 1,
            policy_hash: deploymentRolePolicyHash(oldest),
            disposition: "conflict",
          },
          none: undefined,
        }[receipt];
        if (published)
          tx.events.append(project, {
            id: tx.ids.nextEventId(),
            seq: tx.ids.nextEventSequence(project),
            type: "host_role_pack_published",
            actor: { kind: "system", project_id: project },
            created_at: "2026-11-18T00:00:00.000Z",
            payload: {
              pack_hash: "previous-release",
              roles: { design_director: published },
            },
          });
        return listRoleVersions(tx, project).length;
      });
      const before = store.uow.read((tx) =>
        getRoleVersion(tx, project, "design_director"),
      );
      const changed =
        snapshot(previousDefault) === snapshot(nextDefault)
          ? []
          : ["design_director"];
      upgradeDeployedRoles(
        store,
        project,
        changed,
        { design_director: snapshot(previousDefault) },
        new Set(["fixture"]),
      );
      store.uow.read((tx) => {
        const after = getRoleVersion(tx, project, "design_director");
        const events = tx.events.listAfter(project, undefined, 0);
        const latest = events
          .filter((e) => e.type === "host_role_pack_published")
          .at(-1)?.payload as {
          roles: Record<string, { disposition: string; default_hash: string }>;
        };
        const actions = tx.human_actions.list(project);
        expect(latest.roles.design_director?.default_hash).toBe(
          deploymentRolePolicyHash(nextDefault),
        );
        if (notice === undefined) {
          expect(after?.version).toBe(versions + 1);
          expect(after && deploymentRolePolicyHash(after)).toBe(
            deploymentRolePolicyHash(nextDefault),
          );
          expect(actions).toEqual([]);
          expect(events.map((e) => e.type)).toContain("host_role_upgraded");
          expect(latest.roles.design_director?.disposition).toBe("matched");
        } else {
          expect(after).toEqual(before);
          expect(actions).toHaveLength(1);
          expect(actions[0]?.instructions).toContain(notice);
          expect(events.map((e) => e.type)).not.toContain("host_role_upgraded");
          expect(latest.roles.design_director?.disposition).toBe("conflict");
        }
      });
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
  expect(JSON.parse(stdout)).toEqual(
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
