import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { assertCheckAdmission, CheckHandoffs } from "./check-handoff.js";
import { readContextSamples, writeContextSamples } from "./context-samples.js";
import { defaultMigrationsDir, listMigrations } from "./migrate.js";
import { Store } from "./store.js";
import { latestSchemaVersion } from "./test-support.js";
import {
  readUpstreamProbeSample,
  writeUpstreamProbeSample,
} from "./upstream-probe-samples.js";

test("released handoff migration identity is unchanged and projection versions are distinct", () => {
  const migrations = listMigrations(defaultMigrationsDir);
  expect(new Set(migrations.map((m) => m.version)).size).toBe(
    migrations.length,
  );
  expect(
    migrations
      // These published projection slots stay fixed; later releases may append migrations.
      .filter((m) => m.version >= 28 && m.version <= 30)
      .map(({ version, name }) => ({ version, name })),
  ).toEqual([
    { version: 28, name: "check_handoff" },
    { version: 29, name: "context_samples" },
    { version: 30, name: "upstream_probe_samples" },
  ]);
  // Published in 9afbd6af67a1eedf61485686faeae07a2e108727; never renumber/rewrite it.
  const released = migrations.find((m) => m.version === 28);
  expect(
    createHash("sha256")
      .update(released?.sql ?? "")
      .digest("hex"),
  ).toBe("5a8c3cdc0213c5ba1415740e3e74d4ec2fde546d49b24cd29cdc554de156b97c");
});

test("v28 upgrade preserves a nonempty handoff fence, generation and audit while adding projections exactly once", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "cg-c248-v28-"));
  const oldMigrations = join(dataDir, "v28");
  mkdirSync(oldMigrations);
  for (const migration of listMigrations(defaultMigrationsDir).filter(
    (m) => m.version <= 28,
  ))
    writeFileSync(
      join(
        oldMigrations,
        `${String(migration.version).padStart(4, "0")}_${migration.name}.sql`,
      ),
      migration.sql,
    );
  let store = Store.open({ dataDir, migrationsDir: oldMigrations });
  const project = "fixture";
  try {
    store.createProject({ id: project, name: "Published state" });
    const facts = new CheckHandoffs(store, "previous-controller");
    facts.begin(project, "executor", "fixed-binding");
    facts.claim(project, "executor", 1, "fixed-binding", "previous-holder");
    facts.recordAttempt(
      project,
      "executor",
      1,
      "attempt_progress",
      "synthetic original evidence",
    );
    facts.hold(project, "executor", 1, "precise exit remains unconfirmed");
    const fence = facts.read(project, "executor");
    const history = store.database
      .prepare("SELECT * FROM check_handoff_audit ORDER BY seq")
      .all();
    const releasedVersion = store.database
      .prepare("SELECT * FROM schema_version WHERE version = 28")
      .get();
    const originalSchema = store.database
      .prepare(
        "SELECT type,name,sql FROM sqlite_master WHERE name LIKE 'check_handoff%' ORDER BY name",
      )
      .all();
    store.close();
    store = Store.open({ dataDir });
    expect(store.schemaVersion()).toBe(latestSchemaVersion());
    const probe = {
      provider: "fixture",
      group: "fixture",
      status: "unreachable" as const,
      checked_at: "2026-01-01T00:00:00Z",
      last_failure_at: "2026-01-01T00:00:00Z",
      failure: "connection_error" as const,
    };
    writeContextSamples(store, project, []);
    writeUpstreamProbeSample(store, "configuration", probe);
    const versions = store.database
      .prepare("SELECT * FROM schema_version ORDER BY version")
      .all();
    for (let reopen = 0; reopen < 2; reopen++) {
      store.close();
      store = Store.open({ dataDir });
      expect(store.migrate()).toEqual([]);
      expect(
        new CheckHandoffs(store, "reader").read(project, "executor"),
      ).toEqual(fence);
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
      ).toEqual(originalSchema);
      expect(
        store.database
          .prepare("SELECT * FROM schema_version WHERE version = 28")
          .get(),
      ).toEqual(releasedVersion);
      expect(
        store.database
          .prepare("SELECT * FROM schema_version ORDER BY version")
          .all(),
      ).toEqual(versions);
      expect(readContextSamples(store, project)).toEqual([]);
      expect(
        readUpstreamProbeSample(store, "fixture", "configuration"),
      ).toEqual(probe);
      expect(() =>
        store.uow.run(() => assertCheckAdmission(store, project, "executor")),
      ).toThrow();
    }
  } finally {
    if (store.database.isOpen) store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
