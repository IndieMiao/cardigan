import { homedir } from "node:os";
import { join } from "node:path";
import {
  activeOwner,
  type CapacityOverrideChange,
  changeCapacityOverride,
} from "@cardigan/domain";
import {
  capacityOverrideBase,
  checkHostConfig,
  loadRunCapacityConfig,
  runCapacityMachines,
  withCapacityOverrides,
} from "@cardigan/host";
import {
  persistCapacityOverrideEffect,
  readCapacityOverride,
  Store,
} from "@cardigan/store";
import { CliError, EXIT, formatCommandError } from "./errors.js";
import {
  announceDataDir,
  resolveDataDir,
  resolveGlobalActor,
  systemClock,
} from "./host.js";
import type { CliIo } from "./io.js";

const CONFIG_USAGE = [
  "用法：cardigan config check [--config-dir <目录>] [--data-dir <目录>] [--json]",
  "  用现有加载器一次校验 merge-gate.yaml、run-capacity.yaml、runtime-workers.yaml；",
  "  任一文件无效时退出码非 0。--config-dir 可指向待替换的新配置目录（仅人类）。",
].join("\n");
const CAPACITY_USAGE = [
  "用法（仅人类，写入数据库，运行中的 server 立即生效，不用改 YAML、不用重启）：",
  "  cardigan capacity show <机器>",
  "  cardigan capacity resource <机器> <资源> <名额> | --clear",
  "  cardigan capacity quota <机器> <项目> [--limit <n>] [--resource <资源>=<n>]... | --clear",
].join("\n");

function flags(args: readonly string[], allowed: readonly string[]) {
  const positionals: string[] = [];
  const values = new Map<string, string[]>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split(/=(.*)/su, 2) as [
      string,
      string | undefined,
    ];
    if (!allowed.includes(name))
      throw new CliError(`不接受 --${name}`, EXIT.usage);
    const boolean = name === "json" || name === "clear";
    const value = boolean ? "" : (inline ?? args[++i]);
    if (value === undefined)
      throw new CliError(`--${name} 需要一个值`, EXIT.usage);
    values.set(name, [...(values.get(name) ?? []), value]);
  }
  return {
    positionals,
    has: (name: string) => values.has(name),
    last: (name: string) => values.get(name)?.at(-1),
    all: (name: string) => values.get(name) ?? [],
  };
}

const configDirOf = (io: CliIo, override?: string) =>
  override ??
  io.env.CARDIGAN_CONFIG_DIR ??
  join(homedir(), ".config", "cardigan");

/** C-792: one command over the three loaders the server uses at startup. */
export async function runConfigCommand(
  args: readonly string[],
  io: CliIo,
): Promise<number> {
  if (args[0] !== "check" || args.includes("--help") || args.includes("-h")) {
    io.stdout(CONFIG_USAGE);
    return args[0] === undefined || args[0] === "check" ? EXIT.ok : EXIT.usage;
  }
  resolveGlobalActor(io);
  const parsed = flags(args.slice(1), ["config-dir", "data-dir", "json"]);
  if (parsed.positionals.length) throw new CliError(CONFIG_USAGE, EXIT.usage);
  const dataDir = resolveDataDir(io, parsed.last("data-dir"));
  const store = Store.open({ dataDir, migrate: false });
  let projects: { id: string; base_branch: string }[];
  try {
    projects = store
      .listProjects()
      .map((p) => ({ id: p.id, base_branch: p.base_branch ?? "main" }));
  } finally {
    store.close();
  }
  const result = await checkHostConfig({
    configDir: configDirOf(io, parsed.last("config-dir")),
    dataDir,
    projects,
  });
  if (parsed.has("json")) io.stdout(JSON.stringify(result, null, 2));
  else
    io.stdout(
      result.files
        .flatMap((f) => [
          `${f.file}：${f.status === "ok" ? "通过" : f.status === "missing" ? "未配置（使用默认值）" : "无效"}`,
          ...f.errors.map((error) => `  - ${error}`),
        ])
        .join("\n"),
    );
  return result.ok ? EXIT.ok : EXIT.failure;
}

function count(value: string | undefined, label: string): number {
  if (value === undefined || !/^\d+$/u.test(value))
    throw new CliError(`${label}必须是非负整数`, EXIT.usage);
  return Number(value);
}

/** C-792: live resource slots and project ceilings; YAML stays the default. */
export async function runCapacityCommand(
  args: readonly string[],
  io: CliIo,
): Promise<number> {
  const [sub, ...rest] = args;
  if (
    !["show", "resource", "quota"].includes(sub ?? "") ||
    args.includes("--help") ||
    args.includes("-h")
  ) {
    io.stdout(CAPACITY_USAGE);
    return sub === undefined || args.includes("--help") || args.includes("-h")
      ? EXIT.ok
      : EXIT.usage;
  }
  const actor = resolveGlobalActor(io);
  const parsed = flags(rest, [
    "data-dir",
    ...(sub === "resource" ? ["clear"] : []),
    ...(sub === "quota" ? ["clear", "limit", "resource"] : []),
  ]);
  const [machine, target, value] = parsed.positionals;
  const arity =
    sub === "show" ? 1 : sub === "quota" || parsed.has("clear") ? 2 : 3;
  if (!machine || parsed.positionals.length !== arity)
    throw new CliError(CAPACITY_USAGE, EXIT.usage);
  const yaml = await loadRunCapacityConfig({ env: io.env });
  if (yaml.errors.length)
    throw new CliError("容量操作已停止：并发配置无效。", EXIT.failure, [
      ...yaml.errors,
    ]);
  const dataDir = announceDataDir(io, parsed.last("data-dir"));
  const store = Store.open({ dataDir });
  try {
    if (sub === "show") {
      const live = withCapacityOverrides(yaml, store.database);
      const override = readCapacityOverride(store.database, machine);
      io.stdout(
        JSON.stringify(
          {
            machine_id: machine,
            yaml_resources: Object.fromEntries(
              yaml.resourcesForMachine(machine),
            ),
            override: override ?? null,
            effective_resources: Object.fromEntries(
              live.resourcesForMachine(machine),
            ),
            yaml_only_resources: [
              ...capacityOverrideBase(yaml, machine).pinned,
            ],
          },
          null,
          2,
        ),
      );
      return EXIT.ok;
    }
    let change: CapacityOverrideChange;
    if (sub === "resource")
      change = parsed.has("clear")
        ? { kind: "clear_resource", machine_id: machine, key: target as string }
        : {
            kind: "set_resource",
            machine_id: machine,
            key: target as string,
            slots: count(value, "资源名额"),
          };
    else if (parsed.has("clear")) {
      if (parsed.has("limit") || parsed.has("resource"))
        throw new CliError(
          "--clear 不能与 --limit/--resource 同用",
          EXIT.usage,
        );
      change = {
        kind: "clear_project_quota",
        machine_id: machine,
        project_id: target as string,
      };
    } else {
      const resources: Record<string, number> = {};
      for (const entry of parsed.all("resource")) {
        const at = entry.lastIndexOf("=");
        if (at <= 0)
          throw new CliError("--resource 须写成 <资源>=<n>", EXIT.usage);
        resources[entry.slice(0, at)] = count(
          entry.slice(at + 1),
          "项目资源上限",
        );
      }
      const limit = parsed.last("limit");
      change = {
        kind: "set_project_quota",
        machine_id: machine,
        project_id: target as string,
        resources,
        ...(limit === undefined ? {} : { limit: count(limit, "项目并发上限") }),
      };
    }
    const saved = store.uow.run((tx) => {
      const owner = activeOwner(tx.members.list());
      if (!owner) throw new CliError("没有有效的所有者成员", EXIT.failure);
      const effect = changeCapacityOverride(actor, change, {
        machines: runCapacityMachines(store, tx),
        projects: store.listProjects().map((p) => p.id),
        current: readCapacityOverride(store.database, machine),
        base: capacityOverrideBase(yaml, machine),
        member_id: owner.id,
        clock: systemClock,
        ids: tx.global_ids,
      });
      if (!effect.ok)
        throw new CliError(
          formatCommandError("修改容量", machine, effect.error),
          EXIT.usage,
        );
      persistCapacityOverrideEffect(store.database, tx, machine, effect.value);
      return effect.value.override;
    });
    io.stdout(
      JSON.stringify({ machine_id: machine, override: saved }, null, 2),
    );
    return EXIT.ok;
  } finally {
    store.close();
  }
}
