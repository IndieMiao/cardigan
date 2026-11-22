import {
  type CardId,
  type CardView,
  type CommandState,
  latestMergeCheck,
  type WorkItem,
} from "@cardigan/domain";

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

/** One pass over work items; returns a per-card reader. */
export function cardCheckingIndex(
  state: CommandState,
  mergeState: CommandState = state,
) {
  const precheckWaits = new Map<string, WorkItem[]>();
  for (const item of state.work_items) {
    if (
      item.status !== "blocked" ||
      item.reported_blocker?.resume_when?.kind !== "precheck_finished"
    )
      continue;
    const list = precheckWaits.get(item.card_id) ?? [];
    list.push(item);
    precheckWaits.set(item.card_id, list);
  }
  return (
    card: Pick<CardView, "id" | "status" | "prechecks">,
  ): CardChecking | undefined => {
    const running = (card.prechecks ?? []).filter((c) => active(c.status));
    const runningIds = new Set(running.map((c) => c.attempt_id));
    // A wait counts only while its target attempt is still queued or running;
    // once the attempt settles, the item reads as an ordinary blocker again.
    const waiting = (precheckWaits.get(card.id) ?? [])
      .filter((item) =>
        runningIds.has(item.reported_blocker?.resume_when?.target_id ?? ""),
      )
      .map((item) => item.id);
    const merge =
      card.status === "awaiting_merge"
        ? currentCardMergeCheck(mergeState, card.id)
        : undefined;
    const checking: CardChecking = {
      ...(running.length
        ? {
            precheck: {
              attempt_ids: running.map((c) => c.attempt_id),
              waiting_items: waiting,
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
