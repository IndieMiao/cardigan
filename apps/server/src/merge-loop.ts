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
  mergePlan,
  recordMergeResult,
} from "@cardigan/domain";
import type { CentralProject, MergeOutcome } from "@cardigan/git-service";
import { loadCommandState, persistEffect } from "@cardigan/mcp-server";
import type { Store } from "@cardigan/store";
import type { MergeGit } from "./git.js";
import { startTimerLoop, type TimerLoop } from "./loop.js";
import { type MergeCheckOptions, MergeChecks } from "./merge-checks.js";
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
  readonly gate?: MergeCheckOptions;
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
  private readonly checks: MergeChecks | undefined;
  constructor(private readonly options: MergeLoopOptions) {
    this.checks = options.gate
      ? new MergeChecks({
          ...options.gate,
          store: options.store,
          git: options.git,
          clock: this.clock,
          onError: options.onError ?? (() => {}),
        })
      : undefined;
  }
  stop(): void {
    this.checks?.stop();
  }

  /** Serialize ticks: one project never merges two cards in parallel. */
  tick(project_id?: ProjectId): Promise<void> {
    const next = this.serial.then(async () => {
      const projects = project_id
        ? [project_id]
        : this.options.store.listProjects().map((project) => project.id);
      for (const id of projects) {
        this.confirmDue(id);
        if (!this.checks?.configured(id)) await this.project(id);
      }
      await this.checks?.tick(projects);
    });
    this.serial = next.catch(() => {});
    return next;
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
    const state = this.state(project_id);
    for (const decision of state.decisions.filter(
      (q) =>
        q.trigger === "merge_confirmation" &&
        q.status === "open" &&
        state.cards.some(
          (c) => c.id === q.card_id && c.status === "awaiting_merge",
        ),
    )) {
      // Re-read preferences, the completion version and blockers in the write
      // transaction. Not-yet-due or ineligible decisions wait for another tick.
      runSystemCommand(
        this.options.store,
        project_id,
        (s, a, ports) =>
          autoConfirmMerge(s, a, { decision_id: decision.id }, ports),
        this.clock,
      );
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
      await this.options.git.sync(project);
      return await withPublication(project_id, async () => {
        const outcome: MergeOutcome = await this.options.git.merge(
          project,
          plan,
        );
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
    const project = this.options.git.projectOf(project_id);
    if (project === undefined) return;
    // Cards whose plan does not validate stay put (not confirmed, blocked or
    // nothing to merge); remember them so one pass cannot spin forever.
    const attempted = new Set<CardId>();
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
      if (!plan.ok) continue;
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
    tick: () => executor.tick(),
    intervalMs: options.intervalMs ?? DEFAULT_MERGE_INTERVAL_MS,
    onError: options.onError ?? (() => undefined),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  void loop.done
    .finally(() => options.signal?.removeEventListener("abort", cancel))
    .catch(() => {});
  return {
    executor,
    loop: {
      done: loop.done,
      stop: () => {
        cancel();
        return loop.stop();
      },
    },
  };
}
