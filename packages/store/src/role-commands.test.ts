import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRole,
  type Role,
  rollbackRole,
  updateRole,
} from "@cardigan/domain";
import { expect, test } from "vitest";
import { defaultMigrationsDir, listMigrations } from "./migrate.js";
import {
  getRoleVersion,
  listRoleVersions,
  persistRoleEffect,
  roleDocument,
} from "./roles.js";
import { Store } from "./store.js";
import { withTempStore } from "./test-support.js";

const project = "role-migration";
const actor = { kind: "human", project_id: project } as const;
const legacy: Role = {
  role_id: "coder",
  version: 1,
  display_name: "Coder",
  kind: "work",
  core_prompt: "Legacy prompt\n  with whitespace\n\n",
  harness: "codex",
  launch_profile_ref: "fixture",
  allowed_tools: ["whoami", "submit_delivery"],
  capabilities: ["code"],
  abilities: [],
  worktree: "write",
  required_machine_tags: [],
};
const clock = { now: () => "2026-01-01T00:00:00.000Z" };

test("upgrading a pre-instructions database preserves every byte of old role documents", () => {
  const root = mkdtempSync(join(tmpdir(), "role-migrate-"));
  const oldMigrations = join(root, "old-migrations");
  mkdirSync(oldMigrations);
  for (const migration of listMigrations(defaultMigrationsDir).filter(
    (item) => item.version <= 3,
  )) {
    writeFileSync(
      join(
        oldMigrations,
        `${String(migration.version).padStart(4, "0")}_${migration.name}.sql`,
      ),
      migration.sql,
    );
  }
  const dataDir = join(root, "data");
  let store = Store.open({ dataDir, migrationsDir: oldMigrations });
  try {
    store.createProject({ id: project });
    const original = JSON.stringify(roleDocument(legacy));
    store.database
      .prepare(
        "INSERT INTO roles(project_id, role_id, role_version, doc) VALUES (?, ?, ?, ?)",
      )
      .run(project, "coder", 1, original);
    store.close();
    store = Store.open({ dataDir });
    expect(
      store.database
        .prepare("SELECT doc FROM roles WHERE project_id = ?")
        .get(project)?.doc,
    ).toBe(original);
    expect(
      store.uow.read((tx) => getRoleVersion(tx, project, "coder")),
    ).toEqual(legacy);
    expect(store.migrate()).toEqual([]);
    store.uow.run((tx) => {
      const result = updateRole(
        { project_id: project, roles: listRoleVersions(tx, project) },
        actor,
        "coder",
        { instructions: "Converted" },
        { clock, ids: tx.ids },
      );
      if (!result.ok) throw new Error(result.error.message);
      persistRoleEffect(tx, project, result.value);
    });
    store.close();
    store = Store.open({ dataDir });
    expect(
      store.uow.read((tx) => getRoleVersion(tx, project, "coder", 1)),
    ).toEqual(legacy);
    expect(
      store.uow.read((tx) => getRoleVersion(tx, project, "coder")),
    ).toMatchObject({
      version: 2,
      instructions: "Converted",
      status: "active",
      core_prompt: legacy.core_prompt,
    });
    expect(
      store.uow.read((tx) => tx.events.listAfter(project, undefined, 0)),
    ).toMatchObject([{ type: "role_updated", actor }]);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("versions, audit events and counters are atomic and project-scoped", () => {
  withTempStore((store) => {
    const { version: _version, ...definition } = legacy;
    const write = () =>
      store.uow.run((tx) => {
        const result = createRole(
          { project_id: project, roles: listRoleVersions(tx, project) },
          actor,
          definition,
          { clock, ids: tx.ids },
        );
        if (!result.ok) throw new Error(result.error.message);
        persistRoleEffect(tx, project, result.value);
        throw new Error("rollback transaction");
      });
    expect(write).toThrow("rollback transaction");
    expect(store.uow.read((tx) => listRoleVersions(tx, project))).toEqual([]);
    expect(
      store.uow.read((tx) => tx.events.listAfter(project, undefined, 0)),
    ).toEqual([]);
    store.uow.run((tx) => {
      const result = createRole(
        { project_id: project, roles: [] },
        actor,
        definition,
        { clock, ids: tx.ids },
      );
      if (!result.ok) throw new Error(result.error.message);
      expect(result.value.events[0]?.seq).toBe(1);
      persistRoleEffect(tx, project, result.value);
    });
    store.uow.run((tx) => {
      const result = rollbackRole(
        { project_id: project, roles: listRoleVersions(tx, project) },
        actor,
        "coder",
        1,
        { clock, ids: tx.ids },
      );
      if (!result.ok) throw new Error(result.error.message);
      persistRoleEffect(tx, project, result.value);
    });
    expect(
      store.uow
        .read((tx) => listRoleVersions(tx, project))
        .map((role) => role.version),
    ).toEqual([1, 2]);
    expect(
      store.uow.read((tx) => listRoleVersions(tx, "another-project")),
    ).toEqual([]);
    expect(
      store.uow
        .read((tx) => tx.events.listAfter(project, undefined, 0))
        .map((event) => event.seq),
    ).toEqual([1, 2]);
  });
});
