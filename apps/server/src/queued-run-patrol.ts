import {
  assignmentCardId,
  type CommandState,
  DEFAULT_QUEUED_RECHECK_AFTER_MS,
  type Event,
  type Run,
  runOccupiesSlot,
} from "@cardigan/domain";
import { effectiveRunLimit, runCapacitySnapshot } from "@cardigan/host";
import {
  type BellAttempt,
  recordNotification,
  type Store,
  type StoreTransactionContext,
} from "@cardigan/store";
import { runQueuedAt } from "./run-queued-at.js";

/** Sweep on dispatcher ticks, not on change-feed events. Re-enter normal admission; never start a Run here. */
export class QueuedRunPatrol {
  private readonly threshold: number;
  private readonly lastEvaluation = new WeakMap<Run, number>();
  private readonly queues = new WeakMap<readonly Run[], readonly Run[]>();

  constructor(
    private readonly options: {
      store: Store;
      runLimit?: (machine: string) => number;
      runLimitMaximum?: (machine: string) => number;
      queuedRecheckAfterMs?: number;
    },
  ) {
    this.threshold =
      options.queuedRecheckAfterMs ?? DEFAULT_QUEUED_RECHECK_AFTER_MS;
    if (!Number.isSafeInteger(this.threshold) || this.threshold <= 0)
      throw new Error("Invalid queued Run recheck interval");
  }

  evaluated(run: Run, at: string) {
    this.lastEvaluation.set(run, Date.parse(at));
  }

  sweep(
    tx: StoreTransactionContext,
    state: CommandState,
    at: string,
    attempts: readonly BellAttempt[],
  ) {
    const project = state.project_id,
      now = Date.parse(at);
    let queue = this.queues.get(state.runs);
    if (!queue) {
      queue = state.runs.filter((r) => r.status === "queued");
      this.queues.set(state.runs, queue);
    }
    if (!queue.length) return;
    const reserved = new Set(attempts.map((a) => a.run_id));
    const { store, runLimit, runLimitMaximum } = this.options;
    let capacity: ReturnType<typeof runCapacitySnapshot> | undefined;
    for (const run of queue) {
      if (reserved.has(run.id) || runOccupiesSlot(run)) continue;
      const queuedAt =
        run.queue_entered_at ?? runQueuedAt(state)(run).queued_at;
      // No creation *or* trigger timestamp: age from first observation, never invent a bell.
      if (!queuedAt) {
        tx.runs.put(project, { ...run, queue_entered_at: at });
        continue;
      }
      if (now - Date.parse(queuedAt) < this.threshold) continue;
      const a = tx.assignments.get(project, run.assignment_id);
      if (!a) continue;
      const last = Math.max(
        Date.parse(queuedAt),
        Date.parse(run.queue_last_recheck_at ?? queuedAt),
        this.lastEvaluation.get(run) ?? 0,
      );
      const recheck = now - last >= this.threshold;
      if (!recheck && run.queue_notified_at) continue;
      let spare = false;
      if (!run.queue_notified_at) {
        capacity ??= runCapacitySnapshot(store, tx);
        spare =
          (capacity.occupied.get(a.machine_id) ?? 0) <
          effectiveRunLimit(store, a.machine_id, runLimit, runLimitMaximum);
      }
      if (!recheck && !spare) continue;
      const card = assignmentCardId(a, state, run.trigger_event_id);
      const event: Event = {
        id: tx.ids.nextEventId(),
        seq: tx.ids.nextEventSequence(project, card),
        ...(card ? { card_id: card } : {}),
        type: recheck ? "queued_run_rechecked" : "queued_run_spare_capacity",
        actor: { kind: "system", project_id: project },
        created_at: at,
        payload: {
          run_id: run.id,
          assignment_id: a.id,
          machine_id: a.machine_id,
          queued_at: queuedAt,
          queue_reason: run.queue_reason ?? null,
          threshold_ms: this.threshold,
          notified_pm_ops: spare,
          body: spare
            ? `${run.id} 已排队 ${Math.floor((now - Date.parse(queuedAt)) / 60_000)} 分钟，${a.machine_id} 仍有并发名额。`
            : `${run.id} 排队超时，已请求重新评估。`,
        },
      };
      tx.events.append(project, event);
      if (spare)
        recordNotification(store.database, {
          project_id: project,
          card_id: card,
          event_id: event.id,
          seq: event.seq,
          recipient: { kind: "pm_ops" },
          kind: "run_attention",
          at,
        });
      // Change the Run row even for an existing waiter: this invalidates the
      // owner's candidate result. Never pretend a missing reason was a capacity denial.
      tx.runs.put(project, {
        ...run,
        ...(recheck
          ? {
              queue_reason: run.queue_reason ?? "awaiting_dispatch",
              queue_last_recheck_at: at,
            }
          : {}),
        ...(spare ? { queue_notified_at: at } : {}),
      });
    }
  }
}
