import type { CardId, Clock, ProjectId } from "@cardigan/domain";
import type { ReconcileChecks, ReconcileFinding } from "@cardigan/git-service";
import { retireReconcileNotifications, type Store } from "@cardigan/store";
import { buildCheckoutFacts } from "./build-checkouts.js";
import type { ReconcileGit } from "./git.js";
import { startTimerLoop, type TimerLoop } from "./loop.js";
import { systemClock } from "./merge-loop.js";
import { profileSpan, profileSpanSync } from "./tick-profile.js";

/**
 * M4.4 reconciliation and backup loops (plan §3.6, §3.7; development plan §12.6).
 *
 * Reconciliation compares Git, the worktree directories and the database. It
 * only reports: findings go into the store with their first/last-seen times and
 * a new finding becomes a project-level `reconcile_finding` event, which the
 * Router hands to PM Ops. The one repair it performs is §3.3's: a Git delivery
 * without its fixed ref is re-pinned from the candidate ref.
 *
 * The backup loop fetches `agent/*` from the base clone into the central
 * repository; a failure is logged and changes nothing.
 */
export const DEFAULT_RECONCILE_INTERVAL_MS = 600_000;
export const DEFAULT_BACKUP_INTERVAL_MS = 600_000;

export interface ReconcileOptions {
  readonly store: Store;
  readonly git: ReconcileGit;
  readonly clock?: Clock;
  readonly onError?: (error: unknown) => void;
  /** Non-fatal problems (a failed backup, an unreachable candidate). */
  readonly report?: (message: string) => void;
}

export class ReconcileExecutor {
  private serial: Promise<void> = Promise.resolve();
  // Process-local only: a restart replays durable events, never skips history.
  private readonly checkHistory = new Map<
    ProjectId,
    {
      cursors: ReadonlyMap<string, number>;
      attempts: ReadonlyMap<string, ReconcileChecks["attempts"][number]>;
    }
  >();
  constructor(private readonly options: ReconcileOptions) {}

  private get clock(): Clock {
    return this.options.clock ?? systemClock;
  }
  private state(project_id: ProjectId) {
    return this.options.store.uow.read((tx) => ({
      assignments: tx.assignments.list(project_id),
      work_items: tx.work_items.list(project_id),
      deliveries: tx.deliveries.list(project_id),
    }));
  }

  /** The loop owns database access; ServerGit only needs project lookup. */
  private checks(project_id: ProjectId): ReconcileChecks {
    return profileSpanSync("reconcile.checks", () =>
      this.readChecks(project_id),
    );
  }
  private readChecks(project_id: ProjectId): ReconcileChecks {
    const snapshot = this.options.store.uow.read((tx) => {
      const previous = this.checkHistory.get(project_id);
      const cursors = new Map(previous?.cursors);
      // Keep old attempts too, including superseded completions/closed cards.
      const latest = new Map(previous?.attempts);
      for (const card of tx.cards.list(project_id))
        for (const event of tx.events.listAfter(
          project_id,
          card.id,
          cursors.get(card.id) ?? 0,
        )) {
          cursors.set(card.id, event.seq);
          if (
            event.actor.kind !== "system" ||
            ![
              "merge_check_queued",
              "merge_check_started",
              "merge_check_finished",
              "precheck_queued",
              "precheck_started",
              "precheck_finished",
            ].includes(event.type)
          )
            continue;
          const check = event.payload as ReconcileChecks["attempts"][number];
          latest.set(check.attempt_id, {
            ...check,
            updated_at: event.created_at,
          });
        }
      const streams = tx.events.listStreams?.(project_id);
      const projectEvents = streams
        ? (streams.get("") ?? [])
        : tx.events.listAfter(project_id, undefined, cursors.get("") ?? 0);
      for (const event of projectEvents) {
        if (event.seq <= (previous?.cursors.get("") ?? 0)) continue;
        cursors.set("", event.seq);
        if (
          event.actor.kind !== "system" ||
          !/^merge_batch_check_(queued|started|finished)$/u.test(event.type)
        )
          continue;
        const check = (
          event.payload as unknown as {
            check: ReconcileChecks["attempts"][number];
          }
        ).check;
        if (check?.attempt_id)
          latest.set(check.attempt_id, {
            ...check,
            updated_at: event.created_at,
          });
      }
      return {
        cursors,
        attempts: latest,
        checks: {
          attempts: [...latest.values()],
          now: this.clock.now(),
          // P2a-3: verifier build checkouts live as long as their Runs.
          builds: buildCheckoutFacts(tx.runs.list(project_id)),
        },
      };
    });
    // Publish only after the read transaction has completed successfully.
    this.checkHistory.set(project_id, snapshot);
    return snapshot.checks;
  }

  tick(project_id?: ProjectId): Promise<void> {
    const next = this.serial.then(async () => {
      for (const project of project_id
        ? [project_id]
        : this.options.store.listProjects().map((entry) => entry.id))
        await this.project(project as ProjectId);
    });
    this.serial = next.catch(() => {});
    return next;
  }

  /** §3.3: a missing fixed ref is repaired from the candidate ref, once. */
  private async repair(
    project_id: ProjectId,
    findings: readonly ReconcileFinding[],
  ): Promise<boolean> {
    const project = this.options.git.projectOf(project_id);
    if (project === undefined) return false;
    const state = this.state(project_id);
    let repaired = false;
    for (const finding of findings) {
      if (finding.kind !== "missing_delivery_ref" || !finding.delivery_id)
        continue;
      const delivery = state.deliveries.find(
          (candidate) => candidate.id === finding.delivery_id,
        ),
        item = state.work_items.find(
          (candidate) => candidate.id === delivery?.work_item_id,
        ),
        assignment = state.assignments.find(
          (candidate) => candidate.id === item?.assignment_id,
        );
      if (delivery === undefined || assignment === undefined) continue;
      try {
        if (await this.options.git.repairPin(project, delivery, assignment))
          repaired = true;
      } catch (error) {
        this.report(
          `pinning ${delivery.id} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return repaired;
  }

  private record(project_id: ProjectId, findings: readonly ReconcileFinding[]) {
    const at = this.clock.now();
    return this.options.store.uow.run((tx) => {
      // P2a-12 C: an unreachable executor's directories were not scanned;
      // keep its open findings instead of resolving them.
      const unscanned = findings
        .filter((finding) => finding.kind === "executor_unreachable")
        .flatMap((finding) =>
          finding.path === undefined ? [] : [`${finding.path}/`],
        );
      const { created } = this.options.store.recordReconcileFindings(
        project_id,
        findings,
        {
          unscanned,
          // A failed targeted probe must not resolve a previously confirmed
          // missing directory, or preserve a different Assignment's prefix.
          unscannedPaths: findings
            .filter((finding) => finding.kind === "worker_unchecked")
            .flatMap((finding) =>
              finding.path === undefined ? [] : [finding.path],
            ),
        },
      );
      retireReconcileNotifications(this.options.store.database, project_id, at);
      for (const finding of created) {
        const seq = tx.ids.nextEventSequence(project_id, undefined);
        tx.events.append(project_id, {
          id: tx.ids.nextEventId(),
          seq,
          type: "reconcile_finding",
          actor: { kind: "system", project_id },
          payload: {
            kind: finding.kind,
            detail: finding.detail,
            first_seen_at: finding.first_seen_at,
            ...(finding.path === undefined ? {} : { path: finding.path }),
            ...(finding.assignment_id === undefined
              ? {}
              : { assignment_id: finding.assignment_id }),
            ...(finding.delivery_id === undefined
              ? {}
              : { delivery_id: finding.delivery_id }),
          },
          created_at: at,
        });
      }
      return created;
    });
  }

  private async project(project_id: ProjectId) {
    const project = this.options.git.projectOf(project_id);
    if (project === undefined) return;
    // C-221: `reconcile.*` spans are timing only. `git` includes the
    // filesystem/Git scan and the nested `reconcile.checks` database replay.
    // C-231: after a repair the state re-read and the second scan add to the
    // same `state` and `git` spans, so `git` still contains every `checks`.
    const scan = async () => {
      const state = profileSpanSync("reconcile.state", () =>
        this.state(project_id),
      );
      return profileSpan("reconcile.git", () =>
        this.options.git.reconcile(
          project,
          state.assignments,
          state.deliveries,
          () => this.checks(project_id),
        ),
      );
    };
    let findings = await scan();
    if (
      await profileSpan("reconcile.repair", () =>
        this.repair(project_id, findings),
      )
    )
      findings = await scan();
    profileSpanSync("reconcile.record", () =>
      this.record(project_id, findings),
    );
  }

  private report(message: string) {
    (this.options.report ?? this.options.onError ?? (() => undefined))(message);
  }
}

export interface BackupOptions {
  readonly store: Store;
  readonly git: Pick<ReconcileGit, "projectOf" | "backup">;
  readonly clock?: Clock;
  readonly onError?: (error: unknown) => void;
  readonly report?: (message: string) => void;
}

export class BackupExecutor {
  private serial: Promise<void> = Promise.resolve();
  constructor(private readonly options: BackupOptions) {}

  tick(project_id?: ProjectId): Promise<void> {
    const next = this.serial.then(async () => {
      for (const project of project_id
        ? [project_id]
        : this.options.store.listProjects().map((entry) => entry.id)) {
        const central = this.options.git.projectOf(project as ProjectId);
        if (central === undefined) continue;
        try {
          await profileSpan("backup.fetch", () =>
            this.options.git.backup(central),
          );
        } catch (error) {
          // §3.7: a failed backup keeps the previous one and changes no result.
          (this.options.report ?? this.options.onError ?? (() => undefined))(
            `backup of ${project} failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    });
    this.serial = next.catch(() => {});
    return next;
  }
}

export interface PhaseLoop<T> {
  readonly executor: T;
  readonly loop: TimerLoop;
}

export function startReconcileLoop(options: {
  readonly store: Store;
  readonly git: ReconcileGit;
  readonly intervalMs?: number;
  readonly clock?: Clock;
  readonly onError?: (error: unknown) => void;
  readonly report?: (message: string) => void;
  readonly signal?: AbortSignal;
}): PhaseLoop<ReconcileExecutor> {
  const executor = new ReconcileExecutor({
    store: options.store,
    git: options.git,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
    ...(options.report === undefined ? {} : { report: options.report }),
  });
  const loop = startTimerLoop({
    name: "reconcile",
    tick: () => executor.tick(),
    intervalMs: options.intervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS,
    onError: options.onError ?? (() => undefined),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return { executor, loop };
}

export function startBackupLoop(options: {
  readonly store: Store;
  readonly git: Pick<ReconcileGit, "projectOf" | "backup">;
  readonly intervalMs?: number;
  readonly clock?: Clock;
  readonly onError?: (error: unknown) => void;
  readonly report?: (message: string) => void;
  readonly signal?: AbortSignal;
}): PhaseLoop<BackupExecutor> {
  const executor = new BackupExecutor({
    store: options.store,
    git: options.git,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
    ...(options.report === undefined ? {} : { report: options.report }),
  });
  const loop = startTimerLoop({
    name: "backup",
    // Let startup recovery and queued HEAD checks acquire the repository first.
    initialDelayMs: Math.min(
      30_000,
      options.intervalMs ?? DEFAULT_BACKUP_INTERVAL_MS,
    ),
    tick: () => executor.tick(),
    intervalMs: options.intervalMs ?? DEFAULT_BACKUP_INTERVAL_MS,
    onError: options.onError ?? (() => undefined),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return { executor, loop };
}
