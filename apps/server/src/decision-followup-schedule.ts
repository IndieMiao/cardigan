import {
  type CommandState,
  type Decision,
  type DecisionFollowupStatus,
  type DecisionId,
  decisionFollowupStatus,
} from "@cardigan/domain";

type Settled =
  | { readonly kind: "settled" }
  | { readonly kind: "waiting"; readonly due_at: number };

/**
 * C-244: which decisions the dispatcher must look at for follow-up reminders.
 *
 * Entries are keyed by the Decision object. Store snapshots reuse the object of
 * an unchanged row and parse a new one for any changed row (reducers copy too),
 * so a changed decision is a new key and is evaluated again. An entry is only
 * written for an answer that cannot change while the object stays the same:
 * `ineligible`, `reminded` and durable `recorded` depend only on the decision
 * and on append-only events and timeline entries; `waiting` holds until its
 * `due_at`. `due` (the reminder is being written now; the next pass sees its
 * event) and PM Ops-only `recorded` (depends on Assignments) are re-checked on
 * every pass. A backend that returns new objects on every read simply misses.
 *
 * The map lives in the dispatcher's memory only. A restart starts empty and
 * re-evaluates every decision once from the database.
 */
export class DecisionFollowupSchedule {
  #entries = new WeakMap<Decision, Settled>();

  /** Ids of decisions whose status may have changed, or whose wait is over. */
  pending(state: CommandState, now: string): Set<DecisionId> {
    const at = Date.parse(now);
    const ids = new Set<DecisionId>();
    for (const q of state.decisions) {
      const entry = this.#entries.get(q);
      // An unparsable clock never skips: NaN comparisons are false.
      if (entry?.kind === "settled" || (entry && at < entry.due_at)) continue;
      ids.add(q.id);
    }
    return ids;
  }

  /** Evaluate the pending decisions; the caller records them after commit. */
  evaluate(
    state: CommandState,
    ids: ReadonlySet<DecisionId>,
    now: string,
  ): Map<Decision, DecisionFollowupStatus> {
    const statuses = new Map<Decision, DecisionFollowupStatus>();
    for (const q of state.decisions)
      if (ids.has(q.id)) statuses.set(q, decisionFollowupStatus(state, q, now));
    return statuses;
  }

  record(statuses: ReadonlyMap<Decision, DecisionFollowupStatus>): void {
    for (const [q, status] of statuses) {
      if (
        status.kind === "ineligible" ||
        status.kind === "reminded" ||
        (status.kind === "recorded" && status.durable)
      )
        this.#entries.set(q, { kind: "settled" });
      else if (status.kind === "waiting")
        this.#entries.set(q, { kind: "waiting", due_at: status.due_at });
      else this.#entries.delete(q);
    }
  }
}
