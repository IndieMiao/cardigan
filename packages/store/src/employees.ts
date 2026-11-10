import type { DatabaseSync } from "node:sqlite";
import {
  type Employee,
  type EmployeeEffect,
  type EventId,
  employeeNameKey,
  formatId,
  type GlobalEvent,
  type GlobalIdAllocator,
  type GlobalRepositories,
} from "@cardigan/domain";
import { ReadOnlyTransactionError } from "./read-only.js";
import { newUlid } from "./ulid.js";

export interface ReadGlobalRepositories {
  readonly employees: Pick<GlobalRepositories["employees"], "get" | "list">;
  readonly global_events: Pick<
    GlobalRepositories["global_events"],
    "listAfter"
  >;
}

export function createGlobalRepositories(
  db: DatabaseSync,
  mode: "read" | "write",
): GlobalRepositories {
  function writable(operation: string): void {
    if (mode === "read") throw new ReadOnlyTransactionError(operation);
  }
  const employee = (row: { doc: string }): Employee =>
    JSON.parse(row.doc) as Employee;
  return {
    employees: {
      get: (id) => {
        const row = db
          .prepare("SELECT doc FROM employees WHERE id = ?")
          .get(id) as { doc: string } | undefined;
        return row === undefined ? undefined : employee(row);
      },
      list: () =>
        db
          .prepare(
            "SELECT doc FROM employees ORDER BY CAST(substr(id, 3) AS INTEGER)",
          )
          .all()
          .map((row) => employee(row as { doc: string })),
      put: (value) => {
        writable("employees.put");
        db.prepare(
          "INSERT INTO employees (id, name_key, status, doc) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name_key = excluded.name_key, status = excluded.status, doc = excluded.doc",
        ).run(
          value.id,
          employeeNameKey(value.name),
          value.status,
          JSON.stringify(value),
        );
      },
    },
    global_events: {
      listAfter: (seq) =>
        db
          .prepare("SELECT doc FROM global_events WHERE seq > ? ORDER BY seq")
          .all(seq)
          .map((row) => JSON.parse(row.doc as string) as GlobalEvent),
      append: (event) => {
        writable("global_events.append");
        db.prepare(
          "INSERT INTO global_events (id, seq, type, doc) VALUES (?, ?, ?, ?)",
        ).run(event.id, event.seq, event.type, JSON.stringify(event));
      },
    },
  };
}

/** Allocations share the employee/event write transaction; no project argument exists. */
export function createGlobalIdAllocator(db: DatabaseSync): GlobalIdAllocator {
  function next(kind: string): number {
    const row = db
      .prepare(
        "INSERT INTO global_counters (kind, value) VALUES (?, 1) ON CONFLICT(kind) DO UPDATE SET value = value + 1 RETURNING value",
      )
      .get(kind);
    return Number(row?.value);
  }
  return {
    nextEmployeeId: () => {
      const result = formatId("employee", next("employee"));
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    },
    nextEventId: () => newUlid() as EventId,
    nextEventSequence: () => next("event"),
  };
}

export function persistEmployeeEffect(
  tx: GlobalRepositories,
  effect: EmployeeEffect,
): void {
  for (const employee of effect.employees) tx.employees.put(employee);
  for (const event of effect.events) tx.global_events.append(event);
}
