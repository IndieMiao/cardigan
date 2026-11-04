import { type ToolName, toolNames } from "@cardigan/domain";
import { Store } from "@cardigan/store";
import { CliError, EXIT } from "./errors.js";
import type { CliIo } from "./io.js";

const ADMIN_USAGE = [
  "用法：",
  "  cardigan init [--data-dir <目录>]",
  "  cardigan project create <project_id> [--name <名字>] [--data-dir <目录>]",
  "  cardigan role add <project_id> <role_id> [--version <n>] [--allowed-tools a,b] [--capabilities x,y] [--data-dir <目录>]",
].join("\n");

const IDENTIFIER = /^[a-z0-9][a-z0-9._-]*$/;

export interface AdminOptions {
  readonly dataDir: string | undefined;
  readonly positionals: readonly string[];
  readonly flags: Readonly<Record<string, string>>;
}

/** Parse `init`, `project create` and `role add` arguments. */
export function parseAdminArgs(args: readonly string[]): {
  command: "init" | "project" | "role";
  options: AdminOptions;
} {
  const [command, ...rest] = args;
  const positionals: string[] = [];
  const flags: Record<string, string> = {};
  let dataDir: string | undefined;
  let subcommand: "create" | "add" | undefined;

  let index = 0;
  if (command === "project" || command === "role") {
    const next = rest[0];
    if (next !== "create" && next !== "add") {
      throw new CliError(
        `用法：cardigan ${command} ${command === "project" ? "create" : "add"}`,
        EXIT.usage,
        [ADMIN_USAGE],
      );
    }
    subcommand = next;
    index = 1;
  }

  for (; index < rest.length; index += 1) {
    const token = rest[index] as string;
    if (token.startsWith("--")) {
      const value = rest[index + 1];
      if (value === undefined) {
        throw new CliError(`${token} 需要一个值`, EXIT.usage, [ADMIN_USAGE]);
      }
      if (token === "--data-dir") {
        dataDir = value;
      } else if (
        token === "--name" ||
        token === "--version" ||
        token === "--allowed-tools" ||
        token === "--capabilities"
      ) {
        flags[token.slice(2)] = value;
      } else {
        throw new CliError(`不认识的选项：${token}`, EXIT.usage, [ADMIN_USAGE]);
      }
      index += 1;
      continue;
    }
    positionals.push(token);
  }

  if (command === "init") {
    if (positionals.length > 0) {
      throw new CliError("init 不接受位置参数", EXIT.usage, [ADMIN_USAGE]);
    }
    return { command: "init", options: { dataDir, positionals, flags } };
  }
  if (command === "project" && subcommand === "create") {
    if (positionals.length !== 1) {
      throw new CliError(
        "用法：cardigan project create <project_id>",
        EXIT.usage,
        [ADMIN_USAGE],
      );
    }
    return { command: "project", options: { dataDir, positionals, flags } };
  }
  if (command === "role" && subcommand === "add") {
    if (positionals.length !== 2) {
      throw new CliError(
        "用法：cardigan role add <project_id> <role_id>",
        EXIT.usage,
        [ADMIN_USAGE],
      );
    }
    return { command: "role", options: { dataDir, positionals, flags } };
  }

  throw new CliError(`不认识的命令：${args.join(" ")}`, EXIT.usage, [
    ADMIN_USAGE,
  ]);
}

/** Entry point for `init`, `project create` and `role add`. */
export async function runAdminCommand(
  args: readonly string[],
  io: CliIo,
): Promise<number> {
  const { command, options } = parseAdminArgs(args);
  const dataDir = options.dataDir ?? io.env.CARDIGAN_DATA_DIR ?? ".data";

  switch (command) {
    case "init":
      return initDatabase(dataDir, io);
    case "project":
      return createProject(dataDir, io, options);
    case "role":
      return addRole(dataDir, io, options);
  }
}

/** Create the database, run migrations and report where it lives. */
function initDatabase(dataDir: string, io: CliIo): number {
  const store = Store.open({ dataDir });
  try {
    io.stdout(
      [
        `数据库：${dataDir}`,
        `schema 版本：${store.schemaVersion()}`,
        `项目数：${store.listProjects().length}`,
      ].join("\n"),
    );
    return EXIT.ok;
  } finally {
    store.close();
  }
}

function createProject(
  dataDir: string,
  io: CliIo,
  options: AdminOptions,
): number {
  const projectId = requireIdentifier(options.positionals[0], "project_id");
  const store = Store.open({ dataDir });
  try {
    const created = store.createProject({
      id: projectId,
      ...(options.flags.name === undefined ? {} : { name: options.flags.name }),
    });
    if (!created.ok) {
      throw new CliError(created.error.message, EXIT.usage);
    }
    io.stdout(
      `已创建项目 ${created.value.id}（${created.value.name}）\n数据库：${dataDir}`,
    );
    return EXIT.ok;
  } finally {
    store.close();
  }
}

function addRole(dataDir: string, io: CliIo, options: AdminOptions): number {
  const projectId = requireIdentifier(options.positionals[0], "project_id");
  const roleId = requireIdentifier(options.positionals[1], "role_id");
  const version = parseVersion(options.flags.version);
  const allowedTools = parseTools(options.flags["allowed-tools"]);
  const capabilities = parseList(options.flags.capabilities);

  const store = Store.open({ dataDir });
  try {
    if (store.getProject(projectId) === undefined) {
      throw new CliError(
        `项目 ${projectId} 不存在，先运行 cardigan project create ${projectId}`,
        EXIT.usage,
      );
    }

    store.uow.run((tx) => {
      tx.roles.put(projectId, {
        role_id: roleId,
        role_version: version,
        allowed_tools: allowedTools,
        capabilities,
      });
    });

    io.stdout(
      [
        `已写入角色 ${roleId} v${version}（项目 ${projectId}）`,
        `allowed_tools：${allowedTools.join(", ") || "（无）"}`,
        `capabilities：${capabilities.join(", ") || "（无）"}`,
      ].join("\n"),
    );
    return EXIT.ok;
  } finally {
    store.close();
  }
}

function requireIdentifier(value: string | undefined, what: string): string {
  if (value === undefined || !IDENTIFIER.test(value)) {
    throw new CliError(
      `${what} 不合法：${JSON.stringify(value)}；只允许小写字母、数字和 . _ -`,
      EXIT.usage,
    );
  }
  return value;
}

function parseVersion(value: string | undefined): number {
  if (value === undefined) {
    return 1;
  }
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new CliError(
      `--version 必须是正整数，收到 ${JSON.stringify(value)}`,
      EXIT.usage,
    );
  }
  return version;
}

function parseTools(value: string | undefined): ToolName[] {
  const names = parseList(value);
  const known = new Set<string>(toolNames);
  const unknown = names.filter((name) => !known.has(name));
  if (unknown.length > 0) {
    throw new CliError(`不认识的工具：${unknown.join(", ")}`, EXIT.usage, [
      `可用工具：${toolNames.join(", ")}`,
    ]);
  }
  return names as ToolName[];
}

function parseList(value: string | undefined): string[] {
  if (value === undefined) {
    return [];
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}
