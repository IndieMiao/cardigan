import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Assignment } from "@cardigan/domain";
import { defaultRoleDefinition } from "@cardigan/roles";
import { getRoleVersion, Store, writeRole } from "@cardigan/store";
import { expect, test } from "vitest";
import {
  deploymentRolePolicyHash,
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
      upgradeDeployedRoles(store, project, ["host_ops"], baseline);
      upgradeDeployedRoles(store, project, ["host_ops"], baseline);
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
        expect(tx.assignments.get(project, a.id)).toEqual(a);
        const actions = tx.human_actions.list(project);
        expect(actions).toHaveLength(manual ? 1 : 0);
        if (manual) {
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
      expect(store.verifyToken(token.token)).toBeTruthy();
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
    const blocked = mode !== "safe";
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
        upgradeDeployedRoles(store, project, [], baseline),
      ).toBeUndefined();
      expect(
        store.uow.read((tx) => getRoleVersion(tx, project, "pm")?.version),
      ).toBe(1);
      const next = upgradeDeployedRoles(store, project, ["pm"], baseline);
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
      upgradeDeployedRoles(store, project, ["pm"], baseline);
      expect(
        store.uow.read((tx) => tx.human_actions.list(project)),
      ).toHaveLength(blocked ? 1 : 0);
    } finally {
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);
