import type {
  Assignment,
  ProjectId,
  Runtime,
  RuntimeRef,
} from "@cardigan/domain";
import { abortDispatch, queueRun } from "@cardigan/domain";
import {
  agentCliVersion,
  applyCommand,
  HostLaunchError,
  harnessBinary,
  type LaunchEntities,
  launchEntities,
  launchRun,
  messageOf,
  type PreparedWorktree,
  reviewTargetSha,
  scrubRunCredentials,
  type WorktreeProvider,
  worktreeProvider,
} from "@cardigan/host";
import { type LaunchConfig, resolveProfile } from "@cardigan/roles";
import {
  type ExecutionConfig,
  HerdrRuntime,
  resolveExecutionConfig,
  secureDataDirectory,
} from "@cardigan/runtime-herdr";
import { Store, writeRole } from "@cardigan/store";
import { loadConfig, loadSecrets } from "./config.js";
import { CliError, EXIT } from "./errors.js";
import {
  humanActor,
  resolveDataDir,
  resolveProject,
  runCommand,
  systemClock,
} from "./host.js";
import type { CliIo } from "./io.js";
import { resolveLaunchPaths } from "./paths.js";

/**
 * M2.6: one-command Assignment start (M2 plan §4).
 *
 * The CLI owns what is specific to a human command — argument validation, the
 * launch profile and model choice, the Run queue and the worktree — and then
 * hands the Assignment to `@cardigan/host`'s `launchRun`, the same flow the
 * Dispatcher uses when it opens a terminal for a bell (M3 §3.1).
 */

export type {
  PreparedWorktree,
  RunDirectory,
  WorktreeProvider,
  WorktreeRequest,
} from "@cardigan/host";
export {
  agentNameFor,
  projectSegment,
  projectShortCode,
  runDirectory,
} from "@cardigan/host";

export type LaunchRuntime = Runtime &
  Partial<Pick<HerdrRuntime, "captureAgent">>;

export interface StartOptions {
  readonly store: Store;
  readonly io: CliIo;
  readonly project_id: ProjectId;
  readonly assignment_id: Assignment["id"];
  readonly launch: {
    readonly config: LaunchConfig;
    readonly secrets: Readonly<Record<string, string>>;
  };
  readonly mcpUrl: string;
  readonly runtime: LaunchRuntime;
  readonly dataDir: string;
  readonly worktree?: WorktreeProvider;
}

export interface StartedAssignment {
  readonly assignment: Assignment;
  readonly run_id: string;
  readonly runtime_ref: RuntimeRef;
  readonly run_dir: string;
  readonly worktree_path?: string;
  readonly token_id: string;
}

function requireAssignment(
  store: Store,
  project_id: ProjectId,
  assignment_id: Assignment["id"],
): LaunchEntities {
  try {
    return launchEntities(store, project_id, assignment_id);
  } catch (error) {
    throw new CliError(messageOf(error), EXIT.usage);
  }
}

async function cliVersion(io: CliIo, binary: string): Promise<string> {
  const captured = await io.captureCommand(binary, ["--version"], {
    cwd: io.cwd,
    env: Object.fromEntries(
      Object.entries(io.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    timeoutMs: 10000,
  });
  const text =
    `${captured.stdout}\n${captured.stderr}`.trim().split("\n")[0] ?? "";
  if (captured.code !== 0 || text.length === 0) {
    throw new CliError(
      `无法获取 ${binary} 的版本（${captured.code ?? "no exit code"}）`,
      EXIT.usage,
    );
  }
  return text;
}

const executionFor = (io: CliIo, dataDir: string): ExecutionConfig =>
  resolveExecutionConfig({
    ...io.env,
    CARDIGAN_DATA_DIR: resolveDataDir(io, dataDir),
  });

/** §4 step 3: place the worktree the Role needs (roles with `none` skip it). */
async function prepareWorktree(
  options: StartOptions,
  entities: LaunchEntities,
): Promise<PreparedWorktree | undefined> {
  const { store, project_id } = options;
  const { assignment, role, card, workItem } = entities;
  if (role.worktree === "none") return undefined;
  if (options.worktree === undefined)
    throw new CliError(
      "这个角色需要 worktree，但没有配置 Git 服务",
      EXIT.usage,
    );
  const source_repo = store.getProject(project_id)?.repo_path;
  if (source_repo === undefined || source_repo === null) {
    throw new CliError(
      `项目 ${project_id} 没有登记本地仓库，先运行 cardigan project set-repo --path <目录>`,
      EXIT.usage,
    );
  }
  const placed = await options.worktree({
    project_id,
    source_repo,
    assignment,
    role,
    ...(card === undefined ? {} : { card }),
    ...(workItem === undefined ? {} : { work_item: workItem }),
    ...(role.worktree === "readonly"
      ? { target_sha: reviewTargetSha(store, project_id, workItem) }
      : {}),
  });
  if (placed === undefined)
    throw new CliError("Git 服务没有给出 worktree", EXIT.failure);
  return placed;
}

/** Run the M2 plan §4 flow, compensating every step after a successful queue. */
export async function startAssignment(
  options: StartOptions,
): Promise<StartedAssignment> {
  const { store, io, project_id } = options;
  const execution = executionFor(io, options.dataDir);
  await secureDataDirectory(execution);

  const entities = requireAssignment(store, project_id, options.assignment_id);
  const { assignment, role } = entities;
  if (assignment.status !== "active") {
    throw new CliError(
      `Assignment 状态是 ${assignment.status}，只有 active 能启动`,
      EXIT.usage,
    );
  }

  // 2. queue the Run with a model/CLI snapshot (invariant 12).
  const model = resolveProfile(options.launch.config, role.launch_profile_ref)
    .profile.model;
  if (model === undefined) {
    throw new CliError(
      `启动配置 ${role.launch_profile_ref} 没有 model，Run 无法记录快照`,
      EXIT.usage,
    );
  }
  // The version probe runs as the Agent account in agent-ssh mode (M2.7).
  const version = await agentCliVersion(
    {
      execution,
      captureAgent: options.runtime.captureAgent?.bind(options.runtime),
      captureLocal: (binary) => cliVersion(io, binary),
    },
    harnessBinary(role.harness),
  );
  const run = runCommand(store, {
    project_id,
    actor: humanActor(project_id),
    reduce: (state, actor, ports) =>
      queueRun(
        state,
        actor,
        {
          assignment_id: assignment.id,
          model,
          agent_cli_version: version,
        },
        ports,
      ),
  });

  let delegated = false;
  try {
    // 3. worktree (roles that do not need one skip it).
    const worktree = await prepareWorktree(options, entities);

    // 4–8. token, run directory, provision, dispatch, sentinel: one shared flow
    // that compensates internally (`delegated` keeps the CLI from repeating it).
    delegated = true;
    const launched = await launchRun(
      {
        store,
        runtime: options.runtime,
        launch: options.launch,
        mcpUrl: options.mcpUrl,
        dataDir: options.dataDir,
        execution,
        report: (message) => io.stderr(message),
      },
      {
        project: project_id,
        assignment_id: assignment.id,
        run,
        actor: humanActor(project_id),
        ...(worktree === undefined ? {} : { worktree }),
      },
    );
    return {
      assignment: launched.assignment,
      run_id: launched.run.id,
      runtime_ref: launched.runtime_ref,
      run_dir: launched.run_dir,
      ...(launched.worktree_path === undefined
        ? {}
        : { worktree_path: launched.worktree_path }),
      token_id: launched.token_id,
    };
  } catch (error) {
    if (!delegated) {
      // Nothing was written yet: cancel the queued Run and make sure no
      // plaintext from a prepared directory survives (§4 step 9).
      try {
        await scrubRunCredentials(execution, project_id, assignment.id);
      } catch {
        io.stderr("凭据文件清理失败，需要人工检查");
      }
      abort(store, project_id, run.id, "worktree preparation failed");
    }
    if (error instanceof HostLaunchError)
      throw new CliError(
        `启动失败（${error.step}）：${error.message}`,
        EXIT.failure,
      );
    throw error;
  }
}

/** Abort the Run (best effort); the reason is recorded on it. */
export function abort(
  store: Store,
  project_id: ProjectId,
  run_id: string,
  reason: string,
): void {
  try {
    applyCommand(store, {
      project: project_id,
      actor: humanActor(project_id),
      clock: systemClock,
      reduce: (state, actor, ports) =>
        abortDispatch(state, actor, { run_id: run_id as never, reason }, ports),
    });
  } catch {
    // Nothing to abort (unknown or already finished Run).
  }
}

/** `cardigan assignment stop`: release the terminal, keep the worktree. */
export async function stopAssignment(input: {
  readonly store: Store;
  readonly project_id: ProjectId;
  readonly assignment_id: Assignment["id"];
  readonly runtime: Runtime;
  readonly execution?: ExecutionConfig;
}): Promise<{ released: boolean; aborted: boolean }> {
  const { assignment } = requireAssignment(
    input.store,
    input.project_id,
    input.assignment_id,
  );
  const ref = assignment.runtime_ref;
  if (ref === null) {
    throw new CliError(
      `Assignment ${assignment.id} 没有在运行的终端`,
      EXIT.usage,
    );
  }
  const released = await input.runtime.release(ref, { force: true });
  if (!released.ok && released.error.code !== "runtime_not_found") {
    throw new CliError(
      `释放终端失败：${released.error.code} ${released.error.message}`,
      EXIT.failure,
    );
  }
  const unfinished = input.store.uow.read((tx) =>
    tx.runs
      .list(input.project_id)
      .find(
        (run) =>
          run.assignment_id === assignment.id &&
          !["completed", "failed", "cancelled"].includes(run.status),
      ),
  );
  if (unfinished !== undefined) {
    abort(input.store, input.project_id, unfinished.id, "stopped by host");
  }
  // §9.1: the session is over, so its tokens die with it. A token that outlives
  // a stopped terminal could still read and write the project.
  const revoked = input.store.uow.run((tx) =>
    tx
      .tokensForAssignment(input.project_id, assignment.id)
      .filter((token) => token.revoked_at === null)
      .map((token) => tx.revokeToken(token.id)),
  );
  if (revoked.some((ok) => !ok)) {
    throw new CliError("作废 Token 失败", EXIT.failure);
  }
  if (input.execution)
    await scrubRunCredentials(
      input.execution,
      input.project_id,
      input.assignment_id,
    );
  return { released: true, aborted: unfinished !== undefined };
}

/** `cardigan assignment attach`: print the command a human can paste. */
export async function attachAssignment(input: {
  readonly store: Store;
  readonly project_id: ProjectId;
  readonly assignment_id: Assignment["id"];
  readonly runtime: Runtime;
}): Promise<string> {
  const { assignment } = requireAssignment(
    input.store,
    input.project_id,
    input.assignment_id,
  );
  const ref = assignment.runtime_ref;
  if (ref === null) {
    throw new CliError(
      `Assignment ${assignment.id} 没有在运行的终端`,
      EXIT.usage,
    );
  }
  const entry = await input.runtime.human_entry(ref);
  if (!entry.ok) {
    throw new CliError(
      `无法给出进入方式：${entry.error.code} ${entry.error.message}`,
      EXIT.failure,
    );
  }
  return entry.value;
}

export { writeRole };

const USAGE = [
  "用法：",
  "  cardigan assignment start <A-n> [--project <p>] [--mcp-url <url>] [--hc-session <s>] [--data-dir <目录>]",
  "  cardigan assignment stop <A-n> [--project <p>] [--hc-session <s>] [--data-dir <目录>]",
  "  cardigan assignment attach <A-n> [--project <p>] [--hc-session <s>] [--data-dir <目录>]",
].join("\n");

const DEFAULT_MCP_URL = "http://127.0.0.1:3004/mcp";

function parseArgs(args: readonly string[]) {
  const [sub, ...rest] = args;
  if (sub !== "start" && sub !== "stop" && sub !== "attach") {
    throw new CliError(
      "用法：cardigan assignment start|stop|attach",
      EXIT.usage,
      [USAGE],
    );
  }
  const flags: Record<string, string> = {};
  const positionals: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index] as string;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const value = rest[index + 1];
    if (value === undefined) {
      throw new CliError(`${token} 需要一个值`, EXIT.usage, [USAGE]);
    }
    flags[token.slice(2)] = value;
    index += 1;
  }
  const assignmentId = positionals[0];
  if (assignmentId === undefined) {
    throw new CliError("缺少 Assignment 编号（A-n）", EXIT.usage, [USAGE]);
  }
  return { sub, assignmentId: assignmentId as Assignment["id"], flags };
}

/** `cardigan assignment start|stop|attach` (M2.6). */
export async function runAssignmentCommand(
  args: readonly string[],
  io: CliIo,
): Promise<number> {
  const { sub, assignmentId, flags } = parseArgs(args);
  const dataDir = resolveDataDir(io, flags["data-dir"]);
  const execution = executionFor(io, dataDir);
  await secureDataDirectory(execution);
  const store = Store.open({ dataDir });
  try {
    const project_id = resolveProject(store, io, flags.project);
    const session =
      flags["hc-session"] ?? io.env.CARDIGAN_HC_SESSION ?? "cardigan";
    const created = await HerdrRuntime.create({ session, execution });
    if (!created.ok) {
      throw new CliError(
        `运行时不可用：${created.error.code} ${created.error.message}`,
        EXIT.failure,
      );
    }
    const runtime = created.value;

    if (sub === "stop") {
      const result = await stopAssignment({
        store,
        project_id,
        assignment_id: assignmentId,
        runtime,
        execution,
      });
      io.stdout(
        `已释放 ${assignmentId} 的终端${result.aborted ? "，未结束的 Run 已取消" : ""}（worktree 保留）`,
      );
      return EXIT.ok;
    }
    if (sub === "attach") {
      io.stdout(
        await attachAssignment({
          store,
          project_id,
          assignment_id: assignmentId,
          runtime,
        }),
      );
      return EXIT.ok;
    }
    return await startAssignmentCommand({
      store,
      io,
      project_id,
      assignment_id: assignmentId,
      runtime,
      dataDir: flags["data-dir"] ?? io.env.CARDIGAN_DATA_DIR ?? ".data",
      ...(flags["mcp-url"] === undefined ? {} : { mcpUrl: flags["mcp-url"] }),
    });
  } finally {
    store.close();
  }
}

export interface StartCommandOptions {
  readonly store: Store;
  readonly io: CliIo;
  readonly project_id: ProjectId;
  readonly assignment_id: Assignment["id"];
  readonly runtime: LaunchRuntime;
  readonly dataDir: string;
  readonly mcpUrl?: string;
}

/** Load the host config, wire the Git service and start one Assignment. */
export async function startAssignmentCommand(
  options: StartCommandOptions,
): Promise<number> {
  const { store, io, project_id, assignment_id, runtime } = options;
  const paths = resolveLaunchPaths(io.env);
  const dataDir = resolveDataDir(io, options.dataDir);
  const execution = executionFor(io, dataDir);
  const started = await startAssignment({
    store,
    io,
    project_id,
    assignment_id,
    launch: {
      config: await loadConfig(paths),
      secrets: await loadSecrets(paths, io),
    },
    mcpUrl: options.mcpUrl ?? io.env.CARDIGAN_MCP_URL ?? DEFAULT_MCP_URL,
    runtime,
    dataDir,
    worktree: worktreeProvider(execution, runtime),
  });

  io.stdout(
    [
      `已启动 ${started.assignment.id}（run ${started.run_id}）`,
      `终端：${started.runtime_ref.terminal_ref}（agent ${started.runtime_ref.agent_name}）`,
      `运行目录：${started.run_dir}`,
      ...(started.worktree_path === undefined
        ? []
        : [`worktree：${started.worktree_path}`]),
      "Token 已写入运行目录，由 launch.sh 读取后立即删除；这里不打印。",
    ].join("\n"),
  );
  return EXIT.ok;
}

export interface StartByIdOptions {
  readonly store: Store;
  readonly io: CliIo;
  readonly project_id: ProjectId;
  readonly assignment_id: Assignment["id"];
  readonly dataDir?: string;
  readonly mcpUrl?: string;
  readonly session?: string;
}
export type StartById = (options: StartByIdOptions) => Promise<number>;

/** Create the runtime and start one Assignment (used by `assign --start`). */
export async function startAssignmentById(
  options: StartByIdOptions,
): Promise<number> {
  const dataDir = resolveDataDir(options.io, options.dataDir);
  const execution = executionFor(options.io, dataDir);
  await secureDataDirectory(execution);
  const created = await HerdrRuntime.create({
    execution,
    session:
      options.session ?? options.io.env.CARDIGAN_HC_SESSION ?? "cardigan",
  });
  if (!created.ok) {
    throw new CliError(
      `运行时不可用：${created.error.code} ${created.error.message}`,
      EXIT.failure,
    );
  }
  return await startAssignmentCommand({
    ...options,
    runtime: created.value,
    dataDir,
  });
}
