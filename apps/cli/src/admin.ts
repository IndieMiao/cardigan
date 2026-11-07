import { type ToolName, toolNames } from "@cardigan/domain";
import { RoleVersionError, Store, writeRole } from "@cardigan/store";
import { CliError, EXIT } from "./errors.js";
import { announceDataDir, resolveProject } from "./host.js";
import type { CliIo } from "./io.js";
import { readRoleFile, roleFromFile } from "./role-file.js";

const ADMIN_USAGE = [
  "用法：",
  "  cardigan init [--data-dir <目录>]",
  "  cardigan project create <project_id> [--name <名字>] [--data-dir <目录>]",
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
  readonly subcommand?: "create" | "set-repo" | "add" | "update";
  readonly options: AdminOptions;
}

export function parseAdminArgs(args: readonly string[]): ParsedAdminArgs {
  const [command, ...rest] = args;
  const positionals: string[] = [];
  const flags: Record<string, string> = {};
  let dataDir: string | undefined;
  let subcommand: "create" | "add" | "update" | "set-repo" | undefined;

  let index = 0;
  if (command === "project") {
    const next = rest[0];
    const allowed = ["create", "set-repo"] as const;
    if (next === undefined || !(allowed as readonly string[]).includes(next)) {
      throw new CliError("用法：cardigan project create|set-repo", EXIT.usage, [
        ADMIN_USAGE,
      ]);
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
        token === "--project"
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
  const { command, subcommand, options } = parseAdminArgs(args);
  const dataDir = announceDataDir(io, options.dataDir);

  switch (command) {
    case "init":
      return initDatabase(dataDir, io);
    case "project":
      return options.flags.path === undefined
        ? createProject(dataDir, io, options)
        : setProjectRepo(dataDir, io, options);
    case "role":
      return options.flags.file === undefined
        ? addRole(dataDir, io, options)
        : writeRoleFile(dataDir, io, options, subcommand);
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
        `${result.error.code}: ${result.error.message}`,
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

/**
 * `cardigan role add|update --file <role.yaml> [--project <p>]`
 *
 * The store owns versioning: `add` writes v1, `update` appends the next
 * version, and old versions stay readable (§10.1, invariant 12).
 */
async function writeRoleFile(
  dataDir: string,
  io: CliIo,
  options: AdminOptions,
  subcommand: "add" | "update" | "create" | "set-repo" | undefined,
): Promise<number> {
  const filePath = options.flags.file as string;
  const isUpdate = subcommand === "update";
  const definition = await readRoleFile(filePath);

  const store = Store.open({ dataDir });
  try {
    const projectId = resolveProject(store, io, options.flags.project);
    const result = (() => {
      try {
        return store.uow.run((tx) =>
          writeRole(tx, projectId, roleFromFile(definition, 1), {
            mode: isUpdate ? "update" : "add",
          }),
        );
      } catch (error) {
        if (error instanceof RoleVersionError) {
          throw new CliError(error.message, EXIT.usage);
        }
        throw error;
      }
    })();
    io.stdout(
      [
        `${result.created ? "已创建" : "已更新"}角色 ${result.role.role_id} v${result.role.version}（项目 ${projectId}）`,
        `harness：${result.role.harness}；启动配置：${result.role.launch_profile_ref}`,
        `allowed_tools：${result.role.allowed_tools.join(", ") || "（无）"}`,
        `core_prompt：${result.role.core_prompt.length} 字`,
      ].join("\n"),
    );
    return EXIT.ok;
  } finally {
    store.close();
  }
}
