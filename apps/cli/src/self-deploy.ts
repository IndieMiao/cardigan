import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  DeploymentController,
  DeploymentDiskMonitor,
  DeploymentServerUnavailable,
  deploymentDirectory,
  finishSupervisorUpgrade,
  HostMemoryPressureMonitor,
  loadDeploymentConfig,
  loadSupervisorUpgradeConfig,
  NodeDeploymentDriver,
  nodeRestartPorts,
  nodeSystemdCommand,
  RunCapacityDeferred,
  syncProjectOverlayRoles,
  upgradeDeployedRoles,
  writeDeploymentNotice,
} from "@cardigan/host";
import { Store } from "@cardigan/store";
import { startAssignmentById } from "./assignment.js";
import { validProfileNames } from "./config.js";
import { CliError, EXIT } from "./errors.js";
import { hasToken, resolveDataDir } from "./host.js";
import type { CliIo } from "./io.js";
import { cliLaunchPaths } from "./paths.js";

/** Host service entry, never an Agent tool or a caller-selected commit. */
export async function runSelfDeployCommand(
  args: readonly string[],
  io: CliIo,
): Promise<number> {
  if (hasToken(io))
    throw new CliError("自动部署仅限主机，Agent 不可调用", EXIT.usage);
  if (
    args.length !== 1 ||
    !["watch", "roles", "finish-upgrade", "recover-upgrade"].includes(
      args[0] ?? "",
    )
  )
    throw new CliError(
      "用法：cardigan self-deploy watch|roles|finish-upgrade|recover-upgrade（主机专用，配置来自 self-deploy.yaml；finish-upgrade 与 recover-upgrade 只由监督器自升级启动）",
      EXIT.usage,
    );
  const dataDir = resolveDataDir(io);
  // C-767: the restart helper the supervisor starts in its own systemd unit.
  // It reads only the host-written plan in the deployment directory.
  // C-770: recover-upgrade is the helper unit's ExecStopPost= fallback.
  if (args[0] === "finish-upgrade" || args[0] === "recover-upgrade") {
    const resume = args[0] === "recover-upgrade";
    const store = Store.open({ dataDir, migrate: false });
    try {
      if (!store.getProject("cardigan"))
        throw new CliError("自动部署只服务自举项目 cardigan", EXIT.usage);
      const directory = deploymentDirectory(dataDir);
      const outcome = await finishSupervisorUpgrade({
        store,
        directory,
        ports: nodeRestartPorts({
          directory,
          systemctl: nodeSystemdCommand("systemctl", io.env),
        }),
        resume,
      });
      if (outcome === "none") return EXIT.ok;
      io.stderr(
        outcome === "completed"
          ? "部署监督器自动升级完成"
          : "部署监督器自动升级未完成，结果已写入待办",
      );
      return outcome === "completed" ? EXIT.ok : EXIT.failure;
    } finally {
      store.close();
    }
  }
  const configDir =
    io.env.CARDIGAN_CONFIG_DIR ?? join(homedir(), ".config", "cardigan");
  const config = await loadDeploymentConfig(configDir).catch(
    (error: unknown) => {
      const message =
        "无法安全解析部署配置，自动部署未启动。请管理员核对 self-deploy.yaml；修复后重启监督器。";
      io.stderr(message);
      // Never migrate an existing live deployment merely to record a warning.
      let audit: Store | undefined;
      try {
        audit = Store.open({ dataDir, migrate: false });
        if (audit.getProject("cardigan"))
          writeDeploymentNotice(audit, "deployment-config-invalid", message);
      } catch {
        io.stderr("部署配置告警未能写入待办，请核对主机日志和数据库可用性");
      } finally {
        audit?.close();
      }
      throw error;
    },
  );
  // The running release owns migrations, after both old roles have stopped.
  const store = Store.open({ dataDir, migrate: false });
  let unlock: (() => Promise<void>) | undefined;
  let driver: NodeDeploymentDriver | undefined;
  try {
    if (!store.getProject("cardigan"))
      throw new CliError("自动部署只服务自举项目 cardigan", EXIT.usage);
    if (args[0] === "roles") {
      const invalid = () =>
        new CliError(
          "角色同步必须由部署监督器提供已核对的角色包差异及上一默认版本指纹",
          EXIT.usage,
        );
      let changed: unknown, previous: unknown;
      try {
        changed = JSON.parse(
          io.env.CARDIGAN_DEPLOYMENT_CHANGED_ROLES ?? "null",
        );
        previous = JSON.parse(
          io.env.CARDIGAN_DEPLOYMENT_PREVIOUS_ROLES ?? "null",
        );
      } catch {
        throw invalid();
      }
      if (
        !Array.isArray(changed) ||
        !changed.every((id) => typeof id === "string") ||
        !previous ||
        typeof previous !== "object" ||
        Array.isArray(previous) ||
        !Object.values(previous).every(
          (hash) => typeof hash === "string" && /^[a-f0-9]{64}$/u.test(hash),
        )
      )
        throw invalid();
      // Read only when a role version is about to be written: overlay roles
      // can follow the pack even when the supervisor lists no change.
      let loaded: ReadonlySet<string> | undefined;
      const profiles = (): ReadonlySet<string> => {
        if (loaded) return loaded;
        try {
          loaded = validProfileNames(cliLaunchPaths(io));
        } catch {
          io.stderr("启动配置未通过校验，不发布依赖该配置的新角色版本");
          loaded = new Set();
        }
        return loaded;
      };
      const assignment = upgradeDeployedRoles(
        store,
        "cardigan",
        changed,
        previous as Record<string, string>,
        profiles,
      );
      // C-613: project-customised roles elsewhere follow the same pack.
      for (const other of store.listProjects()) {
        if (other.id === "cardigan") continue;
        try {
          syncProjectOverlayRoles(store, other.id, { profiles });
        } catch {
          io.stderr(
            `项目 ${other.id} 的定制角色未能随默认包升级，下次部署重试`,
          );
        }
      }
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
    // C-767: optional and default off; an unreadable switch file stays off.
    const upgrade = await loadSupervisorUpgradeConfig(configDir).catch(() => {
      const message =
        "无法安全读取 supervisor-upgrade.yaml，监督器自动升级保持关闭。请管理员核对该文件；修复后重启监督器。";
      io.stderr(message);
      try {
        writeDeploymentNotice(
          store,
          "supervisor-upgrade-config-invalid",
          message,
        );
      } catch {
        io.stderr("监督器自动升级配置告警未能写入待办，请核对主机日志");
      }
      return undefined;
    });
    driver = new NodeDeploymentDriver({
      store,
      dataDir,
      config,
      env: io.env,
      ...(upgrade ? { upgrade: { config: upgrade, configDir } } : {}),
    });
    unlock = await driver.initialize();
    const controller = new DeploymentController(driver);
    const disk = new DeploymentDiskMonitor(
      store,
      dataDir,
      config.disk_low_percent,
    );
    const pressure =
      process.platform === "linux"
        ? new HostMemoryPressureMonitor(
            store,
            { tmp: config.tmp_high_percent, swap: config.swap_high_percent },
            undefined,
            // C-656: start after a minute so a supervisor that exits at once
            // (or a short-lived test) never scans the host's /tmp.
            Date.now() + 60_000,
          )
        : undefined;
    const stop = new AbortController();
    const signal = () => stop.abort();
    io.signals.on("SIGTERM", signal);
    io.signals.on("SIGINT", signal);
    try {
      while (!stop.signal.aborted) {
        try {
          await disk.poll();
        } catch {
          io.stderr("本次磁盘空间检查未完成，保留上次观测状态");
        }
        try {
          await pressure?.poll();
        } catch {
          io.stderr("本次 /tmp 与 swap 用量检查未完成，保留上次观测状态");
        }
        // C-767: while the restart helper takes over, start no deployment.
        if (!driver.supervisorRestarting)
          try {
            await controller.tick();
            try {
              await driver.maintainDisk();
            } catch {
              io.stderr("本次磁盘回收未完成，请核对清单和主机审计");
            }
          } catch (error) {
            if (error instanceof DeploymentServerUnavailable) throw error;
            io.stderr("主机自动部署本轮未完成，请核对部署记录和主机配置");
          }
        try {
          await driver.upgradeSupervisor();
        } catch {
          io.stderr("本轮监督器自动升级未完成，下轮重试");
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
    try {
      // A stopped child can still have queued output that needs a rotation audit.
      // Retain both Store and the supervisor lock until that output is written.
      await driver?.finishServerLogs();
    } finally {
      try {
        await unlock?.();
      } finally {
        store.close();
      }
    }
  }
}
