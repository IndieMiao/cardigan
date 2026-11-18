import type { Actor, Run } from "../entities.js";
import type { RunId } from "../ids.js";
import { transition } from "../transitions.js";
import {
  type CommandPorts,
  type CommandState,
  command,
  ensure,
  unwrap,
} from "./core.js";
import { cancelRunDispatch } from "./launch.js";

type Publication = NonNullable<Run["launch_publication"]>;
const next: Record<Publication["phase"], readonly Publication["phase"][]> = {
  preparing: ["preparing", "published", "stopping"],
  published: ["provisioning", "stopping"],
  provisioning: ["provisioned", "stopping"],
  provisioned: ["provisioned", "dispatched", "stopping"],
  dispatched: ["started", "stopping"],
  started: ["started", "stopping"],
  stopping: ["stopping", "exited"],
  exited: ["preparing"],
};
/** Facts are accepted only from the host, bound to this Run and immutable target/generation. */
export function recordLaunchPublication(
  state: CommandState,
  actor: Actor,
  p: { run_id: RunId; publication: Publication; expected_generation?: string },
  ports: CommandPorts,
) {
  return command(state, actor, "manage_dispatch_stop", ports, (d) => {
    const run = d.get("runs", p.run_id),
      a = d.get("assignments", run.assignment_id),
      old = run.launch_publication,
      value = p.publication;
    ensure(
      old?.generation === p.expected_generation &&
        (old
          ? next[old.phase].includes(value.phase)
          : value.phase === "preparing") &&
        (!old ||
          old.phase === "exited" ||
          (old.generation === value.generation &&
            JSON.stringify(old.target) === JSON.stringify(value.target))),
      "illegal_transition",
      "Launch publication generation or phase changed",
    );
    ensure(
      value.target.project_id === state.project_id &&
        value.target.machine_id === a.machine_id &&
        /^[a-f0-9]{32}$/u.test(value.generation) &&
        /^[a-f0-9]{64}$/u.test(value.target.fingerprint) &&
        (!value.sha || /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value.sha)) &&
        (value.failure_reason === undefined ||
          (["stopping", "exited"].includes(value.phase) &&
            value.failure_reason.length > 0 &&
            value.failure_reason.length <= 300 &&
            !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value.failure_reason))) &&
        (!old?.failure_reason ||
          old.phase === "exited" ||
          old.failure_reason === value.failure_reason) &&
        Number.isSafeInteger(value.log_offset) &&
        value.log_offset >= 0 &&
        (!old ||
          old.phase === "exited" ||
          value.log_offset >= old.log_offset) &&
        value.artifacts.every(
          (artifact) =>
            /^[a-f0-9]{64}$/u.test(artifact.sha256) &&
            Number.isSafeInteger(artifact.size) &&
            artifact.size >= 0 &&
            /^[A-Za-z0-9._/-]+$/u.test(artifact.evidence_name) &&
            !artifact.evidence_name.startsWith("/") &&
            !artifact.evidence_name
              .split("/")
              .some((part) =>
                ["", ".", "..", "token", "secrets.env"].includes(part),
              ),
        ) &&
        Number.isFinite(Date.parse(value.lease_until)) &&
        (!value.runtime_ref ||
          (value.runtime_ref.machine_id === a.machine_id &&
            JSON.stringify(value.runtime_ref.target) ===
              JSON.stringify(value.target) &&
            value.runtime_ref.launch_generation?.run_id === run.id &&
            value.runtime_ref.launch_generation.generation ===
              value.generation)),
      "validation_failed",
      "Invalid launch publication facts",
    );
    ensure(
      value.phase !== "preparing" ||
        (run.status === "queued" && a.status === "active"),
      "illegal_transition",
      "Only a queued Run can prepare publication",
    );
    let updated = { ...run, launch_publication: value };
    if (value.phase === "exited" && value.wait && run.status === "dispatched") {
      ensure(
        !run.started_at,
        "illegal_transition",
        "Started Run cannot return to target wait",
      );
      updated = {
        ...updated,
        status: unwrap(transition("run", run.status, "launch_withdrawn")),
      };
    }
    if (
      value.phase === "exited" &&
      value.runtime_ref &&
      a.runtime_ref?.terminal_ref === value.runtime_ref.terminal_ref &&
      a.runtime_ref.launch_generation?.run_id === run.id &&
      a.runtime_ref.launch_generation.generation === value.generation
    )
      d.put("assignments", {
        ...a,
        runtime_ref: null,
        runtime_state:
          a.runtime_state === "running"
            ? unwrap(transition("runtime", a.runtime_state, "run_finished"))
            : a.runtime_state,
      });
    d.put("runs", updated);
    if (
      value.phase === "exited" &&
      !value.wait &&
      !["completed", "failed", "cancelled"].includes(updated.status)
    )
      return cancelRunDispatch(
        d,
        updated,
        value.failure_reason ?? "Worker launch publication failed",
      );
    return updated;
  });
}
