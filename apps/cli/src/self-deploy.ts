import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  DeploymentController,
  loadDeploymentConfig,
  NodeDeploymentDriver,
  RunCapacityDeferred,
  upgradeDeployedRoles,
} from "@cardigan/host";
import { Store } from "@cardigan/store";
import { startAssignmentById } from "./assignment.js";
import { CliError, EXIT } from "./errors.js";
import { hasToken, resolveDataDir } from "./host.js";
import type { CliIo } from "./io.js";

/** Host service entry, never an Agent tool or a caller-selected commit. */
export async function runSelfDeployCommand(
  args: readonly string[],
  io: CliIo,
): Promise<number> {
  if (hasToken(io))
    throw new CliError("自动部署仅限主机，Agent 不可调用", EXIT.usage);
  if (args.length !== 1 || !["watch", "roles"].includes(args[0] ?? ""))
    throw new CliError(
      "用法：cardigan self-deploy watch|roles（主机专用，配置来自 self-deploy.yaml）",
      EXIT.usage,
    );
  const dataDir = resolveDataDir(io);
  const config = await loadDeploymentConfig(
    io.env.CARDIGAN_CONFIG_DIR ?? join(homedir(), ".config", "cardigan"),
  );
  const store = Store.open({ dataDir });
  let unlock: (() => Promise<void>) | undefined;
  try {
    if (!store.getProject("cardigan"))
      throw new CliError("自动部署只服务自举项目 cardigan", EXIT.usage);
    if (args[0] === "roles") {
      const changed: unknown = JSON.parse(
        io.env.CARDIGAN_DEPLOYMENT_CHANGED_ROLES ?? "null",
      );
      if (
        !Array.isArray(changed) ||
        !changed.every((id) => typeof id === "string")
      )
        throw new CliError(
          "角色同步必须由部署监督器提供已核对的角色包差异",
          EXIT.usage,
        );
      const assignment = upgradeDeployedRoles(store, "cardigan", changed);
      if (
        assignment &&
        store.uow.read(
          (tx) =>
            !tx.runs
              .list("cardigan")
              .some((r) => r.assignment_id === assignment),
        )
      )
        try {
          return await startAssignmentById({
            store,
            io,
            dataDir,
            project_id: "cardigan",
            assignment_id: assignment,
            automatic: true,
          });
        } catch (error) {
          // System starts respect capacity; the Dispatcher will launch the queued Run.
          if (!(error instanceof RunCapacityDeferred)) throw error;
        }
      return EXIT.ok;
    }
    const driver = new NodeDeploymentDriver({
      store,
      dataDir,
      config,
      env: io.env,
    });
    unlock = await driver.initialize();
    const controller = new DeploymentController(driver);
    const stop = new AbortController();
    const signal = () => stop.abort();
    io.signals.on("SIGTERM", signal);
    io.signals.on("SIGINT", signal);
    try {
      while (!stop.signal.aborted) {
        try {
          await controller.tick();
        } catch {
          io.stderr("主机自动部署本轮未完成，请核对部署记录和主机配置");
        }
        try {
          await delay(config.poll_interval_ms, undefined, {
            signal: stop.signal,
          });
        } catch {
          /* Shutdown interrupts the idle interval. */
        }
      }
      await driver.stop();
    } finally {
      io.signals.off("SIGTERM", signal);
      io.signals.off("SIGINT", signal);
    }
    return EXIT.ok;
  } finally {
    await unlock?.();
    store.close();
  }
}
