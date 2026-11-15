import type { Assignment, Clock, Precheck, ProjectId } from "@cardigan/domain";
import { prechecks, recordPrecheck } from "@cardigan/domain";
import type { CentralProject } from "@cardigan/git-service";
import {
  acquireMergeCheckCapacity,
  type CheckExecutor,
  CheckExecutorSuspended,
  type CheckRecovery,
  createMergeCheckLog,
  DeploymentInProgress,
  executorExecution,
  GithubDispatchJournal,
  GithubRetryLater,
  type MergeGateConfiguration,
  mergeCheckAttemptRunning,
  type ProjectMergeGate,
  runCheckExecutor,
  SshCheckExecutor,
} from "@cardigan/host";
import { loadCommandState, persistEffect } from "@cardigan/mcp-server";
import type { ExecutionConfig } from "@cardigan/runtime-herdr";
import {
  CheckAdmissionClosed,
  CheckHandoffs,
  type Store,
} from "@cardigan/store";

type Settings = Extract<ProjectMergeGate, { status: "enabled" }>;
type Candidate = { candidate_sha: string; tree_sha: string; base_sha: string };
export interface AuthorCheckGit {
  projectOf(project: ProjectId): CentralProject | undefined;
  checkHead(project: ProjectId, assignment: Assignment): Promise<string>;
  preparePrecheck(
    project: CentralProject,
    assignment: string,
    head: string,
    attempt: string,
  ): Promise<Candidate>;
  distribute(
    project: CentralProject,
    execution?: ExecutionConfig,
  ): Promise<void>;
}
/** Independent author queue; the owner supplies the same target slots/providers as merge checks. */
export class AuthorPrechecks {
  private readonly retry = new Map<string, number>();
  private readonly active = new Map<string, Promise<void>>();
  constructor(
    private readonly options: {
      store: Store;
      clock: Clock;
      execution: ExecutionConfig;
      configuration: MergeGateConfiguration;
      git: Partial<AuthorCheckGit>;
      signal: AbortSignal;
      onError(error: unknown): void;
      reserve(
        settings: Settings,
      ): Promise<{ index: number; release(): void } | undefined>;
      github(
        check: Precheck,
        project: CentralProject,
        settings: Settings,
        bind: (run: NonNullable<Precheck["external_run"]>) => void,
      ): CheckExecutor;
      executor?: CheckExecutor;
      run?: ConstructorParameters<typeof SshCheckExecutor>[0]["run"];
      recovery: CheckRecovery;
      createLog?: typeof createMergeCheckLog;
    },
  ) {}
  owns(attempt: string) {
    return this.active.has(attempt);
  }
  async idle() {
    await Promise.all(this.active.values());
  }
  private state(project: ProjectId) {
    return this.options.store.uow.read((tx) => loadCommandState(tx, project));
  }
  private update(project: ProjectId, check: Precheck) {
    return this.options.store.uow.run((tx) => {
      const effect = recordPrecheck(
        loadCommandState(tx, project),
        { kind: "system", project_id: project },
        check,
        { ids: tx.ids, clock: this.options.clock },
      );
      if (!effect.ok) throw new Error(`Precheck record: ${effect.error.code}`);
      persistEffect(tx, project, effect.value);
    });
  }
  private owner(project: ProjectId, check: Precheck) {
    const s = this.state(project),
      a = s.assignments.find((a) => a.id === check.assignment_id),
      item = s.work_items.find((w) => w.id === check.work_item_id),
      card = s.cards.find((c) => c.id === check.card_id);
    return a?.status === "active" &&
      a.scope === "work_item" &&
      a.work_item_id === item?.id &&
      item.assignment_id === a.id &&
      item.status !== "cancelled" &&
      a.branch === check.branch &&
      a.machine_id === check.machine_id &&
      card &&
      !["done", "cancelled"].includes(card.status)
      ? a
      : undefined;
  }
  async schedule(projects: readonly ProjectId[]) {
    const started: Promise<void>[] = [];
    for (const project of projects)
      for (const check of prechecks(this.state(project).events)) {
        if (
          !["queued", "running"].includes(check.status) ||
          this.active.has(check.attempt_id) ||
          this.options.signal.aborted
        )
          continue;
        if (
          new CheckHandoffs(
            this.options.store,
            "precheck-observer",
          ).blockedProject(project)
        )
          continue;
        const work = this.execute(project, check)
          .catch(() => {
            this.options.onError(new Error("作者预检查收尾失败，保留当前记录"));
          })
          .finally(() => this.active.delete(check.attempt_id));
        this.active.set(check.attempt_id, work);
        started.push(work);
      }
    return { done: Promise.all(started).then(() => {}) };
  }
  private async execute(projectId: ProjectId, original: Precheck) {
    let check = original,
      stage = "配置",
      log: Awaited<ReturnType<typeof createMergeCheckLog>> | undefined;
    let slot: { index: number; release(): void } | undefined,
      release: ReturnType<typeof acquireMergeCheckCapacity> | undefined;
    let finishedLog = false;
    try {
      if (
        Date.parse(this.options.clock.now()) <
        (this.retry.get(check.attempt_id) ?? 0)
      )
        return;
      const settings = this.options.configuration.forProject(projectId);
      if (settings.status !== "enabled" || !settings.executor)
        throw new Error("No trusted remote executor");
      const target = settings.executor;
      if (
        check.executor &&
        (check.executor.name !== target.name ||
          check.executor.type !== (target.type ?? "ssh"))
      )
        throw new Error("Precheck target configuration changed");
      if (
        new CheckHandoffs(this.options.store, "precheck-observer").blocked(
          target.name,
        )
      )
        return;
      if (
        mergeCheckAttemptRunning(
          this.options.store,
          projectId,
          check.attempt_id,
        )
      )
        return;
      const assignment = this.owner(projectId, check);
      if (!assignment) {
        this.update(projectId, {
          ...check,
          status: "interrupted",
          summary: "负责人或卡片已失效",
        });
        return;
      }
      if (check.status === "running" && target.type !== "github") {
        this.update(projectId, {
          ...check,
          status: "interrupted",
          summary: "主机重启后原执行已结束，请重新 request_check",
        });
        return;
      }
      if (
        !this.options.git.checkHead ||
        !this.options.git.preparePrecheck ||
        !this.options.git.distribute ||
        !this.options.git.projectOf
      )
        throw new Error("No trusted Git adapter");
      stage = "读取分支HEAD";
      if (
        (await this.options.git.checkHead(projectId, assignment)) !==
        check.head_sha
      ) {
        this.update(projectId, {
          ...check,
          status: "interrupted",
          summary: "分支HEAD已改变，请重新 request_check",
        });
        return;
      }
      const distribute = this.options.git.distribute;
      const project = this.options.git.projectOf(projectId);
      if (!project) throw new Error("Missing project");
      slot = await this.options.reserve(settings);
      if (!slot || this.options.signal.aborted) return;
      const journal = new GithubDispatchJournal(this.options.store);
      if (target.type === "github") {
        const unfinished = journal
          .unfinished()
          .filter((i) => i.executor === target.name);
        if (
          unfinished.some(
            (i) =>
              i.project === projectId &&
              i.card === check.card_id &&
              i.attempt !== check.attempt_id,
          ) ||
          (!unfinished.some(
            (i) => i.attempt === check.attempt_id && i.project === projectId,
          ) &&
            unfinished.length >= target.maxConcurrent)
        )
          return;
      }
      // Admission and capacity are rechecked under the same SQLite write lock.
      release = acquireMergeCheckCapacity(
        this.options.store,
        projectId,
        check.attempt_id,
        undefined,
        target.name,
        undefined,
        target.maxConcurrent,
      );
      stage = "准备候选";
      const candidate =
        check.candidate_sha && check.base_sha && check.tree_sha
          ? {
              candidate_sha: check.candidate_sha,
              base_sha: check.base_sha,
              tree_sha: check.tree_sha,
            }
          : await this.options.git.preparePrecheck(
              project,
              check.assignment_id,
              check.head_sha,
              check.attempt_id,
            );
      check = {
        ...check,
        ...candidate,
        executor: { name: target.name, type: target.type ?? "ssh" },
      };
      if (check.status === "queued") this.update(projectId, check);
      if (this.options.signal.aborted) return;
      stage = "创建日志";
      log = await (this.options.createLog ?? createMergeCheckLog)({
        dataDir: this.options.execution.dataDir,
        project: projectId,
        attempt: check.attempt_id,
        env: settings.env,
        redactPaths: true,
        ...(target.type === "github"
          ? {
              resume: true,
              failureExcerptBytes: target.failureExcerptBytes ?? 4096,
            }
          : {}),
      });
      const execution =
        target.type === "github"
          ? this.options.execution
          : executorExecution(target, this.options.execution);
      let bound = check.external_run;
      const executor =
        target.type === "github"
          ? this.options.github(check, project, settings, (run) => {
              bound = run;
            })
          : (this.options.executor ??
            new SshCheckExecutor({
              execution,
              distribute: async () => {
                stage = "分发候选";
                await distribute(project, execution);
                if (
                  !this.owner(projectId, check) ||
                  this.options.signal.aborted
                )
                  throw new Error("Stale author check");
              },
              ...(this.options.run ? { run: this.options.run } : {}),
            }));
      stage = "执行检查";
      const result = await runCheckExecutor(
        executor,
        {
          kind: "precheck",
          project: projectId,
          attempt: check.attempt_id,
          sha: candidate.candidate_sha,
          tree: candidate.tree_sha,
          checks: settings.checks.map((s) => ({
            name: s.name,
            run: s.run,
            ...(s.timeoutMs !== undefined ? { timeoutMs: s.timeoutMs } : {}),
          })),
          env: settings.env,
          totalTimeoutMs: settings.totalTimeoutMs,
          serialize: true,
          lockSlot: slot.index,
          ...(target.type === "github"
            ? { hostSignal: this.options.signal }
            : { signal: this.options.signal }),
          onReady: (owner) => {
            release?.transfer(owner);
            if (check.status !== "running") {
              check = {
                ...check,
                status: "running",
                ...(bound ? { external_run: bound } : {}),
              };
              this.update(projectId, check);
            }
          },
          onRegistered: (binding) =>
            this.options.recovery.register(
              projectId,
              check.card_id,
              check.attempt_id,
              candidate.candidate_sha,
              binding,
              target,
            ),
          onOutput: (name, text) => log?.append(name, text),
        },
        (error) => this.options.onError(error),
      );
      stage = "保存日志";
      finishedLog = true;
      const saved = await log.finish(result);
      stage = "核对分支HEAD";
      const current = this.owner(projectId, check);
      const same =
        !!current &&
        (await this.options.git.checkHead(projectId, current)) ===
          check.head_sha;
      this.update(projectId, {
        ...check,
        ...(bound ? { external_run: bound } : {}),
        status: same ? saved.status : "interrupted",
        checks: saved.checks,
        summary: same
          ? saved.summary
          : "分支HEAD或负责人已变化，原结果不再有效",
        log_ref: saved.log_ref,
      });
    } catch (error) {
      if (
        error instanceof CheckAdmissionClosed ||
        error instanceof DeploymentInProgress
      )
        return;
      if (error instanceof CheckExecutorSuspended) return;
      if (error instanceof GithubRetryLater) {
        this.retry.set(check.attempt_id, error.retryAt);
        return;
      }
      const summary = `预检查环境故障（${stage}），请核对检查环境后重新 request_check`;
      try {
        this.options.onError(new Error(summary));
      } catch {}
      if (log && !finishedLog) {
        finishedLog = true;
        try {
          await log.finish({
            status: "failed",
            checks: [],
            cleanup_errors: [],
            reason: summary,
          });
        } catch {}
      }
      this.update(projectId, {
        ...check,
        status: this.owner(projectId, check)
          ? "environment_failed"
          : "interrupted",
        summary,
      });
    } finally {
      release?.();
      slot?.release();
    }
  }
}
