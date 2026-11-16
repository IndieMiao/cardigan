import {
  type CommandState,
  newPmNotification,
  orderPmNotificationGroups,
  pmNotificationState,
} from "@cardigan/domain";
import type { Candidate } from "./candidate-index.js";

/** Consume fresh state outside CandidateIndex: human actions and decisions can change without any new bell. */
export function orderPmCandidates(
  queue: readonly Candidate[],
  stateOf: (c: Candidate) => CommandState,
): Candidate[] {
  return orderPmNotificationGroups(queue, (c) => {
    if (
      c.assignment.scope !== "standing" ||
      c.assignment.role_id !== "pm" ||
      c.assignment.standing_mode !== "ops" ||
      !c.notes.length
    )
      return;
    const state = stateOf(c);
    if (!c.notes.every((n) => newPmNotification(state, n))) return;
    return {
      recipient: `${c.project}/${c.assignment.id}`,
      urgent: c.notes.some((n) => pmNotificationState(state, n) === "urgent"),
    };
  });
}
