import { suggestProjectCode } from "@cardigan/domain";
import { projectCodeSource, Store } from "@cardigan/store";
import { CliError, EXIT, formatCommandError } from "./errors.js";
import { announceDataDir, resolveProject } from "./host.js";
import type { CliIo } from "./io.js";
import { runRoleCommand } from "./role.js";

const ADMIN_USAGE = [
  "用法：",
  "  cardigan init [--data-dir <目录>]",
  "  cardigan project create <project_id> --code <代号> [--name <名字>] [--data-dir <目录>]",
  "  cardigan project code [--set <代号>] [--project <p>]",
  "  cardigan role add <project_id> <role_id> [--version <n>] [--allowed-tools a,b] [--capabilities x,y] [--data-dir <目录>]",
  "  cardigan role add --file <role.yaml> [--project <p>]",
  "  cardigan role update --file <role.yaml> [--project <p>]",
  "  cardigan project set-repo --path <本地仓库> [--base-branch main] [--project <p>]",
].join("\n");

const IDENTIFIER = /^[a-z0-9][a-z0-9._-]*$/;

export interface AdminOptions {
  readonly dataDir: string | undefined;
  readonly positionals: readonly string[];
  readonly flags: Readonly<Record<string, string>>;
}

/** Parse `init`, `project create` and `role add` arguments. */
export interface ParsedAdminArgs {
  readonly command: "init" | "project" | "role";
  readonly subcommand?: "create" | "set-repo" | "code" | "add" | "update";
  readonly options: AdminOptions;
}

export function parseAdminArgs(args: readonly string[]): ParsedAdminArgs {
  const [command, ...rest] = args;
  const positionals: string[] = [];
  const flags: Record<string, string> = {};
  let dataDir: string | undefined;
  let subcommand: "create" | "add" | "update" | "set-repo" | "code" | undefined;

  let index = 0;
  if (command === "project") {
    const next = rest[0];
    const allowed = ["create", "set-repo", "code"] as const;
    if (next === undefined || !(allowed as readonly string[]).includes(next)) {
      throw new CliError(
        "用法：cardigan project create|set-repo|code",
        EXIT.usage,
        [ADMIN_USAGE],
      );
    }
    subcommand = next as (typeof allowed)[number];
    index = 1;
  } else if (command === "role") {
    const next = rest[0];
    const allowed = ["add", "update"] as const;
    if (next === undefined || !(allowed as readonly string[]).includes(next)) {
      throw new CliError("用法：cardigan role add|update", EXIT.usage, [
        ADMIN_USAGE,
      ]);
    }
    subcommand = next as (typeof allowed)[number];
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
        token === "--capabilities" ||
        token === "--file" ||
        token === "--path" ||
        token === "--base-branch" ||
        token === "--project" ||
        token === "--code" ||
        token === "--set"
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
    return {
      command: "init",
      options: { dataDir, positionals, flags },
    };
  }
  if (command === "project" && subcommand === "set-repo") {
    if (flags.path === undefined) {
      throw new CliError(
        "用法：cardigan project set-repo --path <本地仓库>",
        EXIT.usage,
        [ADMIN_USAGE],
      );
    }
    return {
      command: "project",
      subcommand: "set-repo",
      options: { dataDir, positionals, flags },
    };
  }
  if (command === "project" && subcommand === "code") {
    if (positionals.length > 0) {
      throw new CliError(
        "用法：cardigan project code [--set <代号>] [--project <p>]",
        EXIT.usage,
        [ADMIN_USAGE],
      );
    }
    return {
      command: "project",
      subcommand: "code",
      options: { dataDir, positionals, flags },
    };
  }
  if (command === "project" && subcommand === "create") {
    if (positionals.length !== 1) {
      throw new CliError(
        "用法：cardigan project create <project_id>",
        EXIT.usage,
        [ADMIN_USAGE],
      );
    }
    return {
      command: "project",
      subcommand: "create",
      options: { dataDir, positionals, flags },
    };
  }
  if (command === "role" && (subcommand === "add" || subcommand === "update")) {
    if (flags.file !== undefined && positionals.length === 0) {
      return {
        command: "role",
        subcommand,
        options: { dataDir, positionals, flags },
      };
    }
    if (subcommand === "update") {
      throw new CliError("role update 需要 --file <role.yaml>", EXIT.usage, [
        ADMIN_USAGE,
      ]);
    }
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
  if (args[0] === "role") return runRoleCommand(args.slice(1), io);
  const { command, subcommand, options } = parseAdminArgs(args);
  const dataDir = announceDataDir(io, options.dataDir);

  switch (command) {
    case "init":
      return initDatabase(dataDir, io);
    case "project":
      if (subcommand === "code") return projectCode(dataDir, io, options);
      return options.flags.path === undefined
        ? createProject(dataDir, io, options)
        : setProjectRepo(dataDir, io, options);
    case "role":
      return runRoleCommand(args.slice(1), io);
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
    const code = options.flags.code;
    if (code === undefined) {
      // C-674: the code is required; offer the suggestion for this name.
      const suggestion = suggestProjectCode(
        projectCodeSource({
          id: projectId,
          name: options.flags.name ?? projectId,
        }),
        store.listProjects().flatMap((p) => (p.code ? [p.code] : [])),
      );
      throw new CliError(
        `创建项目需要 --code <代号>（3–4 位大写字母或数字，首位是字母，登记后不可改）；建议：--code ${suggestion}`,
        EXIT.usage,
        [ADMIN_USAGE],
      );
    }
    const created = store.createProject({
      id: projectId,
      code,
      ...(options.flags.name === undefined ? {} : { name: options.flags.name }),
    });
    if (!created.ok) {
      throw new CliError(
        formatCommandError("创建项目", projectId, created.error),
        EXIT.usage,
      );
    }
    io.stdout(
      `已创建项目 ${created.value.id}（${created.value.name}），代号 ${created.value.code}\n数据库：${dataDir}`,
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

/** C-674: `cardigan project code [--set <code>]` — view or register the project code. */
function projectCode(
  dataDir: string,
  io: CliIo,
  options: AdminOptions,
): number {
  const store = Store.open({ dataDir });
  try {
    const projectId = resolveProject(store, io, options.flags.project);
    const set = options.flags.set;
    if (set !== undefined) {
      const result = store.setProjectCode({ project_id: projectId, code: set });
      if (!result.ok)
        throw new CliError(
          formatCommandError("登记项目代号", projectId, result.error),
          EXIT.usage,
        );
      io.stdout(`项目 ${projectId} 已登记代号 ${result.value.code}`);
      return EXIT.ok;
    }
    const project = store.getProject(projectId);
    if (project?.code) {
      io.stdout(`项目 ${projectId} 的代号：${project.code}`);
      return EXIT.ok;
    }
    const suggestion = suggestProjectCode(
      projectCodeSource(project ?? { id: projectId, name: projectId }),
      store.listProjects().flatMap((p) => (p.code ? [p.code] : [])),
    );
    io.stdout(
      `项目 ${projectId} 还没有登记代号；建议：cardigan project code --set ${suggestion} --project ${projectId}`,
    );
    return EXIT.ok;
  } finally {
    store.close();
  }
}

/** `cardigan project set-repo --path <dir> [--base-branch main]` */
function setProjectRepo(
  dataDir: string,
  io: CliIo,
  options: AdminOptions,
): number {
  const store = Store.open({ dataDir });
  try {
    const explicit = options.flags.project ?? options.positionals[0];
    const projectId =
      explicit === undefined
        ? resolveProject(store, io, undefined)
        : requireIdentifier(explicit, "project_id");
    const result = store.setProjectRepo({
      project_id: projectId,
      repo_path: options.flags.path as string,
      ...(options.flags["base-branch"] === undefined
        ? {}
        : { base_branch: options.flags["base-branch"] }),
    });
    if (!result.ok) {
      throw new CliError(
        formatCommandError("设置项目仓库", projectId, result.error),
        EXIT.usage,
      );
    }
    io.stdout(
      [
        `项目 ${projectId} 的仓库：${result.value.repo_path}`,
        `默认基线分支：${result.value.base_branch}`,
      ].join("\n"),
    );
    return EXIT.ok;
  } finally {
    store.close();
  }
}
