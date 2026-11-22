import { access } from "node:fs/promises";
import type {
  Assignment,
  AssignmentId,
  CardId,
  Clock,
  ProjectId,
  Runtime,
  RuntimeRef,
} from "@cardigan/domain";
import {
  clearReleasedRuntimeRefs,
  releaseAssignment,
  requestWorktreeCleanup,
} from "@cardigan/domain";
import type { Store } from "@cardigan/store";
import { unrevokedTokensForProject } from "@cardigan/store";
import { buildCheckoutIdle } from "./build-checkouts.js";
import type { ReconcileGit } from "./git.js";
import { type LoopStartup, startTimerLoop, type TimerLoop } from "./loop.js";
import { MaintenanceBatch, projectCycle } from "./maintenance-batch.js";
import { runSystemCommand, systemClock } from "./merge-loop.js";
import { profileSpan, profileSpanSync } from "./tick-profile.js";

/**
 * M4.4 release and worktree cleanup (plan §3.6, development plan §12.6).
 *
 * Once a card is done or cancelled the system releases its work-item
 * Assignments, revokes their tokens, gives the terminal back, and then removes
 * a worktree only when nothing would be lost. Anything dirty becomes a
 * `worktree_cleanup` decision for the human; the loop executes the answer.
 */
export const DEFAULT_CLEANUP_INTERVAL_MS = 60_000;

export interface CleanupOptions {
  readonly store: Store;
  readonly git: ReconcileGit;
  readonly runtime: Runtime;
  readonly clock?: Clock;
  readonly onError?: (error: unknown) => void;
  /** Problems that are not worth throwing, e.g. one failed terminal release. */
  readonly report?: (message: string) => void;
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );

export class CleanupExecutor {
  private serial: Promise<void> = Promise.resolve();
  /** Worktrees this process already cleaned, so a slow git tree is not retried. */
  private readonly cleaned = new Set<string>();

  constructor(private readonly options: CleanupOptions) {}

  private get clock(): Clock {
    return this.options.clock ?? systemClock;
  }
  private readonly owners = new MaintenanceBatch<ProjectId, AssignmentId>();
  private readonly releases = new MaintenanceBatch<ProjectId, AssignmentId>();
  private readonly pass = new Map<
    ProjectId,
    Set<"releases" | "owners" | "builds">
  >();
  private readonly builds = new MaintenanceBatch<ProjectId, string>();
  pending(project: ProjectId) {
    return (
      this.owners.has(project) ||
      this.releases.has(project) ||
      this.builds.has(project)
    );
  }
  private report(message: string) {
    (this.options.report ?? this.options.onError ?? (() => undefined))(message);
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

  /** Finish the current pass. Each tick consumes at least one pending entry
   * of a bounded page, so this ends; the timer loop pages instead. */
  async sweep(project_id?: ProjectId): Promise<void> {
    const projects = () =>
      project_id
        ? [project_id]
        : this.options.store.listProjects().map((entry) => entry.id);
    do await this.tick(project_id);
    while (projects().some((project) => this.pending(project)));
  }

  private async project(project_id: ProjectId) {
    const done =
      this.pass.get(project_id) ?? new Set<"releases" | "owners" | "builds">();
    this.pass.set(project_id, done);
    if (!done.has("releases")) {
      await profileSpan("cleanup.release_closed", () =>
        this.releaseClosed(project_id),
      );
      if (!this.releases.has(project_id)) done.add("releases");
    }
    // Re-read after releasing: released Assignments are what cleanup looks at.
    const assignments = profileSpanSync("cleanup.state", () =>
      this.options.store.uow.read((tx) => tx.assignments.list(project_id)),
    );
    const candidates = assignments.filter(
      (candidate) =>
        candidate.status === "released" ||
        (candidate.status === "suspended" &&
          candidate.scope === "standing" &&
          candidate.role_id === "pm"),
    );
    // Read current token rows even when a terminal was already removed. Late
    // issuance and another connection's writes must not bypass revocation.
    const owners = new Set(candidates.map((a) => a.id));
    profileSpanSync("cleanup.revoke_tokens", () => {
      if (!owners.size) return;
      for (const token of unrevokedTokensForProject(
        this.options.store.database,
        project_id,
      ))
        if (owners.has(token.assignment_id))
          this.options.store.revokeToken(token.id);
    });
    // §12.6: a terminal whose exit is unconfirmed may still use its directories.
    const unconfirmed = new Set(
      candidates.filter((a) => a.runtime_ref).map((a) => String(a.id)),
    );
    const missing: { assignment_id: AssignmentId; runtime_ref: RuntimeRef }[] =
      [];
    const eligible = new Map(candidates.map((a) => [a.id, a]));
    if (!done.has("owners"))
      await this.owners.run(
        project_id,
        () =>
          candidates
            .filter(
              (a) =>
                a.runtime_ref ||
                (a.worktree_path && !this.cleaned.has(`${project_id}/${a.id}`)),
            )
            .map((a) => a.id),
        async (id) => {
          const assignment = eligible.get(id);
          if (!assignment) return;
          if (
            assignment.runtime_ref !== null &&
            !(await profileSpan("cleanup.revoke_and_release", () =>
              this.releaseTerminal(assignment, missing),
            ))
          )
            return;
          unconfirmed.delete(id);
          if (
            assignment.scope === "work_item" &&
            assignment.worktree_path !== undefined
          )
            await profileSpan("cleanup.settle", () =>
              this.settle(project_id, assignment),
            );
        },
      );
    if (missing.length) {
      const cleared = runSystemCommand(
        this.options.store,
        project_id,
        (current, actor, ports) =>
          clearReleasedRuntimeRefs(current, actor, { missing }, ports),
        this.clock,
      );
      if (!cleared.ok)
        this.report(
          `terminal cleanup recording failed: ${cleared.error.code} ${cleared.error.message}`,
        );
    }
    if (!this.owners.has(project_id) && done.has("releases"))
      done.add("owners");
    if (!done.has("builds")) {
      await profileSpan("cleanup.idle_builds", () =>
        this.removeIdleBuilds(project_id, unconfirmed),
      );
      if (!this.builds.has(project_id)) done.add("builds");
    }
    if (!this.pending(project_id)) this.pass.delete(project_id);
  }

  /**
   * P2a-3: a verifier's build checkout is disposable and lives only as long as
   * its Run; remove it in the first round after the Assignment (released or
   * not) has no unfinished Run and, if released, its terminal exit is
   * confirmed. Nothing is backed up and no decision is asked.
   */
  private async removeIdleBuilds(
    project_id: ProjectId,
    unconfirmed: ReadonlySet<string>,
  ) {
    const git = this.options.git;
    const remove = git.removeBuildCheckout?.bind(git);
    if (!git.listBuildCheckouts || !remove) return;
    const project = git.projectOf(project_id);
    if (project === undefined) return;
    const runs = () =>
      this.options.store.uow.read((tx) => tx.runs.list(project_id));
    let owners: readonly string[] | undefined = [];
    try {
      if (!this.builds.has(project_id))
        owners = await git.listBuildCheckouts(project);
      if (owners === undefined) return;
    } catch (error) {
      this.report(
        `build checkout listing for ${project_id} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    const listed = owners;
    await this.builds.run(
      project_id,
      () => [...listed],
      async (assignment_id) => {
        // A released Assignment whose terminal release failed this round keeps
        // its build until the next round confirms the exit (§12.6).
        if (unconfirmed.has(assignment_id)) return;
        if (!buildCheckoutIdle(runs(), assignment_id)) return;
        try {
          await remove({
            project,
            assignment_id,
            // Re-read under the repository lock: a Run queued meanwhile wins.
            idle: () => buildCheckoutIdle(runs(), assignment_id),
          });
        } catch (error) {
          // Reconcile reports the leftover after the cleanup grace.
          this.report(
            `build checkout cleanup for ${assignment_id} failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    );
  }

  /** §3.6: release every work-item Assignment of a done or cancelled card. */
  private releaseClosed(project_id: ProjectId) {
    return this.releases.run(
      project_id,
      () =>
        this.options.store.uow.read((tx) => {
          const closed = new Set(
            tx.cards
              .list(project_id)
              .filter((card) => ["done", "cancelled"].includes(card.status))
              .map((c) => c.id as CardId),
          );
          const items = new Set(
            tx.work_items
              .list(project_id)
              .filter((item) => closed.has(item.card_id))
              .map((item) => item.id),
          );
          return tx.assignments
            .list(project_id)
            .filter(
              (a) =>
                a.scope === "work_item" &&
                a.status !== "released" &&
                items.has(a.work_item_id),
            )
            .map((a) => a.id);
        }),
      async (id) => {
        const released = runSystemCommand(
          this.options.store,
          project_id,
          (current, actor, ports) =>
            releaseAssignment(current, actor, { assignment_id: id }, ports),
          this.clock,
        );
        if (!released.ok)
          this.report(
            `release of ${id} was rejected: ${released.error.code} ${released.error.message}`,
          );
      },
    );
  }

  /** Only absence proves there is no terminal resource left to sweep. */
  private async releaseTerminal(
    assignment: Assignment,
    missing: { assignment_id: AssignmentId; runtime_ref: RuntimeRef }[],
  ): Promise<boolean> {
    const ref: RuntimeRef | undefined = assignment.runtime_ref ?? undefined;
    if (ref === undefined) return true;
    const absent = () => {
      // Suspended PMs can resume; retain their existing cleanup semantics.
      if (assignment.status === "released")
        missing.push({ assignment_id: assignment.id, runtime_ref: ref });
      return true;
    };
    try {
      const observed = await this.options.runtime.status(ref);
      if (!observed.ok && observed.error.code === "runtime_not_found")
        return absent();
      // The domain already forbids release while a business Run is unfinished.
      // A stale harness "working" label must not keep a released Agent alive.
      const result = await this.options.runtime.release(ref, { force: true });
      if (result.ok) return true;
      if (result.error.code === "runtime_not_found") return absent();
      this.report(
        `terminal release for ${assignment.id} failed: ${result.error.code} ${result.error.message}`,
      );
    } catch (error) {
      this.report(
        `terminal release for ${assignment.id} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return false;
  }

  private async settle(project_id: ProjectId, assignment: Assignment) {
    if (this.cleaned.has(`${project_id}/${assignment.id}`)) return;
    // A worktree that is already gone needs no decision and no removal.
    if (!(await exists(assignment.worktree_path as string))) {
      this.cleaned.add(`${project_id}/${assignment.id}`);
      return;
    }
    const decision = this.options.store.uow.read((tx) =>
      tx.decisions
        .list(project_id)
        .findLast(
          (d) =>
            d.trigger === "worktree_cleanup" &&
            d.assignment_id === assignment.id &&
            d.status !== "superseded",
        ),
    );
    if (decision?.status === "resolved") {
      if (decision.resolution?.option === "keep") {
        // §3.6: after `keep` the worktree stays and is never asked about again.
        return;
      }
      if (decision.resolution?.option === "force_clean") {
        await this.clean(project_id, assignment, true);
        return;
      }
    }
    if (
      decision !== undefined &&
      ["open", "provisional"].includes(decision.status)
    )
      return;
    await this.clean(project_id, assignment, false);
  }

  private async clean(
    project_id: ProjectId,
    assignment: Assignment,
    force: boolean,
  ) {
    if (this.cleaned.has(`${project_id}/${assignment.id}`)) return;
    const project = this.options.git.projectOf(project_id);
    if (project === undefined) return;
    try {
      const outcome = await this.options.git.removeWorktree({
        project,
        assignment,
        force,
      });
      if (
        outcome.status === "removed" ||
        outcome.status === "already_removed"
      ) {
        this.cleaned.add(`${project_id}/${assignment.id}`);
        return;
      }
      // Dirty or unreachable: ask the human once, with the reason.
      const summary = outcome.summary;
      const reason = [
        `工作区本地改动：已跟踪文件 ${summary.tracked.length} 个`,
        `未跟踪文件 ${summary.untracked.length} 个`,
        summary.reachable ? "提交已备份" : "分支最新提交尚未备份到中心仓库",
      ].join("，");
      const asked = runSystemCommand(
        this.options.store,
        project_id,
        (state, actor, ports) =>
          requestWorktreeCleanup(
            state,
            actor,
            { assignment_id: assignment.id, reason },
            ports,
          ),
        this.clock,
      );
      if (!asked.ok)
        this.report(
          `cleanup decision for ${assignment.id} was rejected: ${asked.error.code} ${asked.error.message}`,
        );
    } catch (error) {
      // Missing registration and an empty directory race here; reconcile reports
      // the orphan, so the loop only records the reason.
      this.report(
        `worktree cleanup for ${assignment.id} skipped: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

export interface CleanupLoop {
  readonly executor: CleanupExecutor;
  readonly loop: TimerLoop;
}
export function startCleanupLoop(options: {
  readonly store: Store;
  readonly git: ReconcileGit;
  readonly runtime: Runtime;
  readonly startup?: LoopStartup | undefined;
  readonly intervalMs?: number;
  readonly clock?: Clock;
  readonly onError?: (error: unknown) => void;
  readonly report?: (message: string) => void;
  readonly signal?: AbortSignal;
}): CleanupLoop {
  const executor = new CleanupExecutor({
    store: options.store,
    git: options.git,
    runtime: options.runtime,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
    ...(options.report === undefined ? {} : { report: options.report }),
  });
  const loop = startTimerLoop({
    startup: options.startup,
    name: "cleanup",
    initialDelayMs: options.startup
      ? Math.min(3000, options.intervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS)
      : 0,
    ...projectCycle(
      () => options.store.listProjects().map((p) => p.id),
      (p) => executor.tick(p),
      (p) => executor.pending(p),
    ),
    intervalMs: options.intervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS,
    onError: options.onError ?? (() => undefined),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return { executor, loop };
}
