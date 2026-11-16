import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectId } from "@cardigan/domain";
import { expect, test } from "vitest";
import {
  assertCheckAdmission,
  CheckHandoffs,
  defaultMigrationsDir,
  listMigrations,
  Store,
} from "./index.js";

test("upgrading a v27 database applies handoff once and repeated reopen preserves its fence and history", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "handoff-upgrade-"));
  const oldMigrations = join(dataDir, "v27");
  mkdirSync(oldMigrations);
  for (const migration of listMigrations(defaultMigrationsDir).filter(
    (m) => m.version <= 27,
  ))
    writeFileSync(
      join(
        oldMigrations,
        `${String(migration.version).padStart(4, "0")}_${migration.name}.sql`,
      ),
      migration.sql,
    );
  let store = Store.open({ dataDir, migrationsDir: oldMigrations });
  try {
    store.createProject({ id: "p" as ProjectId, name: "Historical fixture" });
    const project = store.getProject("p" as ProjectId);
    expect(store.schemaVersion()).toBe(27);
    expect(
      store.database
        .prepare("SELECT name FROM sqlite_master WHERE name='check_handoff'")
        .get(),
    ).toBeUndefined();
    store.close();
    store = Store.open({ dataDir });
    expect(
      store.database
        .prepare("SELECT version,name FROM schema_version WHERE version=28")
        .all(),
    ).toEqual([{ version: 28, name: "check_handoff" }]);
    const facts = new CheckHandoffs(store, "fixture-controller");
    facts.begin("p", "executor", "binding");
    facts.claim("p", "executor", 1, "binding", "holder");
    facts.hold("p", "executor", 1, "precise exit pending");
    const fence = facts.read("p", "executor");
    const history = store.database
      .prepare("SELECT * FROM check_handoff_audit ORDER BY seq")
      .all();
    const schema = store.database
      .prepare(
        "SELECT type,name,sql FROM sqlite_master WHERE name LIKE 'check_handoff%' ORDER BY name",
      )
      .all();
    for (let reopen = 0; reopen < 2; reopen++) {
      store.close();
      store = Store.open({ dataDir });
      expect(store.migrate()).toEqual([]);
      expect(store.getProject("p" as ProjectId)).toEqual(project);
      expect(
        new CheckHandoffs(store, "fixture-controller").read("p", "executor"),
      ).toEqual(fence);
      expect(() =>
        store.uow.run(() => assertCheckAdmission(store, "p", "executor")),
      ).toThrow();
      expect(
        store.database
          .prepare("SELECT * FROM check_handoff_audit ORDER BY seq")
          .all(),
      ).toEqual(history);
      expect(
        store.database
          .prepare(
            "SELECT type,name,sql FROM sqlite_master WHERE name LIKE 'check_handoff%' ORDER BY name",
          )
          .all(),
      ).toEqual(schema);
      expect(
        store.database
          .prepare("SELECT version,name FROM schema_version WHERE version=28")
          .all(),
      ).toEqual([{ version: 28, name: "check_handoff" }]);
    }
  } finally {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("admission is atomic across connections, target exclusive, and survives controller restart", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "handoff-store-"));
  let store = Store.open({ dataDir });
  const other = Store.open({ dataDir });
  try {
    for (const id of ["p", "q"]) store.createProject({ id: id as ProjectId });
    const original = new CheckHandoffs(store, "controller-1");
    const row = original.begin("p", "executor", "fixed-binding");
    expect(original.begin("p", "executor", "fixed-binding")).toEqual(row);
    expect(() =>
      other.uow.run(() => assertCheckAdmission(other, "q", "executor")),
    ).toThrow();
    expect(() =>
      new CheckHandoffs(other, "other").begin("q", "executor", "other-binding"),
    ).toThrow();
    other.uow.run(() => assertCheckAdmission(other, "q", "elsewhere"));
    const grant = original.claim("p", "executor", 1, "fixed-binding", "holder");
    store.uow.run(() => assertCheckAdmission(store, "p", "executor", grant));
    for (const altered of [
      { ...grant, generation: 0 },
      { ...grant, holder: "wrong" },
      { ...grant, controller: "wrong" },
      { ...grant, binding: "wrong" },
    ])
      expect(() =>
        other.uow.run(() =>
          assertCheckAdmission(other, "p", "executor", altered),
        ),
      ).toThrow();
    expect(() =>
      other.uow.run(() => assertCheckAdmission(other, "q", "executor", grant)),
    ).toThrow();
    expect(() =>
      other.uow.run(() => assertCheckAdmission(other, "p", "elsewhere", grant)),
    ).toThrow();
    expect(() =>
      original.claim("p", "executor", 1, "fixed-binding", "twice"),
    ).toThrow();
    store.close();
    store = Store.open({ dataDir });
    const restarted = new CheckHandoffs(store, "controller-2");
    restarted.recover();
    expect(restarted.read("p", "executor")).toMatchObject({
      generation: 2,
      phase: "held",
      holder: null,
    });
    const beforeLateAudit = store.database
      .prepare("SELECT * FROM check_handoff_audit ORDER BY seq")
      .all();
    expect(() =>
      restarted.recordAttempt(
        "p",
        "executor",
        1,
        "attempt_finished",
        "late-result",
      ),
    ).toThrow();
    expect(
      store.database
        .prepare("SELECT * FROM check_handoff_audit ORDER BY seq")
        .all(),
    ).toEqual(beforeLateAudit);
    restarted.recordAttempt(
      "p",
      "executor",
      2,
      "attempt_finished",
      "safe-current-evidence",
    );
    expect(
      other.database
        .prepare(
          "SELECT evidence FROM check_handoff_audit ORDER BY seq DESC LIMIT 1",
        )
        .get()?.evidence,
    ).toBe("safe-current-evidence");
    expect(() =>
      other.uow.run(() => assertCheckAdmission(other, "p", "executor", grant)),
    ).toThrow();
    expect(() => original.resume("p", "executor", 1, "old-proof")).toThrow();
    expect(() =>
      restarted.resume("p", "executor", 2, "failed", () => {
        throw new Error("unknown exit");
      }),
    ).toThrow();
    expect(restarted.read("p", "executor")?.phase).toBe("held");
    restarted.resume("p", "executor", 2, "exact proof");
    const audit = store.database
      .prepare("SELECT action FROM check_handoff_audit ORDER BY seq")
      .all();
    restarted.resume("p", "executor", 2, "repeat");
    expect(
      store.database
        .prepare("SELECT action FROM check_handoff_audit ORDER BY seq")
        .all(),
    ).toEqual(audit);
    other.uow.run(() => assertCheckAdmission(other, "p", "executor"));
    expect(restarted.begin("p", "executor", "new-binding").generation).toBe(3);
  } finally {
    store.close();
    other.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("failed claim proof rolls back the grant and its audit", () => {
  const store = Store.open({ dbPath: ":memory:" });
  try {
    store.createProject({ id: "p" as ProjectId });
    const facts = new CheckHandoffs(store, "controller");
    facts.begin("p", "target", "binding");
    expect(() =>
      facts.claim("p", "target", 1, "binding", "holder", () => {
        throw new Error("preparing");
      }),
    ).toThrow();
    expect(facts.read("p", "target")?.phase).toBe("draining");
    expect(
      store.database.prepare("SELECT * FROM check_handoff_audit").all(),
    ).toHaveLength(1);
  } finally {
    store.close();
  }
});
