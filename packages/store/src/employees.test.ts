import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEmployee,
  type EmployeeEffect,
  type GlobalRepositories,
  type Result,
} from "@cardigan/domain";
import { expect, test } from "vitest";
import {
  defaultMigrationsDir,
  listMigrations,
  persistEmployeeEffect,
  ReadOnlyTransactionError,
  Store,
  type StoreTransactionContext,
} from "./index.js";
import {
  assignment,
  card,
  event,
  project_id,
  withTempStore,
  workItem,
} from "./test-support.js";

const clock = { now: () => "2026-01-01T00:00:00.000Z" };
function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
function create(tx: StoreTransactionContext, name = "诸葛亮"): EmployeeEffect {
  return value(
    createEmployee(
      tx.employees.list(),
      { kind: "human" },
      { name, title: "产品经理", role_id: "pm" },
      { clock, ids: tx.global_ids },
    ),
  );
}
function add(store: Store, name = "诸葛亮") {
  return store.uow.run((tx) => {
    const effect = create(tx, name);
    persistEmployeeEffect(tx, effect);
    return effect.data;
  });
}

test("employees and audit sequence stay global across projects, connections and reopen", () => {
  withTempStore((store, dataDir) => {
    store.createProject({ id: "p-one" });
    store.createProject({ id: "p-two" });
    expect(add(store).id).toBe("E-1");
    const other = Store.open({ dataDir });
    try {
      expect(add(other, "孔明").id).toBe("E-2");
      expect(() => add(other)).toThrow("在职员工");
      expect(
        other.uow.read((tx) => tx.employees.list()).map((e) => e.id),
      ).toEqual(["E-1", "E-2"]);
      expect(
        other.uow
          .read((tx) => tx.global_events.listAfter(1))
          .map((e) => [e.seq, e.type]),
      ).toEqual([[2, "employee_created"]]);
      expect(store.getUpdates({ project_id: "p-one" }).events).toEqual([]);
      expect(store.getUpdates({ project_id: "p-two" }).events).toEqual([]);
    } finally {
      other.close();
    }
    const reopened = Store.open({ dataDir });
    try {
      expect(add(reopened, "刘备").id).toBe("E-3");
    } finally {
      reopened.close();
    }
  });
});

test("failed writes roll back employees, events and global counters together", () => {
  withTempStore((store) => {
    expect(() =>
      store.uow.run((tx) => {
        persistEmployeeEffect(tx, create(tx));
        throw new Error("abort");
      }),
    ).toThrow("abort");
    expect(store.uow.read((tx) => tx.employees.list())).toEqual([]);
    expect(store.uow.read((tx) => tx.global_events.listAfter(0))).toEqual([]);
    expect(add(store).id).toBe("E-1");
    expect(() =>
      store.uow.run((tx) => {
        const effect = create(tx, "孔明");
        persistEmployeeEffect(tx, {
          ...effect,
          events: [...effect.events, ...effect.events],
        });
      }),
    ).toThrow(/UNIQUE/);
    expect(add(store, "刘备").id).toBe("E-2");
    expect(
      store.uow.read((tx) => tx.global_events.listAfter(0)).map((e) => e.seq),
    ).toEqual([1, 2]);
  });
});

test("SQLite enforces active name uniqueness and read transactions cannot mutate globals", () => {
  withTempStore((store) => {
    const first = add(store, "诸葛 亮");
    expect(() =>
      store.uow.run((tx) =>
        tx.employees.put({
          ...first,
          id: tx.global_ids.nextEmployeeId(),
          name: "　诸葛　亮 ",
        }),
      ),
    ).toThrow(/UNIQUE/);
    store.uow.run((tx) => tx.employees.put({ ...first, status: "inactive" }));
    expect(add(store, "诸葛　亮").id).toBe("E-2");
    expect(() =>
      store.uow.read((tx) => (tx as GlobalRepositories).employees.put(first)),
    ).toThrow(ReadOnlyTransactionError);
    expect(() =>
      store.uow.read((tx) => {
        const existing = tx.global_events.listAfter(0)[0];
        if (!existing) throw new Error("missing event");
        (tx as GlobalRepositories).global_events.append(existing);
      }),
    ).toThrow(ReadOnlyTransactionError);
  });
});

test("v8 migration preserves old project data, assignments, event streams, tokens and counters", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "cardigan-employee-migration-"));
  const oldMigrations = join(dataDir, "old-migrations");
  mkdirSync(oldMigrations);
  for (const migration of listMigrations(defaultMigrationsDir).filter(
    (m) => m.version <= 8,
  )) {
    writeFileSync(
      join(
        oldMigrations,
        `${String(migration.version).padStart(4, "0")}_${migration.name}.sql`,
      ),
      migration.sql,
    );
  }
  const old = Store.open({ dataDir, migrationsDir: oldMigrations });
  let token: string;
  try {
    expect(old.schemaVersion()).toBe(8);
    old.createProject({ id: project_id });
    old.uow.run((tx) => {
      tx.cards.put(project_id, card());
      tx.work_items.put(project_id, workItem());
      tx.assignments.put(project_id, assignment());
      tx.events.append(
        project_id,
        event({ seq: tx.ids.nextEventSequence(project_id, card().id) }),
      );
      expect(tx.ids.next(project_id, "card")).toBe("C-1");
    });
    token = old.issueToken({
      project_id,
      assignment_id: assignment().id,
      role: { role_version: 1, allowed_tools: [] },
    }).token;
  } finally {
    old.close();
  }
  try {
    const upgraded = Store.open({ dataDir });
    try {
      expect(upgraded.schemaVersion()).toBe(9);
      expect(upgraded.migrate()).toEqual([]);
      expect(upgraded.getProject(project_id)?.id).toBe(project_id);
      expect(upgraded.verifyToken(token)).toBeDefined();
      upgraded.uow.read((tx) => {
        expect(tx.cards.get(project_id, card().id)).toEqual(card());
        expect(tx.work_items.get(project_id, workItem().id)).toEqual(
          workItem(),
        );
        expect(tx.assignments.get(project_id, assignment().id)).toEqual(
          assignment(),
        );
        expect(tx.events.listAfter(project_id, card().id, 0)).toHaveLength(1);
        expect(tx.employees.list()).toEqual([]);
        expect(tx.global_events.listAfter(0)).toEqual([]);
      });
      expect(upgraded.uow.run((tx) => tx.ids.next(project_id, "card"))).toBe(
        "C-2",
      );
      expect(add(upgraded).id).toBe("E-1");
      expect(
        upgraded.database
          .prepare("PRAGMA table_info(employees)")
          .all()
          .map((r) => r.name),
      ).not.toContain("project_id");
    } finally {
      upgraded.close();
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
