import { type CpuProfileRole, cpuProfileCommand } from "@cardigan/host";
import { CliError, EXIT } from "./errors.js";
import { resolveDataDir, resolveGlobalActor } from "./host.js";
import type { CliIo } from "./io.js";

const usage =
  "cardigan cpu-profile start|stop|status --target web|background|both [--seconds 1..120] [--interval-us 1000..10000] [--data-dir <目录>]";

export function runCpuProfileCommand(
  args: readonly string[],
  io: CliIo,
): number {
  resolveGlobalActor(io); // Deny Token mode even when this helper is called directly.
  if (args.includes("--help") || args.includes("-h")) {
    io.stdout(usage);
    return EXIT.ok;
  }
  const [action, ...rest] = args;
  const flags: Record<string, string> = {};
  const invalid = (): never => {
    throw new CliError(usage, EXIT.usage);
  };
  if (action !== "start" && action !== "stop" && action !== "status") invalid();
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]?.slice(2),
      value = rest[i + 1];
    if (
      !rest[i]?.startsWith("--") ||
      !key ||
      !["target", "seconds", "interval-us", "data-dir"].includes(key) ||
      flags[key] !== undefined ||
      !value ||
      value.startsWith("--")
    )
      invalid();
    flags[key as string] = value as string;
  }
  if (
    !["web", "background", "both"].includes(flags.target ?? "") ||
    (action !== "start" &&
      (flags.seconds !== undefined || flags["interval-us"] !== undefined))
  )
    invalid();
  for (const key of ["seconds", "interval-us"])
    if (flags[key] !== undefined && !/^\d+$/u.test(flags[key] as string))
      invalid();
  try {
    const result = cpuProfileCommand({
      dataDir: resolveDataDir(io, flags["data-dir"]),
      action: action as "start" | "stop" | "status",
      target: flags.target as CpuProfileRole | "both",
      ...(flags.seconds === undefined
        ? {}
        : { seconds: Number(flags.seconds) }),
      ...(flags["interval-us"] === undefined
        ? {}
        : { intervalUs: Number(flags["interval-us"]) }),
    });
    io.stdout(JSON.stringify(result));
    return EXIT.ok;
  } catch (error) {
    // Never show raw filesystem, inspector, process or config errors.
    const code =
      error instanceof Error && /^cpu_profile_[a-z_]+$/u.test(error.message)
        ? error.message
        : "cpu_profile_io";
    throw new CliError(`CPU 录制操作未完成：${code}`, EXIT.failure);
  }
}
