import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Employee } from "@cardigan/domain";
import { expect, test } from "vitest";
import { migrate, Store } from "./index.js";
import { assignment, migrationsThrough } from "./test-support.js";

test("upgrading v46 scopes legacy employees once without rewriting historical assignments", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "cardigan-employee-projects-"));
  const store = Store.open({
    dataDir,
    migrationsDir: migrationsThrough(dataDir, 46),
  });
  try {
    const employee: Employee = {
      id: "E-1" as Employee["id"],
      name: "Alice",
      title: "Developer",
      bio: "",
      role_id: "coder",
      avatar: null,
      launch_profile_ref: null,
      status: "active",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    };
    const historical = assignment({ employee_id: employee.id });
    store.createProject({ id: "other" });
    store.uow.run((tx) => {
      tx.employees.put(employee);
      tx.assignments.put("other", historical);
    });
    const db = store.database;
    expect(migrate(db)).toContainEqual({
      version: 47,
      name: "employee_projects",
    });
    const read = () => store.uow.read((tx) => tx.employees.get(employee.id));
    expect(read()).toEqual({ ...employee, projects: ["cardigan"] });
    expect(
      store.uow.read((tx) => tx.assignments.get("other", historical.id)),
    ).toEqual(historical);

    store.uow.run((tx) =>
      tx.employees.put({ ...employee, projects: ["other"] }),
    );
    expect(migrate(db)).toEqual([]);
    expect(read()?.projects).toEqual(["other"]);
  } finally {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
