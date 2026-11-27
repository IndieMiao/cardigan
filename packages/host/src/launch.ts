import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  Actor,
  Assignment,
  Clock,
  DispatchRunParams,
  ProjectId,
  Role,
  Run,
  Runtime,
  RuntimeLaunch,
  RuntimeRef,
  StandingMode,
} from "@cardigan/domain";
import {
  abortDispatch,
  canDispatchRun,
  canParkForDiscussion,
  contextUsageThresholds,
  dispatchRun,
  EXTERNAL_ASSIGNMENT_START_ERROR,
  idleWakeGuard,
  isRunCapacityExempt,
  preparationRetryWaiting,
  providerAdmission,
  recoverPreparation,
  recoveryTargetCurrent,
  remainingResourceRatio,
  reviewRunWakeDisposition,
  standingModeOf,
  standingRunDormant,
  worktreeUnavailablePrompt,
  worktreeUnavailableReason,
} from "@cardigan/domain";
import {
  defaultToolCatalogSnapshot,
  loadCommandState,
  persistEffect,
  unwrap,
} from "@cardigan/mcp-server";
import {
  type CompileAssignmentInput,
  type CompiledAssignmentLaunch,
  compileAssignmentLaunch,
  compiledLaunchSettings,
  firstPrompt,
  getHarnessAdapter,
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
  WorkerPreparationFailure,
  workerFiles,
  writeAgentLaunch,
  writeAgentSentinel,
} from "@cardigan/runtime-herdr";
import {
  type BellAttempt,
  beginLaunchAttempt,
  confirmReviewNotSent,
  finishBellAttempt,
  getRoleVersion,
  type ReadRepositories,
  recordToolCatalogSnapshot,
  type Store,
  unfinishedBellAttempts,
  withdrawBellAttempt,
} from "@cardigan/store";
import { loadAgentTestWorkers } from "./agent-test-config.js";
import { agentToolsDirectoryFor } from "./agent-tools.js";
import { launchCapabilityNotes } from "./capability-notes.js";
import {
  applyCommand,
  issueAssignmentToken,
  launchEntities,
  wallClock,
} from "./commands.js";
import { deviceSession } from "./device-providers.js";
import { HostLaunchError, type LaunchStep, messageOf } from "./errors.js";
import { tryHostOpsLock } from "./host-ops-lock.js";
import { launchFingerprint } from "./launch-fingerprint.js";
import { LaunchPublication, launchFailureReason } from "./launch-publish.js";
import { agentNameFor } from "./naming.js";
import { piTrustedWorktreePath } from "./pi-trust.js";
import {
  preparationPolicy,
  withPreparationQueue,
} from "./preparation-queue.js";
import type { ReadProjectQuota } from "./project-quotas.js";
import { resolveResourceAlternatives } from "./resource-alternatives.js";
import type { MachineLeases, ResourceAccess } from "./resource-leases.js";
import {
  RetainedWriterRefused,
  retainedWriterForRun,
} from "./retained-writer.js";
import { bindRepairAttempt, crossRepairSendBoundary } from "./review-wake.js";
import {
  capacityWaiterRunnable,
  effectiveRunLimit,
  hasEarlierCapacityWait,
  type ReadResourceLimits,
  runCapacitySnapshot,
} from "./run-capacity.js";
import {
  resourceEntry,
  sessionFilesRevision,
  verifiedLocalLaunch,
} from "./run-resource-worker.js";
import {
  assignmentResourceKeys,
  unclaimedResourceKeys,
} from "./run-resources.js";
import {
  deferTargetAttempt,
  RunTargetDeferred,
  refreshTargetWait,
} from "./run-target.js";
import {
  type ProvisionTargetRefusal,
  provisionRefusalFor,
  RuntimeTargetError,
  RuntimeTargets,
} from "./runtime-targets.js";
import { stopRunRuntime } from "./stop-run.js";
import { settleTestReviewLimits } from "./test-review-limits.js";
import { testReviewRunContext } from "./test-review-prompt.js";
import {
  armBellReceipt,
  confirmBellWrite,
  RunWakeWithdrawn,
  recordWakeRefusal,
  wakeIsCurrent,
} from "./wake-guard.js";
import {
  describePreparationFailure,
  preparationExecutionExited,
  preparationUnavailable,
} from "./wake-preparation.js";
import {
  checkWorkerMcp,
  WorkerMcpError,
  workerMcpConfig,
  workerMcpPython,
} from "./worker-mcp.js";
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

/** Bounded startup intent: worktree placement may include a 30-minute Git transfer. */
export const WORKTREE_LAUNCH_LEASE_MS = 60 * 60_000;

export class RunCapacityDeferred extends Error {
  constructor(
    readonly run_id: string,
    readonly ahead: number,
  ) {
    super(`排队中（前面还有 ${ahead} 个）`);
  }
}
export class RunProviderDeferred extends Error {
  constructor() {
    super("模型服务不可用，保留执行排队等待");
  }
}
export class RunPreparationDeferred extends Error {
  constructor() {
    super("工作目录准备或启动尚未结束，保留执行排队等待");
  }
}

export interface LaunchHost {
  readonly configDir?: string;
  readonly runLimit?: (machine: string) => number;
  readonly leases?: MachineLeases;
  readonly projectQuota?: ReadProjectQuota;
  readonly resourceLimits?: ReadResourceLimits;
  readonly runLimitMaximum?: (machine: string) => number;
  readonly store: Store;
  readonly runtime: Runtime & Partial<Pick<HerdrRuntime, "captureAgent">>;
  readonly launch: {
    readonly config: LaunchConfig;
    readonly secrets: Readonly<Record<string, string>>;
  };
  readonly mcpUrl: string;
  /**
   * C-600: new sessions must list the Card MCP tools before their first tool
   * call; a session without native tools is refused and rebuilt once.
   */
  readonly verifyMcpSession?: boolean;
  readonly dataDir: string;
  readonly execution?: ExecutionConfig | undefined;
  readonly clock?: Clock | undefined;
  /**
   * Host diagnostics, including manual-start capacity notices and cleanup
   * failures. Reporting must not skip token revocation or Run cancellation.
   */
  readonly report?: ((message: string) => void) | undefined;
}

/** No delivery was possible and any issued credential has been revoked. */
export class RunPreflightDeferred extends Error {}

export interface LaunchRunInput {
  readonly resourceAccess?: ResourceAccess;
  readonly resourcePreflight?: () => Promise<boolean>;
  readonly resourceGate?: () => boolean;
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
  /** Dispatcher owns bounded retry of proven pre-delivery target failures. */
  readonly retry_target_preflight?: true;
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
  ref?: RuntimeRef | null,
): Promise<void> {
  if (
    execution.mode === "agent-ssh" &&
    execution.target?.machine_id !== undefined &&
    execution.target.machine_id !== "local"
  ) {
    if (
      !ref?.launch_generation ||
      JSON.stringify(ref.target) !== JSON.stringify(execution.target)
    )
      throw new Error("Remote cleanup requires the exact launch generation");
    await workerFiles(
      execution,
      {
        project,
        assignment: assignment_id,
        run: ref.launch_generation.run_id,
        generation: ref.launch_generation.generation,
        target: execution.target.fingerprint,
      },
      "clear",
    );
    return;
  }
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
  const unlock = await tryHostOpsLock(
    host.store,
    input.project,
    input.assignment_id,
    "launch",
  );
  if (!unlock) throw new RunPreparationDeferred();
  try {
    settleTestReviewLimits(host.store, input.project, host.clock);
    // Admission is shared with queued/reused-session dispatch. Settle limits
    // first, then re-read the exact Run trigger before preparing resources.
    host.store.uow.read((tx) => {
      const state = loadCommandState(tx, input.project);
      const owner = state.assignments.find((a) => a.id === input.assignment_id);
      const run = state.runs.find((r) => r.id === input.run.id);
      if (
        owner &&
        run &&
        reviewRunWakeDisposition(state, owner, run) === "paused"
      )
        throw new HostLaunchError(
          "dispatch",
          "Review budget is waiting for a decision",
        );
    });
    return await launchWithClaim(host, input);
  } catch (error) {
    settleTestReviewLimits(host.store, input.project, host.clock);
    throw error;
  } finally {
    await unlock();
  }
}

async function launchWithClaim(
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
  const owner = host.store.uow.read((tx) =>
    tx.assignments.get(input.project, input.assignment_id),
  );
  // C-815: the same `android.any` choice before inspection and in the claim.
  const resolvedKeys = (
    tx: ReadRepositories,
    a: Assignment,
    project: string = input.project,
  ) =>
    resolveResourceAlternatives(
      host.store,
      project,
      a,
      assignmentResourceKeys(tx, project, a),
      clock.now(),
      () =>
        runCapacitySnapshot(
          host.store,
          tx,
          host.resourceLimits,
          host.projectQuota,
        ),
      host.leases,
    );
  const inspection =
    owner &&
    (await host.leases?.inspect(
      input.project,
      owner,
      host.store.uow.read((tx) => resolvedKeys(tx, owner)),
    ));
  let access: ResourceAccess | undefined;
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
    const profile =
      run.launch_profile_ref ??
      (assignment.employee_id &&
        tx.employees.get(assignment.employee_id)?.launch_profile_ref) ??
      getRoleVersion(
        tx,
        input.project,
        assignment.role_id,
        assignment.role_version,
      )?.launch_profile_ref;
    const probe = providerAdmission(
      loadCommandState(tx, input.project),
      profile,
      clock.now(),
      (r) =>
        unfinishedBellAttempts(
          host.store.database,
          input.project,
          r.assignment_id,
        ).some((b) => b.run_id === r.id),
    );
    if (probe === "wait") {
      tx.runs.put(input.project, {
        ...run,
        queue_reason: "provider_unavailable",
      });
      return "provider_unavailable" as const;
    }
    tx.runs.put(input.project, { ...run, queue_reason: "concurrency_limit" });
    const capacity = runCapacitySnapshot(
      host.store,
      tx,
      host.resourceLimits,
      host.projectQuota,
    );
    const slots = capacity.resourcesForMachine(assignment.machine_id);
    const keys = resolvedKeys(tx, assignment);
    const denied = host.leases?.blocked(
      input.project,
      assignment.machine_id,
      keys,
      clock.now(),
      inspection,
    );
    if (
      denied ||
      (host.leases &&
        !capacity.withinProjectQuota(input.project, assignment, keys)) ||
      (assignment.runtime_ref &&
        host.leases?.freshSession(input.project, assignment))
    ) {
      const overQuota =
        !denied &&
        !capacity.withinProjectQuota(input.project, assignment, keys);
      host.leases?.wait(
        tx,
        input.project,
        assignment,
        run,
        denied ?? (overQuota ? "项目额度已满" : "等待重新创建资源会话"),
        clock.now(),
        true,
        false,
        overQuota ? "capacity" : undefined,
      );
      return undefined;
    }
    const preferred = host.leases?.config.preferred(assignment.machine_id);
    const manual =
      input.actor.kind === "human" &&
      input.actor.project_id === input.project &&
      (!preferred || preferred === input.project);
    const limit = effectiveRunLimit(
      host.store,
      assignment.machine_id,
      host.runLimit,
      host.runLimitMaximum,
    );
    const occupied = capacity.occupied.get(assignment.machine_id) ?? 0;
    // Q-88: only the explicit human host entry may bypass machine capacity.
    // PM tools, Dispatcher and recovery callers retain system/assignment actors.
    const position = capacity.queue.find(
      (entry) => entry.project_id === input.project && entry.run_id === run.id,
    );
    // Resource limits are hard even for a manual launch. A zero total denotes
    // invalid private configuration, so resource-bearing Runs cannot infer that they're unlimited.
    if (
      !capacity.withinProjectQuota(input.project, assignment, keys) ||
      remainingResourceRatio(keys, slots) <= 0 ||
      (limit === 0 && keys.length > 0) ||
      (!manual &&
        (!canDispatchRun(limit, occupied, isRunCapacityExempt(assignment)) ||
          (!isRunCapacityExempt(assignment) &&
            position &&
            hasEarlierCapacityWait(
              tx,
              capacity.queue,
              position,
              assignment.machine_id,
              slots,
              clock.now(),
              // C-825: judged by the resolved keys, as the dispatcher does.
              capacityWaiterRunnable(capacity, host.leases, clock.now(), tx),
              host.leases?.config.preferred(assignment.machine_id),
              // C-815: an `android.any` waiter is judged by its free option.
              (entry, o) => resolvedKeys(tx, o, entry.project_id),
            ))))
    ) {
      return undefined;
    }
    const cleared = {
      ...run,
      resource_keys: keys,
      // C-736: host launches always claim the work item's resources.
      ...(keys.length ? { resource_reason: "主机启动按工作项占用" } : {}),
      ...(probe ? { provider_probe: probe } : {}),
    };
    delete cleared.queue_reason;
    if (!keys.length) delete cleared.resource_reason;
    tx.runs.put(input.project, cleared);
    const at = clock.now();
    const attempt = {
      id: randomUUID(),
      project_id: input.project,
      assignment_id: input.assignment_id,
      run_id: run.id,
      notification_ids: [],
      started_at: at,
      lease_until: new Date(
        Date.parse(at) + WORKTREE_LAUNCH_LEASE_MS,
      ).toISOString(),
      finished_at: null,
      outcome: null,
    };
    if (inspection)
      access = host.leases?.acquire(
        tx,
        input.project,
        assignment,
        run,
        keys,
        inspection,
        at,
      );
    beginLaunchAttempt(host.store.database, attempt);
    return {
      ...attempt,
      capacity_notice:
        manual &&
        !isRunCapacityExempt(assignment) &&
        limit > 0 &&
        occupied + 1 > limit
          ? `已超过全机上限（当前 ${occupied + 1}/上限 ${limit}）`
          : undefined,
    };
  });
  if (attempt === "provider_unavailable") throw new RunProviderDeferred();
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
  let withdrawn = false;
  const leases = host.leases;
  try {
    // Report the claim-time snapshot, including this Run's durable reservation.
    if (attempt.capacity_notice) host.report?.(attempt.capacity_notice);
    const result = await launch(
      host,
      {
        ...input,
        ...(access ? { resourceAccess: access } : {}),
        ...(leases && owner && access?.target
          ? {
              resourcePreflight: () =>
                leases.canPublish(
                  input.project,
                  owner,
                  input.run,
                  () => clock.now(),
                  access,
                ),
            }
          : {}),
        ...(host.leases && owner
          ? {
              resourceGate: () =>
                !host.leases?.blocked(
                  input.project,
                  owner.machine_id,
                  host.store.uow.read(
                    (tx) =>
                      tx.runs.get(input.project, input.run.id)?.resource_keys ??
                      [],
                  ),
                  clock.now(),
                  undefined,
                  access,
                ),
            }
          : {}),
      },
      attempt,
    );
    sent = true;
    return result;
  } catch (error) {
    deferred = error instanceof RunTargetDeferred;
    // Nothing was delivered; the original notifications keep their retry path.
    withdrawn =
      error instanceof RunWakeWithdrawn ||
      error instanceof RetainedWriterRefused;
    throw error;
  } finally {
    if (withdrawn)
      host.store.uow.run(() =>
        withdrawBellAttempt(host.store.database, input.project, attempt.id),
      );
    else if (deferred) deferTargetAttempt(host.store, attempt, clock);
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
  attempt?: BellAttempt,
): Promise<LaunchedRun> {
  const clock = host.clock ?? wallClock;
  let execution: ExecutionConfig = host.execution ?? {
    mode: "local",
    dataDir: host.dataDir,
  };
  const report = host.report ?? (() => undefined);
  const project = input.project;
  const requireTarget = () => {
    if (
      input.run.recovery_policy &&
      input.run.recovery_policy.root_run_id !== input.run.id
    ) {
      const valid = host.store.uow.read((tx) => {
        const state = loadCommandState(tx, project);
        const run = state.runs.find((r) => r.id === input.run.id);
        return run && recoveryTargetCurrent(state, run);
      });
      if (!valid)
        throw new HostLaunchError(
          "dispatch",
          "Automatic recovery business target changed",
        );
    }
    if (refreshTargetWait(host.store, project, input.run.id, clock, attempt))
      throw new RunTargetDeferred();
  };
  requireTarget();

  const { assignment, role, employee, card, workItem } = launchEntities(
    host.store,
    project,
    input.assignment_id,
  );
  if (host.runtime instanceof RuntimeTargets) {
    try {
      execution = (await host.runtime.forLaunch(project, assignment)).execution;
    } catch (error) {
      if (
        input.retry_target_preflight &&
        error instanceof RuntimeTargetError &&
        error.transient
      )
        throw new RunPreflightDeferred(error.message, { cause: error });
      throw error;
    }
  }
  if (
    input.resourceAccess?.target &&
    input.resourceAccess.target !==
      (execution.target?.fingerprint ??
        (execution.mode === "local" ? "local" : undefined))
  )
    throw new RunPreflightDeferred("资源检查目标已变化");
  const machine = host.store.uow.read((tx) =>
    tx.machines.get(project, assignment.machine_id),
  );
  const remote =
    execution.mode === "agent-ssh" &&
    execution.target?.machine_id === assignment.machine_id &&
    assignment.machine_id !== "local";
  const mcpUrl =
    remote && execution.mode === "agent-ssh"
      ? workerMcpConfig(execution.mcp?.url, execution.mcp?.timeoutMs).url
      : host.mcpUrl;
  if (!machine || (assignment.machine_id !== "local" && !remote))
    throw new HostLaunchError(
      "directory preparation",
      "Runtime target is not enabled for launch",
    );
  await secureDataDirectory(execution);
  if (assignment.status !== "active")
    throw new HostLaunchError(
      "directory preparation",
      `Assignment ${assignment.id} is ${assignment.status}`,
    );
  const current = host.store.uow.read((tx) =>
    tx.runs.get(project, input.run.id),
  );
  if (current && preparationRetryWaiting(current, clock.now()))
    throw new HostLaunchError(
      "directory preparation",
      "工作目录准备重试正在退避等待",
    );
  if (
    host.store.uow.read((tx) =>
      tx.runs
        .list(project)
        .some(
          (r) =>
            r.assignment_id === assignment.id &&
            (r.inactivity_stop ||
              r.dispatch_stop ||
              (r.launch_publication &&
                !["started", "exited"].includes(r.launch_publication.phase))),
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
      host.store.uow.read((tx) => {
        const state = loadCommandState(tx, project);
        return state.runs.some(
          (r) =>
            r.assignment_id === assignment.id &&
            r.id !== current.id &&
            !standingRunDormant(assignment, r) &&
            !canParkForDiscussion(state, assignment, r, current) &&
            !["completed", "failed", "cancelled"].includes(r.status),
        );
      }))
  )
    throw new HostLaunchError(
      "directory preparation",
      "Session replacement requires the same idle Assignment and queued Run",
    );

  let { runDir, repositoriesRoot, buildsRoot } = executionPaths(
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
  const reviewContext = () =>
    role.role_id === "independent_reviewer"
      ? host.store.uow.read((tx) =>
          testReviewRunContext(
            loadCommandState(tx, project),
            assignment.id,
            current.id,
          ),
        )
      : undefined;
  const reviewPrompt = () => reviewContext()?.prompt;
  let preparedReviewPrompt: string | undefined;
  let compiledReviewScope: Run["test_review"] | null | undefined;
  let worktree = input.worktree;
  let workDir = worktree?.path ?? assignment.worktree_path ?? runDir;
  const preparation = () =>
    input.prepare_worktree
      ? input.prepare_worktree()
      : prepareRoleWorktree(
          {
            store: host.store,
            execution,
            runtime:
              host.runtime instanceof RuntimeTargets
                ? host.runtime.forProject(project)
                : host.runtime,
          },
          project,
          assignment.id,
        );
  const prepare = () =>
    !input.prepare_worktree &&
    (role.worktree === "none" ||
      assignment.scope !== "work_item" ||
      !card?.repo)
      ? preparation()
      : withPreparationQueue(execution.dataDir, project, preparation);
  const retained = host.store.uow.read((tx) =>
    retainedWriterForRun(loadCommandState(tx, project), current, assignment),
  );
  const writerBinding = () =>
    host.store.uow.read((tx) =>
      retained?.binding(loadCommandState(tx, project)),
    );
  const verifyWriter = async () => {
    if (!retained) return;
    const current = writerBinding();
    if (current) await retained.verify(current, execution);
  };
  if (input.reuse_session && assignment.runtime_ref) {
    const observed = await host.runtime.status(assignment.runtime_ref);
    if (observed.ok && observed.value.process === "alive") {
      const addressed = assignment.runtime_ref;
      const arm = () =>
        armBellReceipt(
          host.store,
          project,
          current.id,
          addressed,
          card?.id,
          attempt?.review_wake,
        );
      const guard = idleWakeGuard(observed.value);
      if (!guard) throw new RunWakeWithdrawn();
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
        host.store.uow.run((tx) => {
          const state = loadCommandState(tx, project);
          const effect = unwrap(
            dispatchRun(
              state,
              input.actor,
              { run_id: current.id },
              { clock, ids: tx.ids },
            ),
          );
          persistEffect(tx, project, effect);
          if (attempt)
            attempt = bindRepairAttempt(
              host.store,
              state,
              effect.data,
              attempt,
            );
          return effect.data;
        });
      let run: Run | undefined =
        workItem?.kind === "verify" ||
        host.leases?.configured(project, assignment.machine_id) ||
        host.leases?.adbNeeded(project, assignment)
          ? undefined
          : dispatch();
      let waking = false;
      const wakeCurrent = () =>
        host.store.uow.read((tx) => {
          const state = loadCommandState(tx, project);
          const fresh = state.runs.find((r) => r.id === current.id);
          return (
            !!fresh &&
            ["queued", "dispatched"].includes(fresh.status) &&
            wakeIsCurrent(state, assignment, current.id)
          );
        });
      const requireWakeCurrent = () => {
        if (!wakeCurrent()) throw new RunWakeWithdrawn();
      };
      try {
        worktree ??= await prepare();
        requireTarget();
        requireWakeCurrent();
        if (
          (input.resourcePreflight && !(await input.resourcePreflight())) ||
          (input.resourceGate && !input.resourceGate())
        )
          throw new RunTargetDeferred();
        run ??= dispatch();
        preparedReviewPrompt = reviewPrompt();
        waking = true;
        let targetDeferred = false;
        const result = await host.runtime.wake(
          assignment.runtime_ref,
          [prompt, worktreeBaselinePrompt(worktree), preparedReviewPrompt]
            .filter(Boolean)
            .join("\n"),
          {
            ...guard,
            ...(input.resourcePreflight
              ? { resource_preflight: input.resourcePreflight }
              : {}),
            before_send: () => {
              if (input.resourceGate && !input.resourceGate()) return false;
              if (attempt?.review_wake) {
                const gate = crossRepairSendBoundary(
                  host.store,
                  attempt,
                  assignment,
                  clock,
                );
                targetDeferred = gate === "deferred";
                return gate === "send" && arm();
              }
              targetDeferred = refreshTargetWait(
                host.store,
                project,
                current.id,
                clock,
              );
              return (
                !targetDeferred &&
                wakeCurrent() &&
                reviewPrompt() === preparedReviewPrompt &&
                arm()
              );
            },
          },
        );
        if (result.ok && result.value.withdrawn) {
          const refused = attempt;
          if (refused)
            recordWakeRefusal(host.store, refused, assignment, clock.now());
          if (targetDeferred) throw new RunTargetDeferred();
          throw new RunWakeWithdrawn();
        }
        if (result.ok && !result.value.sent && attempt?.review_wake) {
          const unsent = attempt;
          host.store.uow.run(() =>
            confirmReviewNotSent(host.store.database, unsent),
          );
        }
        if (!result.ok || !result.value.sent)
          throw new Error("Session wake failed; delivery may have occurred");
        confirmBellWrite(host.store, project, current.id, clock.now());
      } catch (error) {
        if (
          error instanceof RunWakeWithdrawn ||
          error instanceof RunTargetDeferred
        )
          throw error;
        if (!waking) {
          requireTarget();
          requireWakeCurrent();
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
    machine_id: assignment.machine_id,
    ...(execution.target
      ? { execution_identity: execution.target.fingerprint }
      : {}),
  });

  let step: LaunchStep = "directory preparation";
  let tokenId: string | undefined;
  let ref: RuntimeRef | undefined;
  let publication: LaunchPublication | undefined;
  let launchToken: string | undefined;
  let provisionRefusal: ProvisionTargetRefusal | undefined;
  try {
    if (retained) {
      await verifyWriter();
      worktree = retained.tree;
      workDir = worktree.path;
    }
    if (remote && execution.mode === "agent-ssh") {
      publication = LaunchPublication.begin(
        host,
        execution,
        project,
        assignment,
        current,
        agentName,
        workDir,
      );
      runDir = publication.runDir;
      if (!worktree && !assignment.worktree_path) workDir = runDir;
    }
    if (execution.mode === "agent-ssh" && !remote)
      await prepareAgentProject(execution, project, assignment.id);
    const agentTools = await agentToolsDirectoryFor(execution, remote);

    // The Dispatcher passes no worktree: the host prepares what the Role needs
    // (a writer's branch, or a readonly reviewer at the current delivery).
    if (!worktree && !(remote && role.worktree === "none")) {
      worktree = await prepare();
      // C-784: only this launch's own host preparation can attest the worker.
      if (
        publication &&
        worktree &&
        (role.worktree === "write" || role.worktree === "readonly")
      )
        publication.preparedWorktree = true;
    }
    requireTarget();
    const fresh = host.store.uow.read((tx) =>
      tx.runs.get(project, input.run.id),
    );
    if (fresh?.status !== "queued") throw new RunPreparationDeferred();
    const unclaimed = host.store.uow.read(
      (tx) => unclaimedResourceKeys(tx, project, assignment, fresh).length > 0,
    );
    workDir = worktree?.path ?? workDir;
    publication?.update("preparing", {
      work_dir: workDir,
      sha: worktree?.base_sha ?? assignment.base_sha ?? null,
    });

    step = "token issuance";
    const issued = issueAssignmentToken(host.store, project, {
      assignment,
      role,
    });
    tokenId = issued.record.id;
    launchToken = issued.token;
    publication?.update("preparing", { token_id: tokenId });
    if (remote && execution.mode === "agent-ssh") {
      step = "MCP preflight";
      publication?.assertCurrent();
      await checkWorkerMcp(execution, issued.token);
      requireTarget();
      publication?.assertCurrent();
    }
    // Issuance may have stamped a legacy standing mode; read the row back so
    // the first prompt and the token scope describe the same mode.
    const currentAssignment =
      host.store.uow.read((tx) => tx.assignments.get(project, assignment.id)) ??
      assignment;
    const toolCatalog = sessionFingerprint(
      sessionToolCatalog(
        issued.record.allowed_tools,
        currentAssignment,
        host.store,
        clock,
      ),
      role,
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
    const compiledReview = reviewContext();
    preparedReviewPrompt = compiledReview?.prompt;
    compiledReviewScope = compiledReview?.scope;
    // C-600: a per-launch key only this session's harness sends from its own
    // MCP configuration; the endpoint keeps its digest on the Assignment.
    const mcpSessionKey = host.verifyMcpSession
      ? randomBytes(24).toString("base64url")
      : undefined;
    // C-676: the session learns its project's code for full numbers.
    const projectCode = host.store.projectCode(project);
    // C-726: usage notes of the capabilities this work item requires.
    const capabilityNotes = launchCapabilityNotes(
      host.store,
      project,
      assignment.machine_id,
      workItem?.requirements,
    );
    const compiled = compileAssignmentLaunch({
      ...(employee !== undefined
        ? { employee: { launch_profile_ref: profileRef, identity: employee } }
        : {}),
      assignment: {
        assignment_id: assignment.id,
        run_id: input.run.id,
        project_id: project,
        ...(projectCode === undefined ? {} : { project_code: projectCode }),
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
        // P2a-14 ⑧: `browser` adds the host's local browser when configured.
        capabilities: role.capabilities,
      },
      launch: host.launch.config,
      // An adb slot alone is not a static binding: keep the Run's port
      // allocations (such as a private Vite port) unrestricted.
      ...(input.resourceAccess &&
      (input.resourceAccess.bindings.length || !input.resourceAccess.adb)
        ? { resource_bindings: input.resourceAccess.bindings }
        : // C-721: a Run admitted without some of its work item's resources
          // gets no device either; slot machines already give it none.
          unclaimed && !host.leases?.config.adbSlots(assignment.machine_id)
          ? { resource_bindings: [] }
          : {}),
      // C-679: read the held slot back, so a retried launch of this Run keeps it.
      // C-813: likewise its devices; on a machine that hands out adb devices,
      // a slot Run holding none must not let its adb server claim USB.
      ...launchDevices(
        host.leases,
        project,
        assignment.machine_id,
        input.run.id,
      ),
      ...(capabilityNotes === undefined
        ? {}
        : { capability_notes: capabilityNotes }),
      ...(execution.mode === "agent-ssh" && execution.env
        ? { worker_env: execution.env }
        : {}),
      agent_nice: execution.agentNice ?? 10,
      agent_local_tests: true,
      ...(agentTools ? { agent_tools_dir: agentTools } : {}),
      run_resources: resourceEntry(
        project,
        assignment.machine_id,
        execution,
        mcpUrl,
        issued.record.id,
        host.store.runResources.publicKey(),
      ),
      ...(assignment.machine_id === "local"
        ? { test_max_workers: await loadAgentTestWorkers(host.configDir) }
        : {}),
      status_line: statusLineContext(host.store, project, card?.base_branch),
      mcp: {
        url: mcpUrl,
        ...(mcpSessionKey ? { session_key: mcpSessionKey } : {}),
        // C-600: the Codex Card bridge runs on the interpreter the MCP
        // preflight and the machine check use on this worker.
        ...(remote && execution.mode === "agent-ssh"
          ? { bridge_python: workerMcpPython(execution) }
          : {}),
      },
      run_dir: runDir,
      work_dir: workDir,
      ...(publication ? { worker_launch: publication.wrapper() } : {}),
      // C-235: pi pre-trusts only the verified real path of this worktree.
      ...(worktree === undefined
        ? {}
        : await (publication
            ? publication.worktree(worktree.path)
            : piTrustedWorktreePath(worktree.path)
          ).then((real) =>
            real === undefined ? {} : { work_dir_real: real },
          )),
      // GitWorktreeService owns this layout; do not run host Git in an Agent
      // repository to discover the common dir (§12.2). Only an Assignment that
      // actually got a worktree needs the repository exception (M5.S S13).
      ...(worktree === undefined
        ? {}
        : { repository_root: join(repositoriesRoot, project) }),
      // P2a-3: a reused session keeps working across wakes; the build path is
      // fixed per Assignment, so every readonly verifier trusts it up front.
      ...(worktree === undefined || role.worktree !== "readonly"
        ? {}
        : { build_dir: join(buildsRoot, project, assignment.id) }),
      // The merged bell is the first prompt when the caller has one (M3 §3.2).
      first_prompt: [
        prompt,
        preparedReviewPrompt,
        standingModeLine(currentAssignment, standingModeOf(currentAssignment)),
        worktreeBaselinePrompt(worktree),
        worktree === undefined
          ? worktreeUnavailablePrompt(
              worktreeUnavailableReason(
                role,
                { scope: assignment.scope },
                card,
              ),
            )
          : undefined,
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n"),
      secrets: host.launch.secrets,
    });

    if (
      current.recovery_policy &&
      current.recovery_policy.root_run_id !== current.id
    ) {
      const actual = compiledLaunchSettings(compiled.harness, compiled.args);
      if (
        model !== current.model ||
        (current.launch_profile_ref !== undefined &&
          compiled.profile !== current.launch_profile_ref) ||
        (current.harness !== undefined && actual.harness !== current.harness) ||
        actual.effort !== current.effort
      )
        throw new HostLaunchError(
          step,
          "Recovery launch settings changed; automatic launch refused",
        );
    }
    step = "run directory write";
    if (publication) await publication.publish(compiled.files, issued.token);
    else {
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
    }
    requireTarget();

    if (reviewPrompt() !== preparedReviewPrompt) throw new RunWakeWithdrawn();
    step = "runtime provision";
    await verifyWriter();
    const launchDesc: RuntimeLaunch = publication?.description() ?? {
      ...verifiedLocalLaunch(compiled),
      cwd: workDir,
      agent_name: agentName,
      labels: {
        cardigan: "1",
        project,
        assignment: assignment.id,
        run: input.run.id,
        ...(input.run.recovery_policy ? { generation: randomUUID() } : {}),
      },
    };
    const runtime: Pick<RuntimeTargets, "provision" | "resume_or_replace"> =
      host.runtime;
    const enterAdapter = () => {
      if (retained) writerBinding();
      if (publication) requireTarget();
      publication?.assertCurrent();
      publication?.update("provisioning", { provision_attempted: true });
    };
    // The router has asynchronous target checks of its own. Journal at the
    // actual adapter boundary; an opaque runtime must be fenced before entry.
    const boundary: [] | [() => void] =
      (publication || retained) && host.runtime instanceof RuntimeTargets
        ? [enterAdapter]
        : [];
    if (!boundary.length) enterAdapter();
    const provisioned =
      input.replacement &&
      !input.replacement.previous_exit_confirmed &&
      input.replacement.reason !== "launch_profile_changed"
        ? await runtime.resume_or_replace(
            input.replacement.previous,
            launchDesc,
            ...boundary,
          )
        : await runtime.provision(
            assignment,
            role,
            machine,
            launchDesc,
            ...boundary,
          );
    if (!provisioned.ok) {
      provisionRefusal = provisionRefusalFor(provisioned.error, launchDesc);
      if (provisionRefusal) throw provisionRefusal;
      const message = `provision failed: ${provisioned.error.code} ${provisioned.error.message}`;
      if (
        publication &&
        ["runtime_unavailable", "runtime_timeout", "version_mismatch"].includes(
          provisioned.error.code,
        )
      )
        throw new WorkerPreparationFailure(message);
      throw new Error(message);
    }
    ref = {
      ...provisioned.value,
      ...(publication
        ? {
            launch_generation: {
              run_id: current.id,
              generation: publication.generation,
            },
          }
        : {}),
    };
    publication?.update("provisioned", { runtime_ref: ref });
    await publication?.observeProcess();
    requireTarget();
    publication?.assertCurrent();
    if (reviewPrompt() !== preparedReviewPrompt) throw new RunWakeWithdrawn();

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
    if (
      (input.resourcePreflight && !(await input.resourcePreflight())) ||
      (input.resourceGate && !input.resourceGate())
    )
      throw new RunTargetDeferred();
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
            ...(compiledReviewScope === undefined
              ? {}
              : { expected_test_review: compiledReviewScope }),
            launch_snapshot: {
              model,
              agent_cli_version: current.agent_cli_version,
              launch_profile_ref: compiled.profile,
              launch_fingerprint: launchFingerprint(
                host.store,
                host.launch,
                compiled.profile,
                role.capabilities.includes("browser"),
              ),
              // C-106: what this session was actually started with.
              ...compiledLaunchSettings(compiled.harness, compiled.args),
              // P2a-10 A: the new session lists exactly this token's tools.
              ...(toolCatalog === undefined
                ? {}
                : { tool_catalog: toolCatalog }),
            },
            runtime_ref: dispatchRef,
            ...(mcpSessionKey &&
            getHarnessAdapter(compiled.harness).listsMcpToolsAtStartup
              ? {
                  verify_mcp_session: {
                    key_sha256: createHash("sha256")
                      .update(mcpSessionKey)
                      .digest("hex"),
                    token_id: issued.record.id,
                  },
                }
              : {}),
            ...(baseSha === undefined ? {} : { base_sha: baseSha }),
            ...(input.replacement ? { replacement: input.replacement } : {}),
          },
          ports,
        ),
    });
    publication?.update("dispatched", { runtime_ref: dispatchRef });
    if (
      publication ||
      input.run.recovery_policy ||
      input.run.kind === "rework" ||
      input.run.kind === "decision_resumed"
    )
      requireTarget();

    // Local dispatch and sentinel publication are consecutive synchronous
    // decisions after the last probe. Do not park a local dispatched Run to
    // repeat asynchronous IO. Remote publication has its own withdrawal journal.
    if (
      (publication &&
        input.resourcePreflight &&
        !(await input.resourcePreflight())) ||
      (input.resourceGate && !input.resourceGate())
    )
      throw new RunTargetDeferred();
    step = "sentinel write";
    if (!armBellReceipt(host.store, project, current.id, dispatchRef, card?.id))
      throw new RunWakeWithdrawn();
    if (publication) await publication.commit();
    else await writeAgentSentinel(execution, project, assignment.id);
    confirmBellWrite(host.store, project, current.id, clock.now());

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
    // Verification precedes any credential, terminal or publication. Keep the
    // queued Run: cancelling it would consume the work Ops must still recover.
    if (
      error instanceof RetainedWriterRefused &&
      tokenId === undefined &&
      ref === undefined &&
      publication === undefined
    )
      throw error;
    // A later checkout recheck (before any terminal exists) withdraws only
    // this attempt's token, credentials and publication; the queue stays.
    const refused = error instanceof RetainedWriterRefused && ref === undefined;
    const deferred =
      !refused &&
      step !== "sentinel write" &&
      (error instanceof RunTargetDeferred ||
        refreshTargetWait(host.store, project, input.run.id, clock));
    if (publication) {
      const reason = launchFailureReason(
        step,
        error,
        host.launch.secrets,
        launchToken,
      );
      const targetFailure =
        step === "MCP preflight" && error instanceof WorkerMcpError
          ? new RuntimeTargetError(error.code)
          : provisionRefusal;
      const retry = input.retry_target_preflight && targetFailure?.transient;
      let exited = false;
      try {
        exited = await publication.stop(
          deferred || retry || refused,
          deferred || retry || refused
            ? undefined
            : {
                reason,
                worker:
                  error instanceof WorkerPreparationFailure ||
                  (error instanceof WorkerMcpError &&
                    [
                      "mcp_worker_failed",
                      "mcp_unreachable",
                      "mcp_timeout",
                    ].includes(error.code)),
              },
          provisionRefusal,
        );
      } catch {
        report("远程启动撤回尚未确认，保留阶段和容量预留");
      }
      if (deferred && exited) throw new RunTargetDeferred();
      if (refused && exited) throw error;
      if (retry && exited)
        throw new RunPreflightDeferred(targetFailure.reason, { cause: error });
      throw new HostLaunchError(
        step,
        `${reason}; ${exited ? "withdrawn" : "exit_unconfirmed"}`,
      );
    }
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
      keepRun: deferred || refused,
      ...(!deferred &&
      !refused &&
      step === "directory preparation" &&
      ref === undefined &&
      tokenId === undefined
        ? {
            preparation: (() => {
              const failure = describePreparationFailure(error);
              const policy = preparationPolicy();
              return {
                category:
                  input.run.recovery_policy && preparationUnavailable(error)
                    ? "runtime_unavailable"
                    : failure.category,
                message: failure.message,
                execution_exited: preparationExecutionExited(error),
                backoff_ms: policy.retryBackoffMs,
                retry_schedule_ms: policy.retryScheduleMs,
              };
            })(),
          }
        : {}),
      ...(ref === undefined ? {} : { ref }),
      ...(tokenId === undefined ? {} : { tokenId }),
    });
    if (deferred) throw new RunTargetDeferred();
    if (refused) throw error;
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
  readonly preparation?: {
    category: string;
    message: string;
    execution_exited: boolean;
    backoff_ms: number;
    retry_schedule_ms: readonly number[];
  };
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
    host.store.uow.run((tx) => {
      const ports = { clock: input.clock, ids: tx.ids };
      persistEffect(
        tx,
        input.project,
        unwrap(
          abortDispatch(
            loadCommandState(tx, input.project),
            input.actor,
            { run_id: input.run.id, reason: `${input.step} failed` },
            ports,
          ),
        ),
      );
      if (input.preparation)
        persistEffect(
          tx,
          input.project,
          unwrap(
            recoverPreparation(
              loadCommandState(tx, input.project),
              { kind: "system", project_id: input.project },
              {
                run_id: input.run.id,
                ...input.preparation,
                cleanup_complete: !cleanupFailed,
                expected_runtime_ref: input.assignment.runtime_ref,
              },
              ports,
            ),
          ),
        );
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
 * P2a-3: launch-environment revision of verifier sessions. A readonly
 * work-item session launched before the build checkout existed lacks its
 * environment (`pnpm_config_package_import_method=copy`, safe.directory) and a
 * reused session cannot gain it, so it is folded into the session fingerprint
 * the Dispatcher already compares (P2a-10 A): such a session is replaced once
 * before its next wake, like a changed tool catalog.
 */
export const VERIFIER_LAUNCH_REVISION = "build-env-1";
export function sessionFingerprint(
  catalog: string | undefined,
  role: Pick<Role, "worktree">,
  assignment: Pick<Assignment, "scope">,
  files: string | undefined = sessionFilesRevision(),
): string | undefined {
  if (catalog === undefined) return undefined;
  const base =
    role.worktree === "readonly" && assignment.scope === "work_item"
      ? `${catalog}+${VERIFIER_LAUNCH_REVISION}`
      : catalog;
  return files ? `${base}+${files}` : base;
}

/**
 * P2a-10 A: fingerprint of the tools/list a new session will receive. A
 * failure only drops the fingerprint (no catalog replacement later); it never
 * blocks the launch.
 */
function sessionToolCatalog(
  allowed: readonly string[],
  assignment: Assignment,
  store: Store,
  clock: Clock,
): string | undefined {
  let snapshot: ReturnType<typeof defaultToolCatalogSnapshot>;
  try {
    snapshot = defaultToolCatalogSnapshot(allowed, assignment);
  } catch {
    return undefined;
  }
  // C-797: keep the structure, so a later deploy can tell whether this session
  // may keep running. Losing it only means a replacement at that deploy.
  try {
    recordToolCatalogSnapshot(
      store,
      snapshot.fingerprint,
      snapshot.structure,
      clock.now(),
    );
  } catch {
    // Ignored.
  }
  return snapshot.fingerprint;
}

/** C-686: baseline ref and the project's context thresholds for the status line. */
export function statusLineContext(
  store: Store,
  project: ProjectId,
  baseBranch: string | undefined,
) {
  const { handoff, restart } = contextUsageThresholds(
    store.uow.read((tx) => tx.project_preferences.get(project, project)) ??
      undefined,
  );
  return {
    ...(baseBranch ? { base_ref: `origin/${baseBranch}` } : {}),
    handoff_remaining_pct: handoff,
    restart_remaining_pct: restart,
  };
}

/**
 * C-813: the launch input for the Run's adb slot and held devices, read back
 * from the database so a retried launch keeps them.
 */
export function launchDevices(
  leases: MachineLeases | undefined,
  project: string,
  machine: string,
  run: string,
  now: string = new Date().toISOString(),
): Pick<CompileAssignmentInput, "adb_slot" | "device_session"> {
  if (!leases) return {};
  // C-833: the session launched now carries the machine's adb environment.
  leases.sessions.record(project, machine, run, now);
  const policy = leases.config.adbSlots(machine);
  const slot = policy
    ? (leases.adb.launchSlot(project, machine, run) ?? null)
    : undefined;
  const held = leases.devices.launchDevices(project, machine, run, now);
  const session = deviceSession(held, {
    ...(slot?.emulator_port
      ? { emulator_serial: `emulator-${slot.emulator_port}` }
      : {}),
  });
  const usbOff =
    !!slot &&
    !held.some((d) => policy?.resources.has(d.type)) &&
    leases.devices.adbTypes(machine).length > 0;
  return {
    ...(slot === undefined
      ? {}
      : {
          adb_slot: slot && usbOff ? { ...slot, usb_off: true as const } : slot,
        }),
    ...(session ? { device_session: session } : {}),
  };
}
