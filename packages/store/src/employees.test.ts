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
  latestSchemaVersion,
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
          .read((tx) => tx.global_events.listAfter(2))
          .map((e) => [e.seq, e.type]),
      ).toEqual([[3, "employee_created"]]);
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
    expect(store.uow.read((tx) => tx.global_events.listAfter(1))).toEqual([]);
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
    ).toEqual([1, 2, 3]);
  });
});

test("library occupancy is global across connections and enforced for repository writes including inactive employees", () => {
  withTempStore((store, dataDir) => {
    const first = add(store);
    store.uow.run((tx) =>
      tx.employees.put({
        ...first,
        avatar: "library:guan-yu",
        status: "inactive",
      }),
    );
    const other = Store.open({ dataDir });
    try {
      expect(() =>
        other.uow.run((tx) => {
          const effect = value(
            createEmployee(
              tx.employees.list(),
              { kind: "human" },
              {
                name: "另一个名字",
                title: "开发",
                role_id: "coder",
                avatar: "library:guan-yu",
              },
              { clock, ids: tx.global_ids },
            ),
          );
          persistEmployeeEffect(tx, effect);
        }),
      ).toThrow("人物已被员工");
      expect(() =>
        other.uow.run((tx) =>
          tx.employees.put({
            ...first,
            id: tx.global_ids.nextEmployeeId(),
            name: "直接存储",
            avatar: "library:guan-yu",
          }),
        ),
      ).toThrow("人物已被其他员工");
      expect(other.uow.read((tx) => tx.employees.list())).toHaveLength(1);
      expect(
        other.uow.read((tx) => tx.global_events.listAfter(1)),
      ).toHaveLength(1);
      expect(add(other, "未占用").id).toBe("E-2");
    } finally {
      other.close();
    }
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
    expect(old.schemaVersion()).toBe(latestSchemaVersion(oldMigrations));
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
      expect(upgraded.schemaVersion()).toBe(latestSchemaVersion());
      expect(upgraded.migrate()).toEqual([]);
      expect(upgraded.getProject(project_id)?.id).toBe(project_id);
      expect(upgraded.verifyToken(token)).toBeDefined();
      upgraded.uow.read((tx) => {
        expect(tx.cards.get(project_id, card().id)).toEqual({
          ...card(),
          template_version: 1,
          flow_version: 1,
        });
        expect(tx.work_items.get(project_id, workItem().id)).toEqual(
          workItem(),
        );
        expect(tx.assignments.get(project_id, assignment().id)).toEqual(
          assignment(),
        );
        expect(tx.events.listAfter(project_id, card().id, 0)).toHaveLength(1);
        expect(tx.employees.list()).toEqual([]);
        expect(tx.global_events.listAfter(1)).toEqual([]);
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

test("v9 case-insensitive migration resolves collisions, preserves identities/status and audits each rename once", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "cardigan-name-migration-"));
  const oldMigrations = join(dataDir, "v9");
  mkdirSync(oldMigrations);
  for (const m of listMigrations(defaultMigrationsDir).filter(
    (m) => m.version <= 9,
  ))
    writeFileSync(
      join(
        oldMigrations,
        `${String(m.version).padStart(4, "0")}_${m.name}.sql`,
      ),
      m.sql,
    );
  try {
    const old = Store.open({ dataDir, migrationsDir: oldMigrations });
    try {
      for (const [i, name] of [
        "Alice",
        "alice",
        "alice (E-2)",
        "Änne",
        "änne",
        "ALICE",
      ].entries()) {
        // Reproduce v9 name_key, before JS normalization changed in this version.
        const e = {
          id: `E-${i + 1}`,
          name,
          title: "Dev",
          bio: "",
          avatar: null,
          role_id: "coder",
          launch_profile_ref: null,
          status: i === 5 ? "inactive" : "active",
          created_at: clock.now(),
          updated_at: clock.now(),
        };
        old.database
          .prepare(
            "INSERT INTO employees (id, name_key, status, doc) VALUES (?, ?, ?, ?)",
          )
          .run(e.id, name, e.status, JSON.stringify(e));
      }
      old.database
        .prepare(
          "INSERT INTO global_counters (kind, value) VALUES ('employee', 6)",
        )
        .run();
    } finally {
      old.close();
    }
    const upgraded = Store.open({ dataDir });
    try {
      const employees = upgraded.uow.read((tx) => tx.employees.list());
      expect(employees.map((e) => e.name)).toEqual([
        "Alice",
        "alice (E-2-1)",
        "alice (E-2)",
        "Änne",
        "änne (E-5)",
        "ALICE",
      ]);
      expect(employees.map((e) => e.status)).toEqual([
        "active",
        "active",
        "active",
        "active",
        "active",
        "inactive",
      ]);
      const events = upgraded.uow.read((tx) => tx.global_events.listAfter(0));
      expect(events).toHaveLength(3);
      expect(events[0]).toMatchObject({
        actor: { kind: "system" },
        payload: {
          previous_name: "alice",
          reason: "case_insensitive_name_migration",
        },
      });
      expect(upgraded.migrate()).toEqual([]);
      expect(upgraded.uow.read((tx) => tx.global_events.listAfter(0))).toEqual(
        events,
      );
      expect(() => add(upgraded, "ALIce")).toThrow("在职员工");
      expect(() => add(upgraded, "ÄNNE")).toThrow("在职员工");
      expect(add(upgraded, "Bob").id).toBe("E-7");
    } finally {
      upgraded.close();
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("employee activity spans projects without confusing project-local Assignment IDs", () => {
  withTempStore((store) => {
    const e = add(store);
    for (const project of ["one", "two"]) {
      store.createProject({ id: project });
      store.uow.run((tx) => {
        tx.assignments.put(
          project,
          assignment({
            employee_id: e.id,
            created_at: project === "one" ? "2026-01-01" : "2026-01-02",
          }),
        );
        tx.runs.put(project, {
          id: "R-1" as never,
          assignment_id: assignment().id,
          trigger_event_id: event({ seq: 1 }).id,
          kind: "initial",
          status: project === "one" ? "unknown" : "completed",
          role_version: 1,
          model: "fixture",
          agent_cli_version: "1",
          outcome: null,
          summary: "",
        });
      });
    }
    expect(store.uow.read((tx) => tx.employees.assignmentActivity?.())).toEqual(
      [
        {
          employee_id: e.id,
          last_assigned_at: "2026-01-02",
          unfinished_runs: 1,
          active_assignments: 2,
          has_external_standing_assignment: false,
        },
      ],
    );
    expect(() =>
      store.uow.run((tx) =>
        tx.assignments.put(
          "one",
          assignment({ employee_id: "E-999" as never }),
        ),
      ),
    ).toThrow("employee_id is immutable");
    expect(() =>
      store.uow.run((tx) => tx.assignments.put("one", assignment())),
    ).toThrow("employee_id is immutable");
    store.uow.run((tx) =>
      tx.assignments.put(
        "one",
        assignment({ employee_id: e.id, status: "released" }),
      ),
    );
    expect(
      store.uow.read((tx) => tx.assignments.get("one", assignment().id))
        ?.employee_id,
    ).toBe(e.id);
  });
});

test("employee activity tracks unreleased external standing bindings across projects", () => {
  withTempStore((store) => {
    const e = add(store);
    store.createProject({ id: "external-project" });
    const { work_item_id: _workItem, ...base } = assignment();
    for (const status of ["active", "suspended", "released"] as const) {
      store.uow.run((tx) =>
        tx.assignments.put("external-project", {
          ...base,
          scope: "standing",
          standing_mode: "office",
          employee_id: e.id,
          external: true,
          status,
        }),
      );
      expect(
        store.uow.read((tx) => tx.employees.assignmentActivity?.())?.[0],
      ).toMatchObject({
        employee_id: e.id,
        unfinished_runs: 0,
        has_external_standing_assignment: status !== "released",
      });
    }
  });
});
