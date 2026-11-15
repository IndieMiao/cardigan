import { randomUUID } from "node:crypto";
import type { ProjectId } from "@cardigan/domain";
import type { CentralProject } from "@cardigan/git-service";
import {
  acquireMergeCheckCapacity,
  checkTargetIdle,
  createMergeCheckLog,
  executionOwner,
  executorExecution,
  LOCAL_EXECUTOR,
  type MergeGateConfiguration,
  type ProjectMergeGate,
  runInTemporaryCheckout,
  withCheckoutDeadline,
} from "@cardigan/host";
import type { ExecutionConfig } from "@cardigan/runtime-herdr";
import {
  assertCheckAdmission,
  type CheckGrant,
  CheckHandoffs,
  type Store,
} from "@cardigan/store";
import {
  type CheckApproval,
  type CheckArtifact,
  type CheckCandidate,
  digest,
} from "./check-handoff-artifact.js";
import {
  type HandoffDiagnostic,
  HandoffFailure,
  type HandoffStage,
  handoffFailure,
  stageFailure,
} from "./check-handoff-diagnostics.js";

export interface HandoffGit {
  projectOf(project: ProjectId): CentralProject | undefined;
  verifyCheckCandidate(
    project: CentralProject,
    candidate: CheckCandidate,
  ): Promise<void>;
  distribute(
    project: CentralProject,
    execution: ExecutionConfig,
  ): Promise<void>;
}
export interface HandoffOptions {
  store: Store;
  git: HandoffGit;
  execution: ExecutionConfig;
  configuration: MergeGateConfiguration;
  freshConfiguration: () => Promise<MergeGateConfiguration>;
  approval: () => Promise<CheckApproval>;
  artifact: () => Promise<CheckArtifact>;
  startupArtifact: CheckArtifact | undefined;
  probe?: typeof checkTargetIdle;
  run?: typeof runInTemporaryCheckout;
}
export interface HandoffRequest {
  action: "begin" | "status" | "measure" | "stop" | "resume";
  project: string;
  generation?: number;
  width?: number;
}

/** The production controller owns admission; the measurement assembly has no publication port or domain commands. */
export class CheckHandoffController {
  readonly facts: CheckHandoffs;
  private readonly active = new Map<
    string,
    { abort: AbortController; done: Promise<unknown> }
  >();
  private stopped = false;
  private readonly runningConfiguration: ReadonlyMap<string, ProjectMergeGate>;
  constructor(private readonly options: HandoffOptions) {
    this.facts = new CheckHandoffs(options.store, randomUUID());
    this.runningConfiguration = new Map(
      options.store
        .listProjects()
        .map((project) => [
          project.id,
          structuredClone(options.configuration.forProject(project.id)),
        ]),
    );
  }
  private async binding(project: string) {
    if (this.stopped) throw new Error("移交控制器已停止");
    if (!this.options.startupArtifact)
      throw new HandoffFailure({
        code: "artifact_unavailable",
        stage: "approval",
        recovery: "repair_artifact_then_restart_controller",
      });
    const approval = await this.options.approval();
    const artifact = await this.options.artifact();
    if (
      approval.project_id !== project ||
      digest(artifact) !== digest(this.options.startupArtifact) ||
      approval.software_sha !== artifact.software_sha ||
      approval.artifact_sha256 !== artifact.artifact_sha256
    )
      throw new Error("移交批准或运行制品已改变");
    const original =
      this.runningConfiguration.get(project) ??
      this.options.configuration.forProject(project);
    const fresh = await this.options.freshConfiguration();
    const settings = fresh.forProject(project);
    if (settings.status !== "enabled" || digest(original) !== digest(settings))
      throw new Error("可信检查配置已改变");
    const target = settings.executor?.name ?? LOCAL_EXECUTOR;
    if (target !== approval.target) throw new Error("批准目标不匹配");
    const execution = settings.executor
      ? executorExecution(settings.executor, this.options.execution)
      : this.options.execution;
    const namespace = (e: ExecutionConfig) =>
      digest(
        e.mode === "local"
          ? { mode: e.mode, root: e.dataDir }
          : {
              mode: e.mode,
              host: e.host ?? "localhost",
              port: e.port ?? 22,
              user: e.user ?? "agent",
              root: e.agentRoot,
            },
      );
    const related = (settings: ProjectMergeGate) =>
      settings.status === "enabled" &&
      ((settings.executor?.name ?? LOCAL_EXECUTOR) === target ||
        namespace(
          settings.executor
            ? executorExecution(settings.executor, this.options.execution)
            : this.options.execution,
        ) === namespace(execution));
    const projects = new Set([
      ...this.runningConfiguration.keys(),
      ...this.options.store.listProjects().map((p) => p.id),
    ]);
    for (const id of projects) {
      const running =
        this.runningConfiguration.get(id) ??
        this.options.configuration.forProject(id);
      const current = fresh.forProject(id);
      // Disk configuration never retires a producer still using the running snapshot.
      if (
        (related(running) || related(current)) &&
        digest(running) !== digest(current)
      )
        throw new Error("原锁空间相关的检查配置已改变，拒绝移交");
      if (
        related(running) &&
        running.status === "enabled" &&
        (running.executor?.name ?? LOCAL_EXECUTOR) !== target
      )
        throw new Error("同一原锁空间存在其它名称的检查生产者，拒绝移交");
    }
    const central = this.options.git.projectOf(project as ProjectId);
    if (!central) throw new Error("项目仓库未登记");
    // Persist only a digest: neither environment values nor connection configuration enter the handoff table.
    return {
      approval,
      settings,
      target,
      execution,
      central,
      slots: settings.executor?.maxConcurrent ?? 1,
      hash: digest({ approval, settings, execution, central }),
    };
  }
  private row(project: string, generation?: number) {
    const rows = this.options.store.database
      .prepare(
        "SELECT target FROM check_handoff WHERE project_id=? ORDER BY (phase <> 'open') DESC, generation DESC",
      )
      .all(project);
    const first = rows[0];
    if (!first) throw new Error("没有移交记录");
    if (generation === undefined || !Number.isSafeInteger(generation))
      throw new Error("必须指定当前代次");
    return this.facts.current(project, String(first.target), generation);
  }
  /** A live reservation includes pre-ready preparation; dead rows require the same exact target proof. */
  private reservations(target: string, clearDead = false): void {
    const rows = this.options.store.database
      .prepare("SELECT * FROM merge_check_capacity WHERE machine_id=?")
      .all(target);
    for (const row of rows) {
      const owner = executionOwner(Number(row.owner_pid));
      if (owner?.start === row.owner_start)
        throw new Error("原检查仍在执行或准备");
      if (clearDead)
        this.options.store.database
          .prepare(
            "DELETE FROM merge_check_capacity WHERE project_id=? AND attempt_id=? AND owner_pid=? AND owner_start=?",
          )
          .run(
            String(row.project_id),
            String(row.attempt_id),
            Number(row.owner_pid),
            String(row.owner_start),
          );
    }
  }
  async request(
    request: HandoffRequest,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.stopped) throw new Error("移交控制器已停止");
    const { project, action } = request;
    if (action === "begin") {
      const b = await this.binding(project);
      return this.facts.begin(project, b.target, b.hash);
    }
    if (action === "status") {
      const rows: unknown[] = this.options.store.database
        .prepare(
          "SELECT project_id,target,generation,phase,binding FROM check_handoff WHERE project_id=?",
        )
        .all(project);
      if (!this.options.startupArtifact)
        rows.unshift({
          project_id: project,
          phase: "unavailable",
          diagnostic: {
            code: "artifact_unavailable",
            recovery: "repair_artifact_then_restart_controller",
          },
        });
      return rows;
    }
    const row = this.row(project, request.generation);
    const running = this.active.get(row.target);
    if (action === "stop") {
      running?.abort.abort();
      await running?.done.catch(() => {});
      if (row.phase !== "open")
        this.facts.hold(project, row.target, row.generation, "operator_stop");
      return this.facts.read(project, row.target);
    }
    if (action === "resume") {
      if (running) throw new Error("本次测量尚未精确结束");
      if (row.phase === "open") return row;
      const b = await this.binding(project);
      if (b.target !== row.target || b.hash !== row.binding)
        throw new Error("恢复对象已改变");
      this.options.store.uow.read(() => this.reservations(row.target));
      await (this.options.probe ?? checkTargetIdle)(b.execution, b.slots);
      // Re-read current approval after the asynchronous proof, then atomically clear only dead rows and reopen.
      if ((await this.binding(project)).hash !== row.binding)
        throw new Error("恢复依据已改变");
      return this.facts.resume(
        project,
        row.target,
        row.generation,
        "original_slots+containers+aliases+git_registry_idle",
        () => this.reservations(row.target, true),
      );
    }
    if (action !== "measure" || running || row.phase !== "draining")
      throw new Error("不可重复领取移交");
    const abort = new AbortController();
    const stop = () => abort.abort();
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    // Register BEFORE any await: stop/disconnect cannot miss the preparation window.
    const entry = { abort, done: Promise.resolve<unknown>(undefined) };
    this.active.set(row.target, entry);
    entry.done = this.measure(
      project,
      row.target,
      row.generation,
      row.binding,
      abort,
      request.width ?? 1,
    ).finally(() => {
      signal?.removeEventListener("abort", stop);
      this.active.delete(row.target);
    });
    return entry.done;
  }
  private async measure(
    project: string,
    target: string,
    generation: number,
    binding: string,
    abort: AbortController,
    width: number,
  ) {
    const signal = abort.signal;
    const reports: unknown[] = [];
    let grant: CheckGrant | undefined;
    let stage: HandoffStage = "approval";
    let failure: HandoffDiagnostic | undefined;
    const attempts: {
      attempt: string;
      stage: HandoffStage;
      log_ref?: string;
      code?: HandoffDiagnostic["code"];
      log_failed?: boolean;
      ready?: boolean;
    }[] = [];
    try {
      const b = await this.binding(project);
      if (b.hash !== binding || b.target !== target)
        throw new Error("移交对象已改变");
      if (
        !Number.isSafeInteger(width) ||
        width < 1 ||
        width > b.slots ||
        width > b.approval.candidates.length
      )
        throw new Error("测量宽度超出原有目标容量或固定候选数量");
      stage = "drain";
      this.options.store.uow.read(() => this.reservations(target));
      await (this.options.probe ?? checkTargetIdle)(b.execution, b.slots);
      if (signal.aborted || (await this.binding(project)).hash !== binding)
        throw new Error("移交已停止或批准失效");
      stage = "claim";
      grant = this.facts.claim(
        project,
        target,
        generation,
        binding,
        randomUUID(),
        () => this.reservations(target, true),
      );
      const execute = async (candidate: CheckCandidate, slot: number) => {
        const attempt = `measurement-${randomUUID()}`;
        const evidence: (typeof attempts)[number] = { attempt, stage: "log" };
        attempts.push(evidence);
        this.facts.recordAttempt(
          project,
          target,
          generation,
          "attempt_started",
          JSON.stringify({ ...evidence, candidate }),
        );
        let log: Awaited<ReturnType<typeof createMergeCheckLog>> | undefined;
        let finalized = false,
          recorded = false;
        let release: ReturnType<typeof acquireMergeCheckCapacity> | undefined;
        const progress = (next: HandoffStage) => {
          evidence.stage = next;
          this.facts.recordAttempt(
            project,
            target,
            generation,
            "attempt_progress",
            JSON.stringify(evidence),
          );
        };
        try {
          log = await createMergeCheckLog({
            dataDir: this.options.execution.dataDir,
            project,
            attempt,
            env: b.settings.env,
          });
          evidence.log_ref = log.log_ref;
          progress("approval");
          if (signal.aborted || (await this.binding(project)).hash !== binding)
            throw new Error("停止加量");
          progress("candidate");
          await this.options.git.verifyCheckCandidate(b.central, candidate);
          progress("capacity");
          release = acquireMergeCheckCapacity(
            this.options.store,
            project as ProjectId,
            attempt,
            undefined,
            target,
            grant,
          );
          progress("distribution");
          if (signal.aborted || (await this.binding(project)).hash !== binding)
            throw new Error("分发前批准失效");
          this.options.store.uow.read(() =>
            assertCheckAdmission(this.options.store, project, target, grant),
          );
          await this.options.git.distribute(b.central, b.execution);
          progress("candidate");
          await this.options.git.verifyCheckCandidate(b.central, candidate);
          progress("approval");
          if (signal.aborted || (await this.binding(project)).hash !== binding)
            throw new Error("执行前批准失效");
          this.options.store.uow.read(() =>
            assertCheckAdmission(this.options.store, project, target, grant),
          );
          progress("execution");
          const result = await withCheckoutDeadline(
            {
              execution: b.execution,
              project,
              attempt,
              sha: candidate.sha,
              tree: candidate.tree,
              checks: b.settings.checks,
              env: b.settings.env,
              totalTimeoutMs: b.settings.totalTimeoutMs,
              serialize: true,
              lockSlot: slot,
              signal,
              onReady: (owner) => {
                if (signal.aborted) throw new Error("测量已停止");
                this.options.store.uow.read(() =>
                  assertCheckAdmission(
                    this.options.store,
                    project,
                    target,
                    grant,
                  ),
                );
                release?.transfer(owner);
                evidence.ready = true;
                progress("execution");
              },
              onOutput: (name, text) => log?.append(name, text),
            },
            this.options.run ?? runInTemporaryCheckout,
          );
          evidence.stage = "result";
          this.options.store.uow.read(() =>
            assertCheckAdmission(this.options.store, project, target, grant),
          );
          const resultFailure: HandoffDiagnostic | undefined =
            result.cleanup_errors.length || result.manual_attention
              ? { code: "cleanup_unconfirmed", stage: "cleanup" }
              : signal.aborted || result.status === "interrupted"
                ? { code: "measurement_stopped", stage: "result" }
                : result.status !== "passed"
                  ? { code: "checks_failed", stage: "result" }
                  : undefined;
          evidence.stage = "log";
          finalized = true;
          const finished = await log.finish(result);
          evidence.stage = resultFailure?.stage ?? "result";
          if (resultFailure) evidence.code = resultFailure.code;
          reports.push({
            candidate,
            attempt,
            ...finished,
            ...(resultFailure
              ? {
                  diagnostic: {
                    ...resultFailure,
                    attempt,
                    log_ref: log.log_ref,
                  },
                }
              : {}),
          });
          this.facts.recordAttempt(
            project,
            target,
            generation,
            "attempt_finished",
            JSON.stringify({ ...evidence, status: result.status }),
          );
          recorded = true;
          if (resultFailure)
            throw new HandoffFailure({
              ...resultFailure,
              attempt,
              log_ref: log.log_ref,
            });
        } catch (error) {
          let diagnostic = {
            ...handoffFailure(
              error,
              stageFailure(evidence.stage, signal.aborted),
            ).diagnostic,
            attempt,
            ...(log ? { log_ref: log.log_ref } : {}),
          };
          if (log && !finalized) {
            finalized = true;
            try {
              await log.finish({
                status: signal.aborted ? "interrupted" : "failed",
                checks: [],
                cleanup_errors:
                  diagnostic.code === "execution_exit_unconfirmed"
                    ? ["退出及原资源清理尚未确认"]
                    : [],
                reason: `measurement_failure:${diagnostic.code}; stage:${diagnostic.stage}`,
              });
            } catch {
              diagnostic = { ...diagnostic, log_failed: true };
            }
          } else if (evidence.stage === "log")
            diagnostic = { ...diagnostic, log_failed: true };
          if (!recorded) {
            Object.assign(evidence, diagnostic);
            reports.push({ candidate, attempt, diagnostic });
            this.facts.recordAttempt(
              project,
              target,
              generation,
              "attempt_finished",
              JSON.stringify(evidence),
            );
          }
          throw new HandoffFailure(diagnostic);
        } finally {
          release?.();
        }
      };
      // Isolated measurement only; production retains its original serial project lane.
      // Every worker uses a DIFFERENT ORIGINAL slot, bounded by the unchanged trusted target limit.
      let next = 0;
      const workers = Array.from({ length: width }, async (_, slot) => {
        try {
          while (!signal.aborted) {
            const candidate = b.approval.candidates[next++];
            if (!candidate) return;
            await execute(candidate, slot);
          }
          throw new Error("测量已停止");
        } catch (error) {
          abort.abort();
          throw error;
        }
      });
      const settled = await Promise.allSettled(workers);
      const failed =
        settled.find(
          (entry) =>
            entry.status === "rejected" &&
            handoffFailure(entry.reason).diagnostic.code !==
              "measurement_stopped",
        ) ?? settled.find((entry) => entry.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
      stage = "cleanup";
      await (this.options.probe ?? checkTargetIdle)(b.execution, b.slots);
      return {
        mode: "controlled-measurement",
        generation,
        width,
        reports,
        publication: "structurally_unavailable",
        restored: false,
      };
    } catch (error) {
      const classified = handoffFailure(
        error,
        stageFailure(stage, signal.aborted),
      );
      failure = classified.diagnostic;
      throw classified;
    } finally {
      // Never reopen here: disconnects, exceptions, SIGKILL and restart all leave admission closed.
      this.facts.hold(
        project,
        target,
        generation,
        JSON.stringify({
          grant: !!grant,
          attempts: attempts.length,
          attempt_evidence: attempts,
          ...(failure ? { failure } : {}),
          reason: "explicit_resume_required",
          publication: "not_exposed",
          legacy_merge: "not_exposed",
        }),
      );
    }
  }
  async close(): Promise<void> {
    this.stopped = true;
    for (const entry of this.active.values()) entry.abort.abort();
    await Promise.allSettled(
      [...this.active.values()].map((entry) => entry.done),
    );
  }
}
