import type { Clock, DeliveryId, Event, ProjectId } from "@cardigan/domain";
import type {
  CentralProject,
  ReconcileChecks,
  ReconcileFinding,
} from "@cardigan/git-service";
import { retireReconcileNotifications, type Store } from "@cardigan/store";
import { buildCheckoutFacts } from "./build-checkouts.js";
import type { ReconcileGit, ReconcilePages } from "./git.js";
import { type LoopStartup, startTimerLoop, type TimerLoop } from "./loop.js";
import { MaintenanceBatch, projectCycle } from "./maintenance-batch.js";
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
  private readonly scans = new Map<ProjectId, AsyncGenerator<void>>();
  pending(project: ProjectId) {
    return this.repairs.has(project) || this.scans.has(project);
  }
  private readonly repairs = new MaintenanceBatch<ProjectId, DeliveryId>();
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
      for (const project of project_id
        ? [project_id]
        : this.options.store.listProjects().map((entry) => entry.id)) {
        const pages = this.scans.get(project) ?? this.project(project, paged);
        this.scans.set(project, pages);
        try {
          do {
            if ((await pages.next()).done) {
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
  private async repair(
    project_id: ProjectId,
    findings: readonly ReconcileFinding[],
  ): Promise<boolean> {
    const project = this.options.git.projectOf(project_id);
    if (project === undefined) return false;
    const missing = new Set(
      findings.flatMap((f) =>
        f.kind === "missing_delivery_ref" && f.delivery_id
          ? [f.delivery_id as DeliveryId]
          : [],
      ),
    );
    const state = this.state(project_id);
    let repaired = false;
    await this.repairs.run(
      project_id,
      () => [...missing],
      async (id) => {
        if (!missing.has(id)) return;
        const delivery = state.deliveries.find(
            (candidate) => candidate.id === id,
          ),
          item = state.work_items.find(
            (candidate) => candidate.id === delivery?.work_item_id,
          ),
          assignment = state.assignments.find(
            (candidate) => candidate.id === item?.assignment_id,
          );
        if (delivery === undefined || assignment === undefined) return;
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
      },
    );
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
    let findings = yield* this.scan(project_id, project, paged);
    if (
      await profileSpan("reconcile.repair", () =>
        this.repair(project_id, findings),
      )
    )
      findings = yield* this.scan(project_id, project, paged);
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
