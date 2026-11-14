import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, constants, openSync } from "node:fs";
import { isAbsolute } from "node:path";

export interface WorkerNativeConfig {
  python: string;
  helper: string;
  timeout_ms: number;
}
/** Fixed worker operations only; stdin carries trusted target data, never secrets. */
export function workerNative<T>(
  config: WorkerNativeConfig,
  operation: "identity" | "paths" | "desktop" | "artifact" | "tool",
  input: unknown,
): T {
  if (
    !isAbsolute(config.python) ||
    !isAbsolute(config.helper) ||
    !Number.isSafeInteger(config.timeout_ms) ||
    config.timeout_ms <= 0 ||
    config.timeout_ms > 2147483647
  )
    throw new Error("Invalid worker native configuration");
  try {
    return JSON.parse(
      execFileSync(config.python, ["-B", config.helper, operation], {
        input: JSON.stringify(input),
        encoding: "utf8",
        timeout: config.timeout_ms,
        maxBuffer: 1024 * 1024,
        env: { PATH: "/usr/bin:/bin" },
        stdio: ["pipe", "pipe", "ignore"],
      }),
    ) as T;
  } catch {
    throw new Error("Worker observation unavailable");
  }
}

export function observeWorkerProcess(
  config: WorkerNativeConfig,
  expected: WorkerProcessIdentity,
): WorkerProcessIdentity | null {
  try {
    const actual = workerNative<WorkerProcessIdentity | null>(
      config,
      "identity",
      {
        machine: expected.machine,
        pid: expected.pid,
        terminal: expected.terminal,
        pgid: expected.process_group,
      },
    );
    return sameWorkerProcess(expected, actual) ? actual : null;
  } catch {
    return null;
  }
}

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
const heldLocks = new Set<string>();
export function acquireWorkerLock(
  path: string,
  python: string,
  helper: string,
  budgetMs: number,
): () => void {
  if (
    !Number.isSafeInteger(budgetMs) ||
    budgetMs < 0 ||
    budgetMs > 2147483647 ||
    heldLocks.has(path) ||
    !isAbsolute(path) ||
    !python.startsWith("/") ||
    !helper.startsWith("/")
  )
    throw new Error("Invalid worker lock configuration");
  const fd = openSync(
    path,
    constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    // The installed helper checks the pinned inode, ancestors and native ACLs.
    const result = spawnSync(
      python,
      ["-B", helper, "lock", String(budgetMs), path],
      {
        stdio: ["ignore", "ignore", "ignore", fd],
        env: { PATH: "/usr/bin:/bin" },
      },
    );
    if (result.error || result.status !== 0)
      throw new Error("Worker lock unavailable");
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  heldLocks.add(path);
  let closed = false;
  return () => {
    if (!closed) {
      closed = true;
      closeSync(fd);
      heldLocks.delete(path);
    }
  };
}
