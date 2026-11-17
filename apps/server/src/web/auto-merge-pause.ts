import {
  autoMergeOn,
  autoMergePaused,
  type CommandState,
  prepareMergePlan,
  projectPreferences,
  systemMergeBlockers,
  systemMergeEnabled,
  systemMergeHumanReason,
} from "@cardigan/domain";

/** Read-only: Flow Lite includes ready system-held cards from every flow version. */
export function autoMergePauseView(state: CommandState) {
  const preferences = projectPreferences(state);
  const lite = autoMergeOn(preferences);
  const paused = autoMergePaused(preferences);
  if (!paused) return { paused, waiting_count: 0 };
  const waiting = new Set<string>();
  for (const q of state.decisions) {
    const card = state.cards.find((c) => c.id === q.card_id);
    if (
      !card ||
      card.project_id !== state.project_id ||
      card.status !== "awaiting_merge" ||
      !systemMergeEnabled(state, card) ||
      q.trigger !== "merge_confirmation" ||
      (lite ? !!systemMergeHumanReason(state, q) : !!q.human_required_reason) ||
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
      systemMergeBlockers(state, q).length === 0 &&
      prepareMergePlan(state, card.id).ok
    )
      waiting.add(card.id);
  }
  return { paused, waiting_count: waiting.size };
}
