import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  countDeploymentOperations,
  type DeploymentDriver,
  type DeploymentOperation,
  type DeploymentReadyRetry,
  type DeploymentRecord,
} from "@cardigan/domain";

/** Fatal to the supervisor: its host service manager must recover the server. */
export class DeploymentServerUnavailable extends Error {
  constructor() {
    super("主机 server 已退出或无法确认，监督器退出，请核对主机服务恢复记录");
  }
}

/** C-609: how often the post-build wait re-reads the operation registry. */
export const OPERATION_POLL_MS = 5_000;

const KIND_LABELS: Readonly<Record<string, string>> = {
  mobile_signing: "受管送签",
  artifact_publication: "测试包外发",
  worker_upgrade: "worker 升级",
};

/**
 * Per-kind counts only: the deployment project's record never names another
 * project or card. Each source card gets its own detailed note.
 */
const operationSummary = (ops: readonly DeploymentOperation[]) =>
  countDeploymentOperations(ops)
    .map(
      ({ kind, count }) => `${KIND_LABELS[kind] ?? "其它长操作"} ${count} 项`,
    )
    .join("、");

/** A supervisor outside the server lifetime; no Agent, HTTP or MCP entry point. */
export class DeploymentController {
  private busy = false;
  private readonly failed = new Set<string>();
  /** C-650: cache of the durable retry state per target; restart re-reads it. */
  private readonly retries = new Map<string, DeploymentReadyRetry>();
  /** End of the last attempt that restarted the server (in-memory). */
  private lastRestartAt: number | undefined;
  /** One bounded operation wait per from→to deployment. */
  private drain: { key: string; since: number } | undefined;
  /** The start of new long operations is closed until this attempt ends. */
  private fenced = false;
  constructor(private readonly driver: DeploymentDriver) {}

  /** C-609: deployments within the window wait and then take the latest main. */
  private batched(): number | undefined {
    const window = this.driver.batchWindowMs ?? 0;
    if (window <= 0 || this.lastRestartAt === undefined) return undefined;
    const remaining = this.lastRestartAt + window - this.driver.now();
    return remaining > 0 ? remaining : undefined;
  }

  private async operations(): Promise<readonly DeploymentOperation[]> {
    try {
      return (await this.driver.operations?.()) ?? [];
    } catch {
      return []; // An unreadable registry never holds a deployment.
    }
  }

  /** Close new starts and read what still runs, in one step (C-609). */
  private async fence(): Promise<readonly DeploymentOperation[]> {
    const d = this.driver;
    if (!d.fenceOperations) return this.operations();
    this.fenced = true;
    try {
      return await d.fenceOperations();
    } catch {
      return this.operations();
    }
  }

  private async unfence() {
    if (!this.fenced) return;
    this.fenced = false;
    try {
      await this.driver.releaseOperationFence?.();
    } catch {
      /* An abandoned fence expires with its owner or its age limit. */
    }
  }

  /** Time left in this deployment's bounded operation wait; starts the clock. */
  private remainingWait(key: string): number {
    const d = this.driver;
    if (this.drain?.key !== key) this.drain = { key, since: d.now() };
    return this.drain.since + (d.operationWaitMs ?? 0) - d.now();
  }

  private async deferred(
    record: DeploymentRecord,
    ops?: readonly DeploymentOperation[],
  ) {
    try {
      await this.driver.waitForOperations?.(record, ops);
    } catch {
      /* Audit only; the wait itself stays bounded. */
    }
  }

  /**
   * After the build, wait (bounded by the same deadline) for operations that
   * started meanwhile. The stop decision and the fence on new starts are one
   * step: an operation either runs before the fence (and is waited for, or
   * recorded as interrupted at the deadline) or waits for the next server.
   */
  private async settle(
    key: string,
    record: DeploymentRecord,
  ): Promise<{
    record: DeploymentRecord;
    interrupted: readonly DeploymentOperation[];
  }> {
    const d = this.driver;
    let ops = await this.operations();
    for (;;) {
      if (!ops.length || this.remainingWait(key) <= 0) {
        const running = await this.fence();
        if (!running.length || this.remainingWait(key) <= 0) {
          ops = running;
          break;
        }
        // Started between the last read and the fence: wait for it as well.
        await this.unfence();
        ops = running;
      }
      await this.deferred(
        {
          ...record,
          status: "waiting_for_operations",
          deferred_operations: countDeploymentOperations(ops),
          summary: `构建已完成，等待受管长操作结束后再停服：${operationSummary(ops)}`,
        },
        ops,
      );
      const ms = Math.min(OPERATION_POLL_MS, this.remainingWait(key));
      await (d.sleep ? d.sleep(ms) : delay(ms));
      ops = await this.operations();
    }
    return ops.length
      ? {
          record: {
            ...record,
            interrupted_operations: countDeploymentOperations(ops),
            summary: `${record.summary}；等待受管长操作已达上限，照常部署，重启后续跑或重排：${operationSummary(ops)}`,
          },
          interrupted: ops,
        }
      : { record, interrupted: [] };
  }

  /** C-650: the durable retry state of a target, or undefined when disabled. */
  private async readyRetry(
    key: string,
    target: string,
    controlEventId: string | undefined,
  ): Promise<DeploymentReadyRetry | undefined> {
    const d = this.driver;
    if (d.readyRetryMax === undefined || !d.readyRetryState) return undefined;
    const cached = this.retries.get(key);
    if (cached) return cached;
    const durable = await d.readyRetryState(target, controlEventId);
    if (durable) this.retries.set(key, durable);
    return durable;
  }

  async tick(): Promise<void> {
    const d = this.driver;
    if (this.busy) return;
    this.busy = true;
    let waitingForCapacity = false;
    let unlock: (() => Promise<void>) | undefined;
    try {
      try {
        await d.checkServer();
      } catch {
        throw new DeploymentServerUnavailable();
      }
      if (!d.enabled) return;
      // C-390: a human maintenance window holds every automatic deployment.
      if (await d.maintenanceActive?.()) {
        this.drain = undefined;
        return;
      }
      const current = await d.current();
      const selection = d.target ? await d.target() : { sha: await d.main() };
      const target = selection.sha;
      const failureKey = `${target}:${selection.control_event_id ?? "main"}`;
      if (current.sha === target || this.failed.has(failureKey)) {
        this.drain = undefined;
        return;
      }
      const priorRetry = await this.readyRetry(
        failureKey,
        target,
        selection.control_event_id,
      );
      // C-650: retries used up, or the next retry is not due yet.
      if (
        priorRetry &&
        (priorRetry.next_at === undefined ||
          d.now() < Date.parse(priorRetry.next_at))
      ) {
        this.drain = undefined;
        return;
      }
      let record: DeploymentRecord = {
        attempt: randomUUID(),
        from: current.sha,
        to: target,
        status: "started",
        build: "not_run",
        ready: false,
        downtime_ms: 0,
        summary: selection.control_event_id
          ? "主机准备部署人工固定版本"
          : "主机准备部署中心 main",
        ...(selection.control_event_id
          ? { control_event_id: selection.control_event_id }
          : {}),
      };
      // C-609: a human pin is explicit and is never batched.
      const batchWait = selection.control_event_id ? undefined : this.batched();
      if (batchWait !== undefined) {
        await this.deferred({
          ...record,
          status: "waiting_for_batch",
          ...(d.batchWindowMs ? { batch_window_ms: d.batchWindowMs } : {}),
          summary: `距上次部署不足合批窗口，约 ${Math.ceil(batchWait / 1000)} 秒后部署届时最新的中心 main`,
        });
        return;
      }
      // Keyed by the running build: a main that keeps moving cannot extend it.
      const drainKey = current.sha;
      const busy = await this.operations();
      if (!busy.length) this.drain = undefined;
      else if (this.remainingWait(drainKey) > 0) {
        // Before taking capacity: checks keep being admitted while we wait.
        await this.deferred(
          {
            ...record,
            status: "waiting_for_operations",
            deferred_operations: countDeploymentOperations(busy),
            summary: `等待受管长操作结束或到达可续点后再部署：${operationSummary(busy)}`,
          },
          busy,
        );
        return;
      }
      unlock = await d.acquire();
      if (!unlock) {
        await d.waitForCapacity({
          ...record,
          status: "waiting_for_capacity",
          summary: "主机部署等待本机检查临界区结束，暂停新检查准入",
        });
        waitingForCapacity = true;
        return;
      }
      const fastForward = await d.isFastForward(current.sha, target);
      if (
        !selection.control_event_id &&
        fastForward &&
        !(await d.passedMergeGate(current.sha, target))
      ) {
        // Git publication precedes its audit transaction. Never build without
        // proof, but re-read it next tick instead of poisoning this target.
        // Failed evidence reads/observations also remain outside the failure cache.
        await d.waitForEvidence({
          ...record,
          status: "waiting_for_evidence",
          summary:
            "中心 main 的发布证据尚未完整核验，保留当前服务，后续轮询重新核验",
        });
        return;
      }
      await d.record(record);
      let stoppedAt: number | undefined;
      let oldStopped = false;
      let stage: NonNullable<DeploymentRecord["failure_stage"]> = "host";
      try {
        if (!fastForward && !selection.control_event_id)
          throw new Error("non_fast_forward");
        stage = "build";
        const result = await d.build(target);
        record = {
          ...record,
          log_tail: result.log_tail,
          build: result.build ? "passed" : "failed",
        };
        if (!result.build) throw new Error("build_failed");
        stage = "host";
        const migrations = await d.migrationsChanged(current.sha, target);
        const settled = await this.settle(drainKey, record);
        record = await d.beforeStop(settled.record, settled.interrupted);
        // Backup is taken with the old server stopped, before any new migration.
        stoppedAt = d.now();
        this.lastRestartAt = stoppedAt;
        await d.stop();
        oldStopped = true;
        if (migrations) record = { ...record, backup_file: await d.backup() };
        stage = "start";
        await d.start(result.build);
        stage = "ready";
        if (!(await d.ready())) throw new Error("ready_failed");
        stage = "host";
        await d.promote(result.build);
        record = {
          ...record,
          status: "deployed",
          ready: true,
          downtime_ms: d.now() - stoppedAt,
          summary: selection.control_event_id
            ? "人工固定版本已部署，ready 和两个端口核对通过"
            : "中心 main 已部署，ready 和两个端口核对通过",
        };
      } catch (error) {
        const serverStage = stage === "start" || stage === "ready";
        const code =
          error instanceof Error &&
          ["non_fast_forward", "build_failed", "ready_failed"].includes(
            error.message,
          )
            ? error.message
            : "host_operation_failed";
        // C-650: name a recognised cause (e.g. a locked database), read
        // before the rollback starts a new log.
        let cause: string | undefined;
        if (serverStage)
          try {
            cause = d.serverFailureCause?.();
          } catch {
            cause = undefined;
          }
        const reason = cause ? `${code}（${cause}）` : code;
        record = {
          ...record,
          status: "failed",
          summary: reason,
          failure_stage: stage,
          ...(stage === "start" || stage === "ready"
            ? { log_tail: d.serverDiagnostics(stage) }
            : {}),
        };
        if (oldStopped) {
          try {
            await d.stop();
            await d.start(current);
            const ready = await d.ready();
            if (ready) await d.promote(current);
            record = {
              ...record,
              status: ready ? "rolled_back" : "failed",
              ready,
              summary: ready
                ? `${reason}；已恢复上一构建`
                : `${reason}；上一构建未就绪，需主机处理`,
            };
          } catch {
            record = {
              ...record,
              summary: `${reason}；回滚未确认，需主机处理`,
            };
          }
        }
        const max = d.readyRetryMax;
        if (serverStage && max !== undefined && d.readyRetryState) {
          // C-650: durable, bounded retries; only a restored server is retried.
          const failures = (priorRetry?.failures ?? 0) + 1;
          const interval = d.readyRetryIntervalMs ?? 0;
          const scheduled = record.status === "rolled_back" && failures <= max;
          const ready_retry: DeploymentReadyRetry = scheduled
            ? {
                failures,
                max,
                next_at: new Date(d.now() + interval).toISOString(),
              }
            : { failures, max };
          this.retries.set(failureKey, ready_retry);
          if (!scheduled) this.failed.add(failureKey);
          record = {
            ...record,
            ready_retry,
            summary: scheduled
              ? `${record.summary}；不早于 ${Math.ceil(interval / 1000)} 秒后自动重试（第 ${failures}/${max} 次）`
              : max > 0 && failures > max
                ? `${record.summary}；已自动重试 ${max} 次仍失败，需主机处理`
                : record.summary,
          };
        } else this.failed.add(failureKey);
        record = {
          ...record,
          downtime_ms: stoppedAt === undefined ? 0 : d.now() - stoppedAt,
        };
      }
      if (stoppedAt !== undefined) this.lastRestartAt = d.now();
      this.drain = undefined;
      await d.record(record);
      if (record.status === "deployed") {
        try {
          await d.refreshRoles();
        } catch {
          await d.record({
            ...record,
            post_deploy_failed: true,
            summary: "代码已部署，角色升级或 PM Ops 启动未完成，需主机核对",
          });
        }
      }
    } finally {
      try {
        await this.unfence();
        await unlock?.();
        if (!waitingForCapacity) await d.releaseCapacityWait();
      } finally {
        this.busy = false;
      }
    }
  }
}
