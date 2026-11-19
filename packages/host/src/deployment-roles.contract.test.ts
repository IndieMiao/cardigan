import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Assignment, notices, type Run } from "@cardigan/domain";
import { loadCommandState } from "@cardigan/mcp-server";
import { defaultRoleDefinition } from "@cardigan/roles";
import { getRoleVersion, Store, writeRole } from "@cardigan/store";
import { expect, test } from "vitest";
import {
  deploymentRolePolicyHash,
  rotateIdleDeployedRoles,
  upgradeDeployedRoles,
} from "./deployment-roles.js";

test.each(["pm", "host_ops"] as const)(
  "B9: %s default-tool additions upgrade with notice; busy standing sessions rotate once after becoming idle",
  async (roleId) => {
    const dataDir = await mkdtemp(join(tmpdir(), "cg-deployed-idle-"));
    const store = Store.open({ dataDir });
    const project = "fixture";
    try {
      store.createProject({ id: project });
      const source = defaultRoleDefinition(roleId, {
        harness: "codex",
        launch_profile_ref: "fixture",
      });
      const previous = {
        ...source,
        instructions: "Previous default",
        allowed_tools: source.allowed_tools.filter((t) => t !== "get_card"),
      };
      const owner: Assignment = {
        id: "A-50" as never,
        scope: "standing",
        role_id: roleId,
        role_version: 1,
        ...(roleId === "pm" ? { standing_mode: "ops" as const } : {}),
        status: "active",
        runtime_state: "running",
        machine_id: "local",
        runtime_ref: null,
        mcp_token_id: "fixture",
        session_ref: "previous-session",
        created_at: "2026-01-01T00:00:00.000Z",
      };
      const run: Run = {
        id: "R-50" as never,
        assignment_id: owner.id,
        trigger_event_id: "00000000000000000000000001" as never,
        kind: "initial",
        status: "running",
        role_version: 1,
        model: "fixture",
        agent_cli_version: "1",
        outcome: null,
        summary: "",
      };
      const token = store.uow.run((tx) => {
        writeRole(
          tx,
          project,
          { ...previous, core_prompt: "", version: 1 },
          { mode: "add" },
        );
        tx.assignments.put(project, owner);
        tx.runs.put(project, run);
        return tx.issueToken({
          project_id: project,
          assignment_id: owner.id,
          role: { role_version: 1, allowed_tools: previous.allowed_tools },
        });
      });
      upgradeDeployedRoles(
        store,
        project,
        [roleId],
        {
          [roleId]: deploymentRolePolicyHash(previous),
        },
        new Set(["fixture"]),
      );
      store.uow.read((tx) => {
        expect(getRoleVersion(tx, project, roleId)?.version).toBe(2);
        expect(tx.assignments.get(project, owner.id)?.status).toBe("active");
        expect(tx.human_actions.list(project)).toEqual([]);
        expect(
          notices(loadCommandState(tx, project)).some((n) =>
            n.body.includes("默认角色"),
          ),
        ).toBe(true);
      });
      rotateIdleDeployedRoles(store, project);
      expect(store.verifyToken(token.token)).toBeTruthy();
      store.uow.run((tx) =>
        tx.runs.put(project, {
          ...run,
          status: "completed",
          outcome: "completed",
          finished_at: "2026-01-01T01:00:00Z",
        }),
      );
      rotateIdleDeployedRoles(store, project);
      rotateIdleDeployedRoles(store, project);
      store.uow.read((tx) => {
        expect(tx.assignments.get(project, owner.id)?.status).toBe("released");
        expect(
          tx.assignments.list(project).filter((a) => a.status === "active"),
        ).toMatchObject([{ role_id: roleId, role_version: 2 }]);
        expect(
          tx.assignments.list(project).find((a) => a.status === "active")
            ?.session_ref,
        ).toBeUndefined();
        expect(
          tx.events
            .listAfter(project, undefined, 0)
            .filter((e) =>
              ["standing_pm_rotated", "standing_role_rotated"].includes(e.type),
            ),
        ).toHaveLength(1);
      });
      expect(store.verifyToken(token.token)).toBeUndefined();
    } finally {
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);

test.each(["frontend_engineer", "design_director"] as const)(
  "C-444: %s default updates preserve existing work-item assignments and tokens",
  (roleId) => {
    const store = Store.open({ dbPath: ":memory:" });
    const project = "fixture";
    try {
      store.createProject({ id: project });
      const source = defaultRoleDefinition(roleId, {
        harness: "claude-code",
        launch_profile_ref: "fixture",
      });
      const previous = { ...source, instructions: "Previous default" };
      const owner: Assignment = {
        id: "A-50" as never,
        scope: "work_item",
        work_item_id: "W-50" as never,
        role_id: roleId,
        role_version: 1,
        status: "active",
        runtime_state: "running",
        machine_id: "local",
        runtime_ref: null,
        mcp_token_id: "fixture",
        created_at: "2026-01-01T00:00:00Z",
      };
      const token = store.uow.run((tx) => {
        writeRole(
          tx,
          project,
          { ...previous, core_prompt: "", version: 1 },
          { mode: "add" },
        );
        tx.assignments.put(project, owner);
        return tx.issueToken({
          project_id: project,
          assignment_id: owner.id,
          role: { role_version: 1, allowed_tools: previous.allowed_tools },
        });
      });
      for (let i = 0; i < 2; i++) {
        upgradeDeployedRoles(
          store,
          project,
          [roleId],
          {
            [roleId]: deploymentRolePolicyHash(previous),
          },
          new Set(["fixture"]),
        );
        rotateIdleDeployedRoles(store, project);
      }
      store.uow.read((tx) => {
        expect(getRoleVersion(tx, project, roleId)).toMatchObject({
          version: 2,
          instructions: source.instructions,
        });
        expect(getRoleVersion(tx, project, roleId, 1)?.instructions).toBe(
          "Previous default",
        );
        expect(tx.assignments.get(project, owner.id)).toEqual(owner);
        expect(tx.human_actions.list(project)).toEqual([]);
        expect(
          tx.events
            .listAfter(project, undefined, 0)
            .filter((e) => e.type === "host_role_upgraded"),
        ).toHaveLength(1);
      });
      expect(store.verifyToken(token.token)).toBeTruthy();
    } finally {
      store.close();
    }
  },
);
