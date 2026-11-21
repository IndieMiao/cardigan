import {
  type Assignment,
  type AssignmentId,
  assignmentCardHeld,
  assignmentDependenciesAllowStart,
  type Card,
  type CommandState,
  cardDependencyDispatchOrder,
  type Decision,
  type Delivery,
  type DispatchOrder,
  decisionFollowupBlocked,
  dispatchRunKind,
  dispatchTier,
  eventById,
  hasRunTarget,
  type Notification,
  type ProjectId,
  reviewWakeBlocked,
  runById,
  runnableQueuedRun,
  unreadableCommentTrigger,
  type WorkItem,
} from "@cardigan/domain";
import type { ChangeCursor, ChangeSet } from "@cardigan/store";
import type { StandingResolver } from "./dispatch-inbox.js";

/** Evaluate pending bells against the same business target as queueRun. */
export function notificationBlocked(
  state: CommandState,
  eventId: string,
  owner: AssignmentId,
) {
  const a = assignmentIndex(state.assignments).first.get(owner);
  return (
    decisionFollowupBlocked(state, eventId, owner) ||
    (a?.scope === "work_item" &&
      reviewWakeBlocked(
        state,
        eventById(state.events, eventId),
        a.work_item_id,
      ))
  );
}

export interface Candidate {
  project: ProjectId;
  notes: Notification[];
  assignment: Assignment;
  order: DispatchOrder;
}

/**
 * Every collection a candidate is computed from. `events` are append-only:
 * an existing event never changes, so new events only matter to a result that
 * found its trigger event missing (such results are never reused).
 */
export const CANDIDATE_FEED: readonly string[] = [
  "assignments",
  "runs",
  "work_items",
  "deliveries",
  "cards",
  "decisions",
  "events",
  "notifications",
  "bell_attempts",
];

/** The Store reads one pass needs; all inside the same read transaction. */
export interface CandidateSource {
  /** Row change feed since `cursor`; `undefined` when the database has none. */
  changes(cursor: ChangeCursor | undefined): ChangeSet | undefined;
  state(): CommandState;
  /** Pending notifications, oldest `(seq, id)` first; only `ids` when given. */
  notifications(ids?: readonly string[]): readonly Notification[];
  /** Notification ids held by unfinished BellAttempts. */
  claimed(): ReadonlySet<string>;
}

// Snapshot indexes. State collections are immutable snapshots (every change
// yields a new array, unchanged rows keep their objects), so an index keyed by
// the array cannot go stale; it is rebuilt only when that collection changed.
function weakIndex<K extends object, V>(build: (key: K) => V) {
  const cache = new WeakMap<K, V>();
  return (key: K): V => {
    let value = cache.get(key);
    if (value === undefined) {
      value = build(key);
      cache.set(key, value);
    }
    return value;
  };
}
function firstById<T extends { readonly id: string }>(rows: readonly T[]) {
  const map = new Map<string, T>();
  for (const row of rows) if (!map.has(row.id)) map.set(row.id, row);
  return map;
}
const cardIndex = weakIndex((cards: readonly Card[]) => firstById(cards));
const deliveryIndex = weakIndex((rows: readonly Delivery[]) => firstById(rows));
const decisionIndex = weakIndex((rows: readonly Decision[]) => firstById(rows));
const workItemIndex = weakIndex((items: readonly WorkItem[]) => {
  const first = new Map<string, WorkItem>();
  /** Work item id → every card holding a work item with that id. */
  const cardsOf = new Map<string, Set<string>>();
  /** Card → ids of its work items. */
  const itemsOf = new Map<string, Set<string>>();
  for (const w of items) {
    if (!first.has(w.id)) first.set(w.id, w);
    const cards = cardsOf.get(w.id) ?? new Set<string>();
    cards.add(w.card_id);
    cardsOf.set(w.id, cards);
    const ids = itemsOf.get(w.card_id) ?? new Set<string>();
    ids.add(w.id);
    itemsOf.set(w.card_id, ids);
  }
  return { first, cardsOf, itemsOf };
});
const assignmentIndex = weakIndex((assignments: readonly Assignment[]) => {
  const first = new Map<string, Assignment>();
  const position = new Map<string, number>();
  const byWorkItem = new Map<string, AssignmentId[]>();
  const activeStanding = new Set<string>();
  let legacyStanding = false;
  assignments.forEach((a, i) => {
    if (!first.has(a.id)) {
      first.set(a.id, a);
      position.set(a.id, i);
    }
    if (a.scope === "work_item") {
      const list = byWorkItem.get(a.work_item_id) ?? [];
      list.push(a.id);
      byWorkItem.set(a.work_item_id, list);
    }
    if (a.scope === "standing" && a.status === "active") {
      activeStanding.add(a.id);
      // Without standing_mode the resolver falls back to the tokens table,
      // which has no change feed (C-244).
      if (a.role_id === "pm" && a.standing_mode === undefined)
        legacyStanding = true;
    }
  });
  return { first, position, byWorkItem, activeStanding, legacyStanding };
});

/** Same as cardPriority in dispatch.ts: the first work item, then the first card. */
function priorityOf(state: CommandState, a: Assignment): number {
  const card =
    a.scope === "work_item"
      ? workItemIndex(state.work_items).first.get(a.work_item_id)?.card_id
      : undefined;
  return (
    (card === undefined ? undefined : cardIndex(state.cards).get(card))
      ?.priority ?? 0
  );
}

const qualifiesQueued = (state: CommandState, id: string) => {
  const owner = assignmentIndex(state.assignments).first.get(
    id as AssignmentId,
  );
  const q = owner ? runnableQueuedRun(owner, state) : undefined;
  return (
    q?.queue_reason !== undefined ||
    q?.dispatch_target_wait !== undefined ||
    q?.preparation_retry !== undefined
  );
};

/**
 * `volatile`: the trigger event was missing, so a later (appended) event can
 * change the answer; such a result is never reused.
 */
type Result = {
  readonly candidate: Candidate | undefined;
  readonly volatile: boolean;
};
type NoteInfo = {
  readonly owner: AssignmentId | undefined;
  readonly blocked: boolean;
};

interface ProjectCache {
  cursor: ChangeCursor;
  /** Pending notifications by id. */
  readonly notes: Map<string, Notification>;
  /** `notes` in `(seq, id)` order; rebuilt after a notification change. */
  ordered: Notification[] | undefined;
  claimed: ReadonlySet<string>;
  /** Owner and decision-follow-up block per pending notification. */
  readonly info: Map<string, NoteInfo>;
  standing: Readonly<Record<"pm_ops" | "pm_office", AssignmentId | undefined>>;
  /** Group key → owner, note signature and its reusable result. */
  readonly groups: Map<
    string,
    { owner: AssignmentId; sig: string; result: Result }
  >;
  /** Assignments whose queued Run is waiting (capacity or target wait). */
  readonly queued: Set<AssignmentId>;
  /** Queued-only results by Assignment. */
  readonly queuedResults: Map<AssignmentId, Result>;
  /** Tokens may decide a standing PM, so every pass recomputes (rare). */
  legacy: boolean;
  hadDependencies: boolean;
  last: Candidate[];
}

export interface CandidatePassStats {
  /** `reset`: rebuilt from the full state; `reused`: nothing changed. */
  readonly mode: "reset" | "incremental" | "reused";
  readonly dirty: number;
  readonly evaluated: number;
}

/**
 * C-244: the dispatcher's candidate list per project, maintained across
 * passes. A pass reads the Store's row change feed and recomputes only what
 * depends on a changed row:
 *
 * - no change at all: the previous list is returned without reading the state;
 * - otherwise the dirty Assignments are those whose own row, Runs, work item
 *   (by id, or any work item / delivery / card row on the same card) or raised
 *   decisions changed; only their groups and queued Runs are evaluated again,
 *   and only changed notification rows are re-read.
 *
 * Results equal a full recomputation (same candidates, same order): grouping
 * still follows `(seq, id)` notification order, queued-only candidates follow
 * the Assignment order, and every reused result was computed from rows that
 * have not changed since. A result whose trigger event was missing is never
 * reused. A feed that went backwards, an unknown changed row, or any error
 * drops the cache; the next pass rebuilds from the full state. Memory only: a
 * restart rebuilds once.
 */
export class CandidateIndex {
  readonly #projects = new Map<ProjectId, ProjectCache>();
  lastStats: CandidatePassStats | undefined;

  constructor(
    private readonly standing: StandingResolver | undefined,
    private readonly skipped?: (
      project: ProjectId,
      owner: AssignmentId | undefined,
      id: string,
      at: string,
      reason: string,
    ) => void,
  ) {}

  candidates(project: ProjectId, source: CandidateSource): Candidate[] {
    try {
      return this.#pass(project, source);
    } catch (error) {
      this.#projects.delete(project);
      throw error;
    }
  }

  #pass(project: ProjectId, source: CandidateSource): Candidate[] {
    const previous = this.#projects.get(project);
    const changes = source.changes(previous?.cursor);
    const changed = previous && changes?.changed;
    if (changed && changed.size === 0 && !previous.legacy) {
      this.lastStats = { mode: "reused", dirty: 0, evaluated: 0 };
      return [...previous.last];
    }
    const state = source.state();
    let cache: ProjectCache;
    let dirty: Set<AssignmentId> | "all";
    if (!changes || !changed) {
      cache = {
        cursor: changes?.cursor ?? { project_id: project, versions: new Map() },
        notes: new Map(source.notifications().map((n) => [n.id, n])),
        ordered: undefined,
        claimed: source.claimed(),
        info: new Map(),
        standing: this.#standing(project, state),
        groups: new Map(),
        queued: new Set(),
        queuedResults: new Map(),
        legacy: false,
        hadDependencies: state.cards.some((c) => c.depends_on_cards?.length),
        last: [],
      };
      for (const a of state.assignments)
        if (qualifiesQueued(state, a.id)) cache.queued.add(a.id);
      dirty = "all";
    } else {
      cache = previous;
      const found = this.#dirty(state, changed, previous.hadDependencies);
      if (!found) {
        this.#projects.delete(project);
        return this.#pass(project, source);
      }
      dirty = found;
      const notes = changed.get("notifications");
      if (notes?.size) {
        const ids = [...notes];
        for (const id of ids) {
          cache.notes.delete(id);
          cache.info.delete(id);
        }
        for (const n of source.notifications(ids)) cache.notes.set(n.id, n);
        cache.ordered = undefined;
      }
      if (changed.get("bell_attempts")?.size) cache.claimed = source.claimed();
      // The resolver reads Assignments only (tokens for legacy rows).
      const standing =
        changed.has("assignments") || cache.legacy
          ? this.#standing(project, state)
          : cache.standing;
      const standingChanged =
        standing.pm_ops !== cache.standing.pm_ops ||
        standing.pm_office !== cache.standing.pm_office;
      cache.standing = standing;
      const runs = changed.get("runs");
      for (const [id, info] of cache.info) {
        const n = cache.notes.get(id);
        if (
          !n ||
          (info.owner !== undefined && dirty.has(info.owner)) ||
          (n.run_id !== undefined && runs?.has(n.run_id)) ||
          (standingChanged && n.recipient.kind !== "assignment")
        )
          cache.info.delete(id);
      }
      for (const id of dirty)
        if (qualifiesQueued(state, id)) cache.queued.add(id);
        else cache.queued.delete(id);
      cache.cursor = changes.cursor;
    }
    cache.legacy = assignmentIndex(state.assignments).legacyStanding;
    const evaluated = this.#assemble(project, state, cache, dirty);
    cache.hadDependencies = state.cards.some((c) => c.depends_on_cards?.length);
    this.#projects.set(project, cache);
    this.lastStats = {
      mode: dirty === "all" ? "reset" : "incremental",
      dirty: dirty === "all" ? state.assignments.length : dirty.size,
      evaluated,
    };
    return [...cache.last];
  }

  #standing(project: ProjectId, state: CommandState) {
    const valid = assignmentIndex(state.assignments).activeStanding;
    const resolve = (kind: "pm_ops" | "pm_office") => {
      const id = this.standing?.(project, kind, state);
      return id !== undefined && valid.has(id) ? id : undefined;
    };
    return { pm_ops: resolve("pm_ops"), pm_office: resolve("pm_office") };
  }

  /**
   * Assignments whose candidates may differ because of `changed` rows, or
   * `undefined` when a changed row cannot be placed (the caller rebuilds).
   */
  #dirty(
    state: CommandState,
    changed: ReadonlyMap<string, ReadonlySet<string>>,
    hadDependencies: boolean,
  ): Set<AssignmentId> | undefined {
    const dirty = new Set<AssignmentId>();
    if (
      (hadDependencies ||
        state.cards.some((c) => c.depends_on_cards?.length)) &&
      ["cards", "deliveries", "work_items", "events"].some((key) =>
        changed.has(key),
      )
    )
      return new Set(state.assignments.map((a) => a.id));
    if (changed.has("cards"))
      for (const a of state.assignments)
        if (a.scope === "standing") dirty.add(a.id);
    for (const id of changed.get("assignments") ?? [])
      dirty.add(id as AssignmentId);
    for (const id of changed.get("runs") ?? []) {
      const run = runById(state.runs, id);
      if (!run) return undefined;
      dirty.add(run.assignment_id);
    }
    const cards = new Set<string>();
    const decisions = decisionIndex(state.decisions);
    for (const id of changed.get("decisions") ?? []) {
      const q = decisions.get(id);
      if (!q) return undefined;
      if (q.review_limit_group && q.card_id) cards.add(q.card_id);
      if (q.raised_by.startsWith("assignment:"))
        dirty.add(q.raised_by.slice("assignment:".length) as AssignmentId);
    }
    const items = workItemIndex(state.work_items);
    const owners = assignmentIndex(state.assignments).byWorkItem;
    const touchItem = (id: string) => {
      const holders = items.cardsOf.get(id);
      if (!holders) return false;
      for (const card of holders) cards.add(card);
      for (const a of owners.get(id) ?? []) dirty.add(a);
      return true;
    };
    for (const id of changed.get("work_items") ?? [])
      if (!touchItem(id)) return undefined;
    const deliveries = deliveryIndex(state.deliveries);
    for (const id of changed.get("deliveries") ?? []) {
      const delivery = deliveries.get(id);
      // A delivery of an unknown work item is never a run target.
      if (!delivery) return undefined;
      touchItem(delivery.work_item_id);
    }
    const knownCards = cardIndex(state.cards);
    for (const id of changed.get("cards") ?? []) {
      if (!knownCards.has(id)) return undefined;
      cards.add(id);
    }
    for (const card of cards)
      for (const item of items.itemsOf.get(card) ?? [])
        for (const a of owners.get(item) ?? []) dirty.add(a);
    return dirty;
  }

  /** Rebuild the candidate list, evaluating only what is not reusable. */
  #assemble(
    project: ProjectId,
    state: CommandState,
    cache: ProjectCache,
    dirty: ReadonlySet<AssignmentId> | "all",
  ): number {
    const isDirty = (id: AssignmentId) => dirty === "all" || dirty.has(id);
    let evaluated = 0;
    const evaluate = (assignment: Assignment, notes: Notification[]) => {
      evaluated++;
      return candidateResult(project, state, assignment, notes, (why) => {
        const n = notes[0];
        const q = runnableQueuedRun(assignment, state);
        this.skipped?.(
          project,
          assignment.id,
          n?.id ?? q?.id ?? assignment.id,
          n?.created_at ?? q?.queue_entered_at ?? assignment.created_at,
          why,
        );
      });
    };
    const reusable = (hit: Result | undefined, owner: AssignmentId) =>
      hit !== undefined && !hit.volatile && !isDirty(owner);
    cache.ordered ??= [...cache.notes.values()].sort(
      (a, b) => a.seq - b.seq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    const infoOf = (n: Notification): NoteInfo => {
      let info = cache.info.get(n.id);
      if (!info) {
        const owner = this.#owner(n, state, cache);
        info = {
          owner,
          blocked:
            owner !== undefined &&
            notificationBlocked(state, n.event_id, owner),
        };
        cache.info.set(n.id, info);
      }
      return info;
    };
    const groups = new Map<string, Notification[]>();
    for (const n of cache.ordered) {
      if (n.recipient.kind === "needs_you") continue;
      const { owner, blocked } = infoOf(n);
      const skip = (why: string) =>
        this.skipped?.(project, owner, n.id, n.created_at, why);
      if (cache.claimed.has(n.id)) {
        skip("notification_claimed");
        continue;
      }
      if (!owner || blocked) {
        skip(!owner ? "missing_recipient" : "notification_blocked");
        continue;
      }
      if (
        assignmentIndex(state.assignments).first.get(owner)?.scope ===
          "standing" &&
        n.card_id &&
        cardIndex(state.cards).get(n.card_id)?.hold
      ) {
        skip("card_held");
        continue;
      }
      const key = `${owner}/${n.card_id ?? ""}/${n.attempts ? n.run_id : ""}`;
      const group = groups.get(key);
      if (group) group.push(n);
      else groups.set(key, [n]);
    }
    const assignments = assignmentIndex(state.assignments).first;
    const candidates: Candidate[] = [];
    const added = new Set<AssignmentId>();
    const kept = new Map<
      string,
      { owner: AssignmentId; sig: string; result: Result }
    >();
    for (const [key, notes] of groups) {
      notes.sort((a, b) => {
        const left = eventById(state.events, a.event_id);
        const right = eventById(state.events, b.event_id);
        return (
          (left?.created_at ?? a.created_at).localeCompare(
            right?.created_at ?? b.created_at,
          ) || a.event_id.localeCompare(b.event_id)
        );
      });
      const owner = (notes[0] && cache.info.get(notes[0].id)?.owner) as
        | AssignmentId
        | undefined;
      const assignment =
        owner === undefined ? undefined : assignments.get(owner);
      if (!owner || !assignment) {
        const n = notes[0];
        if (n)
          this.skipped?.(
            project,
            owner,
            n.id,
            n.created_at,
            "missing_assignment",
          );
        continue;
      }
      const sig = notes
        .map((n) => `${n.id}\0${n.event_id}\0${n.run_id ?? ""}`)
        .join("\n");
      const hit = cache.groups.get(key);
      const result =
        hit?.owner === owner && hit.sig === sig && reusable(hit.result, owner)
          ? hit.result
          : evaluate(assignment, notes);
      kept.set(key, { owner, sig, result });
      if (result.candidate) {
        added.add(owner);
        candidates.push({ ...result.candidate, notes, assignment });
      }
    }
    cache.groups.clear();
    for (const [key, entry] of kept) cache.groups.set(key, entry);
    // ACK is not cancellation: a Run deferred for capacity still needs
    // dispatch if its trigger notification was acknowledged while it waited.
    const position = assignmentIndex(state.assignments).position;
    const queued = [...cache.queued]
      .filter((id) => position.has(id))
      .sort((a, b) => (position.get(a) ?? 0) - (position.get(b) ?? 0));
    const results = new Map<AssignmentId, Result>();
    for (const id of queued) {
      const assignment = assignments.get(id);
      const hit = cache.queuedResults.get(id);
      // Already a candidate through its notifications: keep, do not evaluate.
      if (!assignment || added.has(id)) {
        if (hit && !isDirty(id)) results.set(id, hit);
        continue;
      }
      const result = reusable(hit, id) && hit ? hit : evaluate(assignment, []);
      results.set(id, result);
      if (result.candidate)
        candidates.push({ ...result.candidate, notes: [], assignment });
    }
    cache.queuedResults.clear();
    for (const [id, result] of results) cache.queuedResults.set(id, result);
    cache.last = candidates;
    return evaluated;
  }

  /** Same as `notificationOwner`, with the pass's standing PMs. */
  #owner(
    n: Notification,
    state: CommandState,
    cache: ProjectCache,
  ): AssignmentId | undefined {
    if (n.recipient.kind === "needs_you") return undefined;
    if (n.recipient.kind === "assignment") return n.recipient.assignment_id;
    const sent = n.run_id && runById(state.runs, n.run_id);
    if (sent) return sent.assignment_id;
    return cache.standing[n.recipient.kind];
  }
}

/**
 * One candidate for `assignment` with `notes` (possibly none), exactly as the
 * pre-C-244 `add`; no candidate when it does not qualify now.
 */
function candidateResult(
  project: ProjectId,
  state: CommandState,
  assignment: Assignment,
  notes: Notification[],
  skip: (why: string) => void,
): Result {
  const none = { candidate: undefined, volatile: false };
  const omit = (reason: string) => {
    skip(reason);
    return none;
  };
  if (!assignmentDependenciesAllowStart(state, assignment))
    return omit("dependencies");
  if (assignmentCardHeld(assignment, state)) return omit("card_held");
  if (!hasRunTarget(assignment, state)) return omit("no_target");
  const queued = runnableQueuedRun(assignment, state);
  if (queued && unreadableCommentTrigger(state, queued))
    return omit("unreadable_trigger");
  const cause = notes.find((n) => !n.run_id) ?? notes[0];
  const trigger = queued?.trigger_event_id ?? cause?.event_id;
  if (assignmentCardHeld(assignment, state, trigger)) return omit("card_held");
  const event = eventById(state.events, trigger);
  if (!event) {
    skip("trigger_missing");
    return { candidate: undefined, volatile: true };
  }
  const candidate: Candidate = {
    project,
    notes,
    assignment,
    order: {
      ...dispatchTier(
        state,
        assignment,
        queued,
        event,
        queued?.kind ??
          dispatchRunKind(event, assignment, cause?.kind === "review"),
      ),
      priority: priorityOf(state, assignment),
      ...cardDependencyDispatchOrder(state, assignment),
      project_id: project,
      assignment_id: assignment.id,
      created_at: event.created_at,
      trigger_event_id: event.id,
    },
  };
  return { candidate, volatile: false };
}
