import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { executionOwner } from "./process-identity.js";

/** Observer identity, never the remote execution target or a user-supplied name. */
export function capacityMachine(): string {
  const id = readFileSync("/etc/machine-id", "utf8").trim();
  if (!/^[a-f0-9]{32}$/iu.test(id))
    throw new Error("Machine identity unavailable");
  return createHash("sha256").update(id).digest("hex");
}

export interface CapacityOwnerRow {
  readonly owner_pid: number | bigint;
  readonly owner_start: string;
  readonly owner_machine: string | null;
}

/** Unknown is occupied. A PID miss is evidence only on the owning machine/boot. */
export function capacityOwnerState(
  row: CapacityOwnerRow,
): "alive" | "dead" | "unknown" {
  try {
    const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const uuid = "[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}";
    const identity = new RegExp(`^(${uuid}):(\\d+)$`, "u").exec(
      row.owner_start,
    );
    if (!identity || !new RegExp(`^${uuid}$`, "u").test(boot)) return "unknown";
    if (row.owner_machine) {
      if (row.owner_machine !== capacityMachine()) return "unknown";
      if (identity[1] !== boot) return "dead";
    } else if (identity[1] !== boot) return "unknown";
    const owner = executionOwner(Number(row.owner_pid));
    return owner?.start === row.owner_start ? "alive" : "dead";
  } catch {
    return "unknown";
  }
}
