import { spawn, spawnSync } from "node:child_process";
import { LaunchConfigError } from "@cardigan/roles";
import { runAdminCommand } from "./admin.js";
import { runAssignmentCommand } from "./assignment.js";
import { CliError, EXIT } from "./errors.js";
import type { CliIo } from "./io.js";
import { runLaunchCommand } from "./launch.js";
import { type CliHooks, runWorkflowCommand } from "./workflow.js";

export { parseAdminArgs, runAdminCommand } from "./admin.js";
export {
  agentNameFor,
  attachAssignment,
  projectSegment,
  projectShortCode,
  runAssignmentCommand,
  runDirectory,
  startAssignment,
  stopAssignment,
} from "./assignment.js";
export { CliError, EXIT } from "./errors.js";
export {
  humanActor,
  issueTokenForAssignment,
  resolveDataDir,
  resolveProject,
  runCommand,
} from "./host.js";
export type {
  CapturedOutput,
  CaptureOptions,
  CliIo,
  SpawnInheritOptions,
} from "./io.js";
export { parseLaunchArgs, runLaunchCommand } from "./launch.js";
export { type LaunchPaths, resolveLaunchPaths } from "./paths.js";
export { type CliHooks, runWorkflowCommand } from "./workflow.js";

const TOP_LEVEL_USAGE = [
  "cardigan — 卡片式多 Agent 协作开发系统",
  "",
  "用法：cardigan <命令>",
  "",
  "命令：",
  "  init             建库并执行迁移",
  "  project create   创建项目",
  "  role add         写入角色定义（allowed_tools、capabilities）",
  "  pm create        建常驻 PM Assignment 并签发 Token（--office / --ops）",
  "  pm start         一键启动 PM Office 与 PM Ops（已在运行就跳过）",
  "  card create      按 dev 模板建卡",
  "  assign           建 Assignment 并在同一事务里签发 Token",
  "  token issue      给已有 active Assignment 重新签发 Token（先作废旧 Token）",
  "  human-action done 标记人已执行完 h(n)",
  "  needs-you        看待你拍板和待你执行的事项",
  "  assignment start|stop|attach  一键启动/停止/接管 Assignment 的运行时（M2）",
  "  launch           按启动配置启动 Agent CLI（见 cardigan launch --help）",
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
  hooks: CliHooks = {},
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
    if (command === "assignment") {
      return await runAssignmentCommand(rest, io);
    }
    if (
      command === "card" ||
      command === "assign" ||
      command === "token" ||
      command === "pm" ||
      command === "needs-you" ||
      command === "human-action"
    ) {
      return await runWorkflowCommand([command, ...rest], io, hooks);
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
