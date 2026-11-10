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
import { issueTokenInTransaction } from "@cardigan/host";
import { loadCommandState, persistEffect } from "@cardigan/mcp-server";
import { resolveDataDirectory } from "@cardigan/runtime-herdr";
import type {
  IssuedToken,
  Store,
  StoreTransactionContext,
} from "@cardigan/store";
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
        `项目 ${requested} 不存在，先运行 cardigan project create ${requested}`,
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
      ? "还没有项目，先运行 cardigan project create <project_id>"
      : `有多个项目，请用 --project 指定：${projects.map((p) => p.id).join(", ")}`,
    EXIT.usage,
  );
}

export interface CommandRun<T> {
  /** CLI commands provide context; programmatic callers may omit it. */
  readonly operation?: string;
  readonly target?: string;
  readonly project_id: ProjectId;
  readonly actor: Actor;
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
    const state = loadCommandState(tx, run.project_id);
    const ports: CommandPorts = {
      clock: run.clock ?? systemClock,
      ids: tx.ids,
    };
    const result = run.reduce(state, run.actor, ports);
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
