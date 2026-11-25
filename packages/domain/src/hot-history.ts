import type {
  Assignment,
  Card,
  Decision,
  Event,
  HumanAction,
  Run,
  WorkItem,
} from "./entities.js";
import {
  commandEventHistory,
  eventsOfType,
  fullEventHistory,
} from "./event-index.js";
import type { CardId, EventId } from "./ids.js";
import { OFFICE_DIGEST_EVENT_TYPES } from "./office-changes.js";

/**
 * C-639 hot command state.
 *
 * A *cold* card is closed (done/cancelled) and no longer referenced by any
 * live work: no unreleased Assignment or unfinished Run on its work items, no
 * open Human Action, no open Decision naming it, no unfinished Run triggered
 * by one of its events, no pending inbox notification, and it is neither the
 * command target nor a predecessor, parent or source-decision card of an open
 * card. Cold cards keep every event except the high-volume execution
 * telemetry below, which no rule reads once the Runs it describes are over.
 * Hot cards and the project stream keep their whole history.
 */
export const COLD_CARD_OMITTED_EVENT_TYPES: ReadonlySet<string> = new Set([
  "run_queued",
  "run_dispatched",
  "run_started",
  "run_finished",
  "bell_wake_deferred",
  "session_maintenance_changed",
  "machine_selected",
  // github_check_dispatch stays: a github_run_completed wait may name any card's run.
  "github_check_progress",
]);

/**
 * C-649 `lean` scope: cold cards also drop GitHub dispatch records (about a
 * sixth of daily events). Their only command-state reader is a
 * `github_run_completed` wait or resume target, whose dispatch cards are made
 * hot through the full log index (`githubRunCards`).
 */
export const LEAN_COLD_CARD_OMITTED_EVENT_TYPES: ReadonlySet<string> = new Set([
  ...COLD_CARD_OMITTED_EVENT_TYPES,
  "github_check_dispatch",
  "github_probe_dispatch",
]);

/**
 * C-671 `slim`: the only fact types a cold card keeps in the command state.
 * Every reader that can read a cold card's events reads only these types, or
 * reads the cold card's other events through the head index (`eventHead`),
 * which answers over every event without decoding it. The audit behind this
 * list is in docs/plans/C-671.md.
 */
export const SLIM_COLD_CARD_EVENT_TYPES: ReadonlySet<string> = new Set([
  "card_merged",
]);

/**
 * C-671: the types the Store keeps decoded on closed cards in the `slim`
 * scope: the cold whitelist, plus types read across every card stream outside
 * the command state (the GitHub dispatch journal and the Office digest).
 */
export const SLIM_RESIDENT_EVENT_TYPES: ReadonlySet<string> = new Set([
  ...SLIM_COLD_CARD_EVENT_TYPES,
  "github_check_dispatch",
  "github_probe_dispatch",
  ...OFFICE_DIGEST_EVENT_TYPES,
]);

/**
 * C-649 project-stream retention in the `lean` scope, by event type; any
 * other type keeps its whole history. `latest` keeps the newest event per key
 * (every reader takes the last match of exactly these fields); `none` keeps no
 * event (no command-state reader, only the Store log, SQL or `listAfter`).
 * Events that are still a live Run trigger or the subject of a live
 * notification are always kept.
 */
export type ProjectStreamRetention =
  | { readonly kind: "none" }
  | { readonly kind: "latest"; readonly key: (event: Event) => string };
export const PROJECT_STREAM_RETENTION: ReadonlyMap<
  string,
  ProjectStreamRetention
> = new Map<string, ProjectStreamRetention>([
  // apps/server worker-backup.ts lastSuccessfulWorkerBackup: findLast by
  // actor, assignment, machine and branch.
  [
    "assignment_branch_backed_up",
    {
      kind: "latest",
      key: (e) => {
        const p =
          e.payload && typeof e.payload === "object"
            ? (e.payload as Record<string, unknown>)
            : {};
        // Presence is part of the key: the reader compares with ===, so a
        // missing field and an explicit null must never share a key.
        const field = (name: string) => [name in p, p[name]];
        return JSON.stringify([
          e.actor.kind,
          e.actor.project_id,
          Array.isArray(e.payload),
          field("assignment_id"),
          field("machine_id"),
          field("branch"),
        ]);
      },
    },
  ],
  // Audit rows: read by the reference-read audit through listAfter and by the
  // activity page through SQL, never from the command state.
  ["cross_card_read", { kind: "none" }],
]);

/**
 * Ids of project-stream events the retention rules leave out. `typed` are
 * the project stream's events of the retained types, in stream order.
 */
export function projectStreamDropped(
  typed: readonly Event[],
  protect: ReadonlySet<string>,
): Set<string> {
  const dropped = new Set<string>();
  const latest = new Map<string, Event>();
  for (const e of typed) {
    if (e.card_id) continue;
    const rule = PROJECT_STREAM_RETENTION.get(e.type);
    if (!rule) continue;
    if (rule.kind === "none") {
      if (!protect.has(e.id)) dropped.add(e.id);
      continue;
    }
    const key = `${e.type}\u0000${rule.key(e)}`;
    const previous = latest.get(key);
    if (previous && !protect.has(previous.id)) dropped.add(previous.id);
    latest.set(key, e);
  }
  return dropped;
}

/** Positive GitHub run ids, as `github_run_completed` targets carry them. */
const RUN_ID = /^[1-9][0-9]*$/u;
const externalRunId = (e: Event) => {
  const run = (e.payload as { externalRun?: { run_id?: unknown } } | null)
    ?.externalRun;
  return run === undefined ? undefined : String(run.run_id);
};

/**
 * C-649: cards holding the dispatch records of these GitHub run ids (from
 * the full log's type index), so `lean` keeps them whole. `dispatches` are
 * every `github_check_dispatch` event of the project.
 */
export function githubRunCards(
  dispatches: readonly Event[],
  runIds: Iterable<string>,
): Set<CardId> {
  const wanted = new Set<string>();
  for (const id of runIds) if (RUN_ID.test(id)) wanted.add(id);
  const cards = new Set<CardId>();
  if (!wanted.size) return cards;
  for (const e of dispatches) {
    const run = externalRunId(e);
    if (e.card_id && run !== undefined && wanted.has(run)) cards.add(e.card_id);
  }
  return cards;
}

/** GitHub run ids that live blocker waits name, on any work item. */
export function waitedGithubRuns(work_items: readonly WorkItem[]): string[] {
  const runs: string[] = [];
  for (const w of work_items) {
    const c = w.reported_blocker?.resume_when;
    if (c?.kind === "github_run_completed") runs.push(c.target_id);
  }
  return runs;
}

/** Strings among command parameters that look like GitHub run ids. */
export function commandRunIds(values: readonly unknown[]): string[] {
  const found: string[] = [];
  const visit = (value: unknown, depth: number) => {
    if (typeof value === "string") {
      if (RUN_ID.test(value)) found.push(value);
    } else if (typeof value === "number") {
      if (Number.isSafeInteger(value) && value > 0) found.push(String(value));
    } else if (depth < 4 && Array.isArray(value)) {
      for (const v of value) visit(v, depth + 1);
    } else if (depth < 4 && value && typeof value === "object") {
      for (const v of Object.values(value)) visit(v, depth + 1);
    }
  };
  for (const value of values) visit(value, 0);
  return found;
}

const CLOSED: ReadonlySet<Card["status"]> = new Set(["done", "cancelled"]);
const FINISHED_RUN: ReadonlySet<Run["status"]> = new Set([
  "completed",
  "failed",
  "cancelled",
]);
const OPEN_DECISION: ReadonlySet<Decision["status"]> = new Set([
  "open",
  "snoozed",
  "provisional",
]);

export const cardClosed = (card: Pick<Card, "status">): boolean =>
  CLOSED.has(card.status);

export interface HotCardInput {
  readonly cards: readonly Card[];
  readonly work_items: readonly WorkItem[];
  readonly assignments: readonly Assignment[];
  readonly runs: readonly Run[];
  readonly decisions: readonly Decision[];
  readonly human_actions: readonly HumanAction[];
}

/** Events whose stream the host must resolve: triggers of unfinished Runs. */
export function liveTriggerEventIds(
  runs: readonly Pick<Run, "status" | "trigger_event_id" | "recovery_policy">[],
): EventId[] {
  const ids = new Set<EventId>();
  for (const run of runs) {
    if (FINISHED_RUN.has(run.status)) continue;
    ids.add(run.trigger_event_id);
    if (run.recovery_policy) ids.add(run.recovery_policy.trigger_event_id);
  }
  return [...ids];
}

/**
 * Cards whose full history the command state keeps. `extra` carries host
 * facts outside the state: command targets, trigger-event cards and cards of
 * pending notifications. Never shrinks below every open card.
 */
export function hotCardIds(
  state: HotCardInput,
  extra: Iterable<CardId | undefined> = [],
): Set<CardId> {
  const hot = new Set<CardId>();
  const add = (id: CardId | undefined) => {
    if (id) hot.add(id);
  };
  const items = new Map(state.work_items.map((w) => [w.id, w.card_id]));
  const decisions = new Map(state.decisions.map((q) => [q.id, q]));
  for (const card of state.cards) {
    if (cardClosed(card)) continue;
    add(card.id);
    for (const before of card.depends_on_cards ?? []) add(before);
    add(card.parent_card_id);
    // Legacy rows may lack optional-looking fields; never fail closed here.
    if (card.source?.kind === "decision") {
      const source = decisions.get(card.source.decision_id);
      add(source?.card_id);
      for (const id of source?.affected_cards ?? []) add(id);
    }
  }
  const assignmentCard = new Map<string, CardId | undefined>();
  for (const a of state.assignments) {
    const card =
      a.scope === "work_item" ? items.get(a.work_item_id) : undefined;
    assignmentCard.set(a.id, card);
    if (a.status !== "released") add(card);
  }
  for (const run of state.runs) {
    if (FINISHED_RUN.has(run.status)) continue;
    add(assignmentCard.get(run.assignment_id));
    add(run.recovery_policy?.card_id);
    add(run.bell_delivery?.card_id);
  }
  for (const action of state.human_actions)
    if (action.status === "open") {
      add(action.card_id);
      if (action.ready_when && "card_id" in action.ready_when)
        add(action.ready_when.card_id);
    }
  for (const q of state.decisions) {
    if (!OPEN_DECISION.has(q.status)) continue;
    add(q.card_id);
    for (const id of q.affected_cards ?? []) add(id);
    for (const id of q.affected_work_items ?? []) add(items.get(id));
    if (q.ready_when && "card_id" in q.ready_when) add(q.ready_when.card_id);
  }
  for (const id of extra) add(id);
  return hot;
}

/**
 * C-649 `lean` command state as a pure function of the whole-history state:
 * hot cards (plus the dispatch cards of waited GitHub runs) keep whole
 * streams, other cards drop the lean cold types, and the project stream
 * follows `PROJECT_STREAM_RETENTION`. `protect` holds live trigger and
 * notification event ids the host resolved.
 */
export function leanCommandEvents(
  state: HotCardInput & { readonly events: readonly Event[] },
  extra: Iterable<CardId | undefined> = [],
  protect: ReadonlySet<string> = new Set(),
): readonly Event[] {
  return retainedCommandEvents(
    state,
    extra,
    protect,
    (type) => !LEAN_COLD_CARD_OMITTED_EVENT_TYPES.has(type),
  );
}

/**
 * C-671 `slim` command state as a pure function of the whole-history state:
 * `leanCommandEvents`, except that cold cards keep only the whitelisted fact
 * types (`SLIM_COLD_CARD_EVENT_TYPES`).
 */
export function slimCommandEvents(
  state: HotCardInput & { readonly events: readonly Event[] },
  extra: Iterable<CardId | undefined> = [],
  protect: ReadonlySet<string> = new Set(),
): readonly Event[] {
  return retainedCommandEvents(
    state,
    extra,
    protect,
    (type) =>
      SLIM_COLD_CARD_EVENT_TYPES.has(type) &&
      !LEAN_COLD_CARD_OMITTED_EVENT_TYPES.has(type),
  );
}

function retainedCommandEvents(
  state: HotCardInput & { readonly events: readonly Event[] },
  extra: Iterable<CardId | undefined>,
  protect: ReadonlySet<string>,
  coldKeeps: (type: string) => boolean,
): readonly Event[] {
  // C-643: decide over the complete history (telemetry included).
  const all = fullEventHistory(state.events);
  const triggers = new Set<string>(liveTriggerEventIds(state.runs));
  const triggerCards = all
    .filter((e) => triggers.has(e.id))
    .map((e) => e.card_id);
  const dispatches = eventsOfType(state.events, "github_check_dispatch");
  const hot = hotCardIds(state, [
    ...triggerCards,
    ...githubRunCards(dispatches, waitedGithubRuns(state.work_items)),
    ...extra,
  ]);
  const keep = new Set([...protect, ...triggers]);
  const dropped = projectStreamDropped(
    all.filter((e) => !e.card_id && PROJECT_STREAM_RETENTION.has(e.type)),
    keep,
  );
  const kept = all.filter((e) =>
    e.card_id ? hot.has(e.card_id) || coldKeeps(e.type) : !dropped.has(e.id),
  );
  return all === state.events ? kept : commandEventHistory([kept]);
}

/** The kept part of one card stream; hot streams are returned unchanged. */
export function coldCardEvents(events: readonly Event[]): Event[] {
  return events.filter((e) => !COLD_CARD_OMITTED_EVENT_TYPES.has(e.type));
}

/**
 * Card ids named by command parameters, so a command about a closed card
 * keeps that card's whole history. Walks plain parameter objects only.
 */
export function commandTargetCards(
  state: Pick<
    HotCardInput,
    | "cards"
    | "work_items"
    | "assignments"
    | "runs"
    | "decisions"
    | "human_actions"
  > & {
    readonly deliveries: readonly {
      readonly id: string;
      readonly work_item_id: string;
    }[];
    readonly reviews: readonly {
      readonly id: string;
      readonly delivery_id: string;
    }[];
  },
  values: readonly unknown[],
): Set<CardId> {
  const { cards, index } = targetIndex(state);
  const found = new Set<CardId>();
  const visit = (value: unknown, depth: number) => {
    if (typeof value === "string") {
      if (cards.has(value)) found.add(value as CardId);
      for (const id of index.get(value)?.() ?? []) if (id) found.add(id);
    } else if (depth < 4 && Array.isArray(value)) {
      for (const v of value) visit(v, depth + 1);
    } else if (depth < 4 && value && typeof value === "object") {
      for (const v of Object.values(value)) visit(v, depth + 1);
    }
  };
  for (const value of values) visit(value, 0);
  return found;
}

/**
 * The hot command state as a pure function of the whole-history state; the
 * Store-backed loader must produce exactly these events. `extra` names cards
 * whose inbox notifications are still live or that a command targets.
 *
 * C-643: triggers (often `run_queued`) are found in the complete history. A
 * telemetry-free command stream maps to a command stream (same events and
 * journal as the loader's); a plain array maps to a plain array.
 */
export function hotCommandEvents(
  state: HotCardInput & { readonly events: readonly Event[] },
  extra: Iterable<CardId | undefined> = [],
): readonly Event[] {
  const all = fullEventHistory(state.events);
  const triggers = new Set<string>(liveTriggerEventIds(state.runs));
  const triggerCards = all
    .filter((e) => triggers.has(e.id))
    .map((e) => e.card_id);
  const hot = hotCardIds(state, [...triggerCards, ...extra]);
  const kept = all.filter(
    (e) =>
      !e.card_id ||
      hot.has(e.card_id) ||
      !COLD_CARD_OMITTED_EVENT_TYPES.has(e.type),
  );
  return all === state.events ? kept : commandEventHistory([kept]);
}

type TargetState = Parameters<typeof commandTargetCards>[0];
type TargetIndex = {
  readonly cards: ReadonlySet<string>;
  readonly index: ReadonlyMap<string, () => readonly (CardId | undefined)[]>;
};
/** Built once per immutable state snapshot; commands only look ids up. */
const targetIndexes = new WeakMap<object, TargetIndex>();
function targetIndex(state: TargetState): TargetIndex {
  const cached = targetIndexes.get(state);
  if (cached) return cached;

  const cards = new Set(state.cards.map((c) => c.id as string));
  const items = new Map(state.work_items.map((w) => [w.id as string, w]));
  const index = new Map<string, () => readonly (CardId | undefined)[]>();
  const item = (id: string | undefined) =>
    id === undefined ? undefined : items.get(id)?.card_id;
  for (const w of state.work_items) index.set(w.id, () => [w.card_id]);
  for (const a of state.assignments)
    index.set(a.id, () => [
      a.scope === "work_item" ? item(a.work_item_id) : undefined,
    ]);
  const deliveries = new Map(state.deliveries.map((v) => [v.id, v]));
  for (const v of state.deliveries)
    index.set(v.id, () => [item(v.work_item_id)]);
  for (const r of state.reviews)
    index.set(r.id, () => [item(deliveries.get(r.delivery_id)?.work_item_id)]);
  for (const q of state.decisions)
    index.set(q.id, () => [q.card_id, ...(q.affected_cards ?? [])]);
  for (const h of state.human_actions) index.set(h.id, () => [h.card_id]);
  const assignments = new Map(state.assignments.map((a) => [a.id, a]));
  for (const run of state.runs)
    index.set(run.id, () => {
      const a = assignments.get(run.assignment_id);
      return [
        a?.scope === "work_item" ? item(a.work_item_id) : undefined,
        run.recovery_policy?.card_id,
      ];
    });
  const built = { cards, index };
  targetIndexes.set(state, built);
  return built;
}
