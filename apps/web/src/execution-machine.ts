import type { ExecutionAssignment, ExecutionData, RunView } from "./api.js";

type Machines = ExecutionData["machines"];
/** Prefer the registered runtime binding; runtime_machine can be a display name. */
export function assignmentMachine(
  a: ExecutionAssignment,
  machines: Machines,
): string {
  return (
    a.runtime_ref?.machine_id ||
    (machines.some((m) => m.id === a.runtime_ref?.runtime_machine)
      ? a.runtime_ref?.runtime_machine
      : undefined) ||
    a.machine_id ||
    a.runtime_ref?.runtime_machine ||
    ""
  );
}
export function machineLabel(id: string, machines: Machines): string {
  return machines.find((m) => m.id === id)?.label || id || "未记录";
}
/** A finished Run must never inherit a later session's location. */
export function runMachine(run: RunView): string {
  const runtime = run.recovery_runtime ?? run.launch_publication?.runtime_ref;
  return runtime?.machine_id || runtime?.runtime_machine || "";
}
