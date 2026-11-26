import type { Clock, DeliveryId, Event, ProjectId } from "@cardigan/domain";
import type {
  CentralProject,
  ReconcileChecks,
  ReconcileFinding,
} from "@cardigan/git-service";
import { retireReconcileNotifications, type Store } from "@cardigan/store";
import { buildCheckoutFacts } from "./build-checkouts.js";
import {
  appendFindingEvent,
  BUILD_CLEANUP_FINDING,
} from "./build-cleanup-retry.js";
import type { ReconcileGit, ReconcilePages } from "./git.js";
import { type LoopStartup, startTimerLoop, type TimerLoop } from "./loop.js";
import { projectCycle, visitMaintenancePage } from "./maintenance-batch.js";
import { systemClock } from "./merge-loop.js";
import {
  profileProject,
  profileSpan,
  profileSpanSync,
} from "./tick-profile.js";

/**
 * M4.4 reconciliation and backup loops (plan §3.6, §3.7; development plan §12.6).
 *
 * Reconciliation compares Git, the worktree directories and the database.
 * Findings go into the store with their first/last-seen times and
 * a new finding becomes a project-level `reconcile_finding` event, which the
 * Router hands to PM Ops. Each sweep also refreshes existing local mirrors;
 * a Git delivery missing its fixed ref is re-pinned from the candidate (§3.3).
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
  private readonly scans = new Map<ProjectId, AsyncGenerator<void>>();
  pending(project: ProjectId) {
    return this.scans.has(project);
  }
  // Process-local only: a restart replays durable events, never skips history.
  private readonly checkHistory = new Map<
    ProjectId,
    {
      through: number;
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
      // Same append-only watermark as Store.CommandEvents, but cold-start from the
      // project/type index; no unrelated payloads (or entire streams) are decoded.
      const db = this.options.store.database;
      const through = Number(
        db.prepare("SELECT COALESCE(MAX(rowid),0) AS n FROM events").get()?.n,
      );
      const latest = new Map(previous?.attempts);
      if (previous?.through !== through) {
        const source = previous
          ? "events NOT INDEXED"
          : "events INDEXED BY events_by_type";
        const rows = db
          .prepare(`SELECT doc FROM ${source} WHERE project_id=? AND rowid>? AND rowid<=?
          AND type IN ('merge_check_queued','merge_check_started','merge_check_finished','precheck_queued','precheck_started','precheck_finished',
            'merge_batch_check_queued','merge_batch_check_started','merge_batch_check_finished') ORDER BY rowid`)
          .iterate(project_id, previous?.through ?? 0, through);
        for (const row of rows) {
          const event = JSON.parse(String(row.doc)) as Event;
          if (
            event.actor.kind !== "system" ||
            event.actor.project_id !== project_id
          )
            continue;
          const batch = event.type.startsWith("merge_batch_");
          if (batch === Boolean(event.card_id)) continue;
          type Check = ReconcileChecks["attempts"][number];
          const check = batch
            ? (event.payload as unknown as { check?: Check }).check
            : (event.payload as Check);
          if (check?.attempt_id)
            latest.set(check.attempt_id, {
              ...check,
              updated_at: event.created_at,
            });
        }
      }
      return {
        through,
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

  tick(project_id?: ProjectId, paged = false): Promise<void> {
    const next = this.serial.then(async () => {
      const projects = project_id
        ? [project_id]
        : this.options.store.listProjects().map((entry) => entry.id);
      // A failed filesystem/worker scan below must not starve other projects' mirrors.
      for (const id of projects) {
        if (this.scans.has(id)) continue; // A resumed page is not a new sweep.
        const project = this.options.git.projectOf(id as ProjectId);
        if (!project) continue;
        try {
          await profileProject(id, async () =>
            this.options.git.refreshLocalMirror?.(project),
          );
        } catch {
          // Do not log stderr or configuration from the Agent-owned clone.
          this.report(`Local mirror refresh failed for ${id}`);
        }
      }
      for (const project of projects) {
        const pages = this.scans.get(project) ?? this.project(project, paged);
        this.scans.set(project, pages);
        try {
          do {
            if ((await profileProject(project, () => pages.next())).done) {
              this.scans.delete(project);
              break;
            }
          } while (!paged);
        } catch (error) {
          this.scans.delete(project);
          throw error;
        }
      }
    });
    this.serial = next.catch(() => {});
    return next;
  }

  /** §3.3: a missing fixed ref is repaired from the candidate ref, once. */
  private async repair(project_id: ProjectId, id: DeliveryId): Promise<void> {
    const project = this.options.git.projectOf(project_id);
    if (!project) return;
    // Re-read the binding after a page break; no read transaction spans Git IO.
    const target = this.options.store.uow.read((tx) => {
      const delivery = tx.deliveries.get(project_id, id);
      const item =
        delivery && tx.work_items.get(project_id, delivery.work_item_id);
      const assignment =
        item?.assignment_id &&
        tx.assignments.get(project_id, item.assignment_id);
      return delivery && assignment ? { delivery, assignment } : undefined;
    });
    if (!target) return;
    try {
      await this.options.git.repairPin(
        project,
        target.delivery,
        target.assignment,
      );
    } catch (error) {
      this.report(
        `pinning ${id} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
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
          // C-791: the cleanup loop opens and resolves these itself.
          exceptKinds: [BUILD_CLEANUP_FINDING],
        },
      );
      retireReconcileNotifications(this.options.store.database, project_id, at);
      for (const finding of created)
        appendFindingEvent(tx, project_id, finding, at);
      return created;
    });
  }

  private async *scan(
    project_id: ProjectId,
    project: CentralProject,
    paged: boolean,
  ): ReconcilePages {
    const state = profileSpanSync("reconcile.state", () =>
      this.state(project_id),
    );
    const git = this.options.git;
    const args: Parameters<ReconcileGit["reconcile"]> = [
      project,
      state.assignments,
      state.deliveries,
      () => this.checks(project_id),
    ];
    if (!paged || !git.reconcilePages)
      return await profileSpan("reconcile.git", () => git.reconcile(...args));
    const pages = git.reconcilePages(...args);
    for (;;) {
      const page = await profileSpan("reconcile.git", () => pages.next());
      if (page.done) return page.value;
      yield;
    }
  }

  private async *project(project_id: ProjectId, paged: boolean) {
    const project = this.options.git.projectOf(project_id);
    if (project === undefined) return;
    // C-221: `reconcile.*` spans are timing only. `git` includes the
    // filesystem/Git scan and the nested `reconcile.checks` database replay.
    // C-231: after a repair the state re-read and the second scan add to the
    // same `state` and `git` spans, so `git` still contains every `checks`.
    const attempted = new Set<DeliveryId>();
    for (;;) {
      const findings = yield* this.scan(project_id, project, paged);
      const missing = new Set<DeliveryId>();
      for (const finding of findings) {
        if (finding.kind !== "missing_delivery_ref" || !finding.delivery_id)
          continue;
        const id = finding.delivery_id as DeliveryId;
        if (!attempted.has(id)) missing.add(id);
      }
      if (!missing.size) {
        profileSpanSync("reconcile.record", () =>
          this.record(project_id, findings),
        );
        return;
      }
      // Finish this inventory's repair queue before rescanning. Only a full
      // scan with no unattempted repairs may publish/resolve findings.
      const queue = [...missing].reverse();
      while (queue.length) {
        await profileSpan("reconcile.repair", () =>
          visitMaintenancePage(queue, async (id) => {
            await this.repair(project_id, id);
            attempted.add(id);
          }),
        );
        if (paged) yield;
      }
    }
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
          await profileProject(project, () =>
            profileSpan("backup.fetch", () => this.options.git.backup(central)),
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
  readonly startup?: LoopStartup | undefined;
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
    startup: options.startup,
    name: "reconcile",
    initialDelayMs: options.startup
      ? Math.min(5000, options.intervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS)
      : 0,
    ...projectCycle(
      () => options.store.listProjects().map((p) => p.id),
      (p) => executor.tick(p, true),
      (p) => executor.pending(p),
    ),
    intervalMs: options.intervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS,
    onError: options.onError ?? (() => undefined),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return { executor, loop };
}

export function startBackupLoop(options: {
  readonly store: Store;
  readonly git: Pick<ReconcileGit, "projectOf" | "backup">;
  readonly startup?: LoopStartup | undefined;
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
    startup: options.startup,
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
