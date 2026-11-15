import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Actor, Event } from "@cardigan/domain";
import { afterEach, expect, test } from "vitest";
import {
  fixture as domainFixture,
  human,
  id,
  now,
} from "../../domain/src/commands/test-fixtures.js";
import { CheckRecoveryJournal } from "./check-recovery.js";
import { defaultMigrationsDir, listMigrations } from "./migrate.js";
import { Store } from "./store.js";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing journal fixture");
  return value;
}
const roots: string[] = [],
  stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
});
const project = human.project_id,
  card = id("card", 1),
  system: Actor = { kind: "system", project_id: project };
function fixture(store = Store.open({ dbPath: ":memory:" })) {
  stores.push(store);
  store.createProject({ id: project });
  store.uow.run((tx) => {
    for (const c of domainFixture().cards) tx.cards.put(project, c);
  });
  const journal = new CheckRecoveryJournal(store);
  const append = (type: string, payload: Event["payload"], actor = system) =>
    store.uow.run((tx) => {
      const e: Event = {
        id: tx.ids.nextEventId(),
        seq: tx.ids.nextEventSequence(project, card),
        card_id: card,
        type,
        payload,
        actor,
        created_at: now,
      };
      tx.events.append(project, e);
      return e;
    });
  const check = (status: string, actor = system) =>
    append(
      "merge_check_finished",
      { attempt_id: "attempt", candidate_sha: "a".repeat(40), status },
      actor,
    );
  const register = (actor = system) =>
    append(
      "merge_check_checkout_registered",
      {
        attempt_id: "attempt",
        candidate_sha: "a".repeat(40),
        executor_key: "executor",
        binding: {},
      },
      actor,
    );
  return { store, journal, append, check, register };
}

test("authenticated targeted projections ignore forged facts, roll back atomically and remain bounded with 10x unrelated history", () => {
  const f = fixture();
  f.check("running");
  f.register(human);
  expect(f.journal.due(project, "executor", now)).toEqual([]);
  const registration = f.register();
  f.check("failed", human);
  expect(f.journal.due(project, "executor", now)).toEqual([]);
  f.check("failed");
  const first = f.journal.due(project, "executor", now);
  expect(first).toHaveLength(1);
  for (let n = 0; n < 100; n++) f.append("unrelated_history", { value: n });
  const one = f.journal.due(project, "executor", now);
  for (let n = 0; n < 900; n++) f.append("unrelated_history", { value: n });
  expect(f.journal.due(project, "executor", now)).toEqual(one);
  expect(() =>
    f.store.uow.run(() => {
      f.journal.claim(project, required(first[0]), "2099-01-01T00:00:00.000Z");
      throw new Error("rollback");
    }),
  ).toThrow("rollback");
  expect(f.journal.get(project, registration.id)?.revision).toBe(0);
  const revision = f.store.uow.run(() =>
    f.journal.claim(project, required(first[0]), "2099-01-01T00:00:00.000Z"),
  );
  expect(revision).toBe(1);
  expect(
    f.store.uow.run(() => f.journal.claim(project, required(first[0]), now)),
  ).toBeUndefined();
  expect(f.journal.due(project, "executor", now)).toEqual([]);
  expect(() =>
    f.store.uow.run(() =>
      f.journal.recheck(
        { ...system, project_id: "other" },
        project,
        registration.id,
      ),
    ),
  ).toThrow("Unauthorized");
  f.store.uow.run(() => f.journal.recheck(human, project, registration.id));
  expect(f.journal.due(project, "executor", now)).toHaveLength(1);
  expect(
    f.store.uow.run(() =>
      f.journal.settle(
        project,
        required(first[0]),
        required(revision),
        { status: "cleaned", reason: "complete", processes: [] },
        "old",
      ),
    ),
  ).toBe(false);
  console.info(
    "C-329 query evidence",
    JSON.stringify({
      historyRows: [100, 1000],
      returnedRegistrations: [
        one.length,
        f.journal.due(project, "executor", now).length,
      ],
    }),
  );
});

test.each([30, 31])(
  "v%s migration initializes old manual outcomes once without modifying history, and restart preserves state and due time",
  (previousVersion) => {
    const root = mkdtempSync(join(tmpdir(), "cg-recovery-migration-"));
    roots.push(root);
    const migrations = join(root, `v${previousVersion}`);
    mkdirSync(migrations);
    for (const m of listMigrations(defaultMigrationsDir).filter(
      (m) => m.version <= previousVersion,
    ))
      writeFileSync(
        join(migrations, `${String(m.version).padStart(4, "0")}_${m.name}.sql`),
        m.sql,
      );
    const dbPath = join(root, "state.sqlite");
    const f = fixture(Store.open({ dbPath, migrationsDir: migrations }));
    f.check("failed");
    const registration = f.register();
    f.append("merge_check_recovery_finished", {
      registration_id: registration.id,
      attempt_id: "attempt",
      status: "manual_attention",
      reason: "unverified",
      processes: [],
    });
    f.append(
      "merge_check_recovery_finished",
      {
        registration_id: registration.id,
        status: "cleaned",
        reason: "complete",
        processes: [],
      },
      human,
    );
    const original = f.store.database
      .prepare("SELECT * FROM events ORDER BY seq")
      .all();
    stores.splice(stores.indexOf(f.store), 1);
    f.store.close();
    let store = Store.open({ dbPath });
    stores.push(store);
    let journal = new CheckRecoveryJournal(store);
    expect(journal.get(project, registration.id)).toMatchObject({
      state: "manual_attention",
      result: { status: "manual_attention", reason: "unverified" },
    });
    expect(
      store.database.prepare("SELECT * FROM events ORDER BY seq").all(),
    ).toEqual(original);
    const row = required(journal.get(project, registration.id));
    store.uow.run(() =>
      journal.claim(project, row, "2099-01-01T00:00:00.000Z"),
    );
    stores.splice(stores.indexOf(store), 1);
    store.close();
    store = Store.open({ dbPath });
    stores.push(store);
    journal = new CheckRecoveryJournal(store);
    expect(store.migrate()).toEqual([]);
    expect(journal.get(project, registration.id)).toMatchObject({
      state: "manual_attention",
      next_inspection_at: "2099-01-01T00:00:00.000Z",
      revision: 1,
    });
    expect(journal.due(project, "executor", now)).toEqual([]);
    expect(
      store.database.prepare("SELECT * FROM events ORDER BY seq").all(),
    ).toEqual(original);
  },
);
