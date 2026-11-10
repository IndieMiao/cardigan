import { spawn, spawnSync } from "node:child_process";
import { LaunchConfigError } from "@cardigan/roles";
import { runAdminCommand } from "./admin.js";
import { runAssignmentCommand } from "./assignment.js";
import { runContentCommand } from "./content.js";
import { runEmployeeCommand } from "./employee.js";
import { CliError, EXIT } from "./errors.js";
import { attentionCommand, inboxCommand } from "./inbox.js";
import type { CliIo } from "./io.js";
import { runLaunchCommand } from "./launch.js";
import { runMergeCommand } from "./merge.js";
import { runPreferenceCommand } from "./preference.js";
import { runTemplateCommand } from "./template.js";
import { runWebCommand } from "./web.js";
import { type CliHooks, runWorkflowCommand } from "./workflow.js";
import { runWorktreeCommand } from "./worktree.js";

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
export { attentionCommand, inboxCommand } from "./inbox.js";
export type {
  CapturedOutput,
  CaptureOptions,
  CliIo,
  SpawnInheritOptions,
} from "./io.js";
export { parseLaunchArgs, runLaunchCommand } from "./launch.js";
export { runMergeCommand } from "./merge.js";
export { type LaunchPaths, resolveLaunchPaths } from "./paths.js";
export { runWebCommand } from "./web.js";
export { type CliHooks, runWorkflowCommand } from "./workflow.js";
export { runWorktreeCommand } from "./worktree.js";

const TOP_LEVEL_USAGE = [
  "cardigan — 卡片式多 Agent 协作开发系统",
  "  employee add|list|update|deactivate|activate  管理全局员工",
  "",
  "用法：cardigan <命令>",
  "",
  "命令：",
  "  init             建库并执行迁移",
  "  project create   创建项目",
  "  role add         写入角色定义（allowed_tools、capabilities）",
  "  pm create        建常驻 PM Assignment 并签发 Token（--office / --ops）",
  "  pm start         一键启动 PM Office 与 PM Ops（已在运行就跳过）",
  "  preference get|set auto-merge-after  查看或修改超时自动合并偏好",
  "  template list|show|add|copy|update|deactivate|activate|rollback  管理项目模板",
  "  card create      按模板建卡（默认 dev）",
  "  card done        用 --result 记录结果并完成人工完成的卡片，可重复 --file 附证据",
  "  card update      修改或取消卡片；--superseded-by <C-m> 标记取代（已完成卡片不能取消；见 cardigan card --help）",
  "  comment add      发评论：--text <内容> 或 --text-file <路径>，可重复 --file 附文件，--note <说明>",
  "  attachment add   上传附件：--file <路径> [--note <说明>] [--kind evidence|artifact] [--basis <q(n)>] [--entry <C-n#k>]",
  "  assign           建 Assignment 并在同一事务里签发 Token",
  "  token issue      给已有 active Assignment 重新签发 Token（先作废旧 Token）",
  "  human-action done 标记人已执行完 h(n)",
  "  needs-you        看待你拍板和待你执行的事项",
  "  inbox            待投递和投递失败的通知（--assignment A-n 只看一个）",
  "  attention        升级通知与失联的 Assignment",
  "  assignment start|stop|attach  一键启动/停止/接管 Assignment 的运行时（M2）",
  "  merge status|confirm|request|request-changes  查看或确认合并、重新发起确认、退回修改（--reason 必填）",
  "  worktree diff|clean|keep      看 worktree 改动、强制清理或保留（M4）",
  "  web set-password 交互式设置 Workbench 登录密码（M5）",
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
    promptSecret: (question) => promptSecret(question),
  };
}

/**
 * Ask for a secret without echoing it (M5 plan §0: `web set-password`).
 *
 * The prompt goes to stderr so a caller can still pipe the command's stdout.
 * On a TTY the terminal is switched to raw mode and nothing is echoed, which
 * also keeps the password out of the scrollback; on a pipe the first line is
 * read, so the command stays scriptable without accepting secrets in argv.
 */
async function promptSecret(question: string): Promise<string> {
  const stdin = process.stdin;
  process.stderr.write(question);

  if (!stdin.isTTY) {
    let buffer = "";
    for await (const chunk of stdin) {
      buffer += String(chunk);
      const newline = buffer.indexOf("\n");
      if (newline >= 0) return buffer.slice(0, newline).replace(/\r$/u, "");
      if (buffer.length > 4096) break;
    }
    return buffer.trim();
  }

  return new Promise<string>((resolve) => {
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const finish = (result: string): void => {
      stdin.off("data", onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      process.stderr.write("\n");
      resolve(result);
    };
    const onData = (chunk: string): void => {
      for (const character of chunk) {
        if (character === "\r" || character === "\n") {
          finish(value);
          return;
        }
        if (character === "\u0003") {
          // Ctrl-C: leave the terminal usable and report an empty password,
          // which the command itself refuses.
          finish("");
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = Array.from(value).slice(0, -1).join("");
          continue;
        }
        value += character;
      }
    };
    stdin.on("data", onData);
  });
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
    if (command === "employee") return await runEmployeeCommand(rest, io);
    if (command === "init" || command === "project" || command === "role") {
      return await runAdminCommand([command, ...rest], io);
    }
    if (command === "assignment") {
      return await runAssignmentCommand(rest, io);
    }
    if (command === "preference") return runPreferenceCommand(rest, io);
    if (command === "template") return await runTemplateCommand(rest, io);
    if (command === "comment" || command === "attachment") {
      return await runContentCommand(command, rest, io);
    }
    if (command === "merge") return runMergeCommand(rest, io);
    if (command === "web") return await runWebCommand(rest, io);
    if (command === "worktree") return await runWorktreeCommand(rest, io);
    if (command === "inbox") return inboxCommand(rest, io);
    if (command === "attention") return attentionCommand(rest, io);
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
