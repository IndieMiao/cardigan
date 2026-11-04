import { spawn, spawnSync } from "node:child_process";
import { LaunchConfigError } from "@cardigan/roles";
import { runAdminCommand } from "./admin.js";
import { CliError, EXIT } from "./errors.js";
import type { CliIo } from "./io.js";
import { runLaunchCommand } from "./launch.js";

export { parseAdminArgs, runAdminCommand } from "./admin.js";
export { CliError, EXIT } from "./errors.js";
export type {
  CapturedOutput,
  CaptureOptions,
  CliIo,
  SpawnInheritOptions,
} from "./io.js";
export { parseLaunchArgs, runLaunchCommand } from "./launch.js";
export { type LaunchPaths, resolveLaunchPaths } from "./paths.js";

const TOP_LEVEL_USAGE = [
  "cardigan — 卡片式多 Agent 协作开发系统",
  "",
  "用法：cardigan <命令>",
  "",
  "命令：",
  "  init             建库并执行迁移",
  "  project create   创建项目",
  "  role add         写入角色定义（allowed_tools、capabilities）",
  "  launch           按启动配置启动 Agent CLI（见 cardigan launch --help）",
  "",
  "更多命令（card / assign / human-action）在 M1 后续任务里加入。",
].join("\n");

/** Real IO: process streams, real spawning, real filesystem. */
export function createProcessIo(): CliIo {
  return {
    env: process.env,
    cwd: process.cwd(),
    platform: process.platform,
    stdout: (text) => {
      process.stdout.write(`${text}\n`);
    },
    stderr: (text) => {
      process.stderr.write(`${text}\n`);
    },
    signals: {
      on: (signal, listener) => process.on(signal, listener),
      off: (signal, listener) => process.off(signal, listener),
    },
    spawnInherit: (command, args, options) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: "inherit",
      });
      const exit = new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => {
          if (signal !== null) {
            resolve(128 + signalNumber(signal));
            return;
          }
          resolve(code ?? EXIT.failure);
        });
      });
      return {
        pid: child.pid,
        exit,
        kill: (signal) => {
          child.kill(signal);
        },
      };
    },
    captureCommand: (command, args, options) => {
      const result = spawnSync(command, args, {
        cwd: options.cwd,
        env: options.env,
        encoding: "utf8",
        timeout: options.timeoutMs,
      });
      return Promise.resolve({
        code: result.status,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
      });
    },
  };
}

/**
 * Dispatch one CLI invocation. Returns the process exit code; it never calls
 * `process.exit`, so tests can drive it with fake IO.
 */
export async function main(
  argv: readonly string[],
  io: CliIo = createProcessIo(),
): Promise<number> {
  const [command, ...rest] = argv;

  try {
    if (command === undefined || command === "--help" || command === "-h") {
      io.stdout(TOP_LEVEL_USAGE);
      return EXIT.ok;
    }
    if (command === "launch") {
      return await runLaunchCommand(rest, io);
    }
    if (command === "init" || command === "project" || command === "role") {
      return await runAdminCommand([command, ...rest], io);
    }
    io.stderr(`不认识的命令：${command}\n\n${TOP_LEVEL_USAGE}`);
    return EXIT.usage;
  } catch (error) {
    if (error instanceof CliError) {
      io.stderr([error.message, ...error.details].join("\n"));
      return error.exitCode;
    }
    if (error instanceof LaunchConfigError) {
      io.stderr([error.message, ...error.details].join("\n"));
      return EXIT.usage;
    }
    io.stderr(
      `出错了：${error instanceof Error ? error.message : String(error)}`,
    );
    return EXIT.failure;
  }
}

function signalNumber(signal: NodeJS.Signals): number {
  const table: Partial<Record<NodeJS.Signals, number>> = {
    SIGINT: 2,
    SIGTERM: 15,
    SIGHUP: 1,
    SIGQUIT: 3,
  };
  return table[signal] ?? 0;
}
