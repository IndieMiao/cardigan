import {
  type Actor,
  abortMergeBatch,
  abortMergeBatchPublish,
  activeMergeFamilies,
  batchFailures,
  batchStartupFailure,
  beginMergeBatchPublish,
  type CommandEffect,
  type CommandPorts,
  type CommandState,
  eventsOfType,
  formBisectProbe,
  formMergeBatch,
  hasBatchFailureEvidence,
  identifyMergeBatchCulprit,
  type MergeBatch,
  mergeBatchBranch,
  mergeBatches,
  mergePlan,
  mergeQueue,
  mergeWindows,
  mergeWindowVersions,
  type ProjectId,
  type Result,
  recordMergeBatchResult,
  recordMergeQueueConfiguration,
  recordMergeResult,
  refreshMergeWindows,
  requeueMergeBatch,
  startMergeBatchBisect,
  validateMergeBatchMembers,
} from "@cardigan/domain";
import { type CentralProject, centralBranch } from "@cardigan/git-service";
import type { ProjectMergeGate } from "@cardigan/host";
import type { Store } from "@cardigan/store";
import type { MergeGit } from "./git.js";
import { mergeFailureReason, mergeStage } from "./merge-failure.js";
import {
  batchSubject,
  holdMergeStep,
  MergeStepDeferred,
  type MergeStepSubject,
  mergeStep,
} from "./merge-step.js";
import { tryPublication } from "./publication-lock.js";

type Settings = Extract<ProjectMergeGate, { status: "enabled" }>;
type Command = <T>(
  project: string,
  reduce: (
    s: CommandState,
    a: Actor,
    p: CommandPorts,
  ) => Result<CommandEffect<T>>,
) => T;

/** Durable orchestration; check execution stays in the shared MergeChecks scheduler. */
export class MergeBatches {
  constructor(
    private readonly options: {
      /** C-799: Git steps register as managed operations a restart waits for. */
      store: Store;
      git: MergeGit;
      state: (project: string) => CommandState;
      command: Command;
      fenced: (project: string) => boolean;
    },
  ) {}

  async tick(registered: CentralProject, settings: Settings) {
    const { git, state, command, fenced } = this.options,
      id = registered.project_id;
    if (fenced(id)) return;
    // Batches are built per baseline branch: each card's own `base_branch`.
    const branchOf = (card: string) =>
      state(id).cards.find((c) => c.id === card)?.base_branch ??
      registered.base_branch;
    const view = (branch: string) => centralBranch(registered, branch);
    const viewOf = (batch: MergeBatch) =>
      view(branchOf(batch.members[0]?.card_id ?? ""));
    command(id, (s, a, p) => recordMergeQueueConfiguration(s, a, {}, p));
    // Complete an already durable publication even if the queue was disabled.
    for (const batch of mergeBatches(state(id).events).filter(
      (b) => b.status === "publishing",
    ))
      if (!(await this.publish(viewOf(batch), batch))) return;
    if (!settings.queue) {
      for (const batch of activeMergeFamilies(state(id).events))
        command(id, (s, a, p) =>
          abortMergeBatch(
            s,
            a,
            { batch_id: batch.id, reason: "interrupted" },
            p,
          ),
        );
      return;
    }
    if (
      !git.prepareBatch ||
      !git.pinBatch ||
      !git.publishBatch ||
      !git.baseline
    )
      throw new Error("合并队列缺少可信批次 Git 入口");
    // Read only the branches that have work. A failing branch is isolated:
    // its cards record the failing step, other branches keep their queue.
    const baselines = new Map<string, Promise<string | undefined>>();
    const failures = new Map<string, unknown>();
    // The first caller of a branch names the card or batch the read is for.
    const baselineOf = (
      branch: string,
      subject: Omit<MergeStepSubject, "project_id">,
    ) => {
      let read = baselines.get(branch);
      if (!read) {
        const step = { ...subject, project_id: id };
        read = (async () => {
          const project = await mergeStage("选择基线分支", () => view(branch));
          await mergeStep(this.options.store, step, "同步源仓库", () =>
            git.sync(project),
          );
          return mergeStep(this.options.store, step, "读取基线", () => {
            if (!git.baseline) throw new Error("合并队列缺少可信批次 Git 入口");
            return git.baseline(project);
          });
        })().catch((error: unknown) => {
          // C-799: fenced by a restart before the step started; no failure.
          if (!(error instanceof MergeStepDeferred))
            failures.set(branch, error);
          return undefined;
        });
        baselines.set(branch, read);
      }
      return read;
    };
    if (git.deliveryChangedPaths) {
      const snapshot = state(id),
        windows = mergeWindows(snapshot.events).filter((w) => w.open);
      if (windows.length) {
        const paths: Parameters<
          typeof refreshMergeWindows
        >[2]["paths"][number][] = [];
        for (const card of snapshot.cards.filter(
          (c) =>
            c.status === "awaiting_merge" ||
            windows.some((w) => w.card_id === c.id),
        )) {
          const versions = mergeWindowVersions(snapshot, card.id);
          const files = new Set<string>();
          const branch = card.base_branch ?? registered.base_branch;
          const base = await baselineOf(branch, {
            card_id: card.id,
            subject: `合并 ${card.id}`,
          });
          // An unreadable branch keeps its cards' previous protection paths.
          if (base === undefined) continue;
          for (const delivery of snapshot.deliveries.filter((v) =>
            versions.includes(v.id),
          ))
            for (const file of await git.deliveryChangedPaths(
              view(branch),
              base,
              delivery.subject.value,
            ))
              files.add(file);
          paths.push({ card_id: card.id, versions, files: [...files].sort() });
        }
        command(id, (s, a, p) => refreshMergeWindows(s, a, { paths }, p));
      }
    }
    for (const batch of activeMergeFamilies(state(id).events)) {
      if (["failed", "bisecting"].includes(batch.status)) {
        const family = mergeBatches(state(id).events).filter(
          (b) => b.id === batch.id || b.parent_batch_id === batch.id,
        );
        if (
          batchStartupFailure(family) &&
          !family.some((b) => b.status === "checking")
        ) {
          command(id, (s, a, p) =>
            abortMergeBatch(
              s,
              a,
              { batch_id: batch.id, reason: "repository_busy" },
              p,
            ),
          );
          continue;
        }
      }
      let reason: "stale" | "member_left" | undefined;
      const branch = branchOf(batch.members[0]?.card_id ?? "");
      const base = await baselineOf(branch, {
        card_id: batch.members[0]?.card_id,
        subject: batchSubject(batch),
      });
      // Retry on a later tick; never abort a batch on an unreadable baseline.
      if (base === undefined) continue;
      const project = view(branch);
      if (base !== batch.base_sha) reason = "stale";
      else {
        try {
          // The failed member has already returned for fixes. Only the proven
          // prefix can still publish; its members retain their own authorization.
          const pending =
            batch.status === "resolved" && batch.published_prefix
              ? mergeBatches(state(id).events).find(
                  (b) => b.id === batch.published_prefix,
                )
              : batch;
          if (!pending) throw new Error("Missing passed prefix");
          validateMergeBatchMembers(state(id), pending);
        } catch {
          reason = "member_left";
        }
      }
      if (reason) {
        command(id, (s, a, p) =>
          abortMergeBatch(s, a, { batch_id: batch.id, reason }, p),
        );
        continue;
      }
      if (batch.status === "passed") {
        await this.publish(project, batch);
        continue;
      }
      if (batch.status === "resolved" && batch.published_prefix) {
        const prefix = mergeBatches(state(id).events).find(
          (b) => b.id === batch.published_prefix,
        );
        if (prefix?.status === "passed") await this.publish(project, prefix);
        continue;
      }
      if (
        ["failed", "bisecting"].includes(batch.status) &&
        !hasBatchFailureEvidence(batch.check)
      )
        continue;
      if (batch.status === "failed") {
        const rerun = eventsOfType(
          state(id).events,
          "merge_batch_requeued",
        ).some(
          (e) => (e.payload as { batch_id?: string }).batch_id === batch.id,
        );
        if (
          !rerun &&
          (batch.members.length === 1 ||
            batch.check?.timeout_only ||
            batch.check?.infra_flaky)
        ) {
          command(id, (s, a, p) =>
            requeueMergeBatch(s, a, { batch_id: batch.id }, p),
          );
          continue;
        }
        if (batch.members.length === 1) {
          command(id, (s, a, p) =>
            identifyMergeBatchCulprit(
              s,
              a,
              { batch_id: batch.id, failed_batch_id: batch.id },
              p,
            ),
          );
          continue;
        }
        command(id, (s, a, p) =>
          startMergeBatchBisect(s, a, { batch_id: batch.id }, p),
        );
      }
      if (["failed", "bisecting"].includes(batch.status))
        this.bisect(id, batch, settings);
    }
    // Orphaned probes cannot hold members or authorize results after family closure.
    const live = new Set(
      activeMergeFamilies(state(id).events).map((b) => b.id),
    );
    for (const probe of mergeBatches(state(id).events).filter(
      (b) =>
        b.purpose === "bisect" &&
        b.parent_batch_id &&
        !live.has(b.parent_batch_id) &&
        !["published", "aborted", "publishing"].includes(b.status),
    ))
      command(id, (s, a, p) =>
        abortMergeBatch(s, a, { batch_id: probe.id, reason: "interrupted" }, p),
      );
    if (fenced(id)) {
      this.recordFailures(id, failures);
      return;
    }
    // Each branch owns one batch family at a time. A family stuck on its
    // branch (for example an unreadable baseline) never blocks another branch.
    const owned = new Set(
      activeMergeFamilies(state(id).events).map((b) =>
        mergeBatchBranch(state(id), b),
      ),
    );
    const queue = mergeQueue(state(id));
    // The first free branch in queue order whose baseline is readable forms
    // the batch; other branches wait their turn, failed ones record why.
    let branch: string | undefined;
    for (const item of queue) {
      if (owned.has(item.plan.base_branch)) continue;
      if (
        (await baselineOf(item.plan.base_branch, {
          card_id: item.plan.card_id,
          subject: `合并 ${item.plan.card_id}`,
        })) !== undefined
      ) {
        branch = item.plan.base_branch;
        break;
      }
    }
    this.recordFailures(id, failures);
    if (branch === undefined) return;
    // C-647 merge_solo (queue mode): the flag only isolates the card in a batch
    // of its own. It never changes the card's queue rank, and its passed card
    // check stays valid on any baseline (`passedCardCheck`), so other batches
    // merging first never void it. A solo card at the head forms its own
    // batch; a solo card further back is skipped for this batch (it could not
    // join it anyway) and does not cut off the passed cards behind it; it
    // keeps its rank and leads the next batch unless higher-ranked cards come.
    // Without the queue the flag has no effect at all (see MergeChecks).
    const chosen: typeof queue = [];
    for (const item of queue) {
      if (item.plan.base_branch !== branch) continue;
      if (chosen.length >= settings.queue.maxBatchSize) break;
      if (chosen.length && item.solo) continue;
      chosen.push(item);
      if (item.solo) break;
    }
    if (!chosen.length) return;
    const project = view(branch);
    const prepared = await git.prepareBatch(
      project,
      chosen.map((q) => q.plan),
    );
    if (fenced(id)) return;
    for (const conflict of prepared.conflicts)
      command(id, (s, a, p) =>
        recordMergeResult(
          s,
          a,
          {
            card_id: conflict.plan.card_id,
            completion_id: conflict.plan.completion_id,
            result: {
              kind: "conflicted",
              delivery_id: conflict.delivery_id as never,
              files: conflict.files,
            },
          },
          p,
        ),
      );
    for (const noop of prepared.noops)
      command(id, (s, a, p) =>
        recordMergeResult(
          s,
          a,
          {
            card_id: noop.card_id,
            completion_id: noop.completion_id,
            result: {
              kind: "merged",
              merge_sha: prepared.base_sha,
              previous_sha: prepared.base_sha,
              noop: true,
            },
          },
          p,
        ),
      );
    // Noops are verified against the baseline, never inferred from another member.
    if (
      prepared.members.some(
        (m) => !mergeQueue(state(id)).some((q) => q.plan.card_id === m.card_id),
      )
    )
      return;
    if (prepared.members.length) {
      const batch = command(id, (s, a, p) =>
        formMergeBatch(
          s,
          a,
          {
            base_sha: prepared.base_sha,
            members: prepared.members,
            solo: chosen[0]?.solo === true,
          },
          p,
        ),
      );
      await git.pinBatch(project, batch);
    }
  }

  private bisect(id: ProjectId, batch: MergeBatch, settings: Settings) {
    const { state, command } = this.options;
    const probes = mergeBatches(state(id).events).filter(
      (b) => b.parent_batch_id === batch.id && b.status !== "aborted",
    );
    if (batchStartupFailure(probes)) return;
    const failed = [batch, ...probes]
      .filter((b) => hasBatchFailureEvidence(b.check))
      .sort((a, b) => a.members.length - b.members.length)[0];
    if (!failed) return;
    const length = failed.members.length;
    const prefix = probes.find(
      (b) => b.members.length === length - 1 && b.status === "passed",
    );
    if (length === 1 || prefix) {
      const failures = batchFailures(state(id).events, batch.id).length;
      if (failed.id === batch.id && failures < 2) {
        command(id, (s, a, p) =>
          requeueMergeBatch(s, a, { batch_id: batch.id }, p),
        );
        return;
      }
      command(id, (s, a, p) =>
        identifyMergeBatchCulprit(
          s,
          a,
          {
            batch_id: batch.id,
            failed_batch_id: failed.id,
            ...(prefix ? { passed_prefix_id: prefix.id } : {}),
          },
          p,
        ),
      );
      return;
    }
    const capacity =
      settings.executor?.type === "github"
        ? settings.executor.maxConcurrent
        : 1;
    const targets =
      capacity >= batch.members.length - 1
        ? Array.from({ length: batch.members.length - 1 }, (_, i) => i + 1)
        : [
            Math.floor(
              (Math.max(
                0,
                ...probes
                  .filter(
                    (b) => b.status === "passed" && b.members.length < length,
                  )
                  .map((b) => b.members.length),
              ) +
                length) /
                2,
            ),
          ];
    for (const length of targets)
      if (!probes.some((b) => b.members.length === length))
        command(id, (s, a, p) =>
          formBisectProbe(s, a, { batch_id: batch.id, length }, p),
        );
  }

  /**
   * Once per completion, like the direct merge loop: queued cards and members
   * of an active family on a branch whose baseline could not be read.
   */
  private recordFailures(id: string, failures: ReadonlyMap<string, unknown>) {
    if (!failures.size) return;
    const { state, command } = this.options;
    const snapshot = state(id);
    const plans = [
      ...mergeQueue(snapshot).map((q) => q.plan),
      ...activeMergeFamilies(snapshot.events).flatMap((b) =>
        b.members.flatMap((m) => {
          const plan = mergePlan(snapshot, m.card_id);
          return plan.ok ? [plan.value] : [];
        }),
      ),
    ];
    for (const item of plans.map((plan) => ({ plan }))) {
      if (!failures.has(item.plan.base_branch)) continue;
      const recorded = snapshot.events.some(
        (e) =>
          e.type === "merge_failed" &&
          (e.payload as { completion_id?: string } | null)?.completion_id ===
            item.plan.completion_id,
      );
      if (recorded) continue;
      command(id, (s, a, p) =>
        recordMergeResult(
          s,
          a,
          {
            card_id: item.plan.card_id,
            completion_id: item.plan.completion_id,
            result: {
              kind: "failed",
              reason: mergeFailureReason(
                item.plan.card_id,
                failures.get(item.plan.base_branch),
              ),
            },
          },
          p,
        ),
      );
    }
  }

  private async publish(project: CentralProject, batch: MergeBatch) {
    const { command, git, fenced } = this.options;
    if (!git.publishBatch) throw new Error("合并队列缺少可信批次发布入口");
    return tryPublication(project.project_id, async () => {
      if (fenced(project.project_id)) return;
      // C-799: held before the durable publishing record; a restart that
      // fenced it first leaves the batch passed for a later pass.
      let release: () => void;
      try {
        release = holdMergeStep(
          this.options.store,
          {
            project_id: project.project_id,
            card_id: batch.members[0]?.card_id,
            subject: batchSubject(batch),
          },
          "发布合并",
        );
      } catch (error) {
        if (error instanceof MergeStepDeferred) return false;
        throw error;
      }
      try {
        const publishing =
          batch.status === "publishing"
            ? batch
            : command(project.project_id, (s, a, p) =>
                beginMergeBatchPublish(s, a, { batch_id: batch.id }, p),
              );
        const result = await git.publishBatch?.(project, publishing);
        if (result?.status === "published")
          command(project.project_id, (s, a, p) =>
            recordMergeBatchResult(s, a, { batch_id: batch.id }, p),
          );
        else if (result?.status === "stale")
          command(project.project_id, (s, a, p) =>
            abortMergeBatchPublish(
              s,
              a,
              {
                batch_id: batch.id,
                observed_base_sha: result.observed_base_sha,
              },
              p,
            ),
          );
        return true;
      } finally {
        release();
      }
    });
  }
}
