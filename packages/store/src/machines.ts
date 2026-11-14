import { arch, platform } from "node:os";
import type { DatabaseSync } from "node:sqlite";
import { DEFAULT_RUN_LIMIT, type Machine } from "@cardigan/domain";
import { createRepositories } from "./repositories.js";
import { readRunLimit } from "./run-capacity.js";

/**
 * Replace only the shared description under the caller's write transaction.
 * Stage the existing project projections in memory so immediate consistency
 * triggers can validate the new set without disabling any constraint. Readers
 * on other connections see the old set until the transaction (including audit)
 * commits. The savepoint also protects callers that catch a constraint error.
 */
export function updateMachineDescription(
  db: DatabaseSync,
  description: Pick<Machine, "id" | "label" | "os" | "arch">,
): readonly { project_id: string; machine: Machine }[] {
  if (!db.isTransaction)
    throw new Error("Machine description update requires a write transaction");
  const projections = db
    .prepare(
      "SELECT project_id, doc FROM machines WHERE id = ? ORDER BY project_id",
    )
    .all(description.id)
    .map((row) => ({
      project_id: String(row.project_id),
      machine: {
        ...(JSON.parse(String(row.doc)) as Machine),
        label: description.label,
        os: description.os,
        arch: description.arch,
      },
    }));
  db.exec("SAVEPOINT machine_description");
  try {
    db.prepare("DELETE FROM machines WHERE id = ?").run(description.id);
    const tx = createRepositories(db);
    for (const projection of projections)
      tx.machines.put(projection.project_id, projection.machine);
    db.exec("RELEASE machine_description");
    return projections;
  } catch (error) {
    db.exec("ROLLBACK TO machine_description; RELEASE machine_description");
    throw error;
  }
}

/** Called inside migration/project-creation transactions; never rewrites history. */
export function seedLocalMachine(
  db: DatabaseSync,
  project: string,
  now: string,
): void {
  const tx = createRepositories(db);
  if (tx.machines.get(project, "local")) return;
  const existing = db
    .prepare("SELECT doc FROM machines WHERE id = 'local' LIMIT 1")
    .get();
  const known = existing
    ? (JSON.parse(String(existing.doc)) as Machine)
    : undefined;
  const machine: Machine = {
    id: "local",
    label: known?.label ?? "local",
    herdr_machine: "local",
    os: known?.os ?? platform(),
    arch: known?.arch ?? arch(),
    tags: [],
    max_assignments: readRunLimit(db, "local")?.limit ?? DEFAULT_RUN_LIMIT,
    status: "online",
    last_seen: now,
  };
  tx.machines.put(project, machine);
}
