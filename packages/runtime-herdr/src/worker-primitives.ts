import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
} from "node:fs";
import { dirname } from "node:path";

export interface WorkerProcessIdentity {
  machine: string;
  boot: string;
  uid: number;
  pid: number;
  start: string;
  process_group: number;
  terminal: string;
}
export function sameWorkerProcess(
  expected: WorkerProcessIdentity,
  actual: WorkerProcessIdentity | null,
): boolean {
  return (
    actual !== null &&
    Object.entries(expected).every(
      ([key, value]) => actual[key as keyof WorkerProcessIdentity] === value,
    ) &&
    [expected.machine, expected.boot, expected.start, expected.terminal].every(
      (v) => typeof v === "string" && v.length > 0,
    ) &&
    [expected.uid, expected.pid, expected.process_group].every(
      (v) => Number.isSafeInteger(v) && v > 0,
    )
  );
}

/** The administrator preinstalls the empty inode in a non-writable namespace. */
export function acquireWorkerLock(
  path: string,
  python: string,
  helper: string,
  budgetMs: number,
): () => void {
  if (
    !Number.isSafeInteger(budgetMs) ||
    budgetMs < 0 ||
    !python.startsWith("/") ||
    !helper.startsWith("/")
  )
    throw new Error("Invalid worker lock configuration");
  let parent = dirname(path);
  while (true) {
    const entry = lstatSync(parent);
    if (
      !entry.isDirectory() ||
      entry.uid !== 0 ||
      entry.mode & 0o022 ||
      realpathSync(parent) !== parent
    )
      throw new Error("Unsafe worker lock namespace");
    if (parent === "/") break;
    parent = dirname(parent);
  }
  const fd = openSync(
    path,
    constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const entry = fstatSync(fd);
    if (
      !entry.isFile() ||
      entry.nlink !== 1 ||
      entry.uid !== 0 ||
      entry.size !== 0 ||
      entry.mode & 0o007
    )
      throw new Error("Unsafe worker lock inode");
    const result = spawnSync(python, ["-B", helper, "lock", String(budgetMs)], {
      stdio: ["ignore", "ignore", "ignore", fd],
      env: { PATH: "/usr/bin:/bin" },
    });
    if (result.error || result.status !== 0)
      throw new Error("Worker lock unavailable");
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  let closed = false;
  return () => {
    if (!closed) {
      closed = true;
      closeSync(fd);
    }
  };
}
