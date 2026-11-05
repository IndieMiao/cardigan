import { MIN_WEB_PASSWORD_LENGTH, Store } from "@cardigan/store";
import { CliError, EXIT } from "./errors.js";
import { resolveDataDir } from "./host.js";
import type { CliIo } from "./io.js";

/**
 * `cardigan web ...` (M5 plan §4 M5.1, §0).
 *
 * The Workbench password is typed twice and never appears in argv, so it
 * cannot leak through the shell history, `ps` or a log line. Only the scrypt
 * hash reaches the database, and setting a new password revokes every session.
 */

const USAGE = [
  "用法：cardigan web set-password [--data-dir <目录>]",
  "",
  "  set-password   交互式设置 Workbench 登录密码（至少 12 位，输入两次）",
  "",
  "密码只能在这里设置，不能通过命令行参数传入；改密码会让所有已登录的会话立即失效。",
].join("\n");

export async function runWebCommand(
  argv: readonly string[],
  io: CliIo,
): Promise<number> {
  const [subcommand, ...rest] = argv;
  if (subcommand === "--help" || subcommand === "-h") {
    io.stdout(USAGE);
    return EXIT.ok;
  }
  if (subcommand !== "set-password") {
    io.stderr(USAGE);
    return EXIT.usage;
  }
  return setPassword(rest, io);
}

interface Flags {
  readonly dataDir: string | undefined;
}

function parseFlags(argv: readonly string[]): Flags {
  let dataDir: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--data-dir") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new CliError("--data-dir 需要一个目录", EXIT.usage);
      }
      dataDir = value;
      index += 1;
      continue;
    }
    throw new CliError(
      `不认识的参数：${argument ?? ""}\n\n${USAGE}`,
      EXIT.usage,
    );
  }
  return { dataDir };
}

async function setPassword(
  argv: readonly string[],
  io: CliIo,
): Promise<number> {
  if (!io.promptSecret) {
    throw new CliError(
      "当前环境无法交互输入密码；请在终端里运行 cardigan web set-password",
      EXIT.usage,
    );
  }
  const flags = parseFlags(argv);
  const prompt = io.promptSecret;

  const first = await prompt(
    `设置 Workbench 登录密码（至少 ${MIN_WEB_PASSWORD_LENGTH} 位）：`,
  );
  if (Array.from(first).length < MIN_WEB_PASSWORD_LENGTH) {
    throw new CliError(
      `密码至少 ${MIN_WEB_PASSWORD_LENGTH} 位，未做任何修改`,
      EXIT.usage,
    );
  }
  const second = await prompt("再输入一次以确认：");
  if (first !== second) {
    throw new CliError("两次输入不一致，未做任何修改", EXIT.usage);
  }

  const dataDir = resolveDataDir(io, flags.dataDir);
  const store = Store.open({ dataDir });
  try {
    store.setWebPassword(first);
  } finally {
    store.close();
  }
  io.stdout(
    [
      "已设置 Workbench 密码（只保存 scrypt 哈希）。",
      "所有已有的 Workbench 会话已立即失效；MCP Token 不受影响。",
      "密码不能通过命令行参数传入，忘记时重新运行这条命令即可。",
    ].join("\n"),
  );
  return EXIT.ok;
}
