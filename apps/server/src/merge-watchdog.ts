import type { Clock, ProjectId } from "@cardigan/domain";
import { recordNotification, type Store } from "@cardigan/store";

export const DEFAULT_MERGE_WATCHDOG_MS = 5 * 60_000;

/** Runs outside the monitored await. Never interrupts a publication or restarts the host. */
export function watchMergePass(
  store: Store,
  clock: Clock,
  threshold: number,
  onError: (error: unknown) => void,
) {
  const started = clock.now();
  const notified = new Set<ProjectId>();
  const timer = setInterval(() => {
    try {
      for (const { id } of store.listProjects()) {
        if (notified.has(id)) continue;
        try {
          store.uow.run((tx) => {
            const ops = tx.assignments
              .list(id)
              .find(
                (a) =>
                  a.status === "active" &&
                  a.scope === "standing" &&
                  a.role_id === "host_ops",
              );
            const event = {
              id: tx.ids.nextEventId(),
              seq: tx.ids.nextEventSequence(id),
              actor: { kind: "system" as const, project_id: id },
              created_at: clock.now(),
              type: "merge_loop_stalled",
              payload: {
                started_at: started,
                threshold_ms: threshold,
                ...(ops ? { assignment_id: ops.id } : {}),
              },
            };
            tx.events.append(id, event);
            recordNotification(store.database, {
              project_id: id,
              event_id: event.id,
              seq: event.seq,
              at: event.created_at,
              recipient: ops
                ? { kind: "assignment", assignment_id: ops.id }
                : { kind: "pm_ops" },
              kind: "run_attention",
            });
          });
          notified.add(id);
        } catch (error) {
          onError(error);
        }
      }
    } catch (error) {
      onError(error);
    }
  }, threshold);
  return () => clearInterval(timer);
}
