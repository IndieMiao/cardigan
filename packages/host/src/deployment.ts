import { randomUUID } from "node:crypto";
import type { DeploymentDriver, DeploymentRecord } from "@cardigan/domain";

/** Fatal to the supervisor: its host service manager must recover the server. */
export class DeploymentServerUnavailable extends Error {
  constructor() {
    super("主机 server 已退出或无法确认，监督器退出，请核对主机服务恢复记录");
  }
}

/** A supervisor outside the server lifetime; no Agent, HTTP or MCP entry point. */
export class DeploymentController {
  private busy = false;
  private readonly failed = new Set<string>();
  constructor(private readonly driver: DeploymentDriver) {}

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
      const current = await d.current();
      const target = await d.main();
      if (current.sha === target || this.failed.has(target)) return;
      let record: DeploymentRecord = {
        attempt: randomUUID(),
        from: current.sha,
        to: target,
        status: "started",
        build: "not_run",
        ready: false,
        downtime_ms: 0,
        summary: "主机准备部署中心 main",
      };
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
      if (fastForward && !(await d.passedMergeGate(current.sha, target))) {
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
        if (!fastForward) throw new Error("non_fast_forward");
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
        record = await d.beforeStop(record);
        // Backup is taken with the old server stopped, before any new migration.
        stoppedAt = d.now();
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
          summary: "中心 main 已部署，ready 和两个端口核对通过",
        };
      } catch (error) {
        this.failed.add(target);
        const reason =
          error instanceof Error &&
          ["non_fast_forward", "build_failed", "ready_failed"].includes(
            error.message,
          )
            ? error.message
            : "host_operation_failed";
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
        record = {
          ...record,
          downtime_ms: stoppedAt === undefined ? 0 : d.now() - stoppedAt,
        };
      }
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
        await unlock?.();
        if (!waitingForCapacity) await d.releaseCapacityWait();
      } finally {
        this.busy = false;
      }
    }
  }
}
