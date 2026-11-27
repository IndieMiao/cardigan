import {
  type Assignment,
  assignmentCardId,
  type CommandState,
  DEFAULT_QUEUED_MIGRATE_AFTER_MS,
  DEFAULT_QUEUED_MIGRATION_COOLDOWN_MS,
  DEFAULT_QUEUED_RECHECK_AFTER_MS,
  type Event,
  migrateQueuedRun,
  type Run,
  runOccupiesSlot,
  startedAssignment,
} from "@cardigan/domain";
import {
  effectiveRunLimit,
  type ReadProjectQuota,
  type ReadResourceLimits,
  type RunCapacityBlock,
  resolveResourceAlternatives,
  runCapacitySnapshot,
  runResourceKeys,
} from "@cardigan/host";
import { persistEffect } from "@cardigan/mcp-server";
import {
  type BellAttempt,
  PROJECT_EVENT_STREAM,
  recordNotification,
  type Store,
  type StoreTransactionContext,
} from "@cardigan/store";
import { runQueuedAt } from "./run-queued-at.js";

/**
 * C-826: where a queued Run could be admitted right now, by the dispatcher's
 * own admission rules: on its machine, on which other registered machines,
 * and the full ceiling holding it on its machine.
 */
export type QueueFit = (
  tx: StoreTransactionContext,
  state: CommandState,
  owner: Assignment,
  run: Run,
) => {
  readonly here: boolean;
  readonly elsewhere: readonly string[];
  readonly block?: RunCapacityBlock | undefined;
};

/** C-826: a never-started owner is re-examined at most this often. */
const MIGRATION_CHECK_INTERVAL_MS = 60_000;

/** Sweep on dispatcher ticks, not on change-feed events. Re-enter normal admission; never start a Run here. */
export class QueuedRunPatrol {
  private readonly threshold: number;
  private readonly migrateAfter: number | null;
  private readonly migrationCooldown: number;
  private readonly lastEvaluation = new WeakMap<Run, number>();
  private readonly lastMigrationCheck = new Map<string, number>();
  private readonly queues = new WeakMap<readonly Run[], readonly Run[]>();

  constructor(
    private readonly options: {
      store: Store;
      runLimit?: (machine: string) => number;
      runLimitMaximum?: (machine: string) => number;
      resourceLimits?: ReadResourceLimits;
      projectQuota?: ReadProjectQuota;
      queuedRecheckAfterMs?: number;
      /** C-826: null turns automatic queue migration off. */
      queuedMigrateAfterMs?: number | null;
      queuedMigrationCooldownMs?: number;
    },
    private readonly fit?: QueueFit,
  ) {
    this.threshold =
      options.queuedRecheckAfterMs ?? DEFAULT_QUEUED_RECHECK_AFTER_MS;
    if (!Number.isSafeInteger(this.threshold) || this.threshold <= 0)
      throw new Error("Invalid queued Run recheck interval");
    this.migrateAfter =
      options.queuedMigrateAfterMs === undefined
        ? DEFAULT_QUEUED_MIGRATE_AFTER_MS
        : options.queuedMigrateAfterMs;
    this.migrationCooldown =
      options.queuedMigrationCooldownMs ?? DEFAULT_QUEUED_MIGRATION_COOLDOWN_MS;
    if (
      (this.migrateAfter !== null &&
        (!Number.isSafeInteger(this.migrateAfter) || this.migrateAfter <= 0)) ||
      !Number.isSafeInteger(this.migrationCooldown) ||
      this.migrationCooldown < 0
    )
      throw new Error("Invalid queued Run migration interval");
  }

  /**
   * C-826: move a never-started owner whose Run has waited past the
   * threshold to a machine where it can start now. The domain command
   * re-checks eligibility, filters and anti-flapping in this transaction.
   */
  private migrate(
    tx: StoreTransactionContext,
    state: CommandState,
    run: Run,
    owner: Assignment,
    queuedAt: string,
    at: string,
  ): boolean {
    const now = Date.parse(at);
    const key = `${state.project_id}/${run.id}`;
    if (
      !this.fit ||
      this.migrateAfter === null ||
      run.queue_reason !== "concurrency_limit" ||
      owner.scope !== "work_item" ||
      owner.status !== "active" ||
      owner.external ||
      startedAssignment(owner) ||
      now - Date.parse(queuedAt) < this.migrateAfter ||
      now - (this.lastMigrationCheck.get(key) ?? 0) <
        MIGRATION_CHECK_INTERVAL_MS
    )
      return false;
    this.lastMigrationCheck.set(key, now);
    let fit: ReturnType<QueueFit>;
    try {
      fit = this.fit(tx, state, owner, run);
    } catch {
      // A read the admission cannot evaluate leaves the Run where it is.
      return false;
    }
    // Admissible where it is: normal dispatch starts it there.
    if (fit.here || !fit.elsewhere.length) return false;
    const project = state.project_id;
    const result = migrateQueuedRun(
      state,
      { kind: "system", project_id: project },
      {
        run_id: run.id,
        admissible: fit.elsewhere,
        reason: fit.block ? capacityBlockReason(fit.block) : "并发名额已满",
        queued_at: queuedAt,
        cooldown_ms: this.migrationCooldown,
      },
      {
        clock: { now: () => at },
        ids: tx.ids,
        ...(tx.unreservedAssignment
          ? { unreservedAssignment: tx.unreservedAssignment }
          : {}),
      },
    );
    if (!result.ok) return false;
    persistEffect(tx, project, result.value);
    this.lastMigrationCheck.delete(key);
    return true;
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
    for (const key of this.lastMigrationCheck.keys())
      if (
        key.startsWith(`${project}/`) &&
        !queue.some((r) => key === `${project}/${r.id}`)
      )
        this.lastMigrationCheck.delete(key);
    if (!queue.length) return;
    const reserved = new Set(attempts.map((a) => a.run_id));
    const { store, runLimit, runLimitMaximum, resourceLimits, projectQuota } =
      this.options;
    let capacity: ReturnType<typeof runCapacitySnapshot> | undefined;
    // One migration per sweep: the rest of the queue was read before it.
    let migrated = false;
    for (const run of queue) {
      if (reserved.has(run.id) || runOccupiesSlot(run)) continue;
      const queuedAt =
        run.queue_entered_at ?? runQueuedAt(state)(run).queued_at;
      // No creation *or* trigger timestamp: age from first observation, never invent a bell.
      if (!queuedAt) {
        tx.runs.put(project, { ...run, queue_entered_at: at });
        continue;
      }
      const a = tx.assignments.get(project, run.assignment_id);
      if (!a) continue;
      if (!migrated && this.migrate(tx, state, run, a, queuedAt, at)) {
        migrated = true;
        continue;
      }
      if (now - Date.parse(queuedAt) < this.threshold) continue;
      const last = Math.max(
        Date.parse(queuedAt),
        Date.parse(run.queue_last_recheck_at ?? queuedAt),
        this.lastEvaluation.get(run) ?? 0,
      );
      const recheck = now - last >= this.threshold;
      if (!recheck && run.queue_notified_at) continue;
      let spare = false;
      let block: RunCapacityBlock | undefined;
      if (!run.queue_notified_at) {
        capacity ??= runCapacitySnapshot(
          store,
          tx,
          resourceLimits,
          projectQuota,
        );
        spare =
          (capacity.occupied.get(a.machine_id) ?? 0) <
          effectiveRunLimit(store, a.machine_id, runLimit, runLimitMaximum);
        // C-714: free machine slots alone do not mean this Run can start.
        // C-721: name only the resources this Run itself would claim.
        // C-815: an `android.any` Run is named by the option it would take.
        const snapshot = capacity;
        if (spare)
          block = capacity.capacityBlock(
            project,
            a,
            resolveResourceAlternatives(
              store,
              project,
              a,
              runResourceKeys(
                tx,
                project,
                a,
                state.events,
                run,
                // Notices the owner already acknowledged ride on no bell.
                store
                  .listNotifications({
                    project_id: project,
                    status: "pending",
                    assignment_id: a.id,
                  })
                  .filter(
                    (n) =>
                      !state.cursors.some(
                        (c) =>
                          c.assignment_id === a.id &&
                          c.card_id === (n.card_id ?? PROJECT_EVENT_STREAM) &&
                          c.acked_seq >= n.seq,
                      ),
                  ),
                state.timeline,
              ),
              at,
              () => snapshot,
            ),
          );
      }
      if (!recheck && !spare) continue;
      const minutes = Math.floor((now - Date.parse(queuedAt)) / 60_000);
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
          ...(block ? { capacity_block: block } : {}),
          body: spare
            ? `${run.id} 已排队 ${minutes} 分钟，${block ? capacityBlockText(block) : `${a.machine_id} 仍有并发名额。`}`
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

/** C-826: the short form of a ceiling, for the migration timeline line. */
export function capacityBlockReason(block: RunCapacityBlock): string {
  switch (block.kind) {
    case "project_limit":
      return `项目上限 ${block.limit} 已用满`;
    case "project_resource":
      return `项目 ${block.resource} 名额 ${block.limit} 已用满`;
    case "machine_resource":
      return `${block.resource} 名额 ${block.limit} 已用满`;
  }
}

/** C-714: name the full ceiling instead of claiming spare Run capacity. */
export function capacityBlockText(block: RunCapacityBlock): string {
  const others =
    block.kind === "machine_resource" && block.other_project_runs
      ? `其它项目 ${block.other_project_runs} 个`
      : "";
  const held = [
    ...(block.run_ids.length ? [block.run_ids.join("、")] : []),
    ...(others ? [others] : []),
  ];
  const holders = held.length ? `（占用：${held.join("；")}）` : "";
  switch (block.kind) {
    case "project_limit":
      return `项目 ${block.project_id} 在 ${block.machine_id} 的上限 ${block.limit} 已用满${holders}；整机名额未满。`;
    case "project_resource":
      return `项目 ${block.project_id} 在 ${block.machine_id} 的资源 ${block.resource} 上限 ${block.limit} 已用满${holders}；整机名额未满。`;
    case "machine_resource":
      return `${block.machine_id} 的资源 ${block.resource} 名额 ${block.limit} 已用满${holders}；整机名额未满。`;
  }
}
