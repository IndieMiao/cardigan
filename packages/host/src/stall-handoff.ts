import { type Event, eventsOfType } from "@cardigan/domain";
import type { DispatchStall } from "./dispatch-stalls.js";

type Incident = Pick<
  DispatchStall,
  "assignment_id" | "cause_id" | "system_finished_run_id"
>;
const key = (id: string, cause: string) => JSON.stringify([id, cause]);
const incidentKey = (row: Incident) =>
  key(row.assignment_id, row.system_finished_run_id ?? row.cause_id);

/** Only still-live incidents. A reminder is neither a recovery nor stop authority. */
export function overdueStallHandoffs(
  events: readonly Event[],
  rows: readonly Incident[],
  now: string,
) {
  const outstanding = new Set(rows.map(incidentKey));
  if (!outstanding.size) return [];
  const escalated = new Set(
    eventsOfType(events, "dispatch_stall_handoff_overdue").map(
      (e) => (e.payload as { handoff_id: string }).handoff_id,
    ),
  );
  // An automatic attempt that failed does not count as Ops pickup.
  for (const e of eventsOfType(events, "host_ops_action_taken")) {
    if (e.actor.kind !== "assignment" || e.actor.role_id !== "host_ops")
      continue;
    const p = e.payload as {
      assignment_id: string;
      dispatch_stall_id?: string;
      system_finished_run_id?: string;
    };
    if (p.dispatch_stall_id)
      outstanding.delete(
        key(p.assignment_id, p.system_finished_run_id ?? p.dispatch_stall_id),
      );
  }
  return eventsOfType(events, "dispatch_stall_attention").filter(
    (e) =>
      e.actor.kind === "system" &&
      // C-732: a human pause is not an Ops takeover; its resume question
      // (PM Ops or Needs You) is the follow-up.
      !(e.payload as { paused_by?: string }).paused_by &&
      outstanding.delete(incidentKey(e.payload as Incident)) &&
      !escalated.has(e.id) &&
      Date.parse(now) - Date.parse(e.created_at) >= 15 * 60_000,
  );
}
