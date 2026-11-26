import { access } from "node:fs/promises";
import type {
  Assignment,
  AssignmentId,
  CardId,
  Clock,
  ProjectId,
  Run,
  Runtime,
  RuntimeRef,
} from "@cardigan/domain";
import {
  clearReleasedRuntimeRefs,
  isDecisionOther,
  releaseAssignment,
  requestWorktreeCleanup,
  routeWorktreeCleanupDecisions,
} from "@cardigan/domain";
import {
  workerGitRejection,
  workerGitRejectionNeedsHuman,
} from "@cardigan/runtime-herdr";
import type { Store } from "@cardigan/store";
import {
  retireReconcileNotifications,
  unrevokedTokensForProject,
} from "@cardigan/store";
import { buildCheckoutIdle } from "./build-checkouts.js";
import {
  appendFindingEvent,
  BUILD_CLEANUP_FINDING,
  BUILD_FINDING_AFTER,
  BuildCleanupRetries,
  type BuildRetryPolicy,
  buildCleanupDetail,
} from "./build-cleanup-retry.js";
import type { MachineDirectories, ReconcileGit } from "./git.js";
import { type LoopStartup, startTimerLoop, type TimerLoop } from "./loop.js";
import { MaintenanceBatch, projectCycle } from "./maintenance-batch.js";
import { runSystemCommand, systemClock } from "./merge-loop.js";
import {
  profileProject,
  profileSpan,
  profileSpanSync,
} from "./tick-profile.js";

/**
 * M4.4 release and worktree cleanup (plan §3.6, development plan §12.6).
 *
 * Once a card is done or cancelled the system releases its work-item
 * Assignments, revokes their tokens, gives the terminal back, and then removes
 * a worktree only when nothing would be lost. Anything dirty becomes a
 * `worktree_cleanup` decision for the human; the loop executes the answer.
 */
export const DEFAULT_CLEANUP_INTERVAL_MS = 60_000;
/**
 * C-747: how often an unchanged set of owner-held worktree cleanup questions
 * is re-checked for delegation (e.g. PM Ops came back). New questions route
 * when raised and the preference hook moves them when the category turns on.
 */
const ROUTE_RECHECK_MS = 10 * 60_000;

export interface CleanupOptions {
  readonly store: Store;
  readonly git: ReconcileGit;
  readonly runtime: Runtime;
  readonly clock?: Clock;
  readonly onError?: (error: unknown) => void;
  /** Problems that are not worth throwing, e.g. one failed terminal release. */
  readonly report?: (message: string) => void;
  /** C-791: backoff of failed build removals; defaults to 1 min … 6 h. */
  readonly buildRetry?: Partial<BuildRetryPolicy>;
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

  constructor(private readonly options: CleanupOptions) {
    this.buildRetries = new BuildCleanupRetries(options.buildRetry);
  }

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
  /** C-791: builds whose removal failed wait out a backoff, per Assignment. */
  private readonly buildRetries: BuildCleanupRetries;
  /** C-747: last routing check of owner-held worktree cleanup questions. */
  private readonly routing = new Map<
    ProjectId,
    { readonly waiting: string; readonly at: number }
  >();
  /**
   * C-664: per pass, what each machine's project roots hold. A machine whose
   * listing failed is `null`: nothing on it is judged absent or removed.
   */
  private readonly listings = new Map<
    ProjectId,
    Map<string, MachineDirectories | null>
  >();
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
        await profileProject(project, () => this.project(project as ProjectId));
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

  /**
   * C-666: a worker reported low free space. Forget what this process has
   * already judged absent and the listings of the current pass, then finish
   * one full pass now instead of waiting for the timer. The pass applies the
   * usual rules: only released or idle directories, dirty worktrees still
   * become decisions.
   */
  reclaim(project_id: ProjectId): Promise<void> {
    const reset = this.serial.then(() => {
      for (const key of this.cleaned)
        if (key.startsWith(`${project_id}/`)) this.cleaned.delete(key);
      this.buildRetries.reset(project_id);
      this.listings.delete(project_id);
      // A pass already under way may have listed this machine before.
      return this.pass.has(project_id);
    });
    this.serial = reset.then(
      () => undefined,
      () => undefined,
    );
    return reset.then(async (midPass) => {
      await this.sweep(project_id);
      if (midPass) await this.sweep(project_id);
    });
  }

  private async project(project_id: ProjectId) {
    const done =
      this.pass.get(project_id) ?? new Set<"releases" | "owners" | "builds">();
    this.pass.set(project_id, done);
    this.routeCleanupDecisions(project_id);
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
    const withWorktree = new Set<AssignmentId>();
    if (!done.has("owners") && !this.owners.has(project_id))
      for (const a of candidates)
        if (await this.hasWorktree(project_id, a)) withWorktree.add(a.id);
    if (!done.has("owners"))
      await this.owners.run(
        project_id,
        () =>
          candidates
            .filter((a) => a.runtime_ref || withWorktree.has(a.id))
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
          if (await this.hasWorktree(project_id, assignment))
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
    if (!this.pending(project_id)) {
      this.pass.delete(project_id);
      this.listings.delete(project_id);
    }
  }

  /**
   * C-664: list a machine's builds and worktrees once per pass, through the
   * machine's own Git helper. Host `access()` cannot see a worker's disk, so a
   * remote directory is only judged by this listing; a failure judges nothing.
   */
  private async listing(
    project_id: ProjectId,
    machine_id: string,
  ): Promise<MachineDirectories | null> {
    const pass =
      this.listings.get(project_id) ??
      new Map<string, MachineDirectories | null>();
    this.listings.set(project_id, pass);
    const known = pass.get(machine_id);
    if (known !== undefined) return known;
    const list = this.options.git.listMachineDirectories?.bind(
      this.options.git,
    );
    const project = this.options.git.projectOf(project_id);
    if (!list || project === undefined) return null;
    // Do not page through an offline or draining worker every round.
    const machine = this.options.store.uow.read((tx) =>
      tx.machines.get(project_id, machine_id),
    );
    if (
      machine_id !== "local" &&
      !["online", "degraded"].includes(machine?.status ?? "")
    )
      return null;
    try {
      const listed = (await list(project, machine_id)) ?? null;
      // A busy preparation is retried next pass, not recorded as known.
      if (listed) pass.set(machine_id, listed);
      return listed;
    } catch (error) {
      pass.set(machine_id, null);
      this.report(
        `worker directory listing for ${project_id}/${machine_id} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * Whether a released work-item Assignment still has a worktree to settle:
   * a local recorded path is probed by `settle`; a worker's directory, or one
   * whose path the record lost, must appear in its machine's listing.
   */
  private async hasWorktree(
    project_id: ProjectId,
    a: Assignment,
  ): Promise<boolean> {
    if (a.scope !== "work_item") return false;
    if (this.cleaned.has(`${project_id}/${a.id}`)) return false;
    if (a.machine_id === "local" && a.worktree_path !== undefined) return true;
    const listed = await this.listing(project_id, a.machine_id);
    if (listed === null) return false;
    if (listed.worktrees.includes(a.id)) return true;
    // Listed and absent on its own machine: nothing left to remove.
    this.cleaned.add(`${project_id}/${a.id}`);
    return false;
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
    // A failed resume can leave no successor Run. Its build directory is
    // still evidence for the recovery handoff, not disposable idle output.
    // C-664: one Run snapshot pre-filters a page; the removal itself re-reads
    // fresh Runs under the repository lock, which is what decides.
    let snapshot: readonly Run[] | undefined;
    const idle = (id: string, fresh = true) =>
      this.options.store.uow.read((tx) => {
        if (fresh || snapshot === undefined)
          snapshot = tx.runs.list(project_id);
        const runs = snapshot;
        if (!buildCheckoutIdle(runs, id)) return false;
        const a = tx.assignments.get(project_id, id as AssignmentId);
        if (a?.scope !== "work_item" || a.status === "released") return true;
        if (a.idle_retirement?.handoff) return false;
        return !this.options.store.listNotifications({
          project_id,
          assignment_id: a.id,
          statuses: ["pending", "delivery_failed", "needs_attention"],
        }).length;
      });
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
    // C-664: a worker's builds are listed on that worker; only ids whose
    // Assignment is bound there are removed through its own helper leaf.
    const remote: string[] = [];
    const machines = new Map<string, string>();
    if (!this.builds.has(project_id)) {
      const assignments = this.options.store.uow.read((tx) =>
        tx.assignments.list(project_id),
      );
      for (const a of assignments) machines.set(a.id, a.machine_id);
      // C-791: machines whose listing this pass can trust as complete.
      const scanned = new Set(["local"]);
      for (const machine_id of new Set(
        assignments
          .map((a) => a.machine_id)
          .filter((machine) => machine !== "local"),
      )) {
        const found = await this.listing(project_id, machine_id);
        if (found) scanned.add(machine_id);
        for (const id of found?.builds ?? [])
          if (machines.get(id as AssignmentId) === machine_id) remote.push(id);
      }
      const present = new Set([...owners, ...remote]);
      for (const finding of this.options.store.listReconcileFindings(
        project_id,
        { openOnly: true },
      )) {
        if (
          finding.kind !== BUILD_CLEANUP_FINDING ||
          finding.assignment_id === undefined
        )
          continue;
        // A build that is gone (e.g. removed by a person) needs nothing more.
        if (
          !present.has(finding.assignment_id) &&
          scanned.has(machines.get(finding.assignment_id) ?? "local")
        )
          this.buildCleaned(project_id, finding.assignment_id);
        // After a restart the finding still holds its backoff.
        else
          this.buildRetries.restore(
            project_id,
            finding.assignment_id,
            Date.parse(finding.last_seen_at),
          );
      }
    }
    const listed = [...new Set([...owners, ...remote])];
    await this.builds.run(
      project_id,
      () => [...listed],
      async (assignment_id) => {
        // A released Assignment whose terminal release failed this round keeps
        // its build until the next round confirms the exit (§12.6).
        if (unconfirmed.has(assignment_id)) return;
        // C-791: no Git lock or SSH call while a failed removal backs off.
        if (
          !this.buildRetries.due(
            project_id,
            assignment_id,
            Date.parse(this.clock.now()),
          )
        )
          return;
        if (!idle(assignment_id, false)) return;
        try {
          const outcome = await remove({
            project,
            assignment_id,
            // Re-read under the repository lock: a Run queued meanwhile wins.
            idle: () => idle(assignment_id),
          });
          if (outcome.status !== "in_use")
            this.buildCleaned(project_id, assignment_id);
        } catch (error) {
          this.buildFailed(
            project_id,
            assignment_id,
            machines.get(assignment_id) ??
              this.options.store.uow.read(
                (tx) =>
                  tx.assignments.get(project_id, assignment_id as AssignmentId)
                    ?.machine_id,
              ) ??
              "local",
            error,
          );
        }
      },
    );
  }

  /**
   * C-791: one failed build removal. The next try waits an exponential
   * backoff; a cause only a person can repair (non-empty, not removable or
   * not a private directory) waits the cap and is a finding at once, any
   * other cause after `BUILD_FINDING_AFTER` failures in a row.
   */
  private buildFailed(
    project_id: ProjectId,
    assignment_id: string,
    machine_id: string,
    error: unknown,
  ) {
    const reason = workerGitRejection(error);
    const human = reason !== undefined && workerGitRejectionNeedsHuman(reason);
    const now = this.clock.now();
    const retry = this.buildRetries.failed(
      project_id,
      assignment_id,
      Date.parse(now),
      human,
    );
    this.report(
      `build checkout cleanup for ${assignment_id} failed (${retry.failures} in a row, next try after ${new Date(retry.next_at).toISOString()}): ${error instanceof Error ? error.message : String(error)}`,
    );
    if (!human && retry.failures < BUILD_FINDING_AFTER) return;
    this.options.store.uow.run((tx) => {
      const opened = this.options.store.openReconcileFinding(project_id, {
        kind: BUILD_CLEANUP_FINDING,
        assignment_id,
        detail: buildCleanupDetail({
          machine_id,
          reason,
          human,
          failures: retry.failures,
        }),
      });
      if (opened) appendFindingEvent(tx, project_id, opened, now);
    });
  }

  /** C-791: the build is gone; forget its backoff and resolve its finding. */
  private buildCleaned(project_id: ProjectId, assignment_id: string) {
    this.buildRetries.forget(project_id, assignment_id);
    const open = this.options.store
      .listReconcileFindings(project_id, { openOnly: true })
      .some(
        (finding) =>
          finding.kind === BUILD_CLEANUP_FINDING &&
          finding.assignment_id === assignment_id,
      );
    if (!open) return;
    this.options.store.uow.run(() => {
      if (
        this.options.store.resolveReconcileFinding(project_id, {
          kind: BUILD_CLEANUP_FINDING,
          assignment_id,
        })
      )
        retireReconcileNotifications(
          this.options.store.database,
          project_id,
          this.clock.now(),
        );
    });
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

  /**
   * C-747: open worktree cleanup questions still with the human move to PM
   * once data_deletion is delegated and PM Ops is active (questions raised
   * before deployment, or while PM Ops was away). Only a write when one moves.
   */
  private routeCleanupDecisions(project_id: ProjectId) {
    const waiting = this.options.store.uow
      .read((tx) =>
        tx.decisions
          .list(project_id)
          .filter(
            (q) =>
              q.trigger === "worktree_cleanup" &&
              q.decider === "human" &&
              ["open", "provisional", "snoozed"].includes(q.status),
          )
          .map((q) => q.id),
      )
      .join(",");
    const last = this.routing.get(project_id);
    const now = Date.parse(this.clock.now());
    if (
      !waiting ||
      (last?.waiting === waiting && now - last.at < ROUTE_RECHECK_MS)
    )
      return;
    this.routing.set(project_id, { waiting, at: now });
    const routed = runSystemCommand(
      this.options.store,
      project_id,
      (state, actor, ports) =>
        routeWorktreeCleanupDecisions(state, actor, ports),
      this.clock,
    );
    if (!routed.ok)
      this.report(
        `worktree cleanup routing was rejected: ${routed.error.code} ${routed.error.message}`,
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
    // A worktree that is already gone needs no decision and no removal. Only
    // a local recorded path is visible here; the rest came from the listing.
    if (
      assignment.machine_id === "local" &&
      assignment.worktree_path !== undefined &&
      !(await exists(assignment.worktree_path))
    ) {
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
      if (
        decision.resolution?.option === "keep" ||
        isDecisionOther(decision.resolution?.option)
      ) {
        // §3.6: after `keep` the worktree stays and is never asked about again.
        // C-682: "其他" binds no cleanup; PM follows the owner's words.
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
            {
              assignment_id: assignment.id,
              reason,
              // C-664: record where a pathless record's worktree was found.
              ...(assignment.worktree_path === undefined
                ? { worktree_path: summary.worktree_path }
                : {}),
            },
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
  readonly buildRetry?: Partial<BuildRetryPolicy>;
}): CleanupLoop {
  const executor = new CleanupExecutor({
    store: options.store,
    git: options.git,
    runtime: options.runtime,
    ...(options.buildRetry === undefined
      ? {}
      : { buildRetry: options.buildRetry }),
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
