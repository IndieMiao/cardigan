import { isDeepStrictEqual } from "node:util";
import type { Assignment, Clock, Precheck, ProjectId } from "@cardigan/domain";
import {
  prechecks,
  recordPrecheck,
  validPrecheckSummary,
} from "@cardigan/domain";
import type { CentralProject } from "@cardigan/git-service";
import {
  centralBranch,
  PrecheckMergeConflict,
  RepositoryLockTimeoutError,
} from "@cardigan/git-service";
import {
  acquireMergeCheckCapacity,
  boundedCheckSummary,
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
  safeCheckDiagnostic,
} from "@cardigan/host";
import { loadCommandState, persistEffect } from "@cardigan/mcp-server";
import type { ExecutionConfig } from "@cardigan/runtime-herdr";
import {
  CheckAdmissionClosed,
  CheckHandoffs,
  type ReadRepositories,
  type Store,
} from "@cardigan/store";
import { recordCheckFlakes } from "./check-flake-ledger.js";

type Settings = Extract<ProjectMergeGate, { status: "enabled" }>;
/** An explicit rejection of the check evidence, not a failure to persist it. */
class PrecheckVerificationFailure extends Error {}

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
  private readonly pendingFailures = new Set<string>();
  private readonly retry = new Map<string, number>();
  private readonly active = new Map<string, Promise<void>>();
  /** C-783: business cancellation of an in-flight attempt a newer HEAD replaced. */
  private readonly cancels = new Map<string, AbortController>();
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
  private reportFailure(
    stage: string,
    error: unknown,
    env: Readonly<Record<string, string>>,
  ): string {
    const projected = boundedCheckSummary(
      `预检查环境故障（${stage}）：${safeCheckDiagnostic(error, env)}`,
    );
    const summary = validPrecheckSummary(projected)
      ? projected
      : "预检查环境故障（诊断内容已省略）";
    const safeError = new Error(summary);
    safeError.stack = summary;
    try {
      this.options.onError(safeError);
    } catch {
      /* Reporting cannot prevent the terminal record or capacity release. */
    }
    return summary;
  }
  private state(project: ProjectId) {
    return this.options.store.uow.read((tx) => loadCommandState(tx, project));
  }
  private proof(project: ProjectId, check: Precheck): Precheck | undefined {
    const row = this.options.store.database
      .prepare(`SELECT result FROM precheck_head_proofs
      WHERE project_id=? AND card_id=? AND attempt_id=?`)
      .get(project, check.card_id, check.attempt_id);
    return row ? (JSON.parse(String(row.result)) as Precheck) : undefined;
  }
  /** The indexed projection is updated by the same transaction as its system event. */
  private current(project: ProjectId, check: Precheck): Precheck | undefined {
    const row = this.options.store.database
      .prepare(`SELECT doc FROM check_recovery_attempts
      WHERE project_id=? AND card_id=? AND attempt_id=?`)
      .get(project, check.card_id, check.attempt_id);
    return row ? (JSON.parse(String(row.doc)) as Precheck) : undefined;
  }
  private async verify(project: ProjectId, result: Precheck) {
    // A superseded attempt needs no HEAD proof; update() only drops its checkpoint.
    const owner = this.superseded(project, result)
      ? undefined
      : this.owner(project, result);
    let same = false;
    if (owner) {
      if (!this.options.git.checkHead)
        throw new PrecheckVerificationFailure("No trusted Git adapter");
      try {
        same =
          (await this.options.git.checkHead(project, owner)) ===
          result.head_sha;
      } catch (error) {
        // Another tick (or controller after restart) retries only the proof.
        if (error instanceof RepositoryLockTimeoutError) return;
        throw new PrecheckVerificationFailure("Could not verify branch HEAD", {
          cause: error,
        });
      }
    }
    this.update(
      project,
      same
        ? result
        : {
            ...result,
            status: "interrupted",
            summary: "分支HEAD或负责人已变化，原结果不再有效",
          },
      true,
    );
  }
  /** request_check already settled this attempt for a newer HEAD (C-783). */
  private superseded(project: ProjectId, check: Precheck) {
    return !!this.current(project, check)?.superseded_by;
  }
  private cancelSuperseded(attempt: string) {
    this.cancels.get(attempt)?.abort();
  }
  private update(project: ProjectId, check: Precheck, verifyOwner = false) {
    const replaced = this.options.store.uow.run((tx) => {
      // C-783: never republish an attempt a newer HEAD replaced; drop any
      // private result checkpoint and let the executor be cancelled instead.
      if (this.superseded(project, check)) {
        this.options.store.database
          .prepare(`DELETE FROM precheck_head_proofs
          WHERE project_id=? AND card_id=? AND attempt_id=?`)
          .run(project, check.card_id, check.attempt_id);
        return true;
      }
      // A stale queue observer cannot interrupt/requeue a completed execution;
      // concurrent proof readers cannot publish a second terminal result.
      if (verifyOwner !== !!this.proof(project, check)) {
        if (["queued", "running"].includes(check.status))
          throw new CheckExecutorSuspended();
        return;
      }
      if (verifyOwner && !this.ownerIn(tx, project, check))
        check = {
          ...check,
          status: "interrupted",
          summary: "分支HEAD或负责人已变化，原结果不再有效",
        };
      const effect = recordPrecheck(
        loadCommandState(tx, project),
        { kind: "system", project_id: project },
        check,
        { ids: tx.ids, clock: this.options.clock },
      );
      if (!effect.ok)
        throw new PrecheckVerificationFailure(
          `Precheck record: ${effect.error.code}`,
        );
      persistEffect(tx, project, effect.value);
      if (!["queued", "running"].includes(check.status))
        this.options.store.database
          .prepare(`DELETE FROM precheck_head_proofs
          WHERE project_id=? AND card_id=? AND attempt_id=?`)
          .run(project, check.card_id, check.attempt_id);
      return false;
    });
    if (replaced) this.cancelSuperseded(check.attempt_id);
    // A terminal pre-dispatch failure has no remote run or unsettled publisher.
    if (
      check.executor?.type === "github" &&
      !["queued", "running"].includes(check.status)
    )
      new GithubDispatchJournal(this.options.store).reconcile([project], (id) =>
        this.options.configuration.forProject(id),
      );
  }
  private reportFixed(summary: string): void {
    const safeError = new Error(summary);
    safeError.stack = summary;
    try {
      this.options.onError(safeError);
    } catch {
      /* A broken reporter cannot resume execution. */
    }
  }
  /** Preserve a durable settlement intent before a terminal fallback can fail. */
  private settleFailure(project: ProjectId, check: Precheck): void {
    this.pendingFailures.add(check.attempt_id);
    // Reads may fail independently of writes; fence restart before reading state.
    try {
      this.options.store.uow.run((tx) => {
        const exists = tx.events
          .listAfter(project, check.card_id, 0)
          .some(
            (e) =>
              e.type === "precheck_settlement_pending" &&
              e.actor.kind === "system" &&
              (e.payload as { attempt_id?: string })?.attempt_id ===
                check.attempt_id,
          );
        if (!exists)
          tx.events.append(project, {
            id: tx.ids.nextEventId(),
            seq: tx.ids.nextEventSequence(project, check.card_id),
            card_id: check.card_id,
            type: "precheck_settlement_pending",
            actor: { kind: "system", project_id: project },
            payload: { attempt_id: check.attempt_id },
            created_at: this.options.clock.now(),
          });
      });
    } catch {
      this.reportFixed(
        "作者预检查终态保存意图暂时无法写入，保留收尾隔离，禁止重新执行检查",
      );
    }
    let fallback: Precheck;
    try {
      const persisted = prechecks(this.state(project).events).find(
        (c) => c.attempt_id === check.attempt_id,
      );
      if (!persisted || !["queued", "running"].includes(persisted.status)) {
        this.pendingFailures.delete(check.attempt_id);
        return;
      }
      fallback = {
        ...persisted,
        status: this.owner(project, persisted)
          ? "environment_failed"
          : "interrupted",
        summary:
          "预检查环境故障，诊断摘要无法保存；改用固定安全摘要，检查不会自动重新执行，请重新请求预检查",
      };
    } catch {
      this.reportFixed(
        "作者预检查收尾状态暂不可读，保留收尾隔离，禁止重新执行检查",
      );
      return;
    }
    try {
      this.update(project, fallback);
      this.pendingFailures.delete(check.attempt_id);
    } catch {
      this.reportFixed(
        "作者预检查固定终态保存失败，后续仅补记终态，不重新执行检查",
      );
    }
  }
  private finishFailure(project: ProjectId, check: Precheck): void {
    this.pendingFailures.add(check.attempt_id);
    try {
      this.update(project, {
        ...check,
        status: this.owner(project, check)
          ? "environment_failed"
          : "interrupted",
      });
      this.pendingFailures.delete(check.attempt_id);
    } catch {
      this.reportFixed(
        "作者预检查终态投影被拒或无法保存，改用固定安全摘要收尾",
      );
      this.settleFailure(project, check);
    }
  }
  private owner(project: ProjectId, check: Precheck) {
    return this.options.store.uow.read((tx) =>
      this.ownerIn(tx, project, check),
    );
  }
  private ownerIn(tx: ReadRepositories, project: ProjectId, check: Precheck) {
    const a = tx.assignments.get(project, check.assignment_id),
      item = tx.work_items.get(project, check.work_item_id),
      card = tx.cards.get(project, check.card_id);
    return a?.status === "active" &&
      a.scope === "work_item" &&
      a.work_item_id === item?.id &&
      item.assignment_id === a.id &&
      item.card_id === check.card_id &&
      item.status !== "cancelled" &&
      a.branch === check.branch &&
      a.machine_id === check.machine_id &&
      card &&
      !["done", "cancelled"].includes(card.status)
      ? a
      : undefined;
  }
  private held(project: ProjectId, check: Precheck) {
    if (check.status === "running" || check.external_run) return false;
    if (
      !this.options.store.uow.read(
        (tx) => tx.cards.get(project, check.card_id)?.hold,
      )
    )
      return false;
    return !new GithubDispatchJournal(this.options.store)
      .unfinished()
      .some(
        (i) =>
          i.project === project &&
          i.attempt === check.attempt_id &&
          i.phase === "dispatching",
      );
  }
  async schedule(projects: readonly ProjectId[]) {
    const started: Promise<void>[] = [];
    for (const project of projects)
      for (const check of prechecks(this.state(project).events)) {
        if (!["queued", "running"].includes(check.status)) {
          // A retry deadline is useful only while the attempt can run again.
          // Drop settled attempts, including ones settled by another process.
          this.retry.delete(check.attempt_id);
          // C-783: a newer HEAD replaced it; stop its executor and remote run now.
          if (check.superseded_by) this.cancelSuperseded(check.attempt_id);
          continue;
        }
        if (this.active.has(check.attempt_id) || this.options.signal.aborted)
          continue;
        if (
          this.pendingFailures.has(check.attempt_id) ||
          this.options.store.uow.read(() =>
            this.options.store.database
              .prepare(`SELECT 1 FROM events
              WHERE project_id=? AND type='precheck_settlement_pending'
              AND json_extract(doc,'$.actor.kind')='system'
              AND json_extract(doc,'$.payload.attempt_id')=? LIMIT 1`)
              .get(project, check.attempt_id),
          )
        ) {
          this.settleFailure(project, check);
          continue;
        }
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
  private recordMutexWait(
    project: ProjectId,
    check: Precheck,
    blocker: string,
  ): void {
    this.options.store.uow.run((tx) => {
      const events = tx.events.listAfter(project, check.card_id, 0);
      if (
        events.some(
          (e) =>
            e.type === "precheck_waiting" &&
            e.actor.kind === "system" &&
            (e.payload as { attempt_id?: string }).attempt_id ===
              check.attempt_id &&
            (e.payload as { blocking_attempt?: string }).blocking_attempt ===
              blocker,
        )
      )
        return;
      const reason = `等待同卡 GitHub 检查 ${blocker} 释放占用`;
      const seq = tx.ids.nextEventSequence(project, check.card_id),
        at = this.options.clock.now();
      tx.events.append(project, {
        id: tx.ids.nextEventId(),
        seq,
        card_id: check.card_id,
        type: "precheck_waiting",
        actor: { kind: "system", project_id: project },
        payload: {
          attempt_id: check.attempt_id,
          blocking_attempt: blocker,
          reason,
        },
        created_at: at,
      });
      const id = tx.ids.nextTimelineEntryId(project, check.card_id);
      tx.timeline.put(project, {
        id,
        short_id: id,
        card_id: check.card_id,
        event_seq: seq,
        type: "system",
        author: "system",
        refs: [],
        mentions: [],
        retracted: false,
        created_at: at,
        body: `作者预检查 ${check.attempt_id}：${reason}`,
      });
    });
  }
  private async execute(projectId: ProjectId, original: Precheck) {
    let check = original,
      stage = "配置",
      log: Awaited<ReturnType<typeof createMergeCheckLog>> | undefined;
    let slot: { index: number; release(): void } | undefined,
      release: ReturnType<typeof acquireMergeCheckCapacity> | undefined;
    // If the checkpoint cannot be read, neither dispatch nor settle a fallback.
    const pending = this.options.store.uow.read(() =>
      this.proof(projectId, check),
    );
    let finishedLog = false,
      verifying = !!pending;
    let errorEnv: Readonly<Record<string, string>> = {};
    const cancel = new AbortController();
    this.cancels.set(check.attempt_id, cancel);
    try {
      if (
        !pending &&
        (this.held(projectId, check) ||
          Date.parse(this.options.clock.now()) <
            (this.retry.get(check.attempt_id) ?? 0))
      )
        return;
      const settings = this.options.configuration.forProject(projectId);
      if (settings.status !== "enabled" || !settings.executor)
        throw new PrecheckVerificationFailure("No trusted remote executor");
      errorEnv = settings.env;
      const target = settings.executor;
      if (
        check.executor &&
        (check.executor.name !== target.name ||
          check.executor.type !== (target.type ?? "ssh"))
      )
        throw new PrecheckVerificationFailure(
          "Precheck target configuration changed",
        );
      if (pending) {
        stage = "核对分支HEAD";
        await this.verify(projectId, pending);
        return;
      }
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
      let head: string;
      try {
        head = await this.options.git.checkHead(projectId, assignment);
      } catch (error) {
        // No executor has been called. Leave this exact queued/running attempt
        // for the next scheduling pass (including bound work after restart).
        if (error instanceof RepositoryLockTimeoutError) return;
        throw error;
      }
      if (head !== check.head_sha) {
        this.update(projectId, {
          ...check,
          status: "interrupted",
          summary: "分支HEAD已改变，请重新 request_check",
        });
        return;
      }
      const distribute = this.options.git.distribute;
      const registered = this.options.git.projectOf(projectId);
      if (!registered) throw new Error("Missing project");
      // The candidate merges into the card's own baseline branch.
      const branch = this.options.store.uow.read(
        (tx) => tx.cards.get(projectId, check.card_id)?.base_branch,
      );
      const project = branch ? centralBranch(registered, branch) : registered;
      const journal = new GithubDispatchJournal(this.options.store);
      if (target.type === "github") {
        const admitted = journal.admitted();
        const unfinished = admitted.filter((i) => i.executor === target.name);
        const blocker = admitted.find(
          (i) =>
            i.project === projectId &&
            i.card === check.card_id &&
            i.attempt !== check.attempt_id,
        );
        if (blocker) {
          this.recordMutexWait(projectId, check, blocker.attempt);
          return;
        }
        if (
          !unfinished.some(
            (i) => i.attempt === check.attempt_id && i.project === projectId,
          ) &&
          unfinished.length >= target.maxConcurrent
        )
          return;
      }
      slot = await this.options.reserve(settings);
      if (!slot || this.options.signal.aborted) return;
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
      // Admission awaited a slot/HEAD. A different controller may have already
      // completed execution for our old queue snapshot and released its slot.
      if (
        this.options.store.uow.read(
          () =>
            this.proof(projectId, check) ||
            !isDeepStrictEqual(this.current(projectId, check), original),
        )
      )
        return;
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
      if (this.held(projectId, check)) return;
      if (check.status === "queued") this.update(projectId, check);
      if (this.options.signal.aborted || cancel.signal.aborted) return;
      stage = "创建日志";
      log = await (this.options.createLog ?? createMergeCheckLog)({
        dataDir: this.options.execution.dataDir,
        project: projectId,
        attempt: check.attempt_id,
        env: settings.env,
        redactPaths: true,
        // A queued attempt may have been held after creating its private log.
        resume: true,
        ...(target.type === "github"
          ? {
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
      if (this.held(projectId, check)) return;
      stage = "执行检查";
      const result = await runCheckExecutor(
        executor,
        {
          beforeDispatch: () => {
            if (
              cancel.signal.aborted ||
              this.superseded(projectId, check) ||
              !this.owner(projectId, check) ||
              this.held(projectId, check)
            )
              throw new CheckExecutorSuspended();
          },
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
          // Host shutdown only detaches GitHub supervision; supersession
          // cancels the run (C-783), as merge checks do for invalid tasks.
          ...(target.type === "github"
            ? { hostSignal: this.options.signal, signal: cancel.signal }
            : {
                signal: AbortSignal.any([this.options.signal, cancel.signal]),
              }),
          onReady: (owner) => {
            if (target.type !== "github") release?.transfer(owner);
            if (check.status !== "running") {
              check = {
                ...check,
                status: "running",
                ...(bound ? { external_run: bound } : {}),
              };
              this.update(projectId, check);
            }
            // Remote journal retains its slot through verified terminal/recovery.
            if (target.type === "github") release?.();
          },
          onProgress: (summary) => {
            if (this.owner(projectId, check))
              new GithubDispatchJournal(this.options.store).progress(
                projectId,
                check.card_id,
                check.attempt_id,
                summary,
                this.options.clock.now(),
              );
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
          resetFailureLog: (name) => log?.resetOutput(name),
          onOutput: (name, text) => log?.append(name, text),
        },
        (error) => this.options.onError(error),
      );
      stage = "保存日志";
      finishedLog = true;
      const saved = await log.finish(
        result,
        target.type === "github" ? bound : undefined,
        bound
          ? recordCheckFlakes(
              this.options.store,
              projectId,
              check.card_id,
              check.attempt_id,
              this.options.clock.now(),
              result.recovered,
            )
          : undefined,
      );
      const completed: Precheck = {
        ...check,
        ...(bound ? { external_run: bound } : {}),
        status: saved.status,
        checks: saved.checks,
        summary: saved.summary,
        log_ref: saved.log_ref,
      };
      // Save only the host's redacted structured result, never raw executor output.
      // The public status stays queued/running until recordPrecheck validates it.
      const recorded = this.options.store.uow.run(() => {
        const latest = this.current(projectId, check);
        if (!latest || !["queued", "running"].includes(latest.status))
          return false;
        return (
          this.options.store.database
            .prepare(`INSERT INTO precheck_head_proofs
          (project_id,card_id,attempt_id,result) VALUES (?,?,?,?)
          ON CONFLICT(project_id,card_id,attempt_id) DO NOTHING`)
            .run(
              projectId,
              check.card_id,
              check.attempt_id,
              JSON.stringify(completed),
            ).changes === 1
        );
      });
      release();
      release = undefined;
      slot.release();
      slot = undefined;
      if (recorded) {
        verifying = true;
        stage = "核对分支HEAD";
        await this.verify(projectId, completed);
      }
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
      if (verifying && !(error instanceof PrecheckVerificationFailure)) {
        // A rolled-back transaction says nothing about the saved check result.
        // Keep it private and repeat the owner and HEAD proof on the next pass.
        this.reportFixed(
          "作者预检查结果暂未能核验入库，下轮重新核验，不重跑检查",
        );
        return;
      }
      const primaryDiagnostic = this.reportFailure(
        stage,
        error instanceof PrecheckVerificationFailure
          ? (error.cause ?? error)
          : error,
        errorEnv,
      );
      const diagnostics = [primaryDiagnostic];
      if (log && !finishedLog) {
        finishedLog = true;
        try {
          await log.finish({
            status: "failed",
            checks: [],
            cleanup_errors: [],
            reason: primaryDiagnostic,
          });
        } catch (logError) {
          diagnostics.push(this.reportFailure("保存日志", logError, errorEnv));
        }
      }
      const summary = boundedCheckSummary(...diagnostics);
      if (verifying) {
        // Still require the checkpoint when publishing a proof failure: a
        // different verifier may already have settled it. A write fault leaves
        // the checkpoint intact for the next pass, never eligible to dispatch.
        this.update(
          projectId,
          { ...check, status: "environment_failed", summary },
          true,
        );
        return;
      }
      this.finishFailure(projectId, {
        ...check,
        summary,
        ...(stage === "准备候选" && error instanceof PrecheckMergeConflict
          ? {
              failure_kind: "candidate_conflict" as const,
              base_sha: error.baseSha,
            }
          : {}),
      });
    } finally {
      if (this.cancels.get(check.attempt_id) === cancel)
        this.cancels.delete(check.attempt_id);
      release?.();
      slot?.release();
    }
  }
}
