/**
 * M4.5: backfilling `standing_mode` for rows written before the field existed
 * (M4 plan §4 M4.5, development plan §7.1).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Assignment, ProjectId } from "@cardigan/domain";
import { afterEach, beforeEach, expect, test } from "vitest";
import { defaultMigrationsDir, listMigrations, Store } from "./index.js";
import { latestSchemaVersion } from "./test-support.js";

const project = "p-standing" as ProjectId;
let dataDir: string;
let store: Store;

const standing = (id: string, extra: Partial<Assignment> = {}): Assignment =>
  ({
    id: id as never,
    scope: "standing",
    role_id: "pm",
    role_version: 1,
    status: "active",
    runtime_state: "not_provisioned",
    machine_id: "local",
    runtime_ref: null,
    mcp_token_id: id,
    created_at: "2026-01-01T00:00:00.000Z",
    ...extra,
  }) as Assignment;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "cardigan-standing-"));
  store = Store.open({ dataDir });
  store.createProject({ id: project, name: "Standing" });
});
afterEach(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function seat(assignment: Assignment, tools: readonly string[] | undefined) {
  store.uow.run((tx) => {
    tx.assignments.put(project, assignment);
    if (tools !== undefined)
      tx.issueToken({
        project_id: project,
        assignment_id: assignment.id,
        role: { role_version: 1, allowed_tools: tools as never },
      });
  });
}

const modeOf = (id: string) =>
  store.uow.read((tx) => tx.assignments.get(project, id as never))
    ?.standing_mode;

test("infers each legacy row from its newest token and writes it back", () => {
  seat(standing("A-1"), ["whoami", "record_decision"]);
  seat(standing("A-2"), ["whoami", "create_card"]);
  // A row without any token has nothing to infer from and stays untouched.
  seat(standing("A-3"), undefined);

  const updated = store.backfillStandingModes();
  expect(
    updated.map((assignment) => [assignment.id, assignment.standing_mode]),
  ).toEqual([
    ["A-1", "office"],
    ["A-2", "ops"],
  ]);
  expect(modeOf("A-1")).toBe("office");
  expect(modeOf("A-2")).toBe("ops");
  expect(modeOf("A-3")).toBeUndefined();
});

test("a second pass changes nothing, even if a newer token disagrees", () => {
  seat(standing("A-1"), ["whoami", "record_decision"]);
  store.backfillStandingModes();
  // A token issued later with a different scope must not move the mode.
  store.issueToken({
    project_id: project,
    assignment_id: "A-1" as never,
    role: { role_version: 1, allowed_tools: ["whoami"] },
  });
  expect(store.backfillStandingModes()).toEqual([]);
  expect(modeOf("A-1")).toBe("office");
});

test("work-item Assignments are never touched", () => {
  const item = {
    ...standing("A-9"),
    scope: "work_item",
    work_item_id: "W-1",
  } as Assignment;
  seat(item, ["whoami", "record_decision"]);
  expect(store.backfillStandingModes()).toEqual([]);
  expect(modeOf("A-9")).toBeUndefined();
});

test("rows that already carry a mode are left exactly as they are", () => {
  seat(standing("A-1", { standing_mode: "ops" }), [
    "whoami",
    "record_decision",
  ]);
  expect(store.backfillStandingModes()).toEqual([]);
  expect(modeOf("A-1")).toBe("ops");
});

test("external rows enforce Office scope and immutable JSON across writes", () => {
  const external = standing("A-1", { standing_mode: "office", external: true });
  seat(external, ["whoami"]);
  expect(() =>
    seat({ ...external, status: "released" }, undefined),
  ).not.toThrow();
  for (const update of [
    { external: false },
    { external: undefined },
    { standing_mode: "ops" as const },
  ])
    expect(() => seat({ ...external, ...update }, undefined)).toThrow();
  seat(standing("A-2", { standing_mode: "office" }), undefined);
  expect(() =>
    seat(
      standing("A-2", { standing_mode: "office", external: true }),
      undefined,
    ),
  ).toThrow(/immutable/);
  for (const invalid of [
    standing("A-3", { external: true }),
    standing("A-3", { standing_mode: "ops", external: true }),
    {
      ...external,
      id: "A-3",
      scope: "work_item",
      work_item_id: "W-1",
      standing_mode: undefined,
    },
    { ...external, id: "A-3", external: 1 },
  ])
    expect(() => seat(invalid as Assignment, undefined)).toThrow();
  expect(store.migrate()).toEqual([]);
});

test("external migration upgrades the preceding schema without losing identity or tokens", () => {
  const previousDir = join(dataDir, "previous-migrations");
  mkdirSync(previousDir);
  const migrations = listMigrations(defaultMigrationsDir);
  expect(new Set(migrations.map((m) => m.version)).size).toBe(
    migrations.length,
  );
  expect(
    migrations.find((m) => m.name === "external_assignment")?.version,
  ).toBe(16);
  for (const migration of migrations.filter((m) => m.version < 16))
    writeFileSync(
      join(
        previousDir,
        `${String(migration.version).padStart(4, "0")}_${migration.name}.sql`,
      ),
      migration.sql,
    );
  const oldData = join(dataDir, "upgrade");
  const old = Store.open({ dataDir: oldData, migrationsDir: previousDir });
  const original = standing("A-1", { standing_mode: "office" });
  let token: string;
  try {
    old.createProject({ id: project });
    old.uow.run((tx) => tx.assignments.put(project, original));
    token = old.issueToken({
      project_id: project,
      assignment_id: original.id,
      role: { role_version: 1, allowed_tools: ["whoami"] },
    }).token;
  } finally {
    old.close();
  }
  const upgraded = Store.open({ dataDir: oldData });
  try {
    expect(upgraded.schemaVersion()).toBe(latestSchemaVersion());
    expect(upgraded.migrate()).toEqual([]);
    const applied = upgraded.database
      .prepare("SELECT version, name FROM schema_version ORDER BY version")
      .all();
    expect(applied.map((m) => [m.version, m.name])).toEqual(
      migrations.map((m) => [m.version, m.name]),
    );
    expect(
      upgraded.uow.read((tx) => tx.assignments.get(project, original.id)),
    ).toEqual(original);
    expect(upgraded.verifyToken(token)).toBeDefined();
    expect(() =>
      upgraded.uow.run((tx) =>
        tx.assignments.put(project, { ...original, external: true }),
      ),
    ).toThrow(/immutable/);
    const external = standing("A-2", {
      standing_mode: "office",
      external: true,
    });
    upgraded.uow.run((tx) => tx.assignments.put(project, external));
    expect(() =>
      upgraded.uow.run((tx) =>
        tx.assignments.put(project, { ...external, external: false }),
      ),
    ).toThrow(/immutable/);
    expect(() =>
      upgraded.uow.run((tx) =>
        tx.assignments.put(
          project,
          standing("A-3", { standing_mode: "ops", external: true }),
        ),
      ),
    ).toThrow(/standing Office/);
  } finally {
    upgraded.close();
  }
});
