import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Assignment } from "@cardigan/domain";
import { defaultRoleDefinition } from "@cardigan/roles";
import { getRoleVersion, Store, writeRole } from "@cardigan/store";
import { expect, test } from "vitest";
import { upgradeDeployedRoles } from "./deployment-roles.js";

test.each([false, true])(
  "deployment role upgrade/rotation, missing tool = %s",
  async (widening) => {
    const dataDir = await mkdtemp(join(tmpdir(), "cg-deployment-roles-"));
    const store = Store.open({ dataDir });
    try {
      const project = "fixture";
      store.createProject({ id: project });
      const source = defaultRoleDefinition("pm", {
        harness: "codex",
        launch_profile_ref: "fixture",
      });
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
            instructions: "Earlier instructions",
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
      expect(upgradeDeployedRoles(store, project, [])).toBeUndefined();
      expect(
        store.uow.read((tx) => getRoleVersion(tx, project, "pm")?.version),
      ).toBe(1);
      const next = upgradeDeployedRoles(store, project);
      store.uow.read((tx) => {
        expect(getRoleVersion(tx, project, "pm")?.version).toBe(
          widening ? 1 : 2,
        );
        expect(tx.assignments.get(project, previous.id)?.status).toBe(
          widening ? "active" : "released",
        );
        if (widening) {
          expect(next).toBeUndefined();
          expect(tx.human_actions.list(project)).toHaveLength(1);
          expect(tx.human_actions.list(project)[0]).toMatchObject({
            triage: "human",
            status: "open",
          });
          expect(tx.human_actions.list(project)[0]?.instructions).toContain(
            "get_card",
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
      upgradeDeployedRoles(store, project);
      expect(
        store.uow.read((tx) => tx.human_actions.list(project)),
      ).toHaveLength(widening ? 1 : 0);
    } finally {
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);
