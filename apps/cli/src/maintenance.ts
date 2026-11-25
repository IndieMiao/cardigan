import { homedir } from "node:os";
import { join } from "node:path";
import {
  hcUpgradeNeedsStaging,
  hcUpgradeRecoveryWork,
  loadMaintenanceConfig,
  type MaintenanceConfig,
  type MaintenanceDriver,
  type MaintenanceOutcome,
  MaintenanceRunner,
  maintenanceStatus,
  nodeMaintenanceDriver,
  prepareHcUpgrade,
  readMaintenance,
} from "@cardigan/host";
import { Store } from "@cardigan/store";
import { CliError, EXIT } from "./errors.js";
import { hasToken, resolveDataDir } from "./host.js";
import type { CliIo } from "./io.js";

export const MAINTENANCE_USAGE = [
  "用法（人专用，Token/Agent 不可调用；服务与 hc 目标来自主机 maintenance.yaml）：",
  "  cardigan maintenance begin --reason <说明> [--stop-hc <目标,...>] [--timeout-minutes <分钟>]",
  "  cardigan maintenance run --reason <说明> [--stop-hc <目标,...>] [--timeout-minutes <分钟>] -- <绝对路径命令> [参数...]",
  "  cardigan maintenance status",
  "  cardigan maintenance continue [--wait|--proceed]",
  "  cardigan maintenance end",
  "  cardigan maintenance abandon",
].join("\n");
export const HC_USAGE =
  "用法：cardigan hc upgrade --version <版本> [--target <目标,...>] [--reason <说明>] [--timeout-minutes <分钟>]（人专用；版本须与 deploy/hc-version.json 一致）";

/** Test seam: the real driver touches services, ports and the network. */
export interface MaintenanceHooks {
  readonly driver?: (store: Store, dataDir: string) => MaintenanceDriver;
  readonly config?: MaintenanceConfig;
  readonly fetchArchive?: (url: string) => Promise<Uint8Array>;
}

interface Options {
  reason?: string;
  stopHc: string[];
  targets?: string[];
  timeoutMs?: number;
  version?: string;
  choice?: "wait" | "proceed";
  command?: string[];
}

function parse(args: readonly string[], usage: string): Options {
  const options: Options = { stopHc: [] };
  const list = (value: string | undefined) => {
    if (!value) throw new CliError(usage, EXIT.usage);
    return value.split(",").filter(Boolean);
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    const next = () => {
      const value = args[++i];
      if (value === undefined) throw new CliError(usage, EXIT.usage);
      return value;
    };
    if (arg === "--") {
      options.command = args.slice(i + 1) as string[];
      break;
    }
    if (arg === "--reason") options.reason = next().trim();
    else if (arg === "--stop-hc") options.stopHc = list(next());
    else if (arg === "--target") options.targets = list(next());
    else if (arg === "--version") options.version = next();
    else if (arg === "--timeout-minutes") {
      const value = Number(next());
      if (!Number.isSafeInteger(value) || value < 1 || value > 24 * 60)
        throw new CliError(
          "--timeout-minutes 需为 1 到 1440 的整数",
          EXIT.usage,
        );
      options.timeoutMs = value * 60_000;
    } else if (arg === "--wait" || arg === "--proceed") {
      if (options.choice) throw new CliError(usage, EXIT.usage);
      options.choice = arg === "--wait" ? "wait" : "proceed";
    } else throw new CliError(usage, EXIT.usage);
  }
  return options;
}

function exitFor(outcome: MaintenanceOutcome): number {
  return outcome === "completed" ||
    outcome === "stopped" ||
    outcome === "abandoned"
    ? EXIT.ok
    : EXIT.failure;
}

async function withRunner<T>(
  io: CliIo,
  hooks: MaintenanceHooks,
  body: (
    runner: MaintenanceRunner,
    context: {
      store: Store;
      config: MaintenanceConfig;
      driver: MaintenanceDriver;
    },
  ) => Promise<T>,
): Promise<T> {
  const dataDir = resolveDataDir(io);
  const config =
    hooks.config ??
    (await loadMaintenanceConfig(
      io.env.CARDIGAN_CONFIG_DIR ?? join(homedir(), ".config", "cardigan"),
    ));
  const store = Store.open({ dataDir, migrate: false });
  try {
    const driver =
      hooks.driver?.(store, dataDir) ??
      nodeMaintenanceDriver({ store, dataDir, say: (l) => io.stdout(l) });
    return await body(new MaintenanceRunner(store, config, driver), {
      store,
      config,
      driver,
    });
  } finally {
    store.close();
  }
}

function refuseToken(io: CliIo) {
  if (hasToken(io))
    throw new CliError(
      "维护和 hc 升级仅限人在主机终端操作，Token/Agent 不可调用",
      EXIT.usage,
    );
}

export async function runMaintenanceCommand(
  args: readonly string[],
  io: CliIo,
  hooks: MaintenanceHooks = {},
): Promise<number> {
  refuseToken(io);
  const [sub, ...rest] = args;
  const options = parse(rest, MAINTENANCE_USAGE);
  if (sub === "status") {
    if (rest.length) throw new CliError(MAINTENANCE_USAGE, EXIT.usage);
    const store = Store.open({ dataDir: resolveDataDir(io), migrate: false });
    try {
      io.stdout(maintenanceStatus(store));
      return EXIT.ok;
    } finally {
      store.close();
    }
  }
  if (sub === "begin" || sub === "run") {
    if (!options.reason || options.choice || options.targets)
      throw new CliError(MAINTENANCE_USAGE, EXIT.usage);
    if ((sub === "run") !== !!options.command?.length)
      throw new CliError(MAINTENANCE_USAGE, EXIT.usage);
    const command = options.command;
    if (command && !command[0]?.startsWith("/"))
      throw new CliError("维护命令需以绝对路径程序开头", EXIT.usage);
    return withRunner(io, hooks, async (runner) =>
      exitFor(
        await runner.begin({
          reason: options.reason as string,
          operation: command
            ? { kind: "command", argv: command }
            : { kind: "manual" },
          stop_hc: options.stopHc,
          ...(options.timeoutMs ? { timeout_ms: options.timeoutMs } : {}),
        }),
      ),
    );
  }
  if (rest.some((a) => !["--wait", "--proceed"].includes(a)))
    throw new CliError(MAINTENANCE_USAGE, EXIT.usage);
  if (sub === "continue")
    return withRunner(io, hooks, async (runner, context) =>
      exitFor(
        await (await resumable(runner, context, hooks)).resume(
          options.choice ?? "resume",
        ),
      ),
    );
  if (sub === "end" && !options.choice)
    return withRunner(io, hooks, async (runner, context) =>
      exitFor(await (await resumable(runner, context, hooks)).resume("end")),
    );
  if (sub === "abandon" && !options.choice)
    return withRunner(io, hooks, async (runner) =>
      exitFor(await runner.abandon()),
    );
  throw new CliError(MAINTENANCE_USAGE, EXIT.usage);
}

/**
 * An hc upgrade resumed before its switch needs its work again: the staged
 * paths are re-derived (staging is idempotent) for the same version. Past the
 * switch only the recorded recovery points are needed, so nothing is
 * downloaded or staged and an unreachable network or worker cannot block
 * `end` (V-3343).
 */
async function resumable(
  runner: MaintenanceRunner,
  context: {
    store: Store;
    config: MaintenanceConfig;
    driver: MaintenanceDriver;
  },
  hooks: MaintenanceHooks,
): Promise<MaintenanceRunner> {
  const row = readMaintenance(context.store);
  const operation = row?.record.operation;
  if (operation?.kind !== "hc_upgrade") return runner;
  if (!hcUpgradeNeedsStaging(row?.phase ?? "")) {
    const work = hcUpgradeRecoveryWork(
      context.config,
      operation.version,
      operation.targets,
    );
    return new MaintenanceRunner(
      context.store,
      context.config,
      context.driver,
      () => work,
    );
  }
  const plan = await prepareHcUpgrade({
    config: context.config,
    version: operation.version,
    targetIds: operation.targets,
    driver: context.driver,
    ...(hooks.fetchArchive ? { fetchArchive: hooks.fetchArchive } : {}),
  });
  return new MaintenanceRunner(
    context.store,
    context.config,
    context.driver,
    () => plan.work,
  );
}

export async function runHcCommand(
  args: readonly string[],
  io: CliIo,
  hooks: MaintenanceHooks = {},
): Promise<number> {
  refuseToken(io);
  const [sub, ...rest] = args;
  if (sub !== "upgrade") throw new CliError(HC_USAGE, EXIT.usage);
  const options = parse(rest, HC_USAGE);
  if (
    !options.version ||
    options.choice ||
    options.command ||
    options.stopHc.length
  )
    throw new CliError(HC_USAGE, EXIT.usage);
  return withRunner(io, hooks, async (_runner, context) => {
    const machines = new Set(
      context.store.uow.read((tx) =>
        context.store.listProjects().flatMap((p) =>
          tx.machines
            .list(p.id)
            .filter((m) => m.status !== "offline")
            .map((m) => m.id as string),
        ),
      ),
    );
    for (const t of context.config.hc_targets)
      if (
        t.machine &&
        (!options.targets || options.targets.includes(t.id)) &&
        !machines.has(t.machine)
      )
        throw new CliError(
          `hc 目标 ${t.id} 对应的机器 ${t.machine} 未登记或已离线，不切换`,
          EXIT.failure,
        );
    const plan = await prepareHcUpgrade({
      config: context.config,
      version: options.version as string,
      ...(options.targets ? { targetIds: options.targets } : {}),
      driver: context.driver,
      ...(hooks.fetchArchive ? { fetchArchive: hooks.fetchArchive } : {}),
    });
    for (const t of plan.targets)
      io.stdout(
        `已核对 SHA-256 并在 ${t.id} 预置 hc ${plan.version}：${plan.staged[t.id]}`,
      );
    const runner = new MaintenanceRunner(
      context.store,
      context.config,
      context.driver,
      () => plan.work,
    );
    return exitFor(
      await runner.begin({
        reason: options.reason ?? `hc 升级到 ${plan.version}`,
        operation: {
          kind: "hc_upgrade",
          version: plan.version,
          targets: plan.targets.map((t) => t.id),
        },
        // Every target that is switched is stopped first when it can be.
        stop_hc: plan.targets.filter((t) => t.stop).map((t) => t.id),
        ...(options.timeoutMs ? { timeout_ms: options.timeoutMs } : {}),
      }),
    );
  });
}
