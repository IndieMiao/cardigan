import {
  type CommandState,
  type Decision,
  type DecisionFollowupStatus,
  type DecisionId,
  decisionFollowupStatus,
} from "@cardigan/domain";
import type { ChangeCursor, ChangeSet } from "@cardigan/store";

/** The only collection whose changes can unsettle a remembered answer. */
export const DECISION_FOLLOWUP_FEED: readonly string[] = ["decisions"];

type Entry =
  | { readonly kind: "settled" }
  | { readonly kind: "waiting"; readonly due_at: number };

/** What one pass must evaluate, and the feed position it was planned from. */
export interface DecisionFollowupPlan {
  readonly ids: ReadonlySet<DecisionId>;
  /** The schedule starts over: every decision of the state is in `ids`. */
  readonly reset: boolean;
  readonly cursor: ChangeCursor | undefined;
}

const byIds = new WeakMap<readonly Decision[], Map<string, Decision>>();
/** First decision per id, like `decisions.find`; built once per snapshot array. */
function decisionIndex(decisions: readonly Decision[]) {
  let index = byIds.get(decisions);
  if (!index) {
    index = new Map();
    for (const q of decisions) if (!index.has(q.id)) index.set(q.id, q);
    byIds.set(decisions, index);
  }
  return index;
}

/**
 * C-244: which decisions of one project the dispatcher must look at for
 * follow-up reminders, without walking every decision on every pass.
 *
 * A pass evaluates only
 * - decisions whose row changed since the last committed pass (the Store's row
 *   change feed, read in the same transaction as the state),
 * - decisions whose last answer may change without their row changing (`due`:
 *   the reminder is being written now; PM Ops-only `recorded`: depends on
 *   Assignments), and
 * - waits whose `due_at` has come, from a queue sorted by `due_at`.
 *
 * `ineligible`, `reminded` and durable `recorded` depend only on the decision
 * row and on append-only events and timeline entries, so they stay settled
 * until the row changes; `waiting` holds until its `due_at`.
 *
 * Nothing is learned until `record`, which the dispatcher calls after the
 * transaction commits: a rolled-back pass leaves the cursor and every entry as
 * they were, so the same changes are planned again. Memory only — a restart (or
 * a feed that went backwards) starts over and evaluates every decision once.
 * Without a change feed every decision is evaluated on every pass.
 */
export class DecisionFollowupSchedule {
  #cursor: ChangeCursor | undefined;
  readonly #entries = new Map<DecisionId, Entry>();
  /** Due times of `waiting` entries, ascending; stale items are dropped lazily. */
  #queue: { readonly due_at: number; readonly id: DecisionId }[] = [];
  /** Re-checked on every pass. */
  readonly #unstable = new Set<DecisionId>();

  get cursor(): ChangeCursor | undefined {
    return this.#cursor;
  }

  /**
   * Decisions to evaluate now. `changes` is the feed since `cursor`, read in
   * the transaction that loaded `state`; `undefined` when there is no feed.
   */
  plan(
    state: CommandState,
    changes: ChangeSet | undefined,
    now: string,
  ): DecisionFollowupPlan {
    if (!changes?.changed)
      return {
        ids: new Set(decisionIndex(state.decisions).keys()) as Set<DecisionId>,
        reset: true,
        cursor: changes?.cursor,
      };
    const ids = new Set<DecisionId>(this.#unstable);
    for (const id of changes.changed.get("decisions") ?? [])
      ids.add(id as DecisionId);
    const at = Date.parse(now);
    for (const item of this.#queue) {
      // An unparsable clock never skips: every wait is checked.
      if (at < item.due_at) break;
      ids.add(item.id);
    }
    return { ids, reset: false, cursor: changes.cursor };
  }

  /** Evaluate the planned decisions; the caller records them after commit. */
  evaluate(
    state: CommandState,
    plan: DecisionFollowupPlan,
    now: string,
  ): Map<Decision, DecisionFollowupStatus> {
    const index = decisionIndex(state.decisions);
    const statuses = new Map<Decision, DecisionFollowupStatus>();
    for (const id of plan.ids) {
      const q = index.get(id);
      if (q) statuses.set(q, decisionFollowupStatus(state, q, now));
    }
    return statuses;
  }

  #enqueue(item: { readonly due_at: number; readonly id: DecisionId }) {
    const queue = this.#queue;
    let low = 0;
    let high = queue.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if ((queue[mid]?.due_at ?? 0) <= item.due_at) low = mid + 1;
      else high = mid;
    }
    queue.splice(low, 0, item);
  }

  /** Learn a committed pass: its answers and its feed position. */
  record(
    plan: DecisionFollowupPlan,
    statuses: ReadonlyMap<Decision, DecisionFollowupStatus>,
  ): void {
    if (plan.reset) {
      this.#entries.clear();
      this.#unstable.clear();
      this.#queue = [];
    }
    // A planned id without a status no longer exists.
    for (const id of plan.ids) {
      this.#entries.delete(id);
      this.#unstable.delete(id);
    }
    for (const [q, status] of statuses) {
      if (
        status.kind === "ineligible" ||
        status.kind === "reminded" ||
        (status.kind === "recorded" && status.durable)
      )
        this.#entries.set(q.id, { kind: "settled" });
      else if (status.kind === "waiting") {
        this.#entries.set(q.id, { kind: "waiting", due_at: status.due_at });
        this.#enqueue({ due_at: status.due_at, id: q.id });
      } else this.#unstable.add(q.id);
    }
    // Drop leading items that no longer describe their entry. A stale item
    // further back only costs one extra evaluation when its time comes.
    let stale = 0;
    for (const item of this.#queue) {
      const entry = this.#entries.get(item.id);
      if (entry?.kind === "waiting" && entry.due_at === item.due_at) break;
      stale++;
    }
    if (stale) this.#queue.splice(0, stale);
    this.#cursor = plan.cursor;
  }
}
