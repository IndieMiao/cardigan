import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import {
  type RepositoryLock,
  type RepositoryLockKey,
  RepositoryLockTimeoutError,
  repositoryLock,
} from "@cardigan/git-service";

/** Host-owned lock file per project; Agents never write under `<dataDir>/locks`. */
export function repositoryLockPath(dataDir: string, project_id: string) {
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9._-]*$/u.test(project_id))
    throw new Error("Invalid project path component");
  return join(dataDir, "locks", `repo-${project_id}.lock`);
}

export type FlockRunner = (
  args: readonly string[],
  fd: number,
) => Promise<number | null>;

const runFlock: FlockRunner = (args, fd) =>
  new Promise((resolve, reject) => {
    // The child inherits the open file description as fd 3: flock(2) locks
    // belong to that description, so the host keeps the lock after the child
    // exits and releases it by closing its own handle.
    const child = spawn("flock", [...args], {
      stdio: ["ignore", "ignore", "ignore", fd],
      env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
    });
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });

/**
 * Cross-process layer: `flock --exclusive --wait` on a host-owned lock file,
 * like the merge gate. Exit 1 is flock's timeout and is retryable.
 */
export async function acquireRepositoryFlock(
  path: string,
  waitMs: number,
  run: FlockRunner = runFlock,
): Promise<() => Promise<void>> {
  await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
  const handle = await open(
    path,
    constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const seconds = Math.max(0.001, waitMs / 1000).toFixed(3);
    const code = await run(["--exclusive", "--wait", seconds, "3"], handle.fd);
    if (code === 1) throw new RepositoryLockTimeoutError(waitMs);
    if (code !== 0) throw new Error(`flock exited with ${code}`);
  } catch (error) {
    await handle.close();
    throw error;
  }
  return () => handle.close();
}

/**
 * The project's base-clone lock: an in-process queue, then flock across host
 * processes (server loops, CLI). Linux only for the flock layer, as with the
 * merge gate; elsewhere the in-process queue still applies.
 */
export function hostRepositoryLock(
  dataDir: string,
  options: { waitMs?: number; run?: FlockRunner } = {},
): RepositoryLock {
  const flock = process.platform === "linux";
  return repositoryLock({
    ...(options.waitMs === undefined ? {} : { waitMs: options.waitMs }),
    ...(flock
      ? {
          acquire: (key: RepositoryLockKey, remainingMs: number) =>
            acquireRepositoryFlock(
              repositoryLockPath(dataDir, key.project_id),
              remainingMs,
              options.run,
            ),
        }
      : {}),
  });
}
