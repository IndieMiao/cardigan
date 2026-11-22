import { assignmentCardHeld } from "./card-hold.js";
import type { CommandState } from "./commands/core.js";
import { stoppedByHuman } from "./commands/stop.js";
import type { Assignment } from "./entities.js";
import { eventsOfType } from "./event-index.js";
import { hostOpsPending } from "./host-ops.js";
import {
  canonicalSessionFacts,
  retirementOwnsSession,
} from "./retirement-session.js";
import { runsOf } from "./run-index.js";

import {
  SESSION_IDLE_MINUTES,
  type SessionMaintenanceReason,
  type SessionMaintenanceView,
} from "./session-maintenance-types.js";

export { retirementOwnsSession } from "./retirement-session.js";
export * from "./session-maintenance-types.js";

function relatedOwners(state: CommandState, a: Assignment) {
  return state.assignments.filter(
    (other) =>
      other.id === a.id ||
      (a.worktree_path &&
        other.worktree_path === a.worktree_path &&
        other.machine_id === a.machine_id),
  );
}

/** Session boundaries reset a cause; ordinary activity and Run progress do not. */
export function sessionMaintenanceIdentity(
  state: CommandState,
  a: Assignment,
): string {
  return JSON.stringify(
    canonicalSessionFacts({
      project: state.project_id,
      id: a.id,
      item: a.work_item_id,
      role: a.role_id,
      version: a.role_version,
      scope: a.scope,
      external: a.external ?? false,
      ref: a.runtime_ref,
      session: a.session_ref,
    }),
  );
}

/** Bind diagnostics to all control facts, including the complete target/ref generation. */
export function sessionMaintenanceBasis(
  state: CommandState,
  a: Assignment,
): string {
  const item = state.work_items.find((w) => w.id === a.work_item_id);
  const card = state.cards.find((c) => c.id === item?.card_id);
  const owners = relatedOwners(state, a);
  const runs = owners.flatMap((owner) => runsOf(state.runs, owner.id));
  return JSON.stringify(
    canonicalSessionFacts({
      project: state.project_id,
      id: a.id,
      role: a.role_id,
      version: a.role_version,
      status: a.status,
      scope: a.scope,
      external: a.external ?? false,
      ref: a.runtime_ref,
      runtime_state: a.runtime_state,
      activity: a.last_mcp_activity_at,
      upgrade: a.role_upgrade,
      retirement: a.idle_retirement,
      item: item && [item.id, item.assignment_id, item.status, card?.status],
      stopped: stoppedByHuman(state.events, a.id),
      host_ops: hostOpsPending(state.events, a.id),
      shared: owners.map((o) => [
        o.id,
        o.role_upgrade,
        o.idle_retirement,
        hostOpsPending(state.events, o.id),
      ]),
      publication: eventsOfType(state.events, "host_role_pack_published")
        .filter(
          (e) =>
            e.card_id === undefined &&
            e.actor.kind === "system" &&
            e.actor.project_id === state.project_id,
        )
        .sort((a, b) => a.seq - b.seq)
        .at(-1)?.id,
      roles: state.roles
        .filter((r) => r.role_id === a.role_id)
        .map((r) => [r.role_id, r.role_version, r.status]),
      runs: runs
        .map((r) => [
          r.id,
          r.status,
          r.finished_at,
          r.dispatch_stop,
          r.inactivity_stop,
          r.launch_publication,
        ])
        .sort(([a], [b]) => String(a).localeCompare(String(b))),
    }),
  );
}

export function sessionMaintenanceCandidate(
  state: CommandState,
  a: Assignment,
  now: string,
  threshold = SESSION_IDLE_MINUTES,
): Pick<SessionMaintenanceView, "reason" | "candidate"> {
  const excluded = (reason: SessionMaintenanceReason) => ({
    reason,
    candidate: false,
  });
  if (a.external) return excluded("external");
  if (a.scope !== "work_item") return excluded("standing");
  if (a.status !== "active") return excluded("inactive");
  const item = state.work_items.find((w) => w.id === a.work_item_id);
  const card = state.cards.find((c) => c.id === item?.card_id);
  if (
    !item ||
    item.assignment_id !== a.id ||
    !card ||
    ["done", "cancelled"].includes(card.status) ||
    item.status === "cancelled"
  )
    return excluded("closed");
  if (stoppedByHuman(state.events, a.id)) return excluded("stopped");
  if (assignmentCardHeld(a, state)) return excluded("held");
  const owners = relatedOwners(state, a);
  const runs = owners.flatMap((owner) => runsOf(state.runs, owner.id));
  if (
    runs.some((r) => !["completed", "failed", "cancelled"].includes(r.status))
  )
    return excluded("run_busy");
  if (
    owners.some(
      (o) =>
        hostOpsPending(state.events, o.id) ||
        (o.id !== a.id &&
          (o.role_upgrade || o.idle_retirement?.phase === "stopping")),
    ) ||
    runs.some(
      (r) =>
        r.dispatch_stop ||
        r.inactivity_stop ||
        (r.launch_publication &&
          !["started", "exited"].includes(r.launch_publication.phase)),
    )
  )
    return excluded("operation_pending");
  if (a.role_upgrade) return excluded("upgrade_pending");
  if (a.idle_retirement?.phase === "stopping")
    return excluded("retirement_pending");
  if (!a.runtime_ref) return excluded("no_session");
  const lastRun = Math.max(
    ...runs
      .filter((r) => r.assignment_id === a.id)
      .map((r) => Date.parse(r.finished_at ?? "")),
  );
  const mcp = Date.parse(a.last_mcp_activity_at ?? ""),
    at = Date.parse(now);
  if (![lastRun, mcp, at].every(Number.isFinite) || lastRun > at || mcp > at)
    return excluded("activity_unknown");
  if (at - Math.max(lastRun, mcp) <= threshold * 60_000)
    return excluded("recent_activity");
  const pending = a.idle_retirement;
  if (pending?.phase === "waiting" && retirementOwnsSession(a)) {
    if (
      pending.failures >= 3 &&
      pending.evidence?.reason === "kept_terminal" &&
      pending.evidence.observation === "alive"
    )
      return excluded("retained_for_dispatch");
    if (Date.parse(pending.retry_at ?? "") > at)
      return excluded(
        pending.last_failure === "unavailable"
          ? "retirement_unavailable"
          : "retirement_timeout",
      );
  }
  return {
    candidate: true,
    reason: ["lost", "unknown"].includes(a.runtime_state)
      ? "observation_incomplete"
      : "idle_candidate",
  };
}

/** Obsolete observations remain historical facts, never presented as current reasons. */
export function sessionMaintenanceView(
  state: CommandState,
  a: Assignment,
): SessionMaintenanceView | undefined {
  const value = a.session_maintenance;
  if (!value) return undefined;
  const current = value.basis === sessionMaintenanceBasis(state, a);
  return {
    reason: current ? value.reason : "stale",
    candidate: current && value.candidate,
    threshold_minutes: value.threshold_minutes,
    evaluated_at: value.evaluated_at,
    since: value.since,
  };
}
