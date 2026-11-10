import type {
  Assignment,
  ProjectId,
  Runtime,
  RuntimeRef,
} from "@cardigan/domain";
import {
  abortDispatch,
  pauseStandingAssignment,
  queueRun,
  standingModeOf,
} from "@cardigan/domain";
import {
  agentCliVersion,
  applyCommand,
  HostLaunchError,
  harnessBinary,
  type LaunchEntities,
  launchEntities,
  launchRun,
  loadRunCapacityConfig,
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
import {
  finishBellAttempt,
  Store,
  unfinishedBellAttempts,
  writeRole,
} from "@cardigan/store";
import { loadConfig, loadSecrets } from "./config.js";
import {
  CliError,
  EXIT,
  formatCommandError,
  formatLaunchError,
} from "./errors.js";
import {
  announceDataDir,
  humanActor,
  resolveDataDir,
  resolveProject,
  runCommand,
  systemClock,
} from "./host.js";
import type { CliIo, SpawnedChild } from "./io.js";
import { resolveLaunchPaths } from "./paths.js";
import { forwardSignals } from "./signals.js";

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
  // A standing Assignment has no work item to check out; keep it in the run
  // directory even when its role is readonly (M5.S S13).
  if (
    role.worktree === "none" ||
    assignment.scope !== "work_item" ||
    !card?.repo
  )
    return undefined;
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
  const capacity = await loadRunCapacityConfig({ env: io.env });
  for (const error of capacity.errors) io.stderr(error);
  const execution = executionFor(io, options.dataDir);
  await secureDataDirectory(execution);

  const entities = requireAssignment(store, project_id, options.assignment_id);
  const { assignment, role, employee } = entities;
  const resuming =
    assignment.scope === "standing" &&
    assignment.role_id === "pm" &&
    assignment.status === "suspended";
  if (assignment.status !== "active" && !resuming) {
    throw new CliError(
      `Assignment 状态是 ${assignment.status}，只有 active 能启动`,
      EXIT.usage,
    );
  }

  // 2. queue the Run with a model/CLI snapshot (invariant 12).
  const profileRef = employee?.launch_profile_ref ?? role.launch_profile_ref;
  const profile = resolveProfile(options.launch.config, profileRef).profile;
  const model = profile.model;
  if (model === undefined) {
    throw new CliError(
      `启动配置 ${profileRef} 没有 model，Run 无法记录快照`,
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
    harnessBinary(profile.harness),
  ).catch((error: unknown) => {
    const message = formatLaunchError(assignment.id, error);
    if (message) throw new CliError(message, EXIT.failure);
    throw error;
  });
  if (resuming && assignment.runtime_ref)
    await closeStandingTerminal(options.runtime, assignment.runtime_ref);
  const run = runCommand(store, {
    operation: "启动 Assignment",
    target: assignment.id,
    project_id,
    actor: humanActor(project_id),
    reduce: (state, actor, ports) =>
      queueRun(
        state,
        actor,
        {
          assignment_id: assignment.id,
          reuse_queued: true,
          model,
          agent_cli_version: version,
          launch_profile_ref: profileRef,
          ...(resuming ? { resume: true } : {}),
        },
        ports,
      ),
  });

  try {
    // 3–8. Claim queued work before Git preparation, then use the shared
    // token/provision/dispatch flow and its failure compensation.
    const launched = await launchRun(
      {
        store,
        runtime: options.runtime,
        runLimit: capacity.forMachine,
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
        reuse_session: true,
        prepare_worktree: () => prepareWorktree(options, entities),
        ...(resuming
          ? {
              first_prompt: resumedBells(store, project_id, assignment, run.id),
            }
          : {}),
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
    if (resuming) pauseStanding(store, project_id, assignment.id);
    const message = formatLaunchError(assignment.id, error);
    if (message) throw new CliError(message, EXIT.failure);
    if (error instanceof HostLaunchError)
      throw new CliError(
        `启动失败（${error.step}）：${error.message}`,
        EXIT.failure,
      );
    throw error;
  }
}

function pauseStanding(
  store: Store,
  project_id: ProjectId,
  assignment_id: Assignment["id"],
) {
  return runCommand(store, {
    operation: "暂停常驻 PM",
    target: assignment_id,
    project_id,
    actor: humanActor(project_id),
    reduce: (s, a, p) => pauseStandingAssignment(s, a, { assignment_id }, p),
    after: (tx) => {
      const at = systemClock.now();
      for (const token of tx.tokensForAssignment(project_id, assignment_id))
        if (token.revoked_at === null) tx.revokeToken(token.id);
      // A late external result from an interrupted attempt must not escalate a manual stop.
      for (const attempt of unfinishedBellAttempts(store.database, project_id))
        if (attempt.assignment_id === assignment_id)
          finishBellAttempt(
            store.database,
            project_id,
            attempt.id,
            "failed",
            // Keep the intent timestamp monotonic if the host clock moved back.
            new Date(
              Math.max(Date.parse(at), Date.parse(attempt.started_at)),
            ).toISOString(),
          );
    },
  });
}
async function closeStandingTerminal(runtime: Runtime, ref: RuntimeRef) {
  const result = await runtime.release(ref, { force: true });
  if (!result.ok && result.error.code !== "runtime_not_found")
    throw new CliError(
      formatCommandError("关闭终端", "常驻 PM（已暂停）", result.error),
      EXIT.failure,
    );
}
function resumedBells(
  store: Store,
  project: ProjectId,
  a: Assignment,
  run: string,
): string {
  const recipient = standingModeOf(a) === "office" ? "pm_office" : "pm_ops";
  const owners = new Map(
    store.uow
      .read((tx) => tx.runs.list(project))
      .map((r) => [r.id, r.assignment_id]),
  );
  const notes = store
    .listNotifications({ project_id: project })
    .filter(
      (n) =>
        ["pending", "belled", "delivery_failed"].includes(n.status) &&
        (n.run_id && owners.has(n.run_id)
          ? owners.get(n.run_id) === a.id
          : n.recipient.kind === "assignment"
            ? n.recipient.assignment_id === a.id
            : n.recipient.kind === recipient),
    );
  return [
    `[bell] project=${project} asg=${a.id} run=${run} kind=initial`,
    ...notes.map(
      (n) =>
        `[bell] ${n.card_id ? `card=${n.card_id}` : `project=${project}`} asg=${a.id} run=${run} seq=${n.seq}`,
    ),
    "常驻 PM 已由人恢复。请调用 whoami，再逐条读取这些流的 get_updates 并 ack_events，处理暂停期间的更新。",
  ].join("\n");
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
}): Promise<{ released: boolean; aborted: boolean; paused?: boolean }> {
  const { assignment } = requireAssignment(
    input.store,
    input.project_id,
    input.assignment_id,
  );
  const ref = assignment.runtime_ref;
  if (assignment.scope === "standing" && assignment.role_id === "pm") {
    const paused = pauseStanding(input.store, input.project_id, assignment.id);
    try {
      if (ref) await closeStandingTerminal(input.runtime, ref);
    } finally {
      if (input.execution)
        await scrubRunCredentials(
          input.execution,
          input.project_id,
          assignment.id,
        );
    }
    return { released: ref !== null, aborted: paused.aborted, paused: true };
  }
  if (ref === null) {
    throw new CliError(
      `Assignment ${assignment.id} 没有在运行的终端`,
      EXIT.usage,
    );
  }
  const released = await input.runtime.release(ref, { force: true });
  if (!released.ok && released.error.code !== "runtime_not_found") {
    throw new CliError(
      formatCommandError("释放终端", assignment.id, released.error),
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

function attachRef(
  store: Store,
  project: ProjectId,
  id: Assignment["id"],
): RuntimeRef {
  const assignment = store.uow.read((tx) => tx.assignments.get(project, id));
  if (!assignment)
    throw new CliError(
      `Assignment ${id} 在当前项目中不存在；请检查编号和 --project，或用 cardigan assign 指派工作项。`,
      EXIT.usage,
    );
  if (assignment.status !== "active")
    throw new CliError(
      `Assignment ${id} ${assignment.status === "released" ? "已释放" : "已暂停"}，无法接入；请在执行视图检查状态，需继续工作时重新指派。`,
      EXIT.usage,
    );
  if (
    assignment.runtime_ref === null ||
    assignment.runtime_state === "released"
  )
    throw new CliError(
      `Assignment ${id} 没有在运行的终端；请用 cardigan assignment start ${id} 启动。`,
      EXIT.usage,
    );
  return assignment.runtime_ref;
}

function attachFailure(id: Assignment["id"], reason: string): CliError {
  return new CliError(
    `无法接入 ${id}：${reason}；请检查运行服务，终端已结束时用 cardigan assignment start ${id} 重新启动。`,
    EXIT.failure,
  );
}

interface AttachOptions {
  readonly store: Store;
  readonly project_id: ProjectId;
  readonly assignment_id: Assignment["id"];
  readonly runtime: Pick<HerdrRuntime, "human_entry" | "probeTerminal">;
  readonly printOnly?: boolean;
}

/** Return a copyable command; an uncertain probe cannot block printing. */
export async function attachAssignment(input: AttachOptions): Promise<string> {
  return (await prepareAttach({ ...input, printOnly: true })).entry;
}

async function prepareAttach(input: AttachOptions) {
  const ref = attachRef(input.store, input.project_id, input.assignment_id);
  const entry = await input.runtime.human_entry(ref);
  if (!entry.ok) {
    throw attachFailure(
      input.assignment_id,
      formatCommandError("获取终端进入方式", input.assignment_id, entry.error),
    );
  }
  // Attach needs only hc get's process state. Runtime.status also subscribes
  // to events for an observed_seq; a wrapper's surviving stream can hold its
  // pipes open during cleanup and prevent even a non-TTY CLI from exiting.
  const status = await input.runtime.probeTerminal(ref);
  if (status.ok && status.value === "exited")
    throw attachFailure(input.assignment_id, "终端已结束");
  if (!input.printOnly) {
    if (!status.ok)
      throw attachFailure(
        input.assignment_id,
        formatCommandError("查询终端", input.assignment_id, status.error),
      );
    if (status.value !== "alive")
      throw attachFailure(input.assignment_id, "无法确认终端仍在运行");
  }
  return { ref, entry: entry.value };
}

async function enterAssignment(
  io: CliIo,
  runtime: HerdrRuntime,
  ref: RuntimeRef,
  id: Assignment["id"],
  interactive: boolean,
): Promise<number> {
  io.stderr(
    interactive
      ? "将接管终端输入：你的输入会直接发给正在工作的 Agent；按 Ctrl+\\ 分离退出。"
      : "只读观察（不发送输入）；按 Ctrl+\\ 分离退出；使用 --interactive 接管后，你的输入会直接发给正在工作的 Agent。",
  );
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(io.env))
    if (value !== undefined) env[key] = value;
  env.HC_SESSION = runtime.session;
  env.HC_SOCKET = runtime.socketPath;
  let child: SpawnedChild | undefined;
  const dispose = forwardSignals(
    { kill: (signal) => child?.kill(signal) },
    io.signals,
  );
  try {
    child = io.spawnInherit(
      "hc",
      ["attach", ...(interactive ? [] : ["--observe"]), ref.terminal_ref],
      // Keep stdin/stdout attached to the caller's TTY; translate hc failures,
      // including a terminal disappearing after the preflight, on stderr.
      { cwd: io.cwd, env, stderr: "ignore" },
    );
    const code = await child.exit;
    if (code !== 0)
      io.stderr(
        attachFailure(id, `终端连接已中断或不可用（退出码 ${code}）`).message,
      );
    return code;
  } catch {
    throw attachFailure(
      id,
      "无法执行 hc，请确认已安装 hc 0.1.18 且可从 PATH 访问",
    );
  } finally {
    dispose();
  }
}

export { writeRole };

const USAGE = [
  "用法：",
  "  cardigan assignment start <A-n> [--project <p>] [--mcp-url <url>] [--hc-session <s>] [--data-dir <目录>]",
  "  cardigan assignment stop <A-n> [--project <p>] [--hc-session <s>] [--data-dir <目录>]",
  "  cardigan assignment attach <A-n> [--print] [--interactive] [--project <p>] [--hc-session <s>] [--data-dir <目录>]",
  "  attach：输入和输出均为终端（TTY）时直接只读观察；--interactive 允许输入，--print 或非 TTY 只打印命令（默认带 --observe）。",
  "  按 Ctrl+\\ 分离退出；--interactive 下你的输入会直接发给正在工作的 Agent。",
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
    if (sub === "attach" && ["--print", "--interactive"].includes(token)) {
      flags[token.slice(2)] = "true";
      continue;
    }
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
  if (args.includes("--help") || args.includes("-h")) {
    io.stdout(USAGE);
    return EXIT.ok;
  }
  const { sub, assignmentId, flags } = parseArgs(args);
  const dataDir = announceDataDir(io, flags["data-dir"]);
  const execution = executionFor(io, dataDir);
  await secureDataDirectory(execution);
  const store = Store.open({ dataDir });
  try {
    const project_id = resolveProject(store, io, flags.project);
    // Report invalid Assignments even when hc itself is unavailable.
    if (sub === "attach") attachRef(store, project_id, assignmentId);
    if (sub === "stop") {
      const { assignment } = requireAssignment(store, project_id, assignmentId);
      if (assignment.scope === "standing" && assignment.role_id === "pm") {
        pauseStanding(store, project_id, assignment.id);
        await scrubRunCredentials(execution, project_id, assignment.id);
      }
    }
    const session =
      flags["hc-session"] ?? io.env.CARDIGAN_HC_SESSION ?? "cardigan";
    const created = await HerdrRuntime.create({
      session,
      execution,
      env: io.env,
    });
    if (!created.ok) {
      if (sub === "attach")
        throw attachFailure(
          assignmentId,
          formatCommandError(
            "连接运行时",
            "Herdr（请确认已安装 hc 0.1.18）",
            created.error,
          ),
        );
      throw new CliError(
        formatCommandError("连接运行时", "Herdr", created.error),
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
        result.paused
          ? `已暂停常驻 PM ${assignmentId}，门铃将排队；用 cardigan pm start 或 assignment start 恢复。`
          : `已释放 ${assignmentId} 的终端${result.aborted ? "，未结束的 Run 已取消" : ""}（worktree 保留）`,
      );
      return EXIT.ok;
    }
    if (sub === "attach") {
      const printOnly =
        flags.print === "true" || !io.stdinIsTTY || !io.stdoutIsTTY;
      const { entry, ref } = await prepareAttach({
        store,
        project_id,
        assignment_id: assignmentId,
        runtime,
        printOnly,
      });
      const interactive = flags.interactive === "true";
      if (printOnly) {
        io.stdout(`${entry}${interactive ? "" : " --observe"}`);
        return EXIT.ok;
      }
      return await enterAssignment(io, runtime, ref, assignmentId, interactive);
    }
    return await startAssignmentCommand({
      store,
      io,
      project_id,
      assignment_id: assignmentId,
      runtime,
      dataDir,
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
      formatCommandError("连接运行时", "Herdr", created.error),
      EXIT.failure,
    );
  }
  return await startAssignmentCommand({
    ...options,
    runtime: created.value,
    dataDir,
  });
}
