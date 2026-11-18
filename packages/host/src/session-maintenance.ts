import { setImmediate as yieldToLoop } from "node:timers/promises";
import {
  type AssignmentId,
  type Clock,
  type CommandState,
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
  // Only observed owners need a before/after basis. Keep immutable data from
  // before runtime IO rather than serializing every Assignment inside SQLite.
  const original = store.uow.read((tx) => loadCommandState(tx, project));
  const observations = new Map<AssignmentId, SessionMaintenanceReason>();
  return {
    note: (id: AssignmentId, reason: SessionMaintenanceReason) =>
      observations.set(id, reason),
    finish: async () => {
      let ids: AssignmentId[] | undefined;
      let cursor = 0;
      let reuse: { version: string; state: CommandState } | undefined;
      for (;;) {
        const more = store.uow.run((tx) => {
          // Earlier slices wrote only diagnostics of already-visited owners.
          // Those fields/events are not inputs for other owners. Any external
          // command-state write (even between slices) requires a fresh basis.
          const state: CommandState =
            reuse && reuse.version === store.snapshotVersion(project)
              ? reuse.state
              : loadCommandState(tx, project);
          const policies = idleRolePolicies(tx, project);
          ids ??= state.assignments.map((a) => a.id);
          const owners = new Map(state.assignments.map((a) => [a.id, a]));
          const items = new Set(state.work_items.map((w) => w.id));
          // Allow at least one owner to progress, even after a slow snapshot read.
          const deadline = performance.now() + 30;
          do {
            const id = ids[cursor++];
            const a = id && owners.get(id);
            if (
              !a ||
              a.status === "released" ||
              a.scope !== "work_item" ||
              a.external ||
              !a.work_item_id ||
              !items.has(a.work_item_id)
            )
              continue;
            const basis = sessionMaintenanceBasis(state, a);
            const candidate = sessionMaintenanceCandidate(
              state,
              a,
              clock.now(),
              threshold,
            );
            const observed = observations.get(a.id);
            const prior =
              observed && original.assignments.find((v) => v.id === a.id);
            const observation =
              prior && sessionMaintenanceBasis(original, prior) === basis
                ? observed
                : undefined;
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
          } while (cursor < ids.length && performance.now() < deadline);
          const version = store.snapshotVersion(project);
          reuse = version === undefined ? undefined : { version, state };
          return cursor < ids.length;
        });
        if (!more) break;
        await yieldToLoop();
      }
    },
  };
}
