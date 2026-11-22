import type { CardView, WaitingOnItem } from "./api.js";

export const PRECHECK_LABEL = "预检中";
export const MERGE_CHECK_LABEL = "合并检查中";

/**
 * C-567: a blocker that only waits for a running precheck is shown as
 * “预检中”, not as a red block. Once the precheck settles, the server drops it
 * from `checking` and the item reads as an ordinary blocker again.
 */
export function cardChecking(card: Pick<CardView, "waiting_on" | "checking">) {
  const precheckItems = new Set(card.checking?.precheck?.waiting_items ?? []);
  const precheckWait = (item: WaitingOnItem) =>
    item.kind === "blocked" && precheckItems.has(item.ref);
  return {
    precheck: !!card.checking?.precheck,
    mergeCheck: !!card.checking?.merge_check,
    /** `waiting_on` without the blockers that only wait for a precheck. */
    waiting: card.waiting_on.filter((item) => !precheckWait(item)),
    precheckWait,
  };
}
