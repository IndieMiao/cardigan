import { resolveProfile } from "@cardigan/roles";
import { loadConfig } from "./config.js";
import { CliError, EXIT } from "./errors.js";
import type { CliIo } from "./io.js";
import { checkProfile } from "./launch-check.js";
import { importSettings } from "./launch-import.js";
import { runProfile } from "./launch-run.js";
import { type LaunchPaths, resolveLaunchPaths } from "./paths.js";

const LAUNCH_USAGE = [
  "用法：",
  "  cardigan launch --list",
  "  cardigan launch <启动配置> [--cwd <目录>] [--print] [-- <传给 CLI 的参数>...]",
  "  cardigan launch check <启动配置>",
  "  cardigan launch import-claude-settings <settings.json> --provider <名字>",
].join("\n");

export type LaunchArgs =
  | { readonly kind: "help" }
  | { readonly kind: "list" }
  | {
      readonly kind: "run";
      readonly profile: string;
      readonly cwd: string | undefined;
      readonly printOnly: boolean;
      readonly extra: readonly string[];
    }
  | { readonly kind: "check"; readonly profile: string }
  | {
      readonly kind: "import";
      readonly settingsPath: string;
      readonly provider: string;
    };

/** Parse the arguments that follow `cardigan launch`. */
export function parseLaunchArgs(args: readonly string[]): LaunchArgs {
  const rest = [...args];
  let printOnly = false;
  let cwd: string | undefined;
  let extra: string[] = [];

  const positionals: string[] = [];
  while (rest.length > 0) {
    const token = rest.shift() as string;
    if (token === "--") {
      extra = rest.splice(0, rest.length);
      break;
    }
    if (token === "--list" || token === "--help" || token === "-h") {
      positionals.push(token);
      continue;
    }
    if (token === "--print") {
      printOnly = true;
      continue;
    }
    if (token === "--cwd") {
      const value = rest.shift();
      if (value === undefined) {
        throw new CliError("--cwd 需要一个目录", EXIT.usage);
      }
      cwd = value;
      continue;
    }
    if (token.startsWith("--cwd=")) {
      cwd = token.slice("--cwd=".length);
      continue;
    }
    if (token === "--provider") {
      const value = rest.shift();
      if (value === undefined) {
        throw new CliError("--provider 需要一个名字", EXIT.usage);
      }
      positionals.push("--provider", value);
      continue;
    }
    if (token.startsWith("-")) {
      throw new CliError(`不认识的选项：${token}`, EXIT.usage, [LAUNCH_USAGE]);
    }
    positionals.push(token);
  }

  const [first, ...others] = positionals;
  if (first === undefined) {
    if (printOnly || cwd !== undefined) {
      throw new CliError("缺少启动配置名字", EXIT.usage, [LAUNCH_USAGE]);
    }
    throw new CliError("缺少子命令", EXIT.usage, [LAUNCH_USAGE]);
  }
  if (first === "--help" || first === "help" || first === "-h") {
    return { kind: "help" };
  }
  if (first === "--list" || first === "list") {
    if (others.length > 0) {
      throw new CliError("--list 不接受其他参数", EXIT.usage, [LAUNCH_USAGE]);
    }
    return { kind: "list" };
  }
  if (first === "check") {
    const profile = others[0];
    if (profile === undefined || others.length > 1) {
      throw new CliError("用法：cardigan launch check <启动配置>", EXIT.usage);
    }
    return { kind: "check", profile };
  }
  if (first === "import-claude-settings") {
    const settingsPath = others[0];
    const providerIndex = others.indexOf("--provider");
    const provider = providerIndex >= 0 ? others[providerIndex + 1] : undefined;
    if (
      settingsPath === undefined ||
      provider === undefined ||
      others.length !== 3 ||
      providerIndex !== 1
    ) {
      throw new CliError(
        "用法：cardigan launch import-claude-settings <settings.json> --provider <名字>",
        EXIT.usage,
      );
    }
    return { kind: "import", settingsPath, provider };
  }

  return {
    kind: "run",
    profile: first,
    cwd,
    printOnly,
    extra: [...others, ...extra],
  };
}

/** Entry point for everything under `cardigan launch`. */
export async function runLaunchCommand(
  args: readonly string[],
  io: CliIo,
): Promise<number> {
  const parsed = parseLaunchArgs(args);
  const paths = resolveLaunchPaths(io.env);

  switch (parsed.kind) {
    case "help":
      io.stdout(LAUNCH_USAGE);
      return EXIT.ok;
    case "list":
      return listProfiles(paths, io);
    case "check":
      return checkProfile(paths, io, parsed.profile);
    case "import":
      return importSettings(paths, io, parsed.settingsPath, parsed.provider);
    case "run":
      return runProfile(paths, io, parsed);
  }
}

async function listProfiles(paths: LaunchPaths, io: CliIo): Promise<number> {
  const config = await loadConfig(paths);
  const names = Object.keys(config.profiles).sort();
  if (names.length === 0) {
    io.stdout(
      `没有启动配置。编辑 ${paths.launchFile} 添加，或运行 import-claude-settings。`,
    );
    return EXIT.ok;
  }

  io.stdout(`启动配置（${paths.launchFile}）：`);
  for (const name of names) {
    const resolved = resolveProfile(config, name);
    const parts = [
      `harness=${resolved.profile.harness}`,
      `provider=${resolved.provider?.name ?? "-"}`,
      `model=${resolved.profile.model ?? "-"}`,
    ];
    io.stdout(`  ${name}  ${parts.join("  ")}`);
  }
  return EXIT.ok;
}
