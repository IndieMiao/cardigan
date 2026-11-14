import { arch, platform } from "node:os";
import type { DatabaseSync } from "node:sqlite";
import { DEFAULT_RUN_LIMIT, type Machine } from "@cardigan/domain";
import { createRepositories } from "./repositories.js";
import { readRunLimit } from "./run-capacity.js";

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
