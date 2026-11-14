import { randomUUID } from "node:crypto";
import type {
  Clock,
  CommandEffect,
  CommandPorts,
  CommandState,
  Delivery,
  DeliveryPrecheck,
  ProjectId,
  Result,
} from "@cardigan/domain";
import {
  latestDeliveryPrecheck,
  recordDeliveryPrecheck,
  recordMergeExecutor,
  retryDeliveryPrecheck,
  settleDeliveryPrecheck,
} from "@cardigan/domain";
import type { CentralProject } from "@cardigan/git-service";
import {
  acquireMergeCheckCapacity,
  classifyExecutorFailure,
  createMergeCheckLog,
  DeploymentInProgress,
  executorExecution,
  MergeCheckCapacityFull,
  type MergeGateConfiguration,
  mergeCheckAttemptRunning,
  mergeCheckCapacityAvailable,
  type ProjectMergeGate,
  runInTemporaryCheckout,
  safeCheckDiagnostic,
  withCheckoutDeadline,
} from "@cardigan/host";
import { loadCommandState, persistEffect } from "@cardigan/mcp-server";
import type { ExecutionConfig } from "@cardigan/runtime-herdr";
import type { Store } from "@cardigan/store";

type Settings = Extract<ProjectMergeGate, { status: "enabled" }>;
type Lease = { index: number; release: () => void };
const stages = {
  schedule: "调度",
  capacity: "预留执行容量",
  baseline: "读取基线",
  delivery_tree: "读取交付树",
  bind_attempt: "登记执行目标",
  create_log: "创建日志",
  distribute: "分发交付",
  run: "运行检查",
  finish_log: "保存日志",
  record_result: "保存检查结果",
} as const;
interface PrecheckGit {
  projectOf(id: ProjectId): CentralProject | undefined;
  baseline?(project: CentralProject): Promise<string>;
  deliveryTree?(project: CentralProject, sha: string): Promise<string>;
  distribute?(
    project: CentralProject,
    execution?: ExecutionConfig,
  ): Promise<void>;
}

/** Independent background work; the owner provides the same slots used by merges. */
export class DeliveryPrechecks {
  private readonly active = new Map<string, Promise<void>>();
  constructor(
    private readonly options: {
      store: Store;
      clock: Clock;
      configuration: MergeGateConfiguration;
      execution: ExecutionConfig;
      git: PrecheckGit;
      run?: typeof runInTemporaryCheckout;
      createLog?: typeof createMergeCheckLog;
      signal: AbortSignal;
      reserve: (settings: Settings) => Promise<Lease | undefined>;
      onError: (error: unknown) => void;
    },
  ) {}
  private reportFailure(
    stage: keyof typeof stages,
    error: unknown,
    env: Readonly<Record<string, string>>,
  ): string {
    const summary = `预检查${stages[stage]}失败：${safeCheckDiagnostic(error, env)}`;
    const safeError = new Error(summary);
    // Raw causes and Error stacks may contain credentials, commands or host paths.
    safeError.stack = summary;
    try {
      this.options.onError(safeError);
    } catch {
      // An error reporter cannot prevent capacity release or durable failure recording.
    }
    return summary;
  }
  private state(project: ProjectId) {
    return this.options.store.uow.read((tx) => loadCommandState(tx, project));
  }
  private command<T>(
    project: ProjectId,
    reduce: (s: CommandState, p: CommandPorts) => Result<CommandEffect<T>>,
  ): T {
    return this.options.store.uow.run((tx) => {
      const r = reduce(loadCommandState(tx, project), {
        ids: tx.ids,
        clock: this.options.clock,
      });
      if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
      persistEffect(tx, project, r.value);
      return r.value.data;
    });
  }
  private update(project: ProjectId, value: DeliveryPrecheck) {
    return this.command(project, (s, p) =>
      recordDeliveryPrecheck(
        s,
        { kind: "system", project_id: project },
        value,
        p,
      ),
    );
  }
  private current(project: ProjectId, delivery: Delivery) {
    return this.currentIn(this.state(project), delivery);
  }
  private currentIn(s: CommandState, delivery: Delivery) {
    return (
      s.deliveries.some(
        (d) => d.id === delivery.id && d.status !== "superseded",
      ) &&
      s.work_items.some(
        (w) =>
          w.id === delivery.work_item_id &&
          w.status !== "cancelled" &&
          s.cards.some(
            (c) =>
              c.id === w.card_id &&
              !["done", "cancelled", "awaiting_merge"].includes(c.status),
          ),
      )
    );
  }
  private settle(project: ProjectId, delivery: Delivery, attempt: string) {
    return this.command(project, (s, p) =>
      settleDeliveryPrecheck(
        s,
        { kind: "system", project_id: project },
        { delivery_id: delivery.id, attempt_id: attempt },
        p,
      ),
    );
  }
  private executor(
    project: ProjectId,
    name: string,
    status: "poll" | "reachable" | "unreachable",
    attempt?: string,
  ) {
    return this.command(project, (s, p) =>
      recordMergeExecutor(
        s,
        { kind: "system", project_id: project },
        status === "unreachable"
          ? { executor: name, status, attempt_id: attempt ?? "missing-attempt" }
          : { executor: name, status },
        p,
      ),
    );
  }
  async schedule(projects: readonly ProjectId[]) {
    const started: Promise<void>[] = [];
    for (const id of projects) {
      if (this.options.signal.aborted) break;
      // One precheck per project, independent of the merge project's lane.
      if (this.active.has(id)) continue;
      const s = this.state(id);
      for (const old of s.deliveries) {
        if (this.currentIn(s, old)) continue;
        const check = latestDeliveryPrecheck(s.events, old);
        if (
          check?.attempt_id &&
          ["queued", "running"].includes(check.status) &&
          !mergeCheckAttemptRunning(this.options.store, id, check.attempt_id)
        )
          this.settle(id, old, check.attempt_id);
      }
      const delivery = s.deliveries.find(
        (d) =>
          this.currentIn(s, d) &&
          d.kind !== "card_completion" &&
          ["queued", "running", "interrupted", "executor_unreachable"].includes(
            latestDeliveryPrecheck(s.events, d)?.status ?? "",
          ),
      );
      if (!delivery) continue;
      const work = this.process(id, delivery)
        .catch((e) => {
          const settings = this.options.configuration.forProject(id);
          this.reportFailure(
            "schedule",
            e,
            settings.status === "enabled" ? settings.env : {},
          );
        })
        .finally(() => this.active.delete(id));
      this.active.set(id, work);
      started.push(work);
    }
    return { done: Promise.all(started).then(() => {}) };
  }
  async idle() {
    await Promise.all(this.active.values());
  }
  private async process(id: ProjectId, delivery: Delivery) {
    const requested = latestDeliveryPrecheck(this.state(id).events, delivery);
    if (!requested) return;
    let check: DeliveryPrecheck = requested;
    const settings = this.options.configuration.forProject(id);
    const project = this.options.git.projectOf(id);
    if (
      settings.status !== "enabled" ||
      !settings.executor ||
      !project ||
      delivery.subject.kind !== "git_head" ||
      !this.options.git.deliveryTree ||
      !this.options.git.baseline ||
      !this.options.git.distribute
    ) {
      if (check.status === "queued")
        this.update(id, {
          ...check,
          status: "environment_failed",
          checks: [],
          summary:
            "预检查需要有效远程检查配置、项目仓库及 Git 交付；等待修复环境后重新请求",
        });
      return;
    }
    const executor = settings.executor;
    const outage = this.executor(id, executor.name, "poll");
    if (
      outage &&
      Date.parse(outage.next_retry_at) > Date.parse(this.options.clock.now())
    )
      return;
    // Existing executor occupancy includes live supervisors from a previous controller.
    if (
      !mergeCheckCapacityAvailable(
        this.options.store,
        executor.name,
        executor.maxConcurrent,
      )
    )
      return;
    if (
      check.attempt_id &&
      mergeCheckAttemptRunning(this.options.store, id, check.attempt_id)
    )
      return;
    if (check.attempt_id && ["queued", "running"].includes(check.status)) {
      check = this.update(id, {
        ...check,
        status: "interrupted",
        checks: [],
        summary: "主机恢复，旧预检查执行已中断",
      });
    }
    if (["interrupted", "executor_unreachable"].includes(check.status)) {
      check = this.command(id, (s, p) =>
        retryDeliveryPrecheck(
          s,
          { kind: "system", project_id: id },
          { delivery_id: delivery.id },
          p,
        ),
      );
    }
    if (check.status !== "queued" || this.options.signal.aborted) return;
    const slot = await this.options.reserve(settings);
    if (!slot) return;
    const attempt = randomUUID();
    let release: ReturnType<typeof acquireMergeCheckCapacity> | undefined;
    let log: Awaited<ReturnType<typeof createMergeCheckLog>> | undefined;
    let logFinished = false;
    let stage: keyof typeof stages = "capacity";
    try {
      // Atomic check/reservation, also respecting deployment and other controllers.
      release = acquireMergeCheckCapacity(
        this.options.store,
        id,
        attempt,
        undefined,
        executor.name,
        executor.maxConcurrent,
      );
      if (!release || !this.current(id, delivery)) return;
      stage = "baseline";
      const base = await this.options.git.baseline(project);
      stage = "delivery_tree";
      const tree = await this.options.git.deliveryTree(
        project,
        delivery.subject.value,
      );
      if (!this.current(id, delivery)) return;
      stage = "bind_attempt";
      check = this.update(id, {
        ...check,
        attempt_id: attempt,
        candidate_sha: delivery.subject.value,
        tree_sha: tree,
        base_sha: base,
      });
      stage = "create_log";
      log = await (this.options.createLog ?? createMergeCheckLog)({
        dataDir: this.options.execution.dataDir,
        project: id,
        attempt,
        env: settings.env,
        redactPaths: true,
      });
      const execution = executorExecution(executor, this.options.execution);
      stage = "distribute";
      await this.options.git.distribute(project, execution);
      if (!this.current(id, delivery) || this.options.signal.aborted) return;
      stage = "run";
      const result = await withCheckoutDeadline(
        {
          execution,
          project: id,
          attempt,
          sha: delivery.subject.value,
          tree,
          checks: settings.checks.map((c) => ({
            name: c.name,
            run: c.run,
            ...(c.scope === "affected" ? { affectedPaths: [] } : {}),
            ...(c.timeoutMs === undefined ? {} : { timeoutMs: c.timeoutMs }),
          })),
          env: settings.env,
          totalTimeoutMs: settings.totalTimeoutMs,
          serialize: true,
          lockSlot: slot.index,
          signal: this.options.signal,
          onReady: (owner) => {
            release?.transfer(owner);
            this.executor(id, executor.name, "reachable");
            if (this.current(id, delivery))
              check = this.update(id, { ...check, status: "running" });
          },
          onOutput: (name, text) => log?.append(name, text),
        },
        this.options.run ?? runInTemporaryCheckout,
      );
      stage = "finish_log";
      logFinished = true;
      const finished = await log.finish(result);
      if (!this.current(id, delivery)) return;
      const status =
        result.status === "failed" &&
        !result.checks.some((c) => c.status === "failed")
          ? "environment_failed"
          : result.status;
      stage = "record_result";
      this.update(id, {
        ...check,
        status,
        checks: finished.checks,
        summary: finished.summary,
        log_ref: finished.log_ref,
        timeout_only: finished.timeout_only,
      });
      if (status === "executor_unreachable")
        this.executor(id, executor.name, "unreachable", attempt);
    } catch (error) {
      if (
        error instanceof MergeCheckCapacityFull ||
        error instanceof DeploymentInProgress
      )
        return;
      let summary = this.reportFailure(stage, error, settings.env);
      if (!this.current(id, delivery)) return;
      let status:
        | "environment_failed"
        | "interrupted"
        | "executor_unreachable" =
        stage === "finish_log"
          ? "environment_failed"
          : this.options.signal.aborted
            ? "interrupted"
            : classifyExecutorFailure(error) === "executor_unreachable"
              ? "executor_unreachable"
              : "environment_failed";
      const result: Parameters<NonNullable<typeof log>["finish"]>[0] = {
        status: status === "environment_failed" ? ("failed" as const) : status,
        checks: [],
        cleanup_errors: [],
        reason: summary,
      };
      let finished:
        | Awaited<ReturnType<NonNullable<typeof log>["finish"]>>
        | undefined;
      if (log && !logFinished) {
        logFinished = true;
        try {
          finished = await log.finish(result);
        } catch (logError) {
          // Preserve the primary diagnosis even when recording its log also fails.
          status = "environment_failed";
          this.reportFailure("finish_log", logError, settings.env);
          summary += "\n预检查保存日志失败（诊断已单独上报）";
        }
      }
      this.update(id, {
        ...check,
        status,
        checks: [],
        summary,
        ...(finished ? { log_ref: finished.log_ref } : {}),
      });
      if (status === "executor_unreachable")
        this.executor(
          id,
          executor.name,
          "unreachable",
          check.attempt_id ?? randomUUID(),
        );
    } finally {
      try {
        if (check.attempt_id && !this.current(id, delivery))
          this.settle(id, delivery, check.attempt_id);
      } finally {
        release?.();
        slot.release();
      }
    }
  }
}
