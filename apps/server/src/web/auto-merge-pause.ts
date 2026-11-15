import {
  autoMergePaused,
  type CommandState,
  flowAtLeast,
  pmMergeBlockers,
  prepareMergePlan,
  projectPreferences,
} from "@cardigan/domain";

/** A3b read contract. A3a owns creation/consumption of system confirmations.
 * Do not widen Decider or activate flow 4 here; historical flows never count.
 */
export function autoMergePauseView(state: CommandState) {
  const paused = autoMergePaused(projectPreferences(state));
  if (!paused) return { paused, waiting_count: 0 };
  const waiting = new Set<string>();
  for (const q of state.decisions) {
    const card = state.cards.find((c) => c.id === q.card_id);
    if (
      !card ||
      card.project_id !== state.project_id ||
      card.status !== "awaiting_merge" ||
      !flowAtLeast(card, 4) ||
      q.trigger !== "merge_confirmation" ||
      q.human_required_reason ||
      q.superseded_by
    )
      continue;
    const systemHeld = String(q.decider) === "system" && q.status === "open";
    const systemConfirmed =
      String(q.decider) === "system" &&
      q.status === "resolved" &&
      q.resolution?.resolved_by === "system" &&
      q.resolution.option === "merge";
    // The shared gates bind the current completion and exclude checks, reviews,
    // blocking decisions and human prerequisites. Confirmation itself may wait.
    if (
      (systemHeld || systemConfirmed) &&
      pmMergeBlockers(state, q).length === 0 &&
      prepareMergePlan(state, card.id).ok
    )
      waiting.add(card.id);
  }
  return { paused, waiting_count: waiting.size };
}
