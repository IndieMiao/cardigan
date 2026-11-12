import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  Actor,
  Assignment,
  Clock,
  DispatchRunParams,
  Machine,
  ProjectId,
  Run,
  Runtime,
  RuntimeLaunch,
  RuntimeRef,
  StandingMode,
} from "@cardigan/domain";
import {
  abortDispatch,
  canDispatchRun,
  DEFAULT_RUN_LIMIT,
  dispatchRun,
  EXTERNAL_ASSIGNMENT_START_ERROR,
  isStandingPm,
  standingModeOf,
} from "@cardigan/domain";
import { defaultToolCatalog } from "@cardigan/mcp-server";
import {
  type CompiledAssignmentLaunch,
  compileAssignmentLaunch,
  compiledLaunchSettings,
  firstPrompt,
  type LaunchConfig,
  resolveProfile,
  SECRETS_FILE_NAME,
  START_FILE_NAME,
  TOKEN_FILE_NAME,
} from "@cardigan/roles";
import {
  clearAgentSentinel,
  type ExecutionConfig,
  executionPaths,
  type HerdrRuntime,
  prepareAgentProject,
  scrubAgentLaunch,
  secureDataDirectory,
  writeAgentLaunch,
  writeAgentSentinel,
} from "@cardigan/runtime-herdr";
import {
  beginLaunchAttempt,
  finishBellAttempt,
  type Store,
  unfinishedBellAttempts,
} from "@cardigan/store";
import {
  applyCommand,
  issueAssignmentToken,
  launchEntities,
  wallClock,
} from "./commands.js";
import { HostLaunchError, type LaunchStep, messageOf } from "./errors.js";
import { agentNameFor } from "./naming.js";
import { runCapacitySnapshot } from "./run-capacity.js";
import {
  deferTargetAttempt,
  RunTargetDeferred,
  refreshTargetWait,
} from "./run-target.js";
import { stopRunRuntime } from "./stop-run.js";
import {
  type PreparedWorktree,
  prepareRoleWorktree,
  worktreeBaselinePrompt,
} from "./worktree.js";

export type { PreparedWorktree } from "./worktree.js";

/**
 * The one host-side start flow (M2 plan §4 steps 3–9).
 *
 * `cardigan assignment start` and the Dispatcher both end up here once a Run is
 * queued: the CLI with a Run it just queued and a worktree it prepared, the
 * server with a Run the Router queued and a bell as the first prompt. Everything
 * after that point — a fresh token (the old one is revoked), the compiled run
 * directory, provisioning, `dispatchRun`, the start sentinel, and the failure
 * compensation — exists once, so the two entries cannot drift apart.
 */

export class RunCapacityDeferred extends Error {
  constructor(
    readonly run_id: string,
    readonly ahead: number,
  ) {
    super(`排队中（前面还有 ${ahead} 个）`);
  }
}

export interface LaunchHost {
  readonly runLimit?: (machine: string) => number;
  readonly store: Store;
  readonly runtime: Runtime & Partial<Pick<HerdrRuntime, "captureAgent">>;
  readonly launch: {
    readonly config: LaunchConfig;
    readonly secrets: Readonly<Record<string, string>>;
  };
  readonly mcpUrl: string;
  readonly dataDir: string;
  readonly execution?: ExecutionConfig | undefined;
  readonly clock?: Clock | undefined;
  /**
   * Host diagnostics, including manual-start capacity notices and cleanup
   * failures. Reporting must not skip token revocation or Run cancellation.
   */
  readonly report?: ((message: string) => void) | undefined;
}

export interface LaunchRunInput {
  readonly project: ProjectId;
  readonly assignment_id: Assignment["id"];
  /** The Run to start; it must already exist in `queued` state. */
  readonly run: Run;
  /** Human for the CLI, system for the Dispatcher: the domain checks differ. */
  readonly actor: Actor;
  /** Set when the caller prepared a worktree (M2.5); otherwise the Assignment's. */
  readonly worktree?: PreparedWorktree | undefined;
  /** CLI preparation runs only after its queued Run has been claimed. */
  readonly prepare_worktree?: () => Promise<PreparedWorktree | undefined>;
  /** The doorbell (M3 §3.2); without it the M2 initial prompt is generated. */
  readonly first_prompt?: string | undefined;
  readonly replacement?: DispatchRunParams["replacement"];
  /** Explicit assignment start can wake an existing idle business session. */
  readonly reuse_session?: boolean;
}

export interface LaunchedRun {
  readonly assignment: Assignment;
  readonly run: Run;
  readonly runtime_ref: RuntimeRef;
  readonly run_dir: string;
  readonly work_dir: string;
  readonly worktree_path?: string | undefined;
  readonly token_id: string;
}

/** Local machines are the only ones M2/M3 dispatch to (§13.1). */
function localMachine(clock: Clock): Machine {
  return {
    id: "local",
    label: "local",
    herdr_machine: "local",
    os: "linux",
    arch: "x64",
    tags: [],
    max_assignments: 1,
    status: "online",
    last_seen: clock.now(),
  };
}

async function writeRunDirectory(
  compiled: CompiledAssignmentLaunch,
  token: string,
): Promise<void> {
  for (const file of compiled.files) {
    await mkdir(dirname(file.path), { recursive: true, mode: 0o700 });
    await writeFile(file.path, file.content, {
      encoding: "utf8",
      mode: file.mode,
    });
  }
  // The token file is written last and consumed (deleted) by launch.sh.
  await writeFile(compiled.token_file, `${token}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

/**
 * Remove every plaintext secret from the run directory. The token is revoked
 * separately, but `secrets.env` holds provider credentials, so it is removed
 * even if `launch.sh` never ran (§10.2, §14).
 */
export async function scrubRunCredentials(
  execution: ExecutionConfig,
  project: ProjectId,
  assignment_id: Assignment["id"],
): Promise<void> {
  if (execution.mode === "agent-ssh") {
    await scrubAgentLaunch(execution, project, assignment_id);
    return;
  }
  const { runDir } = executionPaths(execution, project, assignment_id);
  for (const name of [TOKEN_FILE_NAME, SECRETS_FILE_NAME, START_FILE_NAME]) {
    await rm(join(runDir, name), { force: true });
  }
}

export function projectActor(
  kind: "human" | "system",
  project: ProjectId,
): Actor {
  return { kind, project_id: project };
}

/**
 * §3.4: a standing PM learns from its first prompt whether it is the foreground
 * Office or the background Ops. M4.5 reads that from the Assignment's
 * `standing_mode`, so the prompt cannot disagree with the token scope (§7.1).
 */
export function standingModeLine(
  assignment: Assignment,
  mode: StandingMode | undefined = assignment.scope === "standing"
    ? assignment.standing_mode
    : undefined,
): string | undefined {
  if (assignment.scope !== "standing" || assignment.role_id !== "pm")
    return undefined;
  if (mode === undefined) return undefined;
  return mode === "office"
    ? "mode=foreground 当前身份：PM Office（前台）。只在 Needs You 新增项和重大风险时被打断；用 record_decision 记录人的原话。"
    : "mode=background 当前身份：PM Ops（后台）。接收 Router 升级的事件，按 Assignment 合并后投递，不直接打扰人。";
}

export async function launchRun(
  host: LaunchHost,
  input: LaunchRunInput,
): Promise<LaunchedRun> {
  if (
    host.store.uow.read((tx) =>
      tx.assignments.get(input.project, input.assignment_id),
    )?.external
  )
    throw new HostLaunchError("dispatch", EXTERNAL_ASSIGNMENT_START_ERROR);
  if (!input.reuse_session) return launch(host, input);
  // CLI starts share the Dispatcher's durable exclusion while the Run is
  // still queued. Otherwise two starts could rotate tokens/provision at once.
  const clock = host.clock ?? wallClock;
  const attempt = host.store.uow.run((tx) => {
    const run = tx.runs.get(input.project, input.run.id);
    if (
      run?.status !== "queued" ||
      run.assignment_id !== input.assignment_id ||
      unfinishedBellAttempts(host.store.database, input.project).some(
        (a) => a.assignment_id === input.assignment_id,
      )
    )
      throw new HostLaunchError(
        "dispatch",
        "Assignment delivery is in progress",
      );
    const assignment = tx.assignments.get(input.project, input.assignment_id);
    if (!assignment)
      throw new HostLaunchError("dispatch", "Assignment is missing");
    tx.runs.put(input.project, { ...run, queue_reason: "concurrency_limit" });
    const capacity = runCapacitySnapshot(host.store, tx);
    const manual =
      input.actor.kind === "human" && input.actor.project_id === input.project;
    const limit = host.runLimit?.(assignment.machine_id) ?? DEFAULT_RUN_LIMIT;
    const occupied = capacity.occupied.get(assignment.machine_id) ?? 0;
    // Q-88: only the explicit human host entry may bypass machine capacity.
    // PM tools, Dispatcher and recovery callers retain system/assignment actors.
    if (
      !manual &&
      (!canDispatchRun(limit, occupied, isStandingPm(assignment)) ||
        (!isStandingPm(assignment) &&
          (capacity.queue.find(
            (r) => r.project_id === input.project && r.run_id === run.id,
          )?.ahead ?? 0) > 0))
    ) {
      return undefined;
    }
    const cleared = { ...run };
    delete cleared.queue_reason;
    tx.runs.put(input.project, cleared);
    const at = clock.now();
    const attempt = {
      id: randomUUID(),
      project_id: input.project,
      assignment_id: input.assignment_id,
      run_id: run.id,
      notification_ids: [],
      started_at: at,
      // Startup can include the host's 30-minute Git transfer timeout.
      lease_until: new Date(Date.parse(at) + 60 * 60_000).toISOString(),
      finished_at: null,
      outcome: null,
    };
    beginLaunchAttempt(host.store.database, attempt);
    return {
      ...attempt,
      capacity_notice:
        manual && limit > 0 && occupied + 1 > limit
          ? `已超过全机上限（当前 ${occupied + 1}/上限 ${limit}）`
          : undefined,
    };
  });
  if (!attempt) {
    const waiting = host.store.uow.read((tx) =>
      runCapacitySnapshot(host.store, tx).queue.find(
        (r) => r.project_id === input.project && r.run_id === input.run.id,
      ),
    );
    throw new RunCapacityDeferred(input.run.id, waiting?.ahead ?? 0);
  }
  let sent = false;
  let deferred = false;
  try {
    // Report the claim-time snapshot, including this Run's durable reservation.
    if (attempt.capacity_notice) host.report?.(attempt.capacity_notice);
    const result = await launch(host, input);
    sent = true;
    return result;
  } catch (error) {
    deferred = error instanceof RunTargetDeferred;
    throw error;
  } finally {
    if (deferred) deferTargetAttempt(host.store, attempt, clock);
    else
      host.store.uow.run(() =>
        finishBellAttempt(
          host.store.database,
          input.project,
          attempt.id,
          sent ? "sent" : "failed",
          clock.now(),
        ),
      );
  }
}

async function launch(
  host: LaunchHost,
  input: LaunchRunInput,
): Promise<LaunchedRun> {
  const clock = host.clock ?? wallClock;
  const execution: ExecutionConfig = host.execution ?? {
    mode: "local",
    dataDir: host.dataDir,
  };
  const report = host.report ?? (() => undefined);
  const project = input.project;
  const requireTarget = () => {
    if (refreshTargetWait(host.store, project, input.run.id, clock))
      throw new RunTargetDeferred();
  };
  requireTarget();

  await secureDataDirectory(execution);
  const { assignment, role, employee, card, workItem } = launchEntities(
    host.store,
    project,
    input.assignment_id,
  );
  if (assignment.status !== "active")
    throw new HostLaunchError(
      "directory preparation",
      `Assignment ${assignment.id} is ${assignment.status}`,
    );
  const current = host.store.uow.read((tx) =>
    tx.runs.get(project, input.run.id),
  );
  if (
    host.store.uow.read((tx) =>
      tx.runs
        .list(project)
        .some(
          (r) =>
            r.assignment_id === assignment.id &&
            (r.inactivity_stop || r.dispatch_stop),
        ),
    )
  )
    throw new HostLaunchError(
      "dispatch",
      "Previous Run is waiting for confirmed runtime exit",
    );
  if (current?.status !== "queued" || current.assignment_id !== assignment.id)
    throw new HostLaunchError(
      "directory preparation",
      `Run ${input.run.id} is not queued`,
    );
  if (
    input.replacement &&
    (input.actor.kind !== "system" ||
      JSON.stringify(assignment.runtime_ref) !==
        JSON.stringify(input.replacement.previous) ||
      host.store.uow
        .read((tx) => tx.runs.list(project))
        .some(
          (r) =>
            r.assignment_id === assignment.id &&
            r.id !== current.id &&
            !["completed", "failed", "cancelled"].includes(r.status),
        ))
  )
    throw new HostLaunchError(
      "directory preparation",
      "Session replacement requires the same idle Assignment and queued Run",
    );

  const { runDir, repositoriesRoot } = executionPaths(
    execution,
    project,
    assignment.id,
  );
  const prompt =
    input.first_prompt ||
    firstPrompt({
      assignment_id: assignment.id,
      run_id: current.id,
      kind: current.kind,
      ...(card ? { card_id: card.id } : {}),
      ...(workItem ? { work_item_id: workItem.id } : {}),
    });
  let worktree = input.worktree;
  let workDir = worktree?.path ?? assignment.worktree_path ?? runDir;
  const prepare = () =>
    input.prepare_worktree
      ? input.prepare_worktree()
      : prepareRoleWorktree(
          { store: host.store, execution, runtime: host.runtime },
          project,
          assignment.id,
        );
  if (input.reuse_session && assignment.runtime_ref) {
    const observed = await host.runtime.status(assignment.runtime_ref);
    if (observed.ok && observed.value.process === "alive") {
      const token = host.store.uow.run((tx) =>
        tx
          .tokensForAssignment(project, assignment.id)
          .findLast((t) => t.revoked_at === null),
      );
      if (!token)
        throw new HostLaunchError(
          "dispatch",
          "Live session has no active token",
        );
      // The persistent attempt excludes concurrent starts throughout preparation.
      const dispatch = () =>
        applyCommand(host.store, {
          project,
          actor: input.actor,
          clock,
          reduce: (state, actor, ports) =>
            dispatchRun(state, actor, { run_id: current.id }, ports),
        });
      let run: Run | undefined =
        workItem?.kind === "verify" ? undefined : dispatch();
      let waking = false;
      try {
        worktree ??= await prepare();
        requireTarget();
        run ??= dispatch();
        waking = true;
        const result = await host.runtime.wake(
          assignment.runtime_ref,
          [prompt, worktreeBaselinePrompt(worktree)].filter(Boolean).join("\n"),
        );
        if (!result.ok || !result.value.sent)
          throw new Error("Session wake failed; delivery may have occurred");
      } catch (error) {
        if (!waking) {
          requireTarget();
          // Genuine preparation failures keep the established retry protocol.
          run ??= dispatch();
        }
        // A failed wake does not prove non-delivery (§6.8). Keep the dispatched
        // Run and credentials so a late MCP acknowledgement remains valid.
        throw new HostLaunchError("dispatch", messageOf(error), {
          cause: error,
        });
      }
      return {
        assignment: launchEntities(host.store, project, assignment.id)
          .assignment,
        run,
        runtime_ref: assignment.runtime_ref,
        run_dir: runDir,
        work_dir: worktree?.path ?? workDir,
        ...(worktree ? { worktree_path: worktree.path } : {}),
        token_id: token.id,
      };
    }
    if (
      (observed.ok && observed.value.process === "unknown") ||
      (!observed.ok &&
        !["runtime_not_found", "runtime_unavailable"].includes(
          observed.error.code,
        ))
    )
      throw new HostLaunchError(
        "dispatch",
        "Cannot determine session liveness",
      );
  }
  const agentName = agentNameFor({
    role_id: role.role_id,
    project_id: project,
    ...(card?.id === undefined ? {} : { card_id: card.id }),
    ...(workItem?.id === undefined ? {} : { work_item_id: workItem.id }),
    assignment_id: assignment.id,
  });

  let step: LaunchStep = "directory preparation";
  let tokenId: string | undefined;
  let ref: RuntimeRef | undefined;
  try {
    if (execution.mode === "agent-ssh")
      await prepareAgentProject(execution, project, assignment.id);

    // The Dispatcher passes no worktree: the host prepares what the Role needs
    // (a writer's branch, or a readonly reviewer at the current delivery).
    worktree ??= await prepare();
    requireTarget();
    workDir = worktree?.path ?? workDir;

    step = "token issuance";
    const issued = issueAssignmentToken(host.store, project, {
      assignment,
      role,
    });
    tokenId = issued.record.id;
    // Issuance may have stamped a legacy standing mode; read the row back so
    // the first prompt and the token scope describe the same mode.
    const currentAssignment =
      host.store.uow.read((tx) => tx.assignments.get(project, assignment.id)) ??
      assignment;
    const toolCatalog = sessionToolCatalog(
      issued.record.allowed_tools,
      currentAssignment,
    );

    step = "launch compilation";
    const profileRef =
      current.launch_profile_ref ??
      employee?.launch_profile_ref ??
      role.launch_profile_ref;
    const model = resolveProfile(host.launch.config, profileRef).profile.model;
    if (model === undefined)
      throw new Error(`Launch profile ${profileRef} has no model`);
    const compiled = compileAssignmentLaunch({
      ...(employee !== undefined
        ? { employee: { launch_profile_ref: profileRef, identity: employee } }
        : {}),
      assignment: {
        assignment_id: assignment.id,
        run_id: input.run.id,
        project_id: project,
        ...(card?.id === undefined ? {} : { card_id: card.id }),
        ...(workItem?.id === undefined ? {} : { work_item_id: workItem.id }),
      },
      role: {
        role_id: role.role_id,
        harness: role.harness,
        launch_profile: profileRef,
        core_prompt: role.core_prompt,
        ...(role.instructions === undefined
          ? {}
          : { instructions: role.instructions }),
        // The harness advertises the tool scope the token actually carries, so
        // a rotated Ops session never even sees record_decision (§7.1).
        allowed_tools: issued.record.allowed_tools,
        worktree: role.worktree,
      },
      launch: host.launch.config,
      agent_nice: execution.agentNice ?? 10,
      mcp: { url: host.mcpUrl },
      run_dir: runDir,
      work_dir: workDir,
      // GitWorktreeService owns this layout; do not run host Git in an Agent
      // repository to discover the common dir (§12.2). Only an Assignment that
      // actually got a worktree needs the repository exception (M5.S S13).
      ...(worktree === undefined
        ? {}
        : { repository_root: join(repositoriesRoot, project) }),
      // The merged bell is the first prompt when the caller has one (M3 §3.2).
      first_prompt: [
        prompt,
        standingModeLine(currentAssignment, standingModeOf(currentAssignment)),
        worktreeBaselinePrompt(worktree),
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n"),
      secrets: host.launch.secrets,
    });

    step = "run directory write";
    await clearAgentSentinel(execution, project, assignment.id);
    if (execution.mode === "agent-ssh")
      await writeAgentLaunch(
        execution,
        project,
        assignment.id,
        compiled.files,
        issued.token,
      );
    else await writeRunDirectory(compiled, issued.token);
    requireTarget();

    step = "runtime provision";
    const launchDesc: RuntimeLaunch = {
      command: compiled.launch_script,
      args: [],
      cwd: workDir,
      agent_name: agentName,
      labels: {
        cardigan: "1",
        project,
        assignment: assignment.id,
        run: input.run.id,
      },
    };
    const provisioned =
      input.replacement && input.replacement.reason !== "launch_profile_changed"
        ? await host.runtime.resume_or_replace(
            input.replacement.previous,
            launchDesc,
          )
        : await host.runtime.provision(
            assignment,
            role,
            localMachine(clock),
            launchDesc,
          );
    if (!provisioned.ok)
      throw new Error(
        `provision failed: ${provisioned.error.code} ${provisioned.error.message}`,
      );
    ref = provisioned.value;
    requireTarget();

    // The worktree is the host's fact, not the runtime's: hand it to dispatch
    // through the ref so the assignment records path, branch and base SHA.
    const dispatchRef: RuntimeRef =
      worktree === undefined
        ? ref
        : {
            ...ref,
            worktree_path: worktree.path,
            ...(worktree.branch === undefined
              ? {}
              : { branch: worktree.branch }),
          };
    const baseSha = worktree?.base_sha ?? assignment.base_sha;
    step = "dispatch";
    applyCommand(host.store, {
      project,
      actor: input.actor,
      clock,
      reduce: (state, actor, ports) =>
        dispatchRun(
          state,
          actor,
          {
            run_id: input.run.id,
            launch_snapshot: {
              model,
              agent_cli_version: current.agent_cli_version,
              launch_profile_ref: compiled.profile,
              // C-106: what this session was actually started with.
              ...compiledLaunchSettings(compiled.harness, compiled.args),
              // P2a-10 A: the new session lists exactly this token's tools.
              ...(toolCatalog === undefined
                ? {}
                : { tool_catalog: toolCatalog }),
            },
            runtime_ref: dispatchRef,
            ...(baseSha === undefined ? {} : { base_sha: baseSha }),
            ...(input.replacement ? { replacement: input.replacement } : {}),
          },
          ports,
        ),
    });

    // Only now may the wrapper start the Agent (M2 §4 step 5–8).
    step = "sentinel write";
    await writeAgentSentinel(execution, project, assignment.id);

    const started = launchEntities(host.store, project, assignment.id);
    const run = host.store.uow.read((tx) => tx.runs.get(project, input.run.id));
    if (run === undefined)
      throw new Error(`Run ${input.run.id} disappeared after dispatch`);
    return {
      assignment: started.assignment,
      run,
      runtime_ref: dispatchRef,
      run_dir: runDir,
      work_dir: workDir,
      ...(worktree === undefined ? {} : { worktree_path: worktree.path }),
      token_id: tokenId,
    };
  } catch (error) {
    const deferred =
      step !== "sentinel write" &&
      (error instanceof RunTargetDeferred ||
        refreshTargetWait(host.store, project, input.run.id, clock));
    await compensate({
      host,
      execution,
      project,
      assignment,
      run: input.run,
      actor: input.actor,
      clock,
      step,
      report,
      keepRun: deferred,
      ...(ref === undefined ? {} : { ref }),
      ...(tokenId === undefined ? {} : { tokenId }),
    });
    if (deferred) throw new RunTargetDeferred();
    throw error instanceof HostLaunchError
      ? error
      : new HostLaunchError(step, messageOf(error), { cause: error });
  }
}

interface Compensation {
  readonly host: LaunchHost;
  readonly execution: ExecutionConfig;
  readonly project: ProjectId;
  readonly assignment: Assignment;
  readonly run: Run;
  readonly actor: Actor;
  readonly clock: Clock;
  readonly step: LaunchStep;
  readonly report: (message: string) => void;
  readonly ref?: RuntimeRef | undefined;
  readonly tokenId?: string | undefined;
  readonly keepRun?: boolean;
}

/** §4 step 9 / §13.4: release, scrub, revoke, cancel — each step independently. */
async function compensate(input: Compensation): Promise<void> {
  const { host, report } = input;
  if (input.keepRun && input.ref !== undefined) {
    if (
      (await stopRunRuntime(host.runtime, input.ref, () => true)) !== "exited"
    ) {
      // This is a real cleanup failure, not a target wait: do not allow another
      // launch to publish a sentinel for an unconfirmed old wrapper.
      await compensate({ ...input, keepRun: false });
      throw new HostLaunchError(
        input.step,
        "Deferred terminal exit could not be confirmed",
      );
    }
  }
  if (input.ref !== undefined && !input.keepRun) {
    try {
      const released = await host.runtime.release(input.ref, { force: true });
      if (!released.ok) report(`终端回收失败：${released.error.code}`);
    } catch {
      report("终端回收失败，需要人工检查");
    }
  }
  if (input.keepRun && input.tokenId === undefined) return;
  let cleanupFailed = false;
  try {
    await scrubRunCredentials(
      input.execution,
      input.project,
      input.assignment.id,
    );
  } catch {
    cleanupFailed = true;
    report("凭据文件清理失败，需要人工检查");
  }
  if (input.tokenId !== undefined) {
    try {
      if (!host.store.revokeToken(input.tokenId)) {
        cleanupFailed = true;
        report("Token 作废失败，需要人工检查");
      }
    } catch {
      cleanupFailed = true;
      report("Token 作废失败，需要人工检查");
    }
  }
  if (input.keepRun && !cleanupFailed) return;
  try {
    applyCommand(host.store, {
      project: input.project,
      actor: input.actor,
      clock: input.clock,
      reduce: (state, actor, ports) =>
        abortDispatch(
          state,
          actor,
          { run_id: input.run.id, reason: `${input.step} failed` },
          ports,
        ),
    });
  } catch {
    // The Run may already be gone; the caller reports the original failure.
  }
  if (input.keepRun && cleanupFailed)
    throw new HostLaunchError(
      input.step,
      "Deferred launch credential cleanup failed",
    );
}

/**
 * P2a-10 A: fingerprint of the tools/list a new session will receive. A
 * failure only drops the fingerprint (no catalog replacement later); it never
 * blocks the launch.
 */
function sessionToolCatalog(
  allowed: readonly string[],
  assignment: Assignment,
): string | undefined {
  try {
    return defaultToolCatalog(allowed, assignment);
  } catch {
    return undefined;
  }
}
