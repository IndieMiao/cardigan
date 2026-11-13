import { randomUUID } from "node:crypto";
import type { DeploymentDriver, DeploymentRecord } from "@cardigan/domain";

/** A supervisor outside the server lifetime; no Agent, HTTP or MCP entry point. */
export class DeploymentController {
  private busy = false;
  private readonly failed = new Set<string>();
  constructor(private readonly driver: DeploymentDriver) {}

  async tick(): Promise<void> {
    const d = this.driver;
    if (!d.enabled || this.busy) return;
    this.busy = true;
    let unlock: (() => Promise<void>) | undefined;
    try {
      unlock = await d.acquire();
      if (!unlock) return;
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
      await d.record(record);
      let stoppedAt: number | undefined;
      let oldStopped = false;
      try {
        if (!(await d.isFastForward(current.sha, target)))
          throw new Error("non_fast_forward");
        if (!(await d.passedMergeGate(current.sha, target)))
          throw new Error("unverified_main");
        const result = await d.build(target);
        record = {
          ...record,
          log_tail: result.log_tail,
          build: result.build ? "passed" : "failed",
        };
        if (!result.build) throw new Error("build_failed");
        const migrations = await d.migrationsChanged(current.sha, target);
        // Backup is taken with the old server stopped, before any new migration.
        stoppedAt = d.now();
        await d.stop();
        oldStopped = true;
        if (migrations) await d.backup();
        await d.start(result.build);
        if (!(await d.ready())) throw new Error("ready_failed");
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
          [
            "non_fast_forward",
            "unverified_main",
            "build_failed",
            "ready_failed",
          ].includes(error.message)
            ? error.message
            : "host_operation_failed";
        record = { ...record, status: "failed", summary: reason };
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
      } finally {
        this.busy = false;
      }
    }
  }
}
