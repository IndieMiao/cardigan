import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { resolve } from "node:path";
import type {
  Actor,
  AssignmentId,
  Clock,
  CommandEffect,
  CommandPorts,
  CommandState,
  ProjectId,
  Result,
  RoleReference,
} from "@cardigan/domain";
import { issueTokenInTransaction, loadMergeGateConfig } from "@cardigan/host";
import {
  authenticate,
  loadCommandState,
  persistEffect,
} from "@cardigan/mcp-server";
import { resolveDataDirectory } from "@cardigan/runtime-herdr";
import type {
  IssuedToken,
  Store,
  StoreTransactionContext,
} from "@cardigan/store";
import { openStore } from "@cardigan/store";
import { cliCommand, cliTool, requireCliTool } from "./command-access.js";
import { CliError, EXIT, formatCommandError } from "./errors.js";
import type { CliIo } from "./io.js";

/**
 * Host-side pieces shared by the CLI commands (§9.1, §10.2): the human actor,
 * the project selector, one transactional command runner and token issuance.
 */

export const systemClock: Clock = { now: () => new Date().toISOString() };

export function humanActor(project_id: ProjectId): Actor {
  return { kind: "human", project_id };
}

export function hasToken(io: Pick<CliIo, "env" | "tokenFile">): boolean {
  return io.env.CARDIGAN_TOKEN !== undefined || io.tokenFile !== undefined;
}

/** Global member/employee commands have no project to authenticate against. */
export function resolveGlobalActor(io: Pick<CliIo, "env" | "tokenFile">): {
  readonly kind: "human";
} {
  if (hasToken(io))
    throw new CliError("此命令仅限人类操作，Token 模式不可用。", EXIT.usage);
  return { kind: "human" };
}

/** Resolve the same identity as MCP; a supplied but unusable credential never
 * falls back to human. Call before opening a command transaction. */
export function resolveActor(
  io: Pick<CliIo, "env" | "tokenFile" | "cwd">,
  project_id: ProjectId,
  store: Store,
): Actor {
  return resolveCommandIdentity(io, project_id, store).actor;
}

/** Capture the original credential once; recheck it on the owning Store's write connection. */
export function resolveCommandIdentity(
  io: Pick<CliIo, "env" | "tokenFile" | "cwd">,
  project_id: ProjectId,
  store: Store,
): Pick<CommandRun<unknown>, "actor" | "revalidateActor"> {
  if (!hasToken(io)) return { actor: humanActor(project_id) };
  if (io.env.CARDIGAN_TOKEN !== undefined && io.tokenFile !== undefined)
    throw new CliError(
      "CARDIGAN_TOKEN 与 --token-file 不能同时提供。",
      EXIT.usage,
    );
  let token = io.env.CARDIGAN_TOKEN;
  if (io.tokenFile !== undefined) {
    let fd: number | undefined;
    try {
      fd = openSync(
        resolve(io.cwd, io.tokenFile),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const info = fstatSync(fd);
      if (!info.isFile() || (info.mode & 0o7777) !== 0o600)
        throw new CliError(
          "Token 文件必须是权限为 0600 的普通文件。",
          EXIT.usage,
        );
      token = readFileSync(fd, "utf8").trim();
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError("无法读取 Token 文件。", EXIT.usage);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  const credential = token ?? "";
  const result = authenticate(store, credential);
  if (!result.ok)
    throw new CliError(
      "Token 无效、已撤销或所属 Assignment 非 active。",
      EXIT.usage,
    );
  if (result.value.actor.project_id !== project_id)
    throw new CliError("Token 无权访问此项目。", EXIT.usage);
  const { actor, token: original } = result.value;
  return {
    actor,
    revalidateActor: () => {
      // verifyToken is a direct read on this connection, not a nested UnitOfWork.
      // Never reread a token file or substitute a newly issued credential.
      const current = store.verifyToken(credential);
      if (
        !current ||
        current.id !== original.id ||
        current.project_id !== project_id ||
        current.assignment_id !== actor.assignment_id ||
        current.role_version !== actor.role_version
      )
        throw new CliError("Token 无效、已撤销或身份已变更。", EXIT.usage);
      return {
        ...actor,
        allowed_tools: actor.allowed_tools.filter((tool) =>
          current.allowed_tools.includes(tool),
        ),
      };
    },
  };
}

/** One fail-closed gate for every index.ts route, including commands that
 * access the store/filesystem directly instead of running a domain command. */
export function authorizeCliInvocation(
  argv: readonly string[],
  io: CliIo,
): void {
  if (!hasToken(io)) return;
  const command = cliCommand(argv);
  if (cliTool(command) === null)
    throw new CliError("此命令仅限人类操作，Token 模式不可用。", EXIT.usage);
  const flag = (name: string): string | undefined => {
    let value: string | undefined;
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i] as string;
      if (arg === `--${name}`) value = argv[++i];
      else if (arg.startsWith(`--${name}=`)) value = arg.slice(name.length + 3);
    }
    return value;
  };
  const store = openStore({ dataDir: resolveDataDir(io, flag("data-dir")) });
  try {
    const project = resolveProject(store, io, flag("project"));
    requireCliTool(resolveActor(io, project, store), command);
  } finally {
    store.close();
  }
}

export async function loadProjectMergeGate(
  store: Store,
  project_id: ProjectId,
  io: CliIo,
  dataDir?: string,
) {
  const projects = store.listProjects();
  const config = await loadMergeGateConfig({
    dataDir: resolveDataDir(io, dataDir),
    baseBranches: Object.fromEntries(
      projects.map((p) => [p.id, p.base_branch ?? "main"]),
    ),
    projectIds: projects.map((p) => p.id),
    env: io.env,
  });
  return config.forProject(project_id);
}

export function resolveDataDir(io: CliIo, override?: string): string {
  return resolveDataDirectory(
    { ...io.env, CARDIGAN_DATA_DIR: override ?? io.env.CARDIGAN_DATA_DIR },
    io.cwd,
  );
}

/** Keep stdout machine-readable; disclose the actual store before opening it. */
export function announceDataDir(io: CliIo, override?: string): string {
  const path = resolveDataDir(io, override);
  io.stderr(`数据目录：${path}`);
  return path;
}

/**
 * Resolve the project a command works on: `--project`, `CARDIGAN_PROJECT`, or
 * the only project in the database.
 */
export function resolveProject(
  store: Store,
  io: CliIo,
  flag: string | undefined,
): ProjectId {
  const requested = flag ?? io.env.CARDIGAN_PROJECT;
  if (requested !== undefined && requested.trim().length > 0) {
    const project = store.getProject(requested.trim());
    if (project === undefined) {
      throw new CliError(
        `项目 ${requested} 不存在，先运行 cardigan project create ${requested} --code <代号>`,
        EXIT.usage,
      );
    }
    return project.id;
  }

  const projects = store.listProjects();
  const only = projects[0];
  if (projects.length === 1 && only !== undefined) {
    return only.id;
  }
  throw new CliError(
    projects.length === 0
      ? "还没有项目，先运行 cardigan project create <project_id> --code <代号>"
      : `有多个项目，请用 --project 指定：${projects.map((p) => (p.code ? `${p.id}（${p.code}）` : p.id)).join(", ")}`,
    EXIT.usage,
  );
}

export interface CommandRun<T> {
  /** CLI commands provide context; programmatic callers may omit it. */
  readonly operation?: string;
  readonly target?: string;
  readonly project_id: ProjectId;
  readonly actor: Actor;
  /** Revalidate the captured credential after acquiring the write lock, before any effects. */
  readonly revalidateActor?: () => Actor;
  /** The domain command, e.g. `createCard`, `assign`, `completeHumanAction`. */
  readonly reduce: (
    state: CommandState,
    actor: Actor,
    ports: CommandPorts,
  ) => Result<CommandEffect<T>>;
  /** Runs inside the same transaction, after the effect is persisted. */
  readonly after?: (transaction: StoreTransactionContext, data: T) => void;
  readonly clock?: Clock;
}

/**
 * Run one domain command in a single write transaction: load the project
 * snapshot, reduce it, persist the effect, then run `after` (token issuance
 * happens there, so the assignment and its token commit together).
 */
export function runCommand<T>(store: Store, run: CommandRun<T>): T {
  return store.uow.run((tx) => {
    const actor = run.revalidateActor?.() ?? run.actor;
    const state = loadCommandState(tx, run.project_id);
    const ports: CommandPorts = {
      clock: run.clock ?? systemClock,
      ids: tx.ids,
      ...(tx.unreservedAssignment
        ? { unreservedAssignment: tx.unreservedAssignment }
        : {}),
    };
    const result = run.reduce(state, actor, ports);
    if (!result.ok) {
      throw new CliError(
        formatCommandError(
          run.operation ?? "执行操作",
          run.target ?? `项目 ${run.project_id}`,
          result.error,
        ),
        EXIT.usage,
      );
    }
    persistEffect(tx, run.project_id, result.value);
    run.after?.(tx, result.value.data);
    return result.value.data;
  });
}

/**
 * The role row a token is scoped to, read inside an open transaction (the
 * command runner already holds the write lock, so `uow.read` would nest).
 */
export function roleInTransaction(
  tx: StoreTransactionContext,
  project_id: ProjectId,
  role_id: string,
  role_version: number,
): RoleReference {
  const role = tx.roles.get(project_id, { role_id, role_version });
  if (role === undefined) {
    throw new CliError(
      `角色 ${role_id} v${role_version} 不存在，先运行 cardigan role add`,
      EXIT.usage,
    );
  }
  return role;
}

/** The role row a token is scoped to, or a hint to run `role add` first. */
export function roleReference(
  store: Store,
  project_id: ProjectId,
  role_id: string,
  role_version: number,
): RoleReference {
  const role = store.uow.read((tx) =>
    tx.roles.get(project_id, { role_id, role_version }),
  );
  if (role === undefined) {
    throw new CliError(
      `角色 ${role_id} v${role_version} 不存在，先运行 cardigan role add`,
      EXIT.usage,
    );
  }
  return role;
}

/**
 * Issue a token for an assignment inside the caller's transaction. Any token of
 * that assignment that is still valid is revoked first (§9.1: a replaced
 * Session invalidates the old token).
 *
 * The rotation rule lives in `@cardigan/host`; a started Assignment uses the
 * same code path through `launchRun`, so both can never rotate differently.
 */
export function issueTokenForAssignment(
  tx: StoreTransactionContext,
  project_id: ProjectId,
  assignment_id: AssignmentId,
  role: Pick<RoleReference, "role_version" | "allowed_tools">,
): IssuedToken {
  return issueTokenInTransaction(tx, project_id, assignment_id, role);
}

/**
 * Print a freshly issued token exactly once. It is never written to a file, a
 * log line or the idempotency cache; the database only stores its hash.
 */
export function printToken(io: CliIo, issued: IssuedToken): void {
  io.stdout(
    [
      `token_id：${issued.record.id}`,
      "Token（只显示这一次，复制后请自行保存，不要写进仓库）：",
      issued.token,
    ].join("\n"),
  );
}
