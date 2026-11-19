import type {
  Actor,
  Assignment,
  ProjectId,
  Runtime,
  RuntimeRef,
} from "@cardigan/domain";
import {
  abortDispatch,
  EXTERNAL_ASSIGNMENT_START_ERROR,
  pauseStandingAssignment,
  queueRun,
  releaseAssignment,
  standingModeOf,
  stopWorkItemAssignment,
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
  RuntimeTargets,
  readonlyWorktreeTarget,
  resolveMcpUrl,
  scrubRunCredentials,
  settleTestReviewLimits,
  stopRunRuntime,
  tryHostOpsLock,
  type WorktreeProvider,
  worktreeProvider,
} from "@cardigan/host";
import { type LaunchConfig, resolveProfile } from "@cardigan/roles";
import {
  DEFAULT_HC_SESSION,
  describeRuntime,
  type ExecutionConfig,
  HC_RELEASE,
  type HerdrRuntime,
  runtimeOwnsRef,
  secureDataDirectory,
} from "@cardigan/runtime-herdr";
import {
  finishBellAttempt,
  retireReconcileNotifications,
  Store,
  type StoreTransactionContext,
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
  resolveActor,
  resolveDataDir,
  resolveProject,
  runCommand,
  systemClock,
} from "./host.js";
import type { CliIo, SpawnedChild } from "./io.js";
import { cliLaunchPaths } from "./paths.js";
import { launchExecution, terminalExecution } from "./runtime-check.js";
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
  /** Trusted host automation; no CLI flag, Token callers remain rejected. */
  readonly automatic?: true;
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
  /** C-154: fresh session for an active standing PM, without pausing it. */
  readonly restart_session?: boolean;
  /** Already checked against the server registration by the caller. */
  readonly execution?: ExecutionConfig;
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

const executionFor = (
  io: CliIo,
  dataDir: string,
  session?: string,
): Promise<ExecutionConfig> =>
  launchExecution(io, resolveDataDir(io, dataDir), session);

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
    ...(role.worktree === "readonly"
      ? readonlyWorktreeTarget(store, project_id, assignment)
      : { work_item: workItem }),
  });
  if (placed === undefined)
    throw new CliError("Git 服务没有给出 worktree", EXIT.failure);
  return placed;
}

/** Run the M2 plan §4 flow, compensating every step after a successful queue. */
export async function startAssignment(
  options: StartOptions,
): Promise<StartedAssignment> {
  if (options.restart_session !== true) return await startUnlocked(options);
  // C-154: one restart at a time per Assignment, from reading the current
  // session to launching the new one. The host_ops service takes the same
  // lock, so a pending host restart and a human restart never interleave.
  if (!/^A-[1-9][0-9]*$/u.test(options.assignment_id))
    throw new CliError(
      `不认识的 Assignment：${options.assignment_id}`,
      EXIT.usage,
    );
  const unlock = await tryHostOpsLock(
    options.store,
    options.project_id,
    options.assignment_id,
  );
  if (unlock === undefined)
    throw new CliError(
      `${options.assignment_id} 正在被另一个重开会话或主机运维操作处理，没有改动；稍后再试`,
      EXIT.failure,
    );
  try {
    return await startUnlocked(options);
  } finally {
    await unlock();
  }
}

async function startUnlocked(
  options: StartOptions,
): Promise<StartedAssignment> {
  const { store, io, project_id } = options;
  const caller = resolveActor(io, project_id, store);
  if (options.automatic && caller.kind !== "human")
    throw new CliError("自动启动仅限主机", EXIT.usage);
  const actor: Actor = options.automatic
    ? { kind: "system", project_id }
    : caller;
  rejectExternalTerminalAction(store, project_id, options.assignment_id);
  const capacity = await loadRunCapacityConfig({ env: io.env });
  for (const error of capacity.errors) io.stderr(error);
  let execution =
    options.execution ?? (await executionFor(io, options.dataDir));
  await secureDataDirectory(execution);

  const entities = requireAssignment(store, project_id, options.assignment_id);
  const { assignment, role, employee } = entities;
  if (options.runtime instanceof RuntimeTargets)
    execution = (await options.runtime.forLaunch(project_id, assignment))
      .execution;
  const resuming =
    assignment.scope === "standing" &&
    assignment.role_id === "pm" &&
    assignment.status === "suspended";
  const restarting = options.restart_session === true;
  if (
    restarting &&
    !(
      assignment.scope === "standing" &&
      assignment.role_id === "pm" &&
      assignment.status === "active"
    )
  )
    throw new CliError(
      resuming
        ? `${assignment.id} 已暂停，用 cardigan pm start 恢复`
        : `${assignment.id} 不是在岗的常驻 PM，不能重开会话`,
      EXIT.usage,
    );
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
  // C-154: replace the session only after independently proving the old
  // terminal exited (same primitive as the host_ops restart); otherwise keep
  // the Assignment, its RuntimeRef and its tokens so the stop can be retried.
  const stoppedRef = assignment.runtime_ref;
  if (restarting) {
    // C-152 × C-154: a terminal recorded on another runtime cannot be seen
    // from here, so "not found" would not prove it exited. Leave it to the
    // host_ops restart, which asks the human to confirm the exit first.
    if (
      stoppedRef &&
      !(options.runtime instanceof RuntimeTargets
        ? options.runtime.ownsRef(stoppedRef)
        : runtimeOwnsRef(execution, stoppedRef))
    )
      throw new CliError(
        `${assignment.id} 的终端 ${stoppedRef.terminal_ref} 记录在运行时机器 ${stoppedRef.runtime_machine}，不属于当前运行时 ${describeRuntime(execution)}，无法确认它已退出，没有替换会话。请让主机运维用 host_ops_restart_standing_pm 重启，按 Needs You 中的步骤确认旧终端已退出。`,
        EXIT.failure,
      );
    const stopped = await stopRunRuntime(
      options.runtime,
      stoppedRef,
      () =>
        JSON.stringify(
          requireAssignment(store, project_id, assignment.id).assignment
            .runtime_ref,
        ) === JSON.stringify(stoppedRef),
    );
    if (stopped !== "exited")
      throw new CliError(
        stopped === "withdrawn"
          ? `${assignment.id} 的会话已变化，没有替换；请重新运行 cardigan pm restart`
          : `${assignment.id} 的旧终端没有确认退出，没有替换会话；Assignment、事项和 Token 都没动，稍后重试 cardigan pm restart`,
        EXIT.failure,
      );
  }
  if (assignment.role_id === "independent_reviewer")
    settleTestReviewLimits(store, project_id);
  const run = (() => {
    try {
      return runCommand(store, {
        operation: "启动 Assignment",
        target: assignment.id,
        project_id,
        actor,
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
              ...(restarting
                ? { restart_session: true, expected_runtime_ref: stoppedRef }
                : {}),
            },
            ports,
          ),
        // C-154: the old session can no longer report or escalate anything.
        ...(restarting
          ? {
              after: (tx: StoreTransactionContext) =>
                retireOldSession(tx, store, project_id, assignment.id),
            }
          : {}),
      });
    } catch (error) {
      if (assignment.role_id === "independent_reviewer")
        settleTestReviewLimits(store, project_id);
      throw error;
    }
  })();

  try {
    // 3–8. Claim queued work before Git preparation, then use the shared
    // token/provision/dispatch flow and its failure compensation.
    const launched = await launchRun(
      {
        store,
        runtime: options.runtime,
        runLimit: capacity.forMachine,
        runLimitMaximum: capacity.maxForMachine,
        resourceLimits: capacity.resourcesForMachine,
        launch: options.launch,
        mcpUrl: options.mcpUrl,
        dataDir: options.dataDir,
        configDir: cliLaunchPaths(io).configDir,
        execution,
        report: (message) => io.stderr(message),
      },
      {
        project: project_id,
        assignment_id: assignment.id,
        run,
        actor,
        reuse_session: true,
        prepare_worktree: () => prepareWorktree(options, entities),
        ...(resuming || restarting
          ? {
              first_prompt: resumedBells(
                store,
                project_id,
                assignment,
                run.id,
                restarting
                  ? "常驻 PM 会话已由人重开（Assignment 不变，事项仍归你）。请调用 whoami，再逐条读取这些流的 get_updates 并 ack_events，接着处理。"
                  : undefined,
              ),
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
    if (resuming) pauseStanding(store, project_id, assignment.id, actor);
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
  actor: Actor,
) {
  rejectExternalTerminalAction(store, project_id, assignment_id, "stop");
  return runCommand(store, {
    operation: "暂停常驻 PM",
    target: assignment_id,
    project_id,
    actor,
    reduce: (s, a, p) => pauseStandingAssignment(s, a, { assignment_id }, p),
    after: (tx) => retireOldSession(tx, store, project_id, assignment_id),
  });
}
/** Revoke the old session's tokens and settle its unfinished bell attempts. */
function retireOldSession(
  tx: StoreTransactionContext,
  store: Store,
  project_id: ProjectId,
  assignment_id: Assignment["id"],
) {
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
  note = "常驻 PM 已由人恢复。请调用 whoami，再逐条读取这些流的 get_updates 并 ack_events，处理暂停期间的更新。",
): string {
  store.acknowledgeNotifications(project, a.id);
  store.uow.run(() => retireReconcileNotifications(store.database, project));
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
    note,
  ].join("\n");
}

/** Abort the Run (best effort); the reason is recorded on it. */
export function abort(
  store: Store,
  project_id: ProjectId,
  run_id: string,
  reason: string,
  actor: Actor,
): void {
  try {
    applyCommand(store, {
      project: project_id,
      actor,
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
  readonly actor?: Actor;
}): Promise<{ released: boolean; aborted: boolean; paused?: boolean }> {
  const actor = input.actor ?? {
    kind: "human" as const,
    project_id: input.project_id,
  };
  const { assignment } = requireAssignment(
    input.store,
    input.project_id,
    input.assignment_id,
  );
  const ref = assignment.runtime_ref;
  const execution =
    ref && input.runtime instanceof RuntimeTargets
      ? input.runtime.executionForRef(ref, input.project_id)
      : input.execution;
  if (assignment.scope === "standing" && assignment.role_id === "pm") {
    const paused = pauseStanding(
      input.store,
      input.project_id,
      assignment.id,
      actor,
    );
    try {
      if (ref) await closeStandingTerminal(input.runtime, ref);
    } finally {
      if (execution)
        await scrubRunCredentials(
          execution,
          input.project_id,
          assignment.id,
          ref,
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
  // C-211: persist the stop before touching the terminal: from here on the
  // Dispatcher starts no session for this Assignment until the human runs
  // `cardigan assignment start` again, and its queued Runs are cancelled.
  // The running Run keeps its run slot until the terminal is released, so a
  // failed release can be retried and never under-counts capacity.
  const stopped = runCommand(input.store, {
    operation: "停止 Assignment",
    target: assignment.id,
    project_id: input.project_id,
    actor,
    reduce: (s, a, p) =>
      stopWorkItemAssignment(
        s,
        a,
        { assignment_id: assignment.id, reason: "stopped by host" },
        p,
      ),
  });
  const released = await input.runtime.release(ref, { force: true });
  if (!released.ok && released.error.code !== "runtime_not_found") {
    throw new CliError(
      formatCommandError("释放终端", assignment.id, released.error),
      EXIT.failure,
    );
  }
  const settled = runCommand(input.store, {
    operation: "停止 Assignment",
    target: assignment.id,
    project_id: input.project_id,
    actor,
    reduce: (s, a, p) =>
      stopWorkItemAssignment(
        s,
        a,
        {
          assignment_id: assignment.id,
          reason: "stopped by host",
          released_runtime_ref: ref,
        },
        p,
      ),
  });
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
  if (execution)
    await scrubRunCredentials(
      execution,
      input.project_id,
      input.assignment_id,
      ref,
    );
  return {
    released: true,
    aborted: stopped.cancelled + settled.cancelled > 0,
  };
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

function attachFailure(
  id: Assignment["id"],
  reason: string,
  details: readonly string[] = [],
): CliError {
  return new CliError(
    `无法接入 ${id}：${reason}；请检查运行服务，终端已结束时用 cardigan assignment start ${id} 重新启动。`,
    EXIT.failure,
    details,
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
  runtime: RuntimeTargets,
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
  const connection = await runtime.attachEnvironment(ref);
  if (!connection.ok) throw attachFailure(id, "终端的受信目标绑定不匹配");
  env.HC_SESSION = connection.value.session;
  env.HC_SOCKET = connection.value.socketPath;
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
      `无法执行 hc，请确认已安装 hc >= ${HC_RELEASE.minimum_version}（推荐 ${HC_RELEASE.version}）且可从 PATH 访问`,
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
  "  cardigan assignment release <A-n> [--project <p>] [--data-dir <目录>]",
  "  cardigan assignment attach <A-n> [--print] [--interactive] [--project <p>] [--hc-session <s>] [--data-dir <目录>]",
  "  stop：释放终端并取消未结束和排队的 Run；之后不会自动起新会话，门铃排队，用 assignment start 恢复。主机运维操作待处理时拒绝 stop；终端释放失败可直接重试。",
  "  attach：输入和输出均为终端（TTY）时直接只读观察；--interactive 允许输入，--print 或非 TTY 只打印命令（默认带 --observe）。",
  "  按 Ctrl+\\ 分离退出；--interactive 下你的输入会直接发给正在工作的 Agent。",
].join("\n");

function parseArgs(args: readonly string[]) {
  const [sub, ...rest] = args;
  if (
    sub !== "start" &&
    sub !== "stop" &&
    sub !== "attach" &&
    sub !== "release"
  ) {
    throw new CliError(
      "用法：cardigan assignment start|stop|attach|release",
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

/** `cardigan assignment start|stop|attach|release`. */
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
  if (sub === "release") {
    const store = Store.open({ dataDir });
    try {
      const project_id = resolveProject(store, io, flags.project);
      const actor = resolveActor(io, project_id, store);
      runCommand(store, {
        project_id,
        actor,
        operation: "释放 Assignment",
        target: assignmentId,
        reduce: (state, caller, ports) =>
          releaseAssignment(
            state,
            caller,
            { assignment_id: assignmentId },
            ports,
          ),
      });
      io.stdout(
        `已释放 Assignment ${assignmentId}；终端和工作区由主机清理流程处理。`,
      );
      return EXIT.ok;
    } finally {
      store.close();
    }
  }
  const launchSession =
    flags["hc-session"] ?? io.env.CARDIGAN_HC_SESSION ?? DEFAULT_HC_SESSION;
  // Refuse a mismatched shell before touching the store (C-152).
  const launching =
    sub === "start"
      ? await executionFor(io, dataDir, launchSession)
      : undefined;
  // attach/stop pick their runtime from the terminal; the private data
  // directory is secured the same way before the store is opened.
  await secureDataDirectory(launching ?? { mode: "local", dataDir });
  const store = Store.open({ dataDir });
  try {
    const project_id = resolveProject(store, io, flags.project);
    const actor = resolveActor(io, project_id, store);
    // Report invalid Assignments even when hc itself is unavailable.
    const ref =
      sub === "attach"
        ? attachRef(store, project_id, assignmentId)
        : sub === "stop"
          ? (store.uow.read((tx) =>
              tx.assignments.get(project_id, assignmentId),
            )?.runtime_ref ?? null)
          : null;
    // attach/stop follow the runtime recorded on the terminal itself and
    // the server's hc session.
    const { execution, session } = launching
      ? { execution: launching, session: launchSession }
      : await terminalExecution(
          io,
          dataDir,
          ref,
          assignmentId,
          flags["hc-session"],
          { store, project: project_id },
        ).catch((error: unknown) => {
          if (sub === "attach" && error instanceof CliError)
            throw attachFailure(assignmentId, error.message, error.details);
          throw error;
        });
    if (!launching) await secureDataDirectory(execution);
    if (sub === "start")
      rejectExternalTerminalAction(store, project_id, assignmentId);
    const created = await RuntimeTargets.create({
      session,
      execution,
      env: io.env,
      store,
      project: project_id,
    });
    if (!created.ok) {
      if (sub === "attach")
        throw attachFailure(
          assignmentId,
          formatCommandError(
            "连接运行时",
            `Herdr（需要 hc >= ${HC_RELEASE.minimum_version}，推荐 ${HC_RELEASE.version}）`,
            created.error,
          ),
        );
      throw new CliError(
        formatCommandError("连接运行时", "Herdr", created.error),
        EXIT.failure,
      );
    }
    if (ref) created.value.executionForRef(ref, project_id);
    const runtime = created.value;

    if (sub === "stop") {
      const result = await stopAssignment({
        actor,
        store,
        project_id,
        assignment_id: assignmentId,
        runtime,
        execution,
      });
      io.stdout(
        result.paused
          ? `已暂停常驻 PM ${assignmentId}，门铃将排队；用 cardigan pm start 或 assignment start 恢复。`
          : `已停止 ${assignmentId}：终端已释放${result.aborted ? "，未结束和排队的 Run 已取消" : ""}（worktree 保留）。之后的门铃会排队，不会自动起新会话；用 cardigan assignment start ${assignmentId} 恢复。`,
      );
      return EXIT.ok;
    }
    if (sub === "attach") {
      const printOnly =
        flags.print === "true" || !io.stdinIsTTY || !io.stdoutIsTTY;
      // Hold the retirement lock while a human observes or controls this session.
      const unlock = printOnly
        ? undefined
        : await tryHostOpsLock(store, project_id, assignmentId);
      if (!printOnly && !unlock)
        throw attachFailure(assignmentId, "会话维护中，请稍后重试");
      try {
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
        return await enterAssignment(
          io,
          runtime,
          ref,
          assignmentId,
          interactive,
        );
      } finally {
        await unlock?.();
      }
    }
    return await startAssignmentCommand({
      store,
      io,
      project_id,
      assignment_id: assignmentId,
      runtime,
      dataDir,
      execution,
      ...(flags["mcp-url"] === undefined ? {} : { mcpUrl: flags["mcp-url"] }),
    });
  } finally {
    store.close();
  }
}

export interface StartCommandOptions {
  /** Trusted host automation; no CLI flag, Token callers remain rejected. */
  readonly automatic?: true;
  readonly store: Store;
  readonly io: CliIo;
  readonly project_id: ProjectId;
  readonly assignment_id: Assignment["id"];
  readonly runtime: LaunchRuntime;
  readonly dataDir: string;
  readonly mcpUrl?: string;
  readonly restart_session?: boolean;
  readonly execution?: ExecutionConfig;
}

/** Follows the server's CARDIGAN_MCP_PORT unless CARDIGAN_MCP_URL is set (C-211). */
function cliMcpUrl(env: CliIo["env"]): string {
  try {
    return resolveMcpUrl(env);
  } catch (error) {
    throw new CliError(messageOf(error), EXIT.usage);
  }
}

/** Load the host config, wire the Git service and start one Assignment. */
export async function startAssignmentCommand(
  options: StartCommandOptions,
): Promise<number> {
  const { store, io, project_id, assignment_id, runtime } = options;
  rejectExternalTerminalAction(store, project_id, assignment_id);
  const paths = cliLaunchPaths(io, options.dataDir);
  const dataDir = paths.dataDir;
  const execution =
    runtime instanceof RuntimeTargets
      ? (
          await runtime.forLaunch(
            project_id,
            requireAssignment(store, project_id, assignment_id).assignment,
          )
        ).execution
      : (options.execution ?? (await executionFor(io, dataDir)));
  const started = await startAssignment({
    execution,
    store,
    io,
    project_id,
    assignment_id,
    launch: {
      config: await loadConfig(paths, (message) => io.stderr(message)),
      secrets: await loadSecrets(paths, io),
    },
    mcpUrl: options.mcpUrl ?? cliMcpUrl(io.env),
    runtime,
    dataDir,
    worktree: worktreeProvider(execution, runtime),
    ...(options.automatic ? { automatic: true } : {}),
    ...(options.restart_session ? { restart_session: true } : {}),
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
  /** Trusted host automation; no CLI flag, Token callers remain rejected. */
  readonly automatic?: true;
  readonly store: Store;
  readonly io: CliIo;
  readonly project_id: ProjectId;
  readonly assignment_id: Assignment["id"];
  readonly dataDir?: string;
  readonly mcpUrl?: string;
  readonly session?: string;
  /** C-154: `cardigan pm restart` — fresh session, same standing PM. */
  readonly restart_session?: boolean;
}
export type StartById = (options: StartByIdOptions) => Promise<number>;

/** Create the runtime and start one Assignment (used by `assign --start`). */
export async function startAssignmentById(
  options: StartByIdOptions,
): Promise<number> {
  rejectExternalTerminalAction(
    options.store,
    options.project_id,
    options.assignment_id,
  );
  const dataDir = resolveDataDir(options.io, options.dataDir);
  const session =
    options.session ?? options.io.env.CARDIGAN_HC_SESSION ?? DEFAULT_HC_SESSION;
  const execution = await executionFor(options.io, dataDir, session);
  await secureDataDirectory(execution);
  const created = await RuntimeTargets.create({
    execution,
    session,
    env: options.io.env,
    store: options.store,
    project: options.project_id,
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
    execution,
  });
}

function rejectExternalTerminalAction(
  store: Store,
  project: ProjectId,
  id: Assignment["id"],
  action: "start" | "stop" = "start",
): void {
  if (store.uow.read((tx) => tx.assignments.get(project, id))?.external)
    throw new CliError(
      action === "start"
        ? EXTERNAL_ASSIGNMENT_START_ERROR
        : "这是外接 Assignment，没有可以停止的终端，用 `cardigan inbox` 查看待处理通知",
      EXIT.usage,
    );
}
