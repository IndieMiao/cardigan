import { readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AssignmentId, HumanActionId, ProjectId } from "@cardigan/domain";
import { RepositoryLockTimeoutError } from "@cardigan/git-service";
import type { Store } from "@cardigan/store";
import { acquireRepositoryFlock } from "./repository-lock.js";

const heldFiles = new Set<string>();
const heldMemory = new WeakMap<object, Set<string>>();
/** In-process holders of a held lock, partitioned like `held`. */
const fileHolders = new Map<string, HostOpsLockHolder>();
const memoryHolders = new WeakMap<object, Map<string, HostOpsLockHolder>>();
function holdersFor(store: Store, path: string | undefined) {
  if (path) return fileHolders;
  let map = memoryHolders.get(store.database);
  if (!map) {
    map = new Map();
    memoryHolders.set(store.database, map);
  }
  return map;
}

/**
 * C-678: who holds an Assignment's host-ops lock, when it is a human attached
 * to the terminal. A waiting host action can then name the reason instead of
 * staying silently pending. Stored beside the lock file; it never grants or
 * keeps the lock and is ignored once its process has exited.
 */
export interface HostOpsLockHolder {
  readonly kind: "attach";
  readonly mode: "interactive" | "observe";
  readonly started_at: string;
  readonly pid: number;
}

/**
 * The database lease schedules retries; it cannot fence delayed filesystem IO.
 * Hold this non-expiring mutex from before claiming through cleanup/settlement.
 * A contender skips this tick rather than taking over while old IO is pending.
 */
export async function tryHostOpsLock(
  store: Store,
  project: ProjectId,
  assignment: AssignmentId,
  scope: "host-ops" | "launch" = "host-ops",
  holder?: Omit<HostOpsLockHolder, "pid">,
): Promise<(() => Promise<void>) | undefined> {
  if (!/^A-[1-9][0-9]*$/u.test(assignment))
    throw new Error("Invalid assignment id");
  return tryScopedLock(
    store,
    project,
    assignment,
    scope,
    holder && scope === "host-ops"
      ? { ...holder, pid: process.pid }
      : undefined,
  );
}

/**
 * The attached human holding an Assignment's host-ops lock, if any. Read only
 * after a lock attempt failed; a record left by a process that has exited is
 * ignored.
 */
export async function hostOpsLockHolder(
  store: Store,
  project: ProjectId,
  assignment: AssignmentId,
): Promise<HostOpsLockHolder | undefined> {
  if (!/^A-[1-9][0-9]*$/u.test(assignment))
    throw new Error("Invalid assignment id");
  const { key, path } = await lockLocation(
    store,
    project,
    assignment,
    "host-ops",
  );
  const local = holdersFor(store, path).get(key);
  if (local) return local;
  if (!path) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(holderPath(path), "utf8"));
  } catch {
    return undefined;
  }
  const holder = validHolder(parsed);
  return holder && processAlive(holder.pid) ? holder : undefined;
}

const holderPath = (lock: string) => `${lock}.holder.json`;

function validHolder(value: unknown): HostOpsLockHolder | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  return v.kind === "attach" &&
    (v.mode === "interactive" || v.mode === "observe") &&
    typeof v.started_at === "string" &&
    !Number.isNaN(Date.parse(v.started_at)) &&
    Number.isSafeInteger(v.pid) &&
    (v.pid as number) > 0
    ? {
        kind: "attach",
        mode: v.mode,
        started_at: v.started_at,
        pid: v.pid as number,
      }
    : undefined;
}

function processAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function tryHelperConfirmationLock(
  store: Store,
  project: ProjectId,
  action: HumanActionId,
) {
  if (!/^H-[1-9][0-9]*$/u.test(action))
    throw new Error("Invalid human action id");
  return tryScopedLock(store, project, action, "helper-confirm");
}

type Scope = "host-ops" | "launch" | "helper-confirm";

async function lockLocation(
  store: Store,
  project: ProjectId,
  id: string,
  scope: Scope,
) {
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9._-]*$/u.test(project))
    throw new Error("Invalid project id");
  const main = store.database
    .prepare("PRAGMA database_list")
    .all()
    .find((row) => row.name === "main");
  const database =
    typeof main?.file === "string" && main.file
      ? await realpath(main.file)
      : undefined;
  const path = database
    ? join(dirname(database), "locks", `${scope}-${project}-${id}.lock`)
    : undefined;
  const key = path ?? JSON.stringify([scope, project, id]);
  return { path, key };
}

async function tryScopedLock(
  store: Store,
  project: ProjectId,
  id: string,
  scope: Scope,
  holder?: HostOpsLockHolder,
) {
  const { path, key } = await lockLocation(store, project, id, scope);
  let held = path ? heldFiles : heldMemory.get(store.database);
  if (!held) {
    held = new Set();
    heldMemory.set(store.database, held);
  }
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
  if (holder) {
    holdersFor(store, path).set(key, holder);
    // Best effort: without the record a waiting action reads as plain pending.
    if (path)
      await writeFile(holderPath(path), JSON.stringify(holder), {
        mode: 0o600,
      }).catch(() => {});
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      if (holder) {
        holdersFor(store, path).delete(key);
        if (path) await rm(holderPath(path), { force: true }).catch(() => {});
      }
    } finally {
      try {
        await release?.();
      } finally {
        held.delete(key);
      }
    }
  };
}
