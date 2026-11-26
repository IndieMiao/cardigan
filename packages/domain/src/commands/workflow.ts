import { unmetCardDependencies } from "../card-dependencies.js";
import type { WorkItem } from "../entities.js";
import type { CardId, WorkItemId } from "../ids.js";
import { beginReviewRound } from "../transitions.js";
import {
  dependencyState,
  requireCardDependencyStart,
} from "./card-dependencies.js";
import { type CommandDraft, ensure, unwrap } from "./core.js";
import { reviewRound } from "./review-round.js";

export { reviewRound } from "./review-round.js";

import { workCompleted } from "./work-status.js";

export { workCompleted } from "./work-status.js";

/**
 * M5.S S6: whether a Run could start this work item right now.
 *
 * A bell that comes from `assign` (an Agent or the PM assigning through MCP)
 * must not wake an Agent that has nothing to do yet: a verify item waits for
 * its target delivery and a produce item for its dependencies — both are woken
 * by their own bell when that happens (§6.4). The rule mirrors `activeWork`
 * without moving anything; the Run itself still advances the item.
 */
export function canStartWork(input: {
  readonly item: WorkItem;
  readonly work_items: readonly WorkItem[];
}): boolean {
  const { item } = input;
  if (item.kind === "verify")
    return (
      item.status === "ready" ||
      (item.status === "todo" && !!item.review_plan_target)
    );
  if (item.status === "ready" || item.status === "changes_requested")
    return true;
  if (item.status !== "todo") return false;
  return item.depends_on.every((id) => {
    const dependency = input.work_items.find(
      (candidate) => candidate.id === id,
    );
    return dependency !== undefined && workCompleted(dependency);
  });
}

/**
 * C-735: the prerequisites that keep `activeWork` from starting this item now,
 * or undefined when it may start. Mirrors the dependency checks of
 * `activeWork` without moving anything, so a Run woken before its
 * prerequisites finish can start as a discussion instead of failing.
 */
export function workDependencyWait(
  d: CommandDraft,
  item: WorkItem,
):
  | {
      readonly cards: readonly CardId[];
      readonly work_items: readonly WorkItemId[];
    }
  | undefined {
  const current = d.work(item.id);
  if (!["todo", "ready", "changes_requested"].includes(current.status)) return;
  const card = d.card(current.card_id);
  const cards =
    card.depends_on_cards?.length && !card.early_start
      ? unmetCardDependencies(dependencyState(d), card)
      : [];
  const work_items =
    current.kind === "produce" && current.status === "todo"
      ? current.depends_on.filter((id) => !workCompleted(d.work(id)))
      : [];
  return cards.length || work_items.length ? { cards, work_items } : undefined;
}

// Only the caller's current Run can activate its work; waiting/terminal states stay intact.
export function activeWork(d: CommandDraft, item: WorkItem): WorkItem {
  let next = d.ownWork(item.id);
  if (["todo", "ready", "changes_requested"].includes(next.status))
    requireCardDependencyStart(d, d.card(item.card_id));
  if (next.kind === "produce" && next.status === "todo") {
    d.currentRun();
    ensure(
      next.depends_on.every((id) => workCompleted(d.work(id))),
      "invariant_violation",
      `Dependencies are not complete for ${item.id}`,
    );
    next = d.move(next, "dependencies_met");
  }
  if (
    next.status === "ready" ||
    (next.kind === "produce" && next.status === "changes_requested")
  ) {
    d.currentRun();
    if (next.kind === "verify") {
      const round = reviewRound(d, next);
      ensure(
        round <= next.max_review_rounds,
        "illegal_transition",
        `Review round limit has been reached for ${item.id} (${item.kind}:${item.status})`,
      );
      return {
        ...next,
        status: unwrap(
          beginReviewRound(next.status, round, next.max_review_rounds),
        ),
      };
    }
    return d.move(next, "run_started");
  }
  return next;
}
