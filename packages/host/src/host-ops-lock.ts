import { realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AssignmentId, ProjectId } from "@cardigan/domain";
import { RepositoryLockTimeoutError } from "@cardigan/git-service";
import type { Store } from "@cardigan/store";
import { acquireRepositoryFlock } from "./repository-lock.js";

const heldFiles = new Set<string>();
const heldMemory = new WeakMap<object, Set<string>>();

/**
 * The database lease schedules retries; it cannot fence delayed filesystem IO.
 * Hold this non-expiring mutex from before claiming through cleanup/settlement.
 * A contender skips this tick rather than taking over while old IO is pending.
 */
export async function tryHostOpsLock(
  store: Store,
  project: ProjectId,
  assignment: AssignmentId,
): Promise<(() => Promise<void>) | undefined> {
  if (
    !/^[a-zA-Z0-9_][a-zA-Z0-9._-]*$/u.test(project) ||
    !/^A-[1-9][0-9]*$/u.test(assignment)
  )
    throw new Error("Invalid host operation lock identity");
  const main = store.database
    .prepare("PRAGMA database_list")
    .all()
    .find((row) => row.name === "main");
  const database =
    typeof main?.file === "string" && main.file
      ? await realpath(main.file)
      : undefined;
  const path = database
    ? join(dirname(database), "locks", `host-ops-${project}-${assignment}.lock`)
    : undefined;
  let held = path ? heldFiles : heldMemory.get(store.database);
  if (!held) {
    held = new Set();
    heldMemory.set(store.database, held);
  }
  const key = path ?? JSON.stringify([project, assignment]);
  if (held.has(key)) return undefined;
  held.add(key);
  let release: (() => Promise<void>) | undefined;
  try {
    if (path && process.platform === "linux")
      release = await acquireRepositoryFlock(path, 1);
  } catch (error) {
    held.delete(key);
    if (error instanceof RepositoryLockTimeoutError) return undefined;
    throw error;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      await release?.();
    } finally {
      held.delete(key);
    }
  };
}
