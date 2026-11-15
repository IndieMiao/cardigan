import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { defaultMigrationsDir, listMigrations } from "./migrate.js";
import { Store } from "./store.js";

const key = {
  project_id: "p" as never,
  card_id: "C-1" as never,
  attempt_id: "attempt-1",
  assignment_id: "A-1" as never,
};

test("committed debits survive connection changes and restart, without cross-account leakage", () => {
  const dir = mkdtempSync(join(tmpdir(), "cg-log-debits-"));
  let a = Store.open({ dataDir: dir });
  const b = Store.open({ dataDir: dir });
  const debit = (store: Store, account = key) =>
    store.withCheckLogBudget(account, 10, (remaining) => ({
      bytes: Math.min(6, remaining),
      value: remaining,
    }));
  try {
    expect(debit(a)).toBe(10);
    expect(debit(b)).toBe(4);
    a.close();
    a = Store.open({ dataDir: dir });
    expect(debit(a)).toBe(0);
    for (const account of [
      { ...key, project_id: "other" as never },
      { ...key, card_id: "C-2" as never },
      { ...key, attempt_id: "another" },
      { ...key, assignment_id: "A-2" as never },
    ])
      expect(debit(b, account)).toBe(10);
    // A configuration decrease cannot refund an already committed debit.
    expect(
      a.withCheckLogBudget(key, 5, (remaining) => ({
        bytes: 0,
        value: remaining,
      })),
    ).toBe(0);
  } finally {
    a.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("failed authorization, invalid debit and callback errors roll back completely", () => {
  const store = Store.open({ dbPath: ":memory:" });
  try {
    for (const operation of [
      () => {
        throw new Error("authorization failed");
      },
      () => ({ bytes: 11, value: "overspend" }),
      () => ({ bytes: -1, value: "refund" }),
    ])
      expect(() => store.withCheckLogBudget(key, 10, operation)).toThrow();
    expect(
      store.database.prepare("SELECT * FROM check_log_debits").all(),
    ).toEqual([]);
    expect(
      store.withCheckLogBudget(key, 10, (remaining) => ({
        bytes: 3,
        value: remaining,
      })),
    ).toBe(10);
  } finally {
    store.close();
  }
});

test("upgrading the published v31 schema preserves migration history and bell index while adding the log ledger once", () => {
  const dir = mkdtempSync(join(tmpdir(), "cg-log-upgrade-v31-"));
  const oldMigrations = join(dir, "published-v31");
  mkdirSync(oldMigrations);
  for (const migration of listMigrations(defaultMigrationsDir).filter(
    (m) => m.version <= 31,
  ))
    writeFileSync(
      join(
        oldMigrations,
        `${String(migration.version).padStart(4, "0")}_${migration.name}.sql`,
      ),
      migration.sql,
    );
  let store = Store.open({ dataDir: dir, migrationsDir: oldMigrations });
  try {
    const history = store.database
      .prepare("SELECT * FROM schema_version ORDER BY version")
      .all();
    const index = store.database
      .prepare(
        "SELECT sql FROM sqlite_master WHERE name='bell_attempt_run_history'",
      )
      .get();
    expect(index).toBeDefined();
    expect(
      store.database
        .prepare("SELECT 1 FROM sqlite_master WHERE name='check_log_debits'")
        .get(),
    ).toBeUndefined();
    store.close();
    store = Store.open({ dataDir: dir });
    expect(
      store.database
        .prepare("SELECT name FROM schema_version WHERE version=32")
        .get(),
    ).toEqual({ name: "check_log_debits" });
    expect(
      store.database
        .prepare(
          "SELECT * FROM schema_version WHERE version<=31 ORDER BY version",
        )
        .all(),
    ).toEqual(history);
    expect(
      store.database
        .prepare(
          "SELECT sql FROM sqlite_master WHERE name='bell_attempt_run_history'",
        )
        .get(),
    ).toEqual(index);
    store.withCheckLogBudget(key, 10, () => ({ bytes: 3, value: undefined }));
    expect(store.migrate()).toEqual([]);
    store.close();
    store = Store.open({ dataDir: dir });
    expect(store.migrate()).toEqual([]);
    expect(
      store.withCheckLogBudget(key, 10, (remaining) => ({
        bytes: 0,
        value: remaining,
      })),
    ).toBe(7);
    expect(
      store.database
        .prepare(
          "SELECT * FROM schema_version WHERE version<=31 ORDER BY version",
        )
        .all(),
    ).toEqual(history);
    expect(
      store.database
        .prepare(
          "SELECT sql FROM sqlite_master WHERE name='bell_attempt_run_history'",
        )
        .get(),
    ).toEqual(index);
  } finally {
    if (store.database.isOpen) store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
