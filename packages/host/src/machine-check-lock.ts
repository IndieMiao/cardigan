import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { acquireHostFileSlot } from "@cardigan/runtime-herdr";

/** CLI, patrol and Workbench use the same physical lock regardless of project.
 * The OS releases the flock on process exit. Never wait inside a store transaction. */
export async function withMachineCheck<T>(
  dataDir: string,
  machine: string,
  work: () => Promise<T>,
  signal?: AbortSignal,
) {
  const dir = join(dataDir, "locks");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(
    dir,
    `machine-check-${createHash("sha256").update(machine).digest("hex")}.lock`,
  );
  for (;;) {
    signal?.throwIfAborted();
    const unlock = await acquireHostFileSlot(
      path,
      1000,
      performance.now() + 5000,
      5000,
    );
    if (!unlock) continue;
    try {
      signal?.throwIfAborted();
      return await work();
    } finally {
      await unlock();
    }
  }
}
