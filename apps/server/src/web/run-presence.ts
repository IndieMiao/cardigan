import {
  type Assignment,
  type CommandState,
  type Precheck,
  prechecks,
  type Run,
} from "@cardigan/domain";

/**
 * C-531: what one person is doing for one card (or one work item), as shown
 * on their avatar. Only a Run the host confirmed as `running` is "running";
 * a waiting precheck, decision or blocker never is.
 */
export type RunPresenceState =
  | "running"
  | "starting"
  | "queued"
  | "unknown"
  | "waiting"
  | "idle";
export type RunPresenceWaiting = "precheck" | "decision" | "blocked";
export interface RunPresence {
  readonly state: RunPresenceState;
  readonly waiting?: RunPresenceWaiting;
}

// Merge order for several assignments of the same person: running > starting
// > queued > waiting > idle. A dispatched Run is starting, not waiting for a
// machine. A lost Run ("unknown") ranks above waiting and idle so it is never
// reported as idle.
const rank: Record<RunPresenceState, number> = {
  running: 5,
  starting: 4,
  queued: 3,
  unknown: 2,
  waiting: 1,
  idle: 0,
};
const waitingRank: Record<RunPresenceWaiting, number> = {
  precheck: 2,
  decision: 1,
  blocked: 0,
};

/** Live Run statuses; finished, failed and cancelled Runs carry no presence. */
function runState(run: Run): RunPresenceState | undefined {
  switch (run.status) {
    case "running":
      return "running";
    case "queued":
      return "queued";
    // The host already placed it on a machine; only the session start is left.
    case "dispatched":
    case "acked":
      return "starting";
    case "unknown":
      return "unknown";
    default:
      return undefined;
  }
}

export function strongestPresence(
  presences: readonly RunPresence[],
): RunPresence {
  let best: RunPresence = { state: "idle" };
  for (const presence of presences) {
    if (
      rank[presence.state] > rank[best.state] ||
      (presence.state === "waiting" &&
        best.state === "waiting" &&
        waitingRank[presence.waiting ?? "blocked"] >
          waitingRank[best.waiting ?? "blocked"])
    )
      best = presence;
  }
  return best;
}

/**
 * C-765: when this Assignment's earliest `running` Run started, in ms.
 * Undefined when it has no running Run or the host recorded no start time.
 */
export function runningSince(
  state: Pick<CommandState, "runs">,
  assignment: Pick<Assignment, "id">,
): number | undefined {
  let since: number | undefined;
  for (const run of state.runs) {
    if (run.assignment_id !== assignment.id || run.status !== "running")
      continue;
    const at = run.started_at ? Date.parse(run.started_at) : Number.NaN;
    if (Number.isFinite(at) && (since === undefined || at < since)) since = at;
  }
  return since;
}

/**
 * C-765: board avatars show at most three people, so running people go
 * first, ordered by when their Run started (unknown start last, ties keep
 * the given order). Everyone else keeps the given order after them. With
 * nobody running the order is unchanged.
 */
export function runningFirst<T>(
  people: readonly T[],
  fact: (person: T) => {
    readonly presence: RunPresence;
    readonly since?: number | undefined;
  },
): T[] {
  const ranked = people.map((person, index) => ({
    person,
    index,
    ...fact(person),
  }));
  const running = ranked.filter((p) => p.presence.state === "running");
  if (!running.length) return [...people];
  const rest = ranked.filter((p) => p.presence.state !== "running");
  running.sort((a, b) => {
    if (a.since !== b.since) {
      if (a.since === undefined) return 1;
      if (b.since === undefined) return -1;
      return a.since - b.since;
    }
    return a.index - b.index;
  });
  return [...running, ...rest].map((p) => p.person);
}

/**
 * Presence of one work-item Assignment. `cardPrechecks` must be this card's
 * precheck projection; it is passed in so a list computes it once per card.
 */
export function assignmentPresence(
  state: Pick<CommandState, "runs" | "work_items">,
  assignment: Assignment,
  cardPrechecks: readonly Precheck[],
): RunPresence {
  const live = state.runs
    .filter((run) => run.assignment_id === assignment.id)
    .flatMap((run) => {
      const value = runState(run);
      return value ? [{ state: value }] : [];
    });
  if (live.length) return strongestPresence(live);
  const waiting: RunPresence[] = [];
  if (
    cardPrechecks.some(
      (check) =>
        check.assignment_id === assignment.id &&
        (check.status === "queued" || check.status === "running"),
    )
  )
    waiting.push({ state: "waiting", waiting: "precheck" });
  const item = state.work_items.find((w) => w.id === assignment.work_item_id);
  if (item?.status === "waiting_decision")
    waiting.push({ state: "waiting", waiting: "decision" });
  if (item?.status === "blocked")
    waiting.push({ state: "waiting", waiting: "blocked" });
  return strongestPresence(waiting);
}

/** Per-card precheck projections, computed once for a whole list. */
export function precheckIndex(state: Pick<CommandState, "events">) {
  const cache = new Map<string, readonly Precheck[]>();
  return (cardId: string) => {
    let value = cache.get(cardId);
    if (!value) {
      value = prechecks(state.events, cardId as Precheck["card_id"]);
      cache.set(cardId, value);
    }
    return value;
  };
}
