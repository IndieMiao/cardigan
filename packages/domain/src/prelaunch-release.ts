import type { Event } from "./entities.js";
import { eventsOfType } from "./event-index.js";
import type { AssignmentId, CardId, ProjectId } from "./ids.js";

/** The release command's durable proof, scoped to one work-item assignment. */
export function prelaunchRelease(
  state: { project_id: ProjectId; events: readonly Event[] },
  card: CardId,
  assignment: AssignmentId,
) {
  return eventsOfType(state.events, "assignment_released").find((e) => {
    const p = e.payload as Record<string, unknown> | null;
    return (
      e.card_id === card &&
      e.actor.project_id === state.project_id &&
      e.actor.kind !== "system" &&
      p?.assignment_id === assignment &&
      p.runtime_ref === null &&
      p.worktree_path === null &&
      p.branch === null
    );
  });
}

export function cancelledQueueRelease(
  ...args: Parameters<typeof prelaunchRelease>
) {
  const release = prelaunchRelease(...args);
  return typeof (
    release?.payload as { cancelled_queued_run_id?: unknown } | undefined
  )?.cancelled_queued_run_id === "string"
    ? release
    : undefined;
}
