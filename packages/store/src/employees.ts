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
import type { SnapshotTransaction } from "./command-snapshots.js";
import { createMemberRepository } from "./members.js";
import { ReadOnlyTransactionError } from "./read-only.js";
import { prepare } from "./statements.js";
import { newUlid } from "./ulid.js";

export interface ReadGlobalRepositories {
  readonly members: Pick<GlobalRepositories["members"], "get" | "list">;
  readonly employees: Pick<
    GlobalRepositories["employees"],
    "get" | "list" | "assignmentActivity"
  >;
  readonly global_events: Pick<
    GlobalRepositories["global_events"],
    "listAfter"
  >;
}

export function createGlobalRepositories(
  db: DatabaseSync,
  mode: "read" | "write",
  snapshots?: SnapshotTransaction,
): GlobalRepositories {
  function writable(operation: string): void {
    if (mode === "read") throw new ReadOnlyTransactionError(operation);
  }
  const employee = (row: { doc: string }): Employee =>
    JSON.parse(row.doc) as Employee;
  return {
    members: createMemberRepository(db, mode),
    employees: {
      assignmentActivity: () =>
        snapshots
          ? snapshots.global(["employees", "assignment_activity"], () =>
              prepare(
                db,
                `SELECT e.id AS employee_id, MAX(a.last_assigned_at) AS last_assigned_at,
          COALESCE(SUM(a.unfinished_runs), 0) AS unfinished_runs,
          COALESCE(MAX(a.external_standing), 0) AS has_external_standing_assignment
          FROM employees e LEFT JOIN assignment_activity a ON a.employee_id = e.id GROUP BY e.id`,
              )
                .all()
                .map((row) => ({
                  employee_id: row.employee_id as Employee["id"],
                  last_assigned_at: row.last_assigned_at as string | null,
                  unfinished_runs: Number(row.unfinished_runs),
                  has_external_standing_assignment:
                    Number(row.has_external_standing_assignment) === 1,
                })),
            )
          : prepare(
              db,
              `
        SELECT e.id AS employee_id,
          MAX(json_extract(a.doc, '$.created_at')) AS last_assigned_at,
          COUNT(r.id) AS unfinished_runs,
          MAX(CASE WHEN json_extract(a.doc, '$.scope') = 'standing'
            AND json_extract(a.doc, '$.external') = 1
            AND json_extract(a.doc, '$.status') != 'released'
            THEN 1 ELSE 0 END) AS has_external_standing_assignment
        FROM employees e
        LEFT JOIN assignments a ON json_extract(a.doc, '$.employee_id') = e.id
        LEFT JOIN runs r ON r.project_id = a.project_id AND r.assignment_id = a.id
          AND json_extract(r.doc, '$.status') NOT IN ('completed', 'failed', 'cancelled')
        GROUP BY e.id
      `,
            )
              .all()
              .map((row) => ({
                employee_id: row.employee_id as Employee["id"],
                last_assigned_at: row.last_assigned_at as string | null,
                unfinished_runs: Number(row.unfinished_runs),
                has_external_standing_assignment:
                  Number(row.has_external_standing_assignment) === 1,
              })),
      get: (id) => {
        const row = prepare(db, "SELECT doc FROM employees WHERE id = ?").get(
          id,
        ) as { doc: string } | undefined;
        return row === undefined ? undefined : employee(row);
      },
      list: () =>
        prepare(
          db,
          "SELECT doc FROM employees ORDER BY CAST(substr(id, 3) AS INTEGER)",
        )
          .all()
          .map((row) => employee(row as { doc: string })),
      put: (value) => {
        writable("employees.put");
        // All repository writes hold BEGIN IMMEDIATE: check and write cannot
        // race another connection. Keep inactive employees in the reservation.
        if (
          value.avatar?.startsWith("library:") &&
          prepare(
            db,
            "SELECT id FROM employees WHERE id != ? AND json_extract(doc, '$.avatar') = ? LIMIT 1",
          ).get(value.id, value.avatar)
        )
          throw new Error("人物已被其他员工使用，在职和离职员工均占用人物");
        prepare(
          db,
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
        prepare(db, "SELECT doc FROM global_events WHERE seq > ? ORDER BY seq")
          .all(seq)
          .map((row) => JSON.parse(row.doc as string) as GlobalEvent),
      append: (event) => {
        writable("global_events.append");
        prepare(
          db,
          "INSERT INTO global_events (id, seq, type, doc) VALUES (?, ?, ?, ?)",
        ).run(event.id, event.seq, event.type, JSON.stringify(event));
      },
    },
  };
}

/** Allocations share the employee/event write transaction; no project argument exists. */
export function createGlobalIdAllocator(db: DatabaseSync): GlobalIdAllocator {
  function next(kind: string): number {
    const row = prepare(
      db,
      "INSERT INTO global_counters (kind, value) VALUES (?, 1) ON CONFLICT(kind) DO UPDATE SET value = value + 1 RETURNING value",
    ).get(kind);
    return Number(row?.value);
  }
  return {
    nextMemberId: () => {
      const result = formatId("member", next("member"));
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    },
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
