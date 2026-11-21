import type { Actor } from "../entities.js";
import type { AssignmentId } from "../ids.js";
import {
  type SessionMaintenanceView,
  sessionMaintenanceBasis,
  sessionMaintenanceIdentity,
  sessionMaintenanceReasons,
} from "../session-maintenance.js";
import {
  type CommandPorts,
  type CommandState,
  command,
  ensure,
} from "./core.js";

/** Host-only observations. No runtime, role, token or lifecycle mutation. */
export function recordSessionMaintenance(
  state: CommandState,
  actor: Actor,
  id: AssignmentId,
  observation: Pick<
    SessionMaintenanceView,
    "reason" | "candidate" | "threshold_minutes"
  > & { readonly basis: string },
  ports: CommandPorts,
) {
  return command(state, actor, "upgrade_idle_assignment_role", ports, (d) => {
    ensure(
      actor.kind === "system",
      "unauthorized",
      "Only the system may record session maintenance",
    );
    ensure(
      Object.hasOwn(sessionMaintenanceReasons, observation.reason) &&
        observation.reason !== "stale" &&
        Number.isSafeInteger(observation.threshold_minutes) &&
        observation.threshold_minutes > 0 &&
        observation.threshold_minutes <= 2_147_483_647,
      "validation_failed",
      "Invalid maintenance observation",
    );
    const a = d.get("assignments", id);
    if (sessionMaintenanceBasis(state, a) !== observation.basis) return a;
    const previous = a.session_maintenance;
    if (previous && Date.parse(previous.evaluated_at) > Date.parse(d.now))
      return a;
    const sessionBasis = sessionMaintenanceIdentity(state, a);
    const sameSession =
      previous?.session_basis !== undefined
        ? previous.session_basis === sessionBasis
        : previous?.basis === observation.basis;
    const same =
      previous !== undefined &&
      sameSession &&
      previous.reason === observation.reason &&
      previous.candidate === observation.candidate &&
      previous.threshold_minutes === observation.threshold_minutes;
    const since = same ? previous.since : d.now;
    const alert =
      observation.candidate &&
      [
        "identity_unproven",
        "unsupported_capability",
        "observation_incomplete",
        "runtime_unavailable",
        "publication_pending",
      ].includes(observation.reason);
    const notify =
      alert &&
      !(same && previous.notice_sent) &&
      Date.parse(d.now) - Date.parse(since) >= 15 * 60_000;
    const next = {
      ...a,
      session_maintenance: {
        ...observation,
        session_basis: sessionBasis,
        since,
        evaluated_at: d.now,
        ...((same && previous.notice_sent) || notify
          ? { notice_sent: true }
          : {}),
      },
    };
    d.put("assignments", next);
    const card = state.work_items.find((w) => w.id === a.work_item_id)?.card_id;
    if (!same || notify)
      d.emit(
        notify
          ? "session_maintenance_attention"
          : "session_maintenance_changed",
        card,
        {
          assignment_id: id,
          reason: observation.reason,
          candidate: observation.candidate,
          since,
          evaluated_at: d.now,
          threshold_minutes: observation.threshold_minutes,
          ...(notify
            ? {
                notice: `${id} 会话维护持续等待：${sessionMaintenanceReasons[observation.reason]}。`,
              }
            : {}),
        },
      );
    return next;
  });
}
