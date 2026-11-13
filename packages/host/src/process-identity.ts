import { readFileSync } from "node:fs";

export interface ExecutionOwner {
  readonly pid: number;
  /** Boot ID and Linux start ticks identify an incarnation, not just a PID. */
  readonly start: string;
}

/** Linux host/SSH-client process. A closed pipe makes the check supervisor cancel. */
export function executionOwner(pid: number): ExecutionOwner | undefined {
  if (!Number.isSafeInteger(pid) || pid < 1)
    throw new Error("Invalid execution PID");
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat
      .slice(stat.lastIndexOf(") ") + 2)
      .trim()
      .split(/\s+/u);
    if (["Z", "X"].includes(fields[0] ?? "")) return undefined;
    const ticks = fields[19];
    if (!ticks || !/^\d+$/u.test(ticks))
      throw new Error("Invalid execution identity");
    const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return { pid, start: `${boot}:${ticks}` };
  } catch (error) {
    if (
      ["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")
    )
      return undefined;
    throw error;
  }
}
