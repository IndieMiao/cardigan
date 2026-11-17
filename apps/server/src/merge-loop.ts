import type {
  Actor,
  CardId,
  Clock,
  CommandEffect,
  CommandPorts,
  CommandState,
  DeliveryId,
  MergePlan,
  MergeResult,
  ProjectId,
  Result,
} from "@cardigan/domain";
import {
  autoConfirmMerge,
  autoMergeOn,
  automaticMergeReasons,
  mergePlan,
  recordAutomaticMergeWaits,
  recordMergeCheckBlockers,
  recordMergeResult,
  systemConfirmMerge,
} from "@cardigan/domain";
import type { CentralProject, MergeOutcome } from "@cardigan/git-service";
import { loadCommandState, persistEffect } from "@cardigan/mcp-server";
import { CheckHandoffs, type Store } from "@cardigan/store";
import type { MergeGit } from "./git.js";
import { startTimerLoop, type TimerLoop } from "./loop.js";
import { type MergeCheckOptions, MergeChecks } from "./merge-checks.js";
import { mergePublicationGuard } from "./merge-publication.js";
import { MergeSkipLog } from "./merge-skip-log.js";
import { withPublication } from "./publication-lock.js";

/** Default cadence: one pass is cheap when no card is ready. */
export const DEFAULT_MERGE_INTERVAL_MS = 5_000;

export const systemClock: Clock = { now: () => new Date().toISOString() };

/**
 * Run one command as the system actor (§4.4: `recordMergeResult` is system-only).
 * Any Git IO has already happened outside this transaction.
 */
export function runSystemCommand<T>(
  store: Store,
  project_id: ProjectId,
  reduce: (
    state: CommandState,
    actor: Actor,
    ports: CommandPorts,
  ) => Result<CommandEffect<T>>,
  clock: Clock = systemClock,
): Result<T> {
  const actor: Actor = { kind: "system", project_id };
  return store.uow.run((tx) => {
    const result = reduce(loadCommandState(tx, project_id), actor, {
      clock,
      ids: tx.ids,
    });
    if (!result.ok) return result;
    persistEffect(tx, project_id, result.value);
    return { ok: true as const, value: result.value.data };
  });
}

export interface MergeLoopOptions {
  readonly store: Store;
  readonly git: MergeGit;
  readonly clock?: Clock;
  readonly onError?: (error: unknown) => void;
  /** C-112: informational notices such as skipped merge candidates. */
  readonly report?: (message: string) => void;
  readonly gate?: MergeCheckOptions;
  readonly mergeBlockedReminderMs?: number;
}

/**
 * M4.4 merge loop (§3.5, plan §4 M4.4).
 *
 * For every card that is `awaiting_merge` and whose merge plan validates —
 * policy `auto`, or a `merge` confirmation for the accepted completion — the
 * loop synchronizes the registered source, merges the pinned deliveries into
 * the central baseline and records the result as the system actor. One merge
 * per project runs at a time; a `stale` result retries on the next tick.
 */
export class MergeExecutor {
  private serial: Promise<void> = Promise.resolve();
  private confirmationErrors = 0;
  get confirmationErrorCount(): number {
    return this.confirmationErrors;
  }
  private readonly checks: MergeChecks | undefined;
  private readonly skips: MergeSkipLog;
  constructor(private readonly options: MergeLoopOptions) {
    this.skips = new MergeSkipLog(
      "merge loop",
      (message) => this.options.report?.(message),
      this.clock,
    );
    this.checks = options.gate
      ? new MergeChecks({
          ...options.gate,
          store: options.store,
          git: options.git,
          clock: this.clock,
          onError: options.onError ?? (() => {}),
          ...(options.report ? { report: options.report } : {}),
        })
      : undefined;
  }
  stop(): void {
    this.checks?.stop();
  }

  /**
   * Serialize ticks: one project never merges two cards in parallel. Resolves
   * after the check round this tick started, if any (see `schedule`).
   */
  async tick(project_id?: ProjectId): Promise<void> {
    await (await this.schedule(project_id)).done;
  }
  /**
   * One serialized pass. A gated check round keeps running in the background,
   * so the next pass can publish already-checked cards without waiting (C-113).
   */
  schedule(project_id?: ProjectId): Promise<{ readonly done: Promise<void> }> {
    const next = this.serial.then(async () => {
      const projects = project_id
        ? [project_id]
        : this.options.store.listProjects().map((project) => project.id);
      for (const id of projects) {
        this.confirmDue(id);
        if (!this.checks?.configured(id)) await this.project(id);
      }
      return (
        (await this.checks?.schedule(projects)) ?? {
          done: Promise.resolve(),
        }
      );
    });
    this.serial = next.then(
      () => {},
      () => {},
    );
    return next;
  }
  /** Resolves when no background check round is in flight. */
  idle(): Promise<void> {
    return this.checks?.idle() ?? Promise.resolve();
  }

  private get clock(): Clock {
    return this.options.clock ?? systemClock;
  }
  private state(project_id: ProjectId) {
    return this.options.store.uow.read((tx) =>
      loadCommandState(tx, project_id),
    );
  }

  /** Delegation grants consent only; both publication paths retain their own gates. */
  private confirmDue(project_id: ProjectId) {
    if (!this.options.git.projectOf(project_id)) return;
    const observed = runSystemCommand(
      this.options.store,
      project_id,
      (s, a, p) =>
        recordAutomaticMergeWaits(
          s,
          a,
          {
            ...(this.options.mergeBlockedReminderMs === undefined
              ? {}
              : { reminder_after_ms: this.options.mergeBlockedReminderMs }),
          },
          p,
        ),
      this.clock,
    );
    if (!observed.ok)
      this.confirmationError(project_id, new Error(observed.error.message));
    const state = this.state(project_id);
    const lite = autoMergeOn(
      state.project_preferences?.find((p) => p.id === project_id),
    );
    for (const decision of state.decisions.filter(
      (q) =>
        q.trigger === "merge_confirmation" &&
        (q.status === "open" ||
          ((q.decider === "system" ||
            (lite && q.resolution?.option === "merge")) &&
            q.status === "resolved")) &&
        state.cards.some(
          (c) => c.id === q.card_id && c.status === "awaiting_merge",
        ),
    )) {
      // Re-read preferences, the completion version and blockers in the write
      // transaction. Not-yet-due or ineligible decisions wait for another tick.
      try {
        const system = decision.decider === "system" || lite;
        const result = runSystemCommand(
          this.options.store,
          project_id,
          (s, a, ports) =>
            (system ? systemConfirmMerge : autoConfirmMerge)(
              s,
              a,
              { decision_id: decision.id },
              ports,
            ),
          this.clock,
        );
        if (!result.ok) {
          const current = this.state(project_id);
          const q = current.decisions.find((q) => q.id === decision.id);
          const card = current.cards.find((c) => c.id === q?.card_id);
          const expected =
            result.error.code === "illegal_transition" &&
            (!system ||
              (card &&
                q &&
                automaticMergeReasons(current, card, q).length > 0));
          if (!expected)
            this.confirmationError(
              project_id,
              new Error(
                `${decision.id}: ${result.error.code} ${result.error.message}`,
              ),
            );
        }
      } catch (error) {
        this.confirmationError(project_id, error);
      }
    }
  }

  private confirmationError(project: ProjectId, error: unknown): void {
    this.confirmationErrors++;
    const message = `Automatic merge confirmation failed (${project}; count=${this.confirmationErrors}): ${error instanceof Error ? error.message : "Unknown error"}`;
    try {
      if (this.options.onError)
        this.options.onError(new Error(message, { cause: error }));
      else if (this.options.report) this.options.report(message);
      else console.error(message, error);
    } catch {
      /* A broken logger must not stop other cards. */
    }
  }

  /** Record one result; a rejection is reported, never thrown into the loop. */
  private record(project_id: ProjectId, plan: MergePlan, result: MergeResult) {
    const recorded = runSystemCommand(
      this.options.store,
      project_id,
      (state, actor, ports) =>
        recordMergeResult(
          state,
          actor,
          {
            card_id: plan.card_id,
            completion_id: plan.completion_id,
            result,
          },
          ports,
        ),
      this.clock,
    );
    if (!recorded.ok)
      this.options.onError?.(
        new Error(
          `merge result for ${plan.completion_id} was rejected: ${recorded.error.code} ${recorded.error.message}`,
        ),
      );
  }

  /** Record `failed` at most once per completion, so a broken repo cannot spam Ops. */
  private recordFailure(
    project_id: ProjectId,
    plan: MergePlan,
    reason: string,
  ) {
    const already = this.state(project_id).events.some(
      (event) =>
        event.type === "merge_failed" &&
        (event.payload as { completion_id?: string } | null)?.completion_id ===
          plan.completion_id,
    );
    if (!already) this.record(project_id, plan, { kind: "failed", reason });
  }

  /**
   * One attempt; `false` means "stop this round". Only a `stale` baseline stops
   * the round: a broken card must not block the other cards of its project.
   */
  private async merge(
    project: CentralProject,
    plan: MergePlan,
  ): Promise<boolean> {
    const project_id = project.project_id as ProjectId;
    try {
      if (new CheckHandoffs(this.options.store, "").blockedProject(project_id))
        return false;
      await this.options.git.sync(project);
      return await withPublication(project_id, async () => {
        if (
          new CheckHandoffs(this.options.store, "").blockedProject(project_id)
        )
          return false;
        // Sync can yield to preference/evidence changes. Re-read at publication.
        const current = mergePlan(this.state(project_id), plan.card_id);
        if (
          !current.ok ||
          JSON.stringify(current.value) !== JSON.stringify(plan)
        )
          return false;
        let outcome: MergeOutcome;
        const git = this.options.git;
        if (git.prepare && git.publish) {
          const candidate = await git.prepare(project, plan);
          if (candidate.status === "candidate") {
            const published = await git.publish(
              project,
              plan.completion_id,
              candidate,
              mergePublicationGuard({
                store: this.options.store,
                project: project_id,
                plan,
                clock: this.clock,
                stopped: () =>
                  new CheckHandoffs(this.options.store, "").blockedProject(
                    project_id,
                  ),
                result: {
                  kind: "merged",
                  merge_sha: candidate.candidate_sha,
                  previous_sha: candidate.previous_sha,
                  tree_sha: candidate.tree_sha,
                },
              }),
            );
            return published.status !== "stale";
          }
          outcome = candidate;
        } else {
          outcome = await git.merge(project, plan);
        }
        if (outcome.status === "stale") return false;
        if (outcome.status === "merged")
          this.record(project_id, plan, {
            kind: "merged",
            merge_sha: outcome.merge_sha,
            previous_sha: outcome.previous_sha,
          });
        else if (outcome.status === "noop")
          // Every planned delivery is already an ancestor of the baseline; the
          // card still has to reach `done`, so the result names the current tip.
          this.record(project_id, plan, {
            kind: "merged",
            merge_sha: outcome.branch_sha,
            previous_sha: outcome.branch_sha,
          });
        else
          this.record(project_id, plan, {
            kind: "conflicted",
            delivery_id: outcome.delivery_id as DeliveryId,
            files: outcome.files,
          });
        return true;
      });
    } catch (error) {
      this.recordFailure(
        project_id,
        plan,
        `Merge of ${plan.card_id} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return true;
    }
  }

  private async project(project_id: ProjectId) {
    if (new CheckHandoffs(this.options.store, "").blockedProject(project_id))
      return;
    const project = this.options.git.projectOf(project_id);
    const observed = runSystemCommand(
      this.options.store,
      project_id,
      (s, a, p) =>
        recordMergeCheckBlockers(
          s,
          a,
          project ? {} : { unavailable: "repository" },
          p,
        ),
      this.clock,
    );
    if (!observed.ok) this.options.onError?.(new Error(observed.error.message));
    if (project === undefined) return;
    // Cards whose plan does not validate stay put (not confirmed, blocked or
    // nothing to merge); remember them so one pass cannot spin forever.
    const attempted = new Set<CardId>();
    this.skips.retain(
      project_id,
      new Set(
        this.state(project_id)
          .cards.filter((c) => c.status === "awaiting_merge")
          .map((c) => c.id),
      ),
    );
    for (;;) {
      const state = this.state(project_id),
        card = state.cards
          .filter(
            (candidate) =>
              candidate.status === "awaiting_merge" &&
              !attempted.has(candidate.id),
          )
          .sort((a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2)))[0];
      if (card === undefined) return;
      attempted.add(card.id);
      const plan = mergePlan(this.state(project_id), card.id);
      if (!plan.ok) {
        this.skips.skipped(project_id, card.id, plan.error);
        continue;
      }
      this.skips.ready(project_id, card.id);
      if (!(await this.merge(project, plan.value))) return;
    }
  }
}

export interface MergeLoop {
  readonly executor: MergeExecutor;
  readonly loop: TimerLoop;
}
export function startMergeLoop(
  options: MergeLoopOptions & {
    readonly intervalMs?: number;
    readonly clock?: Clock;
    readonly onError?: (error: unknown) => void;
    readonly signal?: AbortSignal;
  },
): MergeLoop {
  const executor = new MergeExecutor(options);
  const cancel = () => executor.stop();
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const loop = startTimerLoop({
    name: "merge",
    tick: async () => {
      await executor.schedule();
    },
    intervalMs: options.intervalMs ?? DEFAULT_MERGE_INTERVAL_MS,
    onError: options.onError ?? (() => undefined),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  // A background check round is part of the loop: stopping waits for it to
  // record its interruption, so SIGTERM never leaves a check half-recorded.
  const done = loop.done.finally(async () => {
    cancel();
    await executor.idle();
  });
  void done
    .finally(() => options.signal?.removeEventListener("abort", cancel))
    .catch(() => {});
  return {
    executor,
    loop: {
      done,
      stop: () => {
        cancel();
        void loop.stop();
        return done;
      },
    },
  };
}
