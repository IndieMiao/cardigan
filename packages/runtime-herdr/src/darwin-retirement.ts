import { posix } from "node:path";
import type { RetirementIdentity, RuntimeRef } from "@cardigan/domain";
import type { ExecutionConfig } from "./execution.js";
import { workerTerminalProbe } from "./loopback-terminal.js";

/** Only these bounded facts can cross the trusted worker boundary. */
export async function darwinRetirementObservation(
  execution: Extract<ExecutionConfig, { mode: "agent-ssh" }>,
  ref: RuntimeRef,
  owner: RetirementIdentity & { readonly system_finished_turn?: true },
  probe = workerTerminalProbe,
): Promise<"alive" | "exited" | "kept" | "unknown"> {
  const launch = ref.launch_generation,
    p = owner.enrolled_process,
    target = execution.target;
  if (
    !execution.fileHelper ||
    !execution.user ||
    !target ||
    !launch ||
    !p ||
    p.terminal !== launch.generation ||
    p.machine !== target.fingerprint ||
    !ref.terminal_ref.startsWith(`${execution.machine}/`)
  )
    return "unknown";
  const observed: unknown = await probe(execution, {
    platform: "darwin",
    user: execution.user,
    gid: execution.gid,
    session: target.session,
    target: target.fingerprint,
    project: owner.project_id,
    assignment: owner.assignment_id,
    launch_run: launch.run_id,
    generation: launch.generation,
    terminal: ref.terminal_ref.slice(execution.machine.length + 1),
    process: p,
    require_idle: owner.system_finished_turn === true,
    primitive: posix.join(
      posix.dirname(execution.fileHelper.path),
      "worker-primitives.py",
    ),
  });
  return observed === "exited" || observed === "alive" || observed === "kept"
    ? observed
    : "unknown";
}
