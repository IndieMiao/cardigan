import { access } from "node:fs/promises";
import type {
  Assignment,
  CardId,
  Clock,
  CommandState,
  Decision,
  ProjectId,
  Runtime,
  RuntimeRef,
} from "@cardigan/domain";
import { releaseAssignment, requestWorktreeCleanup } from "@cardigan/domain";
import { loadCommandState } from "@cardigan/mcp-server";
import type { Store } from "@cardigan/store";
import { tokensForAssignment } from "@cardigan/store";
import type { ReconcileGit } from "./git.js";
import { startTimerLoop, type TimerLoop } from "./loop.js";
import { runSystemCommand, systemClock } from "./merge-loop.js";

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
    () => false,
  );

export class CleanupExecutor {
  private serial: Promise<void> = Promise.resolve();
  /** Worktrees this process already cleaned, so a slow git tree is not retried. */
  private readonly cleaned = new Set<string>();

  constructor(private readonly options: CleanupOptions) {}

  private get clock(): Clock {
    return this.options.clock ?? systemClock;
  }
  private state(project_id: ProjectId) {
    return this.options.store.uow.read((tx) =>
      loadCommandState(tx, project_id),
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

  private async project(project_id: ProjectId) {
    this.releaseClosed(project_id);
    // Re-read after releasing: released Assignments are what cleanup looks at.
    const state = this.state(project_id);
    for (const assignment of state.assignments.filter(
      (candidate) =>
        candidate.status === "released" ||
        (candidate.status === "suspended" &&
          candidate.scope === "standing" &&
          candidate.role_id === "pm"),
    )) {
      // Terminal/token cleanup is independent of Git and runs on every sweep:
      // previous failures or incomplete external releases must be repaired.
      if (!(await this.revokeAndReleaseTerminal(project_id, assignment)))
        continue;
      if (
        assignment.scope === "work_item" &&
        assignment.worktree_path !== undefined
      )
        await this.settle(project_id, assignment);
    }
  }

  /** §3.6: release every work-item Assignment of a done or cancelled card. */
  private releaseClosed(project_id: ProjectId) {
    const state = this.state(project_id);
    const closed = new Set(
      state.cards
        .filter((card) => ["done", "cancelled"].includes(card.status))
        .map((card) => card.id as CardId),
    );
    const workItemCard = new Map(
      state.work_items.map((item) => [item.id, item.card_id]),
    );
    for (const assignment of state.assignments) {
      if (assignment.scope !== "work_item") continue;
      if (assignment.status === "released") continue;
      const card = workItemCard.get(assignment.work_item_id);
      if (card === undefined || !closed.has(card)) continue;
      const released = runSystemCommand(
        this.options.store,
        project_id,
        (current, actor, ports) =>
          releaseAssignment(
            current,
            actor,
            { assignment_id: assignment.id },
            ports,
          ),
        this.clock,
      );
      if (!released.ok)
        this.report(
          `release of ${assignment.id} was rejected: ${released.error.code} ${released.error.message}`,
        );
    }
  }

  /** Revoke tokens and give the terminal back; a released token must not work. */
  private async revokeAndReleaseTerminal(
    project_id: ProjectId,
    assignment: Assignment,
  ): Promise<boolean> {
    for (const token of tokensForAssignment(
      this.options.store.database,
      project_id,
      assignment.id,
    ))
      if (token.revoked_at === null) this.options.store.revokeToken(token.id);
    const ref: RuntimeRef | undefined = assignment.runtime_ref ?? undefined;
    if (ref === undefined) return true;
    try {
      const observed = await this.options.runtime.status(ref);
      if (!observed.ok && observed.error.code === "runtime_not_found")
        return true;
      // The domain already forbids release while a business Run is unfinished.
      // A stale harness "working" label must not keep a released Agent alive.
      const result = await this.options.runtime.release(ref, { force: true });
      if (result.ok || result.error.code === "runtime_not_found") return true;
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

  /** The newest cleanup decision of an Assignment, if any. */
  private cleanupDecision(
    state: CommandState,
    assignment: Assignment,
  ): Decision | undefined {
    return state.decisions
      .filter(
        (decision) =>
          decision.trigger === "worktree_cleanup" &&
          decision.assignment_id === assignment.id &&
          decision.status !== "superseded",
      )
      .at(-1);
  }

  private async settle(project_id: ProjectId, assignment: Assignment) {
    const state = this.state(project_id),
      decision = this.cleanupDecision(state, assignment);
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
    if (this.cleaned.has(assignment.id)) return;
    const project = this.options.git.projectOf(project_id);
    if (project === undefined) return;
    // A worktree that is already gone needs no decision and no removal.
    if (!(await exists(assignment.worktree_path as string))) {
      this.cleaned.add(assignment.id);
      return;
    }
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
        this.cleaned.add(assignment.id);
        return;
      }
      // Dirty or unreachable: ask the human once, with the reason.
      const summary = outcome.summary;
      const reason = [
        `worktree has local changes: tracked=${summary.tracked.length}`,
        `untracked=${summary.untracked.length}`,
        summary.reachable
          ? "commits backed up"
          : "branch tip not in the central repository",
      ].join(", ");
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
    tick: () => executor.tick(),
    intervalMs: options.intervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS,
    onError: options.onError ?? (() => undefined),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return { executor, loop };
}
