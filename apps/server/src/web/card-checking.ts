import {
  appendEvents,
  type CardId,
  type CardView,
  type CommandState,
  type Event,
  latestMergeCheck,
  type ProjectId,
  prechecks,
  type WorkItem,
} from "@cardigan/domain";
import type { Store } from "@cardigan/store";
import { inIds } from "./sql-state.js";

/**
 * C-567: checks the card is waiting on right now. Present only while a check
 * is queued or running, so a finished check falls back to the existing
 * waiting/blocked display.
 */
export interface CardChecking {
  readonly precheck?: {
    readonly attempt_ids: readonly string[];
    /** Blocked work items whose blocker only waits for one of these attempts. */
    readonly waiting_items: readonly string[];
    /** Other cards whose precheck is waited for; their events refresh this card. */
    readonly cards?: readonly string[];
  };
  readonly merge_check?: {
    readonly attempt_id: string;
    readonly status: "queued" | "running";
  };
}

const active = (status: string): status is "queued" | "running" =>
  status === "queued" || status === "running";

/** The latest non-superseded completion's merge check, as the detail reads it. */
export function currentCardMergeCheck(state: CommandState, cardId: CardId) {
  if (!state.cards.some((c) => c.id === cardId)) return undefined;
  const items = new Set(
    state.work_items.filter((w) => w.card_id === cardId).map((w) => w.id),
  );
  const completion = state.deliveries
    .filter(
      (d) =>
        items.has(d.work_item_id) &&
        d.kind === "card_completion" &&
        d.status !== "superseded",
    )
    .sort((a, b) => Number(b.id.slice(2)) - Number(a.id.slice(2)))[0];
  return completion
    ? latestMergeCheck(state.events, cardId, completion.id)
    : undefined;
}

/**
 * A blocked item whose only wait is a precheck. An item the domain has handed
 * to PM for a manual resume (`auto_resume_disabled`) stays a real blocker.
 */
function precheckWait(item: WorkItem) {
  const blocker = item.reported_blocker;
  return item.status === "blocked" &&
    !blocker?.auto_resume_disabled &&
    blocker?.resume_when?.kind === "precheck_finished"
    ? blocker.resume_when.target_id
    : undefined;
}

/** Waited-for attempts absent from `state.events` (another card's precheck). */
export function missingPrecheckTargets(
  state: Pick<CommandState, "work_items" | "events">,
): string[] {
  const known = new Set(prechecks(state.events).map((c) => c.attempt_id));
  return [
    ...new Set(
      state.work_items.flatMap((item) => {
        const target = precheckWait(item);
        return target && !known.has(target) ? [target] : [];
      }),
    ),
  ];
}

/** The precheck events of the given attempts, whichever card they belong to. */
export function readPrecheckAttempts(
  store: Store,
  project: ProjectId,
  attempts: readonly string[],
): Event[] {
  if (!attempts.length) return [];
  return store.database
    .prepare(
      `SELECT doc FROM events WHERE project_id = ? AND type IN ('precheck_queued', 'precheck_started', 'precheck_finished') AND ${inIds("json_extract(doc, '$.payload.attempt_id')")}`,
    )
    .all(project, JSON.stringify(attempts))
    .map((row) => JSON.parse(String(row.doc)) as Event);
}

/**
 * One pass over work items; returns a per-card reader. `precheckEvents` adds
 * attempts the scoped state lacks, so a wait for another card's precheck
 * resolves even when that card is not on the page.
 */
export function cardCheckingIndex(
  state: CommandState,
  mergeState: CommandState = state,
  precheckEvents: readonly Event[] = [],
) {
  // Trusted system events only (the domain projection), latest per attempt.
  const attempts = new Map(
    // C-671: appended to the indexed history, so lookups still see every card.
    prechecks(appendEvents(state.events, precheckEvents)).map((c) => [
      c.attempt_id,
      c,
    ]),
  );
  const precheckWaits = new Map<
    string,
    { item: string; target: string; card: string }[]
  >();
  for (const item of state.work_items) {
    const target = precheckWait(item);
    const attempt = target ? attempts.get(target) : undefined;
    if (!target || !attempt || !active(attempt.status)) continue;
    const list = precheckWaits.get(item.card_id) ?? [];
    list.push({ item: item.id, target, card: attempt.card_id });
    precheckWaits.set(item.card_id, list);
  }
  return (
    card: Pick<CardView, "id" | "status" | "prechecks">,
  ): CardChecking | undefined => {
    const waits = precheckWaits.get(card.id) ?? [];
    // Own running attempts, then attempts on other cards this card waits for.
    const running = [
      ...new Set([
        ...(card.prechecks ?? [])
          .filter((c) => active(c.status))
          .map((c) => c.attempt_id),
        ...waits.map((w) => w.target),
      ]),
    ];
    const others = [
      ...new Set(waits.map((w) => w.card).filter((id) => id !== card.id)),
    ];
    const merge =
      card.status === "awaiting_merge"
        ? currentCardMergeCheck(mergeState, card.id)
        : undefined;
    const checking: CardChecking = {
      ...(running.length
        ? {
            precheck: {
              attempt_ids: running,
              waiting_items: waits.map((w) => w.item),
              ...(others.length ? { cards: others } : {}),
            },
          }
        : {}),
      ...(merge && active(merge.status)
        ? {
            merge_check: { attempt_id: merge.attempt_id, status: merge.status },
          }
        : {}),
    };
    return checking.precheck || checking.merge_check ? checking : undefined;
  };
}
