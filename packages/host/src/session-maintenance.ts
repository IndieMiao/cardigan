import {
  type AssignmentId,
  type Clock,
  type ProjectId,
  recordSessionMaintenance,
  SESSION_IDLE_MINUTES,
  type SessionMaintenanceReason,
  sessionMaintenanceBasis,
  sessionMaintenanceCandidate,
} from "@cardigan/domain";
import { loadCommandState, persistEffect, unwrap } from "@cardigan/mcp-server";
import { recordNotification, type Store } from "@cardigan/store";
import { idleRolePolicies } from "./deployment-roles.js";

/** Candidate display only; this setting never authorizes retirement. */
export function sessionIdleMinutes(
  raw = process.env.CARDIGAN_IDLE_SESSION_MINUTES,
): number {
  if (raw === undefined) return SESSION_IDLE_MINUTES;
  const value = Number(raw);
  if (
    !/^\d+$/u.test(raw) ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > 2_147_483_647
  )
    throw new Error("CARDIGAN_IDLE_SESSION_MINUTES must be a positive integer");
  return value;
}

/** Reuse maintenance observations; never add a terminal probe or destructive IO. */
export function sessionMaintenanceScan(
  store: Store,
  project: ProjectId,
  clock: Clock,
  threshold: number,
  supported: boolean,
) {
  const original = store.uow.read((tx) => {
    const state = loadCommandState(tx, project);
    return new Map(
      state.assignments.map((a) => [a.id, sessionMaintenanceBasis(state, a)]),
    );
  });
  const observations = new Map<AssignmentId, SessionMaintenanceReason>();
  return {
    note: (id: AssignmentId, reason: SessionMaintenanceReason) =>
      observations.set(id, reason),
    finish: () =>
      store.uow.run((tx) => {
        const state = loadCommandState(tx, project);
        const policies = idleRolePolicies(tx, project);
        for (const a of state.assignments) {
          if (
            a.status === "released" ||
            a.scope !== "work_item" ||
            a.external ||
            !state.work_items.some((w) => w.id === a.work_item_id)
          )
            continue;
          const basis = sessionMaintenanceBasis(state, a);
          const candidate = sessionMaintenanceCandidate(
            state,
            a,
            clock.now(),
            threshold,
          );
          const observation =
            original.get(a.id) === basis ? observations.get(a.id) : undefined;
          let reason = candidate.reason;
          if (reason === "idle_candidate" && !supported)
            reason = "unsupported_capability";
          // Busy/excluded facts outrank runtime or policy observations.
          if (
            [
              "no_session",
              "recent_activity",
              "activity_unknown",
              "identity_unproven",
              "unsupported_capability",
              "upgrade_pending",
              "idle_candidate",
            ].includes(reason)
          ) {
            if (
              observation &&
              (observation !== "unsupported_capability" ||
                reason === "unsupported_capability")
            )
              reason = observation;
            const policy = policies.get(a.role_id);
            if (
              policy &&
              (policy.role.version > a.role_version || a.role_upgrade)
            ) {
              if (!policy.published) reason = "publication_pending";
              else if (!policy.matches) reason = "role_conflict";
            }
          }
          const effect = unwrap(
            recordSessionMaintenance(
              state,
              { kind: "system", project_id: project },
              a.id,
              {
                basis,
                reason,
                candidate: candidate.candidate,
                threshold_minutes: threshold,
              },
              { ids: tx.ids, clock },
            ),
          );
          persistEffect(tx, project, effect);
          for (const event of effect.events.filter(
            (e) => e.type === "session_maintenance_attention",
          ))
            recordNotification(store.database, {
              project_id: project,
              event_id: event.id,
              card_id: event.card_id,
              seq: event.seq,
              recipient: { kind: "pm_ops" },
              kind: "run_attention",
              at: event.created_at,
            });
        }
      }),
  };
}
