import type {
  Assignment,
  Card,
  Decision,
  Event,
  HumanAction,
  Run,
  WorkItem,
} from "./entities.js";
import { commandEventHistory, fullEventHistory } from "./event-index.js";
import type { CardId, EventId } from "./ids.js";

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
