import type { DatabaseSync } from "node:sqlite";
import { type Employee, employeeNameKey } from "@cardigan/domain";
import {
  createGlobalIdAllocator,
  createGlobalRepositories,
} from "./employees.js";

/** V1b: Unicode lowercase in JS (SQLite lower() handles only ASCII). */
export function migrateEmployeeNames(db: DatabaseSync, at: string): void {
  const tx = createGlobalRepositories(db, "write");
  const ids = createGlobalIdAllocator(db);
  const employees = tx.employees.list(); // Numeric ID order decides who keeps the name.
  // Reserve original names too, so a generated suffix cannot take another person's name.
  const reserved = new Set(
    employees
      .filter((e) => e.status === "active")
      .map((e) => employeeNameKey(e.name)),
  );
  const seen = new Set<string>();
  for (const original of employees) {
    let employee: Employee = original;
    let key = employeeNameKey(employee.name);
    if (employee.status === "active") {
      if (seen.has(key)) {
        let attempt = 0;
        let name: string;
        do {
          const suffix = ` (${employee.id}${attempt ? `-${attempt}` : ""})`;
          name =
            Array.from(original.name)
              .slice(0, 40 - suffix.length)
              .join("")
              .trimEnd() + suffix;
          key = employeeNameKey(name);
          attempt++;
        } while (reserved.has(key));
        employee = { ...employee, name, updated_at: at };
        reserved.add(key);
        tx.global_events.append({
          id: ids.nextEventId(),
          seq: ids.nextEventSequence(),
          type: "employee_updated",
          actor: { kind: "system" },
          created_at: at,
          payload: {
            employee: { ...employee },
            previous_name: original.name,
            reason: "case_insensitive_name_migration",
          },
        });
      }
      seen.add(key);
    }
    tx.employees.put(employee);
  }
  db.exec(
    "CREATE UNIQUE INDEX employees_active_name ON employees(name_key) WHERE status = 'active'",
  );
}
