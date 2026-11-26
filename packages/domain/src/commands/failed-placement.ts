import type { Assignment, Run } from "../entities.js";
import { eventById, eventsOfType } from "../event-index.js";
import type { CardId } from "../ids.js";
import { prelaunchRelease } from "../prelaunch-release.js";
import { remoteWorkerLosses } from "../remote-worker-loss.js";
import type { CommandDraft } from "./core.js";

/** Only a first queue or its single host-confirmed, cleaned preparation retry may move. */
export function neverDispatchedQueue(d: CommandDraft, run: Run, card: CardId) {
  const runs = d
    .list("runs")
    .filter((r) => r.assignment_id === run.assignment_id);
  if (
    runs.some(
      (r) =>
        r.started_at ||
        (r.launch_publication &&
          (r.launch_publication.phase !== "exited" ||
            r.launch_publication.provision_attempted !== false ||
            r.launch_publication.runtime_ref !== null ||
            r.launch_publication.process !== null)) ||
        r.recovery_runtime ||
        r.dispatch_stop ||
        r.inactivity_stop ||
        r.pending_finish,
    )
  )
    return false;
  if (
    eventsOfType(d.state.events, "run_dispatched").some((e) => {
      const p = e.payload as { assignment_id?: string; run_id?: string };
      return (
        p?.assignment_id === run.assignment_id ||
        runs.some((r) => r.id === p?.run_id)
      );
    })
  )
    return false;
  if (!run.preparation_retry) return runs.length === 1;
  // C-738: a chain of host-confirmed preparation retries, each bound to its
  // cancelled source, back to the first queue — and no other Run.
  const chain = new Set<string>();
  let current = run;
  while (current.preparation_retry) {
    if (chain.has(current.id)) return false;
    chain.add(current.id);
    const retry = current.preparation_retry;
    const source = runs.find(
      (r) => r.id === retry.source_run_id && r.id !== current.id,
    );
    const evidence = eventById(d.state.events, current.trigger_event_id);
    const p = evidence?.payload as Record<string, unknown> | undefined;
    if (
      source?.status !== "cancelled" ||
      evidence?.type !== "run_preparation_recovered" ||
      evidence.actor.kind !== "system" ||
      evidence.actor.project_id !== d.state.project_id ||
      evidence.card_id !== card ||
      p?.assignment_id !== run.assignment_id ||
      p.run_id !== source.id ||
      p.replacement_run_id !== current.id ||
      p.original_trigger_event_id !== source.trigger_event_id ||
      p.ready_at !== retry.ready_at
    )
      return false;
    current = source;
  }
  if (chain.has(current.id)) return false;
  chain.add(current.id);
  return runs.length === chain.size;
}

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
  const release = prelaunchRelease(d.state, card, a.id);
  if (!release) return false;
  const runs = d.list("runs").filter((r) => r.assignment_id === a.id);
  if (runs.length) {
    const cancelled = (release.payload as Record<string, unknown>)
      .cancelled_queued_run_id;
    const run = runs.find((r) => r.id === cancelled);
    return run?.status === "cancelled" && neverDispatchedQueue(d, run, card);
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

/**
 * C-716: for an assignment already proven `releasedBeforeFirstLaunch`, did its
 * first launch actually fail on that machine? A snapshot failure (no Run) or a
 * host-recovered preparation failure did; a released queue that was simply
 * never dispatched did not.
 */
export function firstLaunchFailed(d: CommandDraft, a: Assignment) {
  const runs = d.list("runs").filter((r) => r.assignment_id === a.id);
  return !runs.length || runs.some((r) => r.preparation_retry);
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
