import type { ProjectId, Role } from "@cardigan/domain";
import { describe, expect, test } from "vitest";
import {
  getRoleVersion,
  listRoleVersions,
  nextRoleVersion,
  RoleVersionError,
  roleDocument,
  roleFromDocument,
  writeRole,
} from "./roles.js";
import { Store } from "./store.js";
import { withTempStore } from "./test-support.js";

const project_id = "p-roles" as ProjectId;

function definition(overrides: Partial<Role> = {}): Role {
  return {
    role_id: "coder",
    version: 1,
    display_name: "Coder",
    kind: "work",
    core_prompt: "You write code.",
    harness: "codex",
    launch_profile_ref: "codex-agent",
    allowed_tools: ["submit_delivery", "get_card"],
    capabilities: ["code"],
    abilities: ["coding"],
    worktree: "write",
    required_machine_tags: [],
    ...overrides,
  };
}

describe("role versions", () => {
  test("add writes version 1", () => {
    withTempStore((store) => {
      const result = store.uow.run((tx) =>
        writeRole(tx, project_id, definition(), { mode: "add" }),
      );
      expect(result.role.version).toBe(1);
      expect(result.created).toBe(true);
      expect(
        store.uow.run((tx) => getRoleVersion(tx, project_id, "coder")),
      ).toEqual(result.role);
    });
  });

  test("update appends a version and keeps the old one readable", () => {
    withTempStore((store) => {
      store.uow.run((tx) =>
        writeRole(tx, project_id, definition(), { mode: "add" }),
      );
      const updated = store.uow.run((tx) =>
        writeRole(
          tx,
          project_id,
          definition({
            display_name: "Coder v2",
            launch_profile_ref: "codex-agent-2",
            allowed_tools: ["submit_delivery"],
          }),
          { mode: "update" },
        ),
      );
      expect(updated.role.version).toBe(2);

      const all = store.uow.run((tx) => listRoleVersions(tx, project_id));
      expect(all.map((role) => role.version)).toEqual([1, 2]);
      expect(all[0]?.display_name).toBe("Coder");
      expect(all[0]?.launch_profile_ref).toBe("codex-agent");
      expect(all[1]?.allowed_tools).toEqual(["submit_delivery"]);
      // The latest version is what an unversioned lookup returns.
      expect(
        store.uow.run((tx) => getRoleVersion(tx, project_id, "coder"))?.version,
      ).toBe(2);
    });
  });

  test("an existing version is never overwritten", () => {
    withTempStore((store) => {
      store.uow.run((tx) =>
        writeRole(tx, project_id, definition(), { mode: "add" }),
      );
      store.uow.run((tx) =>
        writeRole(tx, project_id, definition({ display_name: "v2" }), {
          mode: "update",
        }),
      );

      // Writing version 1 (or 2) again is refused; versions only grow.
      expect(() =>
        store.uow.run((tx) =>
          writeRole(tx, project_id, definition({ display_name: "rewrite" }), {
            mode: "update",
            version: 1,
          }),
        ),
      ).toThrow(RoleVersionError);
      expect(() =>
        store.uow.run((tx) =>
          writeRole(tx, project_id, definition(), {
            mode: "add",
            version: 3,
          }),
        ),
      ).toThrow(RoleVersionError);

      expect(
        store.uow.run((tx) => getRoleVersion(tx, project_id, "coder", 1))
          ?.display_name,
      ).toBe("Coder");
    });
  });

  test("add refuses a role that already exists", () => {
    withTempStore((store) => {
      store.uow.run((tx) =>
        writeRole(tx, project_id, definition(), { mode: "add" }),
      );
      expect(() =>
        store.uow.run((tx) =>
          writeRole(tx, project_id, definition({ display_name: "dup" }), {
            mode: "add",
          }),
        ),
      ).toThrow(/already exists/);
    });
  });

  test("update refuses a role that does not exist", () => {
    withTempStore((store) => {
      expect(() =>
        store.uow.run((tx) =>
          writeRole(tx, project_id, definition(), { mode: "update" }),
        ),
      ).toThrow(/does not exist/);
    });
  });

  test("run version snapshots still resolve to the original definition", () => {
    withTempStore((store) => {
      const first = store.uow.run((tx) =>
        writeRole(tx, project_id, definition(), { mode: "add" }),
      );
      // A Run records the version it started with (invariant 12).
      store.uow.run((tx) => {
        tx.assignments.put(project_id, {
          id: "A-1" as never,
          scope: "standing",
          role_id: "coder",
          role_version: first.role.version,
          status: "active",
          runtime_state: "not_provisioned",
          machine_id: "local",
          runtime_ref: null,
          mcp_token_id: "t",
          created_at: "2026-01-01T00:00:00.000Z",
        });
        tx.runs.put(project_id, {
          id: "R-1" as never,
          assignment_id: "A-1" as never,
          trigger_event_id: "01J00000000000000000000001" as never,
          kind: "initial",
          status: "queued",
          role_version: first.role.version,
          model: "fictional-model",
          agent_cli_version: "0.0.1",
          outcome: null,
          summary: "",
        });
      });

      store.uow.run((tx) =>
        writeRole(
          tx,
          project_id,
          definition({ launch_profile_ref: "changed", allowed_tools: [] }),
          { mode: "update" },
        ),
      );

      const run = store.uow.run((tx) =>
        tx.runs.get(project_id, "R-1" as never),
      );
      expect(run?.role_version).toBe(1);
      const pinned = store.uow.run((tx) =>
        getRoleVersion(tx, project_id, "coder", run?.role_version),
      );
      expect(pinned?.launch_profile_ref).toBe("codex-agent");
      expect(pinned?.allowed_tools).toEqual(["submit_delivery", "get_card"]);
    });
  });

  test("the stored document keeps both version fields, so M1 readers work", () => {
    const document = roleDocument(definition());
    expect(document.version).toBe(1);
    expect(document.role_version).toBe(1);
    expect(roleFromDocument(document)).toEqual(definition());
  });

  test("nextRoleVersion counts from the latest version", () => {
    withTempStore((store) => {
      expect(
        store.uow.run((tx) => nextRoleVersion(tx, project_id, "coder")),
      ).toBe(1);
      store.uow.run((tx) =>
        writeRole(tx, project_id, definition(), { mode: "add" }),
      );
      expect(
        store.uow.run((tx) => nextRoleVersion(tx, project_id, "coder")),
      ).toBe(2);
    });
  });
});

describe("project repository registration", () => {
  test("setProjectRepo records the path and branch", () => {
    withTempStore((store) => {
      store.createProject({ id: project_id, name: "Fictional" });
      const result = store.setProjectRepo({
        project_id,
        repo_path: "/srv/agent/repos/example",
        base_branch: "develop",
      });
      expect(result.ok && result.value).toMatchObject({
        repo_path: "/srv/agent/repos/example",
        base_branch: "develop",
      });
      expect(store.getProject(project_id)?.repo_path).toBe(
        "/srv/agent/repos/example",
      );
    });
  });

  test("the base branch defaults to main and a relative path is refused", () => {
    withTempStore((store) => {
      store.createProject({ id: project_id });
      const ok = store.setProjectRepo({
        project_id,
        repo_path: "/srv/agent/repos/example",
      });
      expect(ok.ok && ok.value.base_branch).toBe("main");

      const relative = store.setProjectRepo({
        project_id,
        repo_path: "relative/path",
      });
      expect(relative.ok).toBe(false);
      expect(relative.ok === false && relative.error.code).toBe(
        "validation_failed",
      );
    });
  });

  test("an unknown project is not_found and the branch name is validated", () => {
    withTempStore((store) => {
      expect(
        store.setProjectRepo({
          project_id: "p-missing" as ProjectId,
          repo_path: "/srv/x",
        }),
      ).toMatchObject({ ok: false, error: { code: "not_found" } });

      store.createProject({ id: project_id });
      expect(
        store.setProjectRepo({
          project_id,
          repo_path: "/srv/x",
          base_branch: "-bad",
        }),
      ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
      expect(store.getProject(project_id)?.repo_path).toBeNull();
    });
  });

  test("migrations are repeatable and keep the recorded repository", () => {
    withTempStore((store) => {
      store.createProject({ id: project_id });
      store.setProjectRepo({
        project_id,
        repo_path: "/srv/agent/repos/example",
        base_branch: "main",
      });
      expect(store.migrate()).toEqual([]);
      expect(store.schemaVersion()).toBe(7);
      expect(store.getProject(project_id)?.repo_path).toBe(
        "/srv/agent/repos/example",
      );
    });
  });

  test("reopening the database keeps role versions and the repository", () => {
    withTempStore((store, dataDir) => {
      store.createProject({ id: project_id });
      store.setProjectRepo({
        project_id,
        repo_path: "/srv/agent/repos/example",
      });
      store.uow.run((tx) =>
        writeRole(tx, project_id, definition(), { mode: "add" }),
      );

      const reopened = Store.open({ dataDir });
      try {
        expect(reopened.schemaVersion()).toBe(7);
        expect(reopened.getProject(project_id)?.repo_path).toBe(
          "/srv/agent/repos/example",
        );
        expect(
          reopened.uow
            .read((tx) => listRoleVersions(tx, project_id))
            .map((role) => role.version),
        ).toEqual([1]);
      } finally {
        reopened.close();
      }
    });
  });
});
