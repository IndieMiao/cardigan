import type {
  Assignment,
  CommandState,
  WorkerRecoveryBackup,
} from "@cardigan/domain";

/** RW-1 success evidence is project-scoped and written only after a verified fetch. */
export function lastSuccessfulWorkerBackup(
  state: Pick<CommandState, "project_id" | "events">,
  assignment: Pick<Assignment, "id" | "machine_id" | "branch">,
): WorkerRecoveryBackup | undefined {
  if (!assignment.branch) return;
  const event = state.events.findLast((e) => {
    if (
      e.type !== "assignment_branch_backed_up" ||
      e.actor.kind !== "system" ||
      e.actor.project_id !== state.project_id ||
      e.card_id !== undefined ||
      !e.payload ||
      typeof e.payload !== "object" ||
      Array.isArray(e.payload)
    )
      return false;
    const payload = e.payload as Record<string, unknown>;
    return (
      payload.assignment_id === assignment.id &&
      payload.machine_id === assignment.machine_id &&
      payload.branch === assignment.branch
    );
  });
  if (!event) return;
  const payload = event.payload as Record<string, unknown>;
  if (
    typeof payload.sha !== "string" ||
    !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(payload.sha) ||
    payload.ref !==
      `refs/cardigan/backups/${assignment.machine_id}/${assignment.branch}` ||
    !Number.isFinite(Date.parse(event.created_at))
  )
    return;
  return { sha: payload.sha, at: event.created_at, branch: assignment.branch };
}
