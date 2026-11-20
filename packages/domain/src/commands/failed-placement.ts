import type { Assignment } from "../entities.js";
import { eventsOfType } from "../event-index.js";
import type { CardId } from "../ids.js";
import { remoteWorkerLosses } from "../remote-worker-loss.js";
import type { CommandDraft } from "./core.js";

/** A launch needs a durable Run before provisioning. A missing terminal alone is not proof. */
export function releasedBeforeFirstLaunch(
  d: CommandDraft,
  a: Assignment,
  card: CardId,
) {
  if (
    a.scope !== "work_item" ||
    a.status !== "released" ||
    a.runtime_state !== "released" ||
    a.runtime_ref ||
    a.session_ref ||
    a.worktree_path ||
    a.branch ||
    a.base_sha ||
    remoteWorkerLosses(d.state.events).some(
      (loss) => loss.assignment_id === a.id,
    )
  )
    return false;
  const release = eventsOfType(d.state.events, "assignment_released").find(
    (e) => {
      const p = e.payload as Record<string, unknown>;
      return (
        e.card_id === card &&
        e.actor.project_id === d.state.project_id &&
        e.actor.kind !== "system" &&
        p.assignment_id === a.id &&
        p.runtime_ref === null &&
        p.worktree_path === null &&
        p.branch === null
      );
    },
  );
  if (!release) return false;
  const runs = d.list("runs").filter((r) => r.assignment_id === a.id);
  if (runs.length) {
    const cancelled = (release.payload as Record<string, unknown>)
      .cancelled_queued_run_id;
    return (
      runs.length === 1 &&
      runs[0]?.id === cancelled &&
      runs[0]?.status === "cancelled"
    );
  }
  return (
    a.machine_id !== "local" &&
    eventsOfType(d.state.events, "bell_delivery_failed").some((e) => {
      const p = e.payload as Record<string, unknown>;
      return (
        e.card_id === card &&
        e.seq < release.seq &&
        e.actor.kind === "system" &&
        e.actor.project_id === d.state.project_id &&
        p.assignment_id === a.id &&
        p.reason === "snapshot_unavailable"
      );
    })
  );
}

/** Follow this takeover's predecessors, not an unrelated loss on the same item. */
export function continuesConfirmedTakeover(
  d: CommandDraft,
  retry: Assignment,
  card: CardId,
  history: readonly Assignment[],
  confirmedLoss: (a: Assignment) => boolean,
): boolean {
  const predecessors = new Map(history.map((a) => [a.id, a]));
  let current = retry;
  while (current.recovery) {
    predecessors.delete(current.id);
    const prior = predecessors.get(current.recovery.previous_assignment_id);
    if (!prior) return false;
    if (confirmedLoss(prior)) return true;
    if (!releasedBeforeFirstLaunch(d, prior, card)) return false;
    current = prior;
  }
  return false;
}
