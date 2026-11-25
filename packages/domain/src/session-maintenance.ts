import { assignmentCardHeld } from "./card-hold.js";
import type { CommandState } from "./commands/core.js";
import { stoppedByHuman } from "./commands/stop-state.js";
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

export {
  retirementOwnsSession,
  supersededRetirement,
} from "./retirement-session.js";
export * from "./session-maintenance-types.js";

export function darwinWorker(state: CommandState, a: Assignment) {
  return (
    a.machine_id !== "local" &&
    state.machines?.some(
      (m) => m.id === a.machine_id && ["macos", "darwin"].includes(m.os),
    ) === true
  );
}

export function needsRetirementHandoff(state: CommandState, a: Assignment) {
  const p = a.idle_retirement;
  return (
    a.scope === "work_item" &&
    !a.external &&
    a.status === "active" &&
    !!p &&
    !p.handoff &&
    (p.failures >= 3 ||
      (p.phase === "waiting" && p.last_failure === "timeout")) &&
    retirementOwnsSession(a) &&
    darwinWorker(state, a)
  );
}

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
  if (a.idle_retirement?.handoff && retirementOwnsSession(a))
    return excluded("retained_for_dispatch");
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
  if (handedBackForWork(state, a, at))
    return excluded("business_work_cooldown");
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

/** C-739: handed back for business work within the cooldown, with no Run
 * started or finished since (a Run is the dispatch the cooldown waits for). */
function handedBackForWork(state: CommandState, a: Assignment, at: number) {
  const since = Math.max(
    0,
    ...runsOf(state.runs, a.id).flatMap((r) =>
      [r.started_at, r.finished_at].map((t) => Date.parse(t ?? "") || 0),
    ),
  );
  return eventsOfType(state.events, "idle_session_retirement_released").some(
    (e) => {
      const p = e.payload as { assignment_id?: string; reason?: string } | null;
      const t = Date.parse(e.created_at);
      return (
        p?.assignment_id === a.id &&
        p.reason === "business_work" &&
        t > since &&
        t <= at &&
        at - t < BUSINESS_WORK_COOLDOWN_MS
      );
    },
  );
}

/** Another live registration on the same terminal or worktree of this machine. */
export function sharedStallRegistration(state: CommandState, a: Assignment) {
  const ref = a.runtime_ref;
  return state.assignments.some(
    (other) =>
      other.id !== a.id &&
      other.status !== "released" &&
      other.machine_id === a.machine_id &&
      ((!!a.worktree_path && other.worktree_path === a.worktree_path) ||
        (!!ref &&
          other.runtime_ref?.runtime_machine === ref.runtime_machine &&
          (other.runtime_ref.terminal_ref === ref.terminal_ref ||
            other.runtime_ref.agent_name === ref.agent_name))),
  );
}

/**
 * C-739: after a retained retirement was handed back for business work
 * (C-690), the same session is not reclaimed for this long, so the
 * dispatcher can deliver that work. Without it the patrol reclaimed the
 * session within milliseconds and nothing was ever dispatched (sensen A-327,
 * A-316: released -> started -> withdrawn -> handed off, again and again).
 */
export const BUSINESS_WORK_COOLDOWN_MS = 10 * 60_000;

/** C-730: default for `probeInvalidStreak` before a stale terminal is released. */
export const UNRESPONSIVE_PROBE_LIMIT = 3;

/**
 * C-730: how many idle retirements of this exact session were withdrawn in a
 * row because the process proof was invalid (`probe_invalid`: the macOS idle
 * owner refused to serve its CLI, or the worker helper read no identity).
 * Any other withdrawal reason ends the streak. Only withdrawals after the last
 * MCP call and after the latest Run of this Assignment started or finished
 * count, so an Agent that showed any sign of life starts again from zero.
 */
export function probeInvalidStreak(state: CommandState, a: Assignment): number {
  if (!a.runtime_ref) return 0;
  const ref = JSON.stringify(canonicalSessionFacts(a.runtime_ref));
  const since = Math.max(
    0,
    Date.parse(a.last_mcp_activity_at ?? "") || 0,
    ...runsOf(state.runs, a.id).flatMap((r) =>
      [r.started_at, r.finished_at].map((at) => Date.parse(at ?? "") || 0),
    ),
  );
  let streak = 0;
  for (const e of eventsOfType(
    state.events,
    "idle_session_retirement_withdrawn",
  )) {
    const p = e.payload as {
      assignment_id?: string;
      runtime_ref?: unknown;
      evidence?: { reason?: string };
    } | null;
    if (
      p?.assignment_id !== a.id ||
      JSON.stringify(canonicalSessionFacts(p.runtime_ref)) !== ref ||
      !(Date.parse(e.created_at) > since)
    )
      continue;
    streak = p.evidence?.reason === "probe_invalid" ? streak + 1 : 0;
  }
  return streak;
}

/**
 * C-739: how many idle retirements of this session were given up since its
 * last sign of life (an MCP call, a Run start or finish): withdrawn attempts
 * of this exact session, whatever the reason, and retained retirements
 * released because business work arrived (C-690). A session that keeps
 * being reclaimed and handed back without ever being woken shows up here.
 */
export function retirementWithdrawals(
  state: CommandState,
  a: Assignment,
): number {
  if (!a.runtime_ref) return 0;
  const ref = JSON.stringify(canonicalSessionFacts(a.runtime_ref));
  const since = Math.max(
    0,
    Date.parse(a.last_mcp_activity_at ?? "") || 0,
    ...runsOf(state.runs, a.id).flatMap((r) =>
      [r.started_at, r.finished_at].map((at) => Date.parse(at ?? "") || 0),
    ),
  );
  let count = 0;
  for (const e of eventsOfType(
    state.events,
    "idle_session_retirement_withdrawn",
  )) {
    const p = e.payload as {
      assignment_id?: string;
      runtime_ref?: unknown;
    } | null;
    if (
      p?.assignment_id === a.id &&
      JSON.stringify(canonicalSessionFacts(p.runtime_ref)) === ref &&
      Date.parse(e.created_at) > since
    )
      count++;
  }
  for (const e of eventsOfType(
    state.events,
    "idle_session_retirement_released",
  )) {
    const p = e.payload as { assignment_id?: string; reason?: string } | null;
    if (
      p?.assignment_id === a.id &&
      p.reason === "business_work" &&
      Date.parse(e.created_at) > since
    )
      count++;
  }
  return count;
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
