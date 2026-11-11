import { randomUUID } from "node:crypto";
import type {
  Actor,
  Clock,
  CommandEffect,
  CommandPorts,
  CommandState,
  DeliveryId,
  MergeCheckView,
  MergePlan,
  MergeResult,
  ProjectId,
  Result,
} from "@cardigan/domain";
import {
  hasPassedMergeCheck,
  latestMergeCheck,
  mergePlan,
  prepareMergePlan,
  recordMergeCheck,
  recordMergeResult,
} from "@cardigan/domain";
import type {
  CentralProject,
  MergeOutcome,
  PreparedMerge,
} from "@cardigan/git-service";
import {
  acquireMergeCheckCapacity,
  createMergeCheckLog,
  type MergeGateConfiguration,
  type ProjectMergeGate,
  runInTemporaryCheckout,
} from "@cardigan/host";
import { loadCommandState, persistEffect } from "@cardigan/mcp-server";
import type { ExecutionConfig } from "@cardigan/runtime-herdr";
import type { Store } from "@cardigan/store";
import type { MergeGit } from "./git.js";

import { mergeProjectSettings } from "./merge-push-loop.js";
import { withPublication } from "./publication-lock.js";

type Candidate = Extract<PreparedMerge, { status: "candidate" }>;
type Settings = Extract<ProjectMergeGate, { status: "enabled" }>;
type WithoutCard<T> = T extends unknown ? Omit<T, "card_id"> : never;
type CheckChange = WithoutCard<Parameters<typeof recordMergeCheck>[2]>;
export interface MergeCheckGit {
  baseline(project: CentralProject): Promise<string>;
  prepare(project: CentralProject, plan: MergePlan): Promise<PreparedMerge>;
  publish(
    project: CentralProject,
    completion: DeliveryId,
    candidate: Candidate,
  ): Promise<
    | Extract<MergeOutcome, { status: "stale" }>
    | (Extract<MergeOutcome, { status: "merged" }> & {
        readonly tree_sha: string;
      })
  >;
  distribute(project: CentralProject): Promise<void>;
}
export interface MergeCheckOptions {
  readonly configuration: MergeGateConfiguration;
  readonly execution: ExecutionConfig;
  readonly run?: typeof runInTemporaryCheckout;
}
interface Task {
  project: CentralProject;
  plan: MergePlan;
  settings: Settings;
  entered: string;
}

/** Persisted queue; the OS execution slot is held by the trusted check supervisor. */
export class MergeChecks {
  private readonly abort = new AbortController();
  private readonly seen = new Set<string>();
  private readonly prepared = new Map<
    string,
    { key: string; value: PreparedMerge }
  >();
  constructor(
    private readonly options: MergeCheckOptions & {
      store: Store;
      git: MergeGit & Partial<MergeCheckGit>;
      clock: Clock;
      onError: (error: unknown) => void;
    },
  ) {}

  stop(): void {
    this.abort.abort();
  }
  configured(project: ProjectId): boolean {
    return this.options.configuration.forProject(project).status !== "disabled";
  }
  private state(project: string) {
    return this.options.store.uow.read((tx) =>
      loadCommandState(
        tx,
        project as ProjectId,
        mergeProjectSettings(this.options.configuration, project),
      ),
    );
  }
  private command<T>(
    project: string,
    reduce: (
      state: CommandState,
      actor: Actor,
      ports: CommandPorts,
    ) => Result<CommandEffect<T>>,
  ): T {
    return this.options.store.uow.run((tx) => {
      const result = reduce(
        loadCommandState(
          tx,
          project as ProjectId,
          mergeProjectSettings(this.options.configuration, project),
        ),
        { kind: "system", project_id: project as ProjectId },
        { ids: tx.ids, clock: this.options.clock },
      );
      if (!result.ok)
        throw new Error(`${result.error.code}: ${result.error.message}`);
      persistEffect(tx, project as ProjectId, result.value);
      return result.value.data;
    });
  }
  private check(task: Task, update: CheckChange) {
    const identity = {
      card_id: task.plan.card_id,
      attempt_id: update.attempt_id,
      completion_id: update.completion_id,
      candidate_sha: update.candidate_sha,
      tree_sha: update.tree_sha,
    };
    return this.command(task.project.project_id, (s, a, p) =>
      recordMergeCheck(
        s,
        a,
        update.status === "queued" || update.status === "running"
          ? { ...identity, status: update.status }
          : { ...update, ...identity },
        p,
      ),
    );
  }
  private record(task: Task, result: MergeResult) {
    return this.command(task.project.project_id, (s, a, p) =>
      recordMergeResult(
        s,
        a,
        {
          card_id: task.plan.card_id,
          completion_id: task.plan.completion_id,
          result,
        },
        p,
      ),
    );
  }
  private git(): MergeGit & MergeCheckGit {
    const git = this.options.git;
    if (!git.baseline || !git.prepare || !git.publish || !git.distribute)
      throw new Error("合并闸门缺少 Git 执行入口，拒绝合并");
    return git as MergeGit & MergeCheckGit;
  }
  private valid(task: Task, confirmed = false): boolean {
    const plan = (confirmed ? mergePlan : prepareMergePlan)(
      this.state(task.project.project_id),
      task.plan.card_id,
    );
    return plan.ok && JSON.stringify(plan.value) === JSON.stringify(task.plan);
  }
  private passed(task: Task, tree: string): boolean {
    return hasPassedMergeCheck(
      this.state(task.project.project_id).events,
      task.plan.card_id,
      task.plan.completion_id,
      tree,
    );
  }
  private async prepare(task: Task): Promise<PreparedMerge> {
    const git = this.git();
    await git.sync(task.project);
    const baseline = await git.baseline(task.project),
      id = `${task.project.project_id}/${task.plan.card_id}`;
    const key = JSON.stringify([task.project, task.plan, baseline]);
    const cached = this.prepared.get(id);
    if (cached?.key === key) return cached.value;
    const value = await git.prepare(task.project, task.plan);
    this.prepared.set(id, { key, value });
    return value;
  }
  private async interrupt(task: Task, check: MergeCheckView) {
    // A queued attempt has no writer; preserve any existing crashed-attempt log.
    try {
      const log = await createMergeCheckLog({
        dataDir: this.options.execution.dataDir,
        project: task.project.project_id,
        attempt: check.attempt_id,
        env: task.settings.env,
      });
      await log.finish({
        status: "interrupted",
        checks: [],
        cleanup_errors: [],
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST")
        this.options.onError(new Error("中断检查的日志无法创建"));
    }
    this.check(task, {
      ...check,
      status: "interrupted",
      checks: [],
      summary: "检查中断或候选已改变，重新排队",
      log_ref: `${check.attempt_id}.log`,
    });
    this.seen.delete(check.attempt_id);
  }
  private async queue(
    task: Task,
    candidate: Candidate,
  ): Promise<MergeCheckView | undefined> {
    const { plan } = task;
    const events = this.state(task.project.project_id).events;
    const latest = latestMergeCheck(events, plan.card_id, plan.completion_id);
    if (
      latest &&
      ["running", "queued"].includes(latest.status) &&
      !latest.recheck_requested
    ) {
      if (
        this.seen.has(latest.attempt_id) &&
        latest.status === "queued" &&
        latest.candidate_sha === candidate.candidate_sha &&
        latest.tree_sha === candidate.tree_sha
      )
        return latest;
      await this.interrupt(task, latest);
    }
    if (this.passed(task, candidate.tree_sha)) return undefined;
    const previous = latestMergeCheck(
      this.state(task.project.project_id).events,
      plan.card_id,
      plan.completion_id,
      candidate.tree_sha,
    );
    if (
      previous &&
      previous.status !== "interrupted" &&
      !previous.recheck_requested
    )
      return undefined;
    const queued = this.check(task, {
      completion_id: plan.completion_id,
      attempt_id: randomUUID(),
      candidate_sha: candidate.candidate_sha,
      tree_sha: candidate.tree_sha,
      status: "queued",
    });
    this.seen.add(queued.attempt_id);
    return queued;
  }
  private terminal(task: Task, prepared: Exclude<PreparedMerge, Candidate>) {
    if (prepared.status === "conflicted")
      this.record(task, {
        kind: "conflicted",
        delivery_id: prepared.delivery_id as DeliveryId,
        files: prepared.files,
      });
    else if (this.valid(task, true))
      this.record(task, {
        kind: "merged",
        merge_sha: prepared.branch_sha,
        previous_sha: prepared.branch_sha,
        noop: true,
      });
  }
  private async execute(task: Task, check: MergeCheckView): Promise<void> {
    let log: Awaited<ReturnType<typeof createMergeCheckLog>> | undefined;
    let result: Awaited<ReturnType<typeof runInTemporaryCheckout>>;
    let releaseCapacity = () => {};
    try {
      log = await createMergeCheckLog({
        dataDir: this.options.execution.dataDir,
        project: task.project.project_id,
        attempt: check.attempt_id,
        env: task.settings.env,
      });
      await this.git().distribute(task.project);
      if (!this.valid(task)) throw new Error("Merge target changed");
      result = await (this.options.run ?? runInTemporaryCheckout)({
        execution: this.options.execution,
        project: task.project.project_id,
        attempt: check.attempt_id,
        sha: check.candidate_sha,
        tree: check.tree_sha,
        checks: task.settings.checks,
        env: task.settings.env,
        totalTimeoutMs: task.settings.totalTimeoutMs,
        serialize: true,
        signal: this.abort.signal,
        onReady: (owner) => {
          releaseCapacity = acquireMergeCheckCapacity(
            this.options.store,
            task.project.project_id as ProjectId,
            check.attempt_id,
            owner,
          );
          this.check(task, { ...check, status: "running" });
        },
        onOutput: (name, text) => log?.append(name, text),
      });
    } catch {
      // Never expose raw Git/SSH diagnostics or configured environment values.
      result = {
        status: this.abort.signal.aborted ? "interrupted" : "failed",
        checks: [],
        cleanup_errors: [],
        reason: "候选同步或检查执行入口失败，请检查执行环境",
      };
    } finally {
      // Always release runtime occupancy, even if a returned/cancelled target
      // makes the subsequent business result command reject.
      releaseCapacity();
    }
    let finished: {
      status: Exclude<MergeCheckView["status"], "running" | "queued">;
      checks: MergeCheckView["checks"];
      summary: string;
      log_ref: string;
    };
    try {
      finished = log
        ? await log.finish(result)
        : {
            ...result,
            summary: "检查日志无法创建，检查未执行",
            log_ref: `${check.attempt_id}.log`,
          };
    } catch {
      finished = {
        status: "failed" as const,
        checks: [],
        summary: "检查日志写入失败，拒绝发布",
        log_ref: `${check.attempt_id}.log`,
      };
    }
    this.check(task, {
      ...check,
      status: finished.status,
      checks: finished.checks,
      summary: finished.summary,
      log_ref: finished.log_ref,
    });
    this.seen.delete(check.attempt_id);
  }
  private async publish(task: Task) {
    if (this.abort.signal.aborted || !this.valid(task, true)) return;
    const candidate = await this.prepare(task);
    if (candidate.status !== "candidate") {
      this.terminal(task, candidate);
      return;
    }
    if (!this.passed(task, candidate.tree_sha)) {
      await this.queue(task, candidate);
      return;
    }
    // Re-read confirmation/state after Git IO. CAS protects against another baseline writer.
    if (!this.valid(task, true)) return;
    // C-94: moving central main and recording the move share one lock with
    // the pre-push check, so an unrecorded window is never observed.
    await withPublication(task.project.project_id, async () => {
      const result = await this.git().publish(
        task.project,
        task.plan.completion_id,
        candidate,
      );
      if (result.status === "merged")
        this.record(task, {
          kind: "merged",
          merge_sha: result.merge_sha,
          previous_sha: result.previous_sha,
          tree_sha: result.tree_sha,
        });
    });
  }
  private failure(task: Task, error: unknown) {
    this.options.onError(error);
    if (!this.valid(task)) return;
    if (
      !this.state(task.project.project_id).events.some(
        (e) =>
          e.type === "merge_failed" &&
          (e.payload as { completion_id?: string } | null)?.completion_id ===
            task.plan.completion_id,
      )
    )
      this.record(task, {
        kind: "failed",
        reason: "合并候选准备或结果记录失败，未发布未经检查的代码",
      });
  }
  async tick(projects: readonly ProjectId[]): Promise<void> {
    const tasks: Task[] = [];
    for (const id of projects) {
      const settings = this.options.configuration.forProject(id),
        project = this.options.git.projectOf(id);
      if (settings.status !== "enabled" || !project) continue;
      const state = this.state(id);
      for (const card of state.cards) {
        if (card.status !== "awaiting_merge") continue;
        const plan = prepareMergePlan(state, card.id);
        if (!plan.ok) continue;
        const entered = state.events
          .filter(
            (e) =>
              e.type === "review_submitted" &&
              (e.payload as { delivery_id?: string } | null)?.delivery_id ===
                plan.value.completion_id,
          )
          .at(-1)?.created_at;
        if (!entered) {
          this.options.onError(new Error("待合并卡片缺少完成审核事件"));
          continue;
        }
        tasks.push({ project, plan: plan.value, settings, entered });
      }
    }
    tasks.sort(
      (a, b) =>
        a.entered.localeCompare(b.entered) ||
        a.project.project_id.localeCompare(b.project.project_id) ||
        a.plan.card_id.localeCompare(b.plan.card_id),
    );
    // Persist the entire queue before starting the first expensive command.
    for (const task of tasks) {
      if (this.abort.signal.aborted) return;
      try {
        const prepared = await this.prepare(task);
        if (!this.valid(task)) continue;
        if (prepared.status === "candidate") await this.queue(task, prepared);
        else this.terminal(task, prepared);
      } catch (error) {
        this.failure(task, error);
      }
    }
    for (const task of tasks) {
      if (this.abort.signal.aborted) return;
      try {
        if (!this.valid(task)) continue;
        // Earlier cards may have advanced this project's baseline while queued.
        const prepared = await this.prepare(task);
        if (prepared.status !== "candidate") {
          this.terminal(task, prepared);
          continue;
        }
        const check = await this.queue(task, prepared);
        if (check) await this.execute(task, check);
        await this.publish(task);
      } catch (error) {
        this.failure(task, error);
      }
    }
    const live = new Set(
      tasks.map((t) => `${t.project.project_id}/${t.plan.card_id}`),
    );
    for (const key of this.prepared.keys())
      if (!live.has(key)) this.prepared.delete(key);
  }
}
