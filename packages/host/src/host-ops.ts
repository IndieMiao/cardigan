import { isDeepStrictEqual } from "node:util";
import {
  type Assignment,
  type AssignmentId,
  ATTACHED_HUMAN_WAIT_OVERDUE,
  admitWorkerInspection,
  attachedHumanWaits,
  automaticContextActionForRun,
  automaticContextRestartReady,
  beginAutomaticContextRestart,
  beginHostOpsAction,
  type CardId,
  type Clock,
  type CommandState,
  type ContextObservation,
  cancelQueuedHostOpsRun,
  checkHostOpsAccess,
  claimHostOpsAction,
  contextRestartRetryState,
  contextUsageFresh,
  currentHarnessActivity,
  DEFAULT_ATTACHED_HUMAN_NOTICE_MS,
  directlyCancellableRun,
  dispatchedAt,
  dispatchRecoveryQueuedAt,
  eventById,
  eventsOfType,
  finishHostOpsAction,
  guardReviewRestartStop,
  type HarnessActivity,
  type HostOpsExecution,
  type HostOpsExecutionTool,
  hostOpsExitConfirmation,
  hostOpsPending,
  hostOpsReadDiagnostics,
  hostOpsRecheckPrecheck,
  lastRunActivity,
  observedLocalExitCause,
  type ProjectId,
  pendingHostOpsActions,
  prepareHostOpsAction,
  type RetirementStop,
  type Run,
  type RunId,
  type Runtime,
  type RuntimeRef,
  recheckMerge,
  recordAttachedHumanWait,
  recordAutomaticContextRestartResult,
  recordContextUsageNotices,
  requestHostOpsExitConfirmation,
  retirementStallHandoff,
  reviewRestartStopStarted,
  type SessionActivity,
  systemTurnOwner,
  type UpstreamDiagnosis,
  type UpstreamHoldDetail,
  type WorkerInspectionRequest,
  withdrawRecoveredHostOpsAction,
  withdrawUnstartedStallRestart,
  workerInspectionTarget,
} from "@cardigan/domain";
import {
  type HostOpsToolOptions,
  loadCommandState,
  persistEffect,
  type ToolContext,
  ToolError,
  unwrap,
} from "@cardigan/mcp-server";
import type { LaunchConfig } from "@cardigan/roles";
import { launchWarnings } from "@cardigan/roles";
import {
  DEFAULT_HC_SESSION,
  type ExecutionConfig,
  type HerdrRuntime,
} from "@cardigan/runtime-herdr";
import {
  listWorkerUsage,
  readContextSamples,
  recordNotification,
  type Store,
  unfinishedBellAttempts,
  writeContextSamples,
} from "@cardigan/store";
import { readAttention } from "./attention.js";
import {
  notifyAutomaticContextResult,
  recoveryPm,
} from "./automatic-context-restart.js";
import {
  assignmentActivityScope,
  type ContextUsageOptions,
  contextThresholdView,
  DEFAULT_CONTEXT_STALE_AFTER_MS,
  type HarnessActivityInspection,
  type ResolveActivityExecution,
  readSessionContexts,
  type SessionContextDiagnostic,
} from "./context-usage.js";
import { readDeploymentDiagnostics } from "./deployment-diagnostics.js";
import { hostOpsLockHolder, tryHostOpsLock } from "./host-ops-lock.js";
import { idleScarceSessions } from "./idle-scarce-sessions.js";
import { releaseExitedAgent } from "./idle-session-retirement.js";
import { stopIdleSession } from "./idle-session-stop.js";
import { recordRunLaunchEvidence } from "./launch-evidence.js";
import {
  incidentIdentity,
  settlementIdentityHolds,
  writerPlacementSeal,
} from "./retained-writer.js";
import { DEFAULT_SCARCE_RESOURCES } from "./run-capacity-config.js";
import {
  darwinTurnTarget,
  localTurnExitProof,
  remoteStallExit,
  sessionExitProof,
  stallWorkspace,
  transferredSessionExited,
  turnIdlePrompt,
  writableInPlace,
} from "./stall-evidence.js";
import { recoveryBasis, StallPatrol } from "./stall-patrol.js";
import {
  exitStandingSession,
  remindStandingExitOverdue,
  type StandingExitOutcome,
  type StandingExitPolicy,
  standingExitPolicy,
} from "./standing-session-exit.js";
import {
  revokeStoppedRunTokens,
  stopRunRuntime,
  stopSystemTurn,
} from "./stop-run.js";
import {
  releaseUnresponsiveAgent,
  type UnresponsiveProof,
} from "./unresponsive-session.js";
import {
  staleObservation,
  UpstreamHealthMonitor,
  upstreamHoldDetail,
  upstreamHoldReason,
} from "./upstream-health.js";
import { inspectWorker } from "./worker-inspection.js";

interface Options {
  stallBackup?: (
    project: ProjectId,
    a: Assignment,
    action: string,
  ) => Promise<{ ref: string; sha: string }>;
  workerInspectionIntervalMs?: number;
  workerExecution?: (project: ProjectId, machine: string) => ExecutionConfig;
  upstream?: LaunchConfig | undefined;
  upstreamMonitor?: UpstreamHealthMonitor;
  store: Store;
  runtime: Runtime &
    Partial<Pick<HerdrRuntime, "diagnostics" | "interaction">> & {
      executionForRef?: ResolveActivityExecution;
    };
  snapshot: (
    a: Assignment,
    project: ProjectId,
  ) => Promise<NonNullable<HostOpsExecution["snapshot"]>>;
  settings?: (project: ProjectId) => CommandState["project_settings"];
  clock?: Clock;
  contextUsage?: ContextUsageOptions;
  scrubCredentials?: (
    project: ProjectId,
    assignment: AssignmentId,
    ref: RuntimeRef | null,
  ) => Promise<void>;
  /**
   * C-152: whether `runtime` can observe this terminal. A terminal recorded on
   * another runtime (e.g. a local terminal while the server runs agent-ssh)
   * can never be proven exited here, so the human confirms it instead.
   * Defaults to "every reference belongs to `runtime`".
   */
  ownsRuntimeRef?: (ref: RuntimeRef) => boolean;
  /** Label of the server runtime for the human instructions. */
  runtimeLabel?: string;
  /**
   * C-153: the hc session the server registered in `runtime.json`; the hc
   * commands handed to the human use it instead of a hard-coded name.
   */
  hcSession?: string;
  /** Host observation/publication failures are reported here; drain still runs. */
  onError?: (error: unknown) => void;
  /** C-625: standing PM exit timings; defaults read the environment. */
  standingExit?: StandingExitPolicy;
  /** C-678: Needs You notice after an attached human held an action this long. */
  attachedHumanNoticeMs?: number;
  /** C-730: worker evidence for remote releases; tests substitute it. */
  unresponsiveProof?: UnresponsiveProof;
  /** C-759: resources flagged in `idle_scarce_sessions` (default: emulator, simulator, godot). */
  scarceResources?: readonly string[];
}
/** Requests commit first. The dispatch loop drains intents; a restart resumes unfinished work. */
export class HostOpsService {
  private readonly clock: Clock;
  private generation: LaunchConfig | undefined;
  private monitor: UpstreamHealthMonitor | undefined;
  private readonly retiring = new Set<Promise<void>>();
  private readonly upstreamPolls = new Map<ProjectId, Promise<void>>();
  private readonly sessionPolls = new Map<
    ProjectId,
    Promise<SessionContextDiagnostic[]>
  >();
  private readonly sessionSamples = new Map<
    ProjectId,
    {
      completedAt: number;
      samples: SessionContextDiagnostic[];
    }
  >();
  private readonly actionWorkers = new Map<string, Promise<void>>();
  /** C-678: last recorded attached-human wait per action; skips idle writes. */
  private readonly attachedWaits = new Map<
    string,
    { started_at: string; since: number; overdue: boolean }
  >();
  private readonly contextAbort = new AbortController();
  private contextPoll: Promise<void> | undefined;
  private closing = false;
  private readonly stallPatrol: StallPatrol;
  private stallPoll: Promise<void> | undefined;
  private lastStallPoll = Number.NEGATIVE_INFINITY;
  private lastContextPoll = Number.NEGATIVE_INFINITY;
  private serial: Promise<void> = Promise.resolve();
  private readonly standingExitPolicy: StandingExitPolicy;
  constructor(private readonly options: Options) {
    this.clock = options.clock ?? { now: () => new Date().toISOString() };
    this.standingExitPolicy = options.standingExit ?? standingExitPolicy();
    this.stallPatrol = new StallPatrol(
      options.store,
      this.clock,
      options.runtime,
      (project, machine) => this.stallExecution(project, machine),
      this.contextAbort.signal,
      (ref) => options.ownsRuntimeRef?.(ref) !== false,
      options.scrubCredentials,
    );
  }
  /** A project-local worker may have a different account and workspace root
   * than the host default. Never fall back across a rejected registry binding. */
  private stallExecution(
    project: ProjectId,
    machine: Assignment["machine_id"],
  ) {
    try {
      return this.options.workerExecution
        ? this.options.workerExecution(project, machine)
        : machine === "local"
          ? this.options.contextUsage?.execution
          : undefined;
    } catch {
      return undefined;
    }
  }
  /** Each monitor (including its in-flight probes) belongs to one immutable launch generation. */
  private get upstream(): UpstreamHealthMonitor | undefined {
    if (this.options.upstreamMonitor) return this.options.upstreamMonitor;
    const config = this.options.upstream;
    if (!this.closing && this.generation !== config) {
      if (this.monitor) {
        const retiring = this.monitor
          .close()
          .finally(() => this.retiring.delete(retiring));
        this.retiring.add(retiring);
      }
      this.generation = config;
      this.monitor = config
        ? new UpstreamHealthMonitor(
            config,
            this.options.runtime,
            this.clock,
            undefined,
            this.options.store,
            () =>
              this.options.onError?.(
                new Error("upstream probe publication failed"),
              ),
            (line) => this.options.onError?.(new Error(line)),
          )
        : undefined;
    }
    return this.monitor;
  }
  readonly tools: NonNullable<HostOpsToolOptions["hostOps"]> = {
    inspectWorker: (context, request) =>
      this.workerInspection(context, request),
    read: (context, project) => this.read(context, project),
    execute: (context, tool, params) => this.execute(context, tool, params),
  };
  /** Private host projection for the authenticated human Workbench. */
  async executionDiagnostics(project: ProjectId) {
    const activity = await this.observeUpstream(project);
    return this.options.store.uow.read((tx) => {
      const state = loadCommandState(tx, project);
      return {
        available: this.upstream !== undefined,
        configuration: this.options.upstream
          ? launchWarnings(this.options.upstream)
          : [],
        expires_at: new Date(
          Math.min(
            Date.parse(this.clock.now()) +
              (this.options.upstream?.interaction_stale_after_ms ?? 30_000),
            ...Object.values(activity).flatMap((sample) =>
              typeof sample === "object" && "interaction" in sample
                ? [Date.parse(sample.observed_at) + sample.stale_after_ms]
                : [],
            ),
          ),
        ).toISOString(),
        sessions: (
          this.upstream?.diagnostics(state, activity).sessions ?? []
        ).map((s) => ({
          assignment_id: s.assignment_id,
          cause: s.cause,
          action: s.action,
          evidence: s.evidence,
        })),
      };
    });
  }
  private async workerInspection(
    context: ToolContext,
    request: WorkerInspectionRequest,
  ) {
    context.revalidateToken?.();
    const actor = context.identity.actor,
      project = actor.project_id;
    const { store, workerExecution } = this.options;
    const { status, assignment, run, current, platform, harness } =
      store.uow.run((tx) => {
        const effect = unwrap(
          admitWorkerInspection(
            loadCommandState(tx, project),
            actor,
            request,
            {
              clock: this.clock,
              ids: tx.ids,
            },
            this.options.workerInspectionIntervalMs,
          ),
        );
        persistEffect(tx, project, effect);
        return effect.data;
      });
    if (status === "rate_limited")
      throw new ToolError(
        "illegal_transition",
        "Worker inspection rate limited; retry later",
      );
    if (status !== "admitted" || !assignment || !platform)
      throw new ToolError(
        "not_found",
        "Worker inspection target does not match",
      );
    const resolve = () => {
      try {
        if (workerExecution)
          return workerExecution(project, request.machine_id);
      } catch {
        /* Never expose config or SSH diagnostics. */
      }
      throw new ToolError(
        "illegal_transition",
        "Worker inspection unavailable: worker_binding_unconfigured",
        { reason: "worker_binding_unconfigured" },
      );
    };
    const execution = resolve();
    // C-806: a Run that never started also gets its launch evidence.
    const since =
      run && !run.started_at
        ? store.uow.read((tx) =>
            dispatchedAt(loadCommandState(tx, project), run),
          )
        : undefined;
    const result = await inspectWorker(
      execution,
      project,
      assignment,
      run,
      current,
      platform,
      harness,
      this.options.runtime,
      since ? { since } : undefined,
    );
    context.revalidateToken?.();
    const fresh = store.uow.read((tx) => {
      const state = loadCommandState(tx, project);
      unwrap(checkHostOpsAccess(state, actor, "host_ops_inspect_worker"));
      return workerInspectionTarget(state, request);
    });
    if (
      fresh.assignment?.machine_id !== assignment.machine_id ||
      fresh.assignment.external ||
      fresh.platform !== platform ||
      fresh.harness !== harness ||
      fresh.current !== current ||
      fresh.run?.id !== run?.id ||
      fresh.run?.status !== run?.status ||
      JSON.stringify(fresh.run?.launch_publication) !==
        JSON.stringify(run?.launch_publication) ||
      JSON.stringify(fresh.assignment.runtime_ref) !==
        JSON.stringify(assignment.runtime_ref) ||
      resolve().target?.fingerprint !== execution.target?.fingerprint
    )
      throw new ToolError(
        "stale_target",
        "Worker binding changed during inspection",
      );
    return {
      machine_id: assignment.machine_id,
      assignment_id: assignment.id,
      run_id: run?.id ?? null,
      ...result,
    };
  }
  private async read(context: ToolContext, project?: string) {
    context.revalidateToken?.();
    const actor = context.identity.actor;
    if (project !== undefined && project !== actor.project_id)
      throw new ToolError(
        "unauthorized",
        "Diagnostics are limited to the authenticated project",
      );
    this.options.store.uow.read((tx) =>
      unwrap(
        checkHostOpsAccess(
          loadCommandState(tx, actor.project_id),
          actor,
          "host_ops_read_diagnostics",
        ),
      ),
    );
    const observationStarted = performance.now();
    const [sessions, deployment, stalls] = await Promise.all([
      this.sessions(actor.project_id),
      readDeploymentDiagnostics(this.options.store, actor.project_id),
      this.stallPatrol.diagnostics(actor.project_id),
    ]);
    const activity = await this.observeUpstream(
      actor.project_id,
      undefined,
      sessions,
    );
    context.recordTiming?.(
      "diagnostics_observe",
      performance.now() - observationStarted,
    );
    // Incident publication belongs to the background poll, never a diagnostic read.
    context.revalidateToken?.();
    const aggregateStarted = performance.now();
    const result = this.options.store.uow.read((tx) => {
      const state = loadCommandState(tx, actor.project_id);
      const view = unwrap(hostOpsReadDiagnostics(state, actor)).data;
      const attention = readAttention(
        this.options.store,
        actor.project_id,
        this.clock.now(),
        tx,
      );
      const summary = (a: Assignment) => ({
        id: a.id,
        role_id: a.role_id,
        status: a.status,
        runtime_state: a.runtime_state,
      });
      const runs = view.runs.map((r) => ({
        id: r.id,
        assignment_id: r.assignment_id,
        status: r.status,
        recovery_owner:
          r.dispatch_stop ||
          r.inactivity_stop ||
          (!r.started_at &&
            (dispatchRecoveryQueuedAt(state, r) ||
              eventsOfType(state.events, "bell_delivery_attempt_failed").some(
                (e) => (e.payload as { run_id?: string }).run_id === r.id,
              )))
            ? "automatic"
            : "host_ops",
      }));
      return {
        ...attention,
        dispatch_stalls: stalls,
        // C-759: idle sessions holding a scarce resource (emulator etc.).
        idle_scarce_sessions: idleScarceSessions(
          tx,
          state,
          this.options.scarceResources ?? DEFAULT_SCARCE_RESOURCES,
          this.clock.now(),
        ),
        ...(this.options.upstream
          ? { launch_warnings: launchWarnings(this.options.upstream) }
          : {}),
        ...(this.options.runtime.diagnostics
          ? { runtime_calls: this.options.runtime.diagnostics() }
          : {}),
        ...(deployment ? { deployment } : {}),
        ...(this.upstream
          ? { upstream_health: this.upstream.diagnostics(state, activity) }
          : {}),
        lost: attention.lost.map(summary),
        paused: attention.paused.map(summary),
        findings: attention.findings.map((f) => ({
          kind: f.kind,
          first_seen_at: f.first_seen_at,
          last_seen_at: f.last_seen_at,
        })),
        actions: view.actions,
        ...(view.worker_maintenance
          ? { worker_maintenance: view.worker_maintenance }
          : {}),
        // C-666: each remote worker's latest usage report for this project.
        worker_usage: listWorkerUsage(this.options.store, actor.project_id),
        // Full read-only state stays visible; C-56 failures are excluded from patrol work.
        runs,
        patrol_runs: runs.filter(
          (r) =>
            r.recovery_owner === "host_ops" &&
            ["dispatched", "acked", "unknown"].includes(r.status),
        ),
        context_thresholds: contextThresholdView(state),
        sessions: sessions.map(
          ({
            observation: _observation,
            activity: _activity,
            startupFailure: _startupFailure,
            ...view
          }) => view,
        ),
      };
    });
    context.recordTiming?.(
      "diagnostics_aggregate",
      performance.now() - aggregateStarted,
    );
    return result;
  }
  private async execute(
    context: ToolContext,
    tool: HostOpsToolName,
    p: {
      target_id: string;
      attempt_id?: string;
      action?: "reinspect" | "abandon";
      reason?: string;
      idempotency_key: string;
      context_session_id?: string;
      dispatch_stall_id?: string;
    },
  ) {
    const { store } = this.options,
      actor = context.identity.actor,
      project = actor.project_id;
    context.revalidateToken?.();
    store.uow.read((tx) =>
      unwrap(checkHostOpsAccess(loadCommandState(tx, project), actor, tool)),
    );
    const invocation = {
      project_id: project,
      assignment_id: actor.assignment_id,
      key: p.idempotency_key,
      request: { tool, params: p },
    };
    const miss = Symbol("prepare");
    try {
      return unwrap(
        store.runIdempotent(invocation, () => {
          throw miss;
        }),
      ).value;
    } catch (error) {
      if (error !== miss) throw error;
    }
    if (tool === "host_ops_recheck_merge")
      return unwrap(
        store.runIdempotent(invocation, (tx) => {
          context.revalidateToken?.();
          const effect = unwrap(
            recheckMerge(
              loadCommandState(tx, project, this.options.settings?.(project)),
              actor,
              { card_id: p.target_id as CardId },
              { clock: this.clock, ids: tx.ids },
            ),
          );
          persistEffect(tx, project, effect);
          return effect.data;
        }),
      ).value;
    // C-773: only records the request; the author precheck scheduler
    // settles it (reinspect through the bound run, or a verified abandon).
    if (tool === "host_ops_recheck_precheck")
      return unwrap(
        store.runIdempotent(invocation, (tx) => {
          context.revalidateToken?.();
          const effect = unwrap(
            hostOpsRecheckPrecheck(
              loadCommandState(tx, project, this.options.settings?.(project)),
              actor,
              {
                card_id: p.target_id as CardId,
                attempt_id: p.attempt_id ?? "",
                action: p.action as "reinspect" | "abandon",
                reason: p.reason ?? "",
              },
              { clock: this.clock, ids: tx.ids },
            ),
          );
          persistEffect(tx, project, effect);
          return effect.data;
        }),
      ).value;
    if (tool === "host_ops_stop_assignment") {
      const stopped = await this.stopIdle(context, project, p);
      return unwrap(store.runIdempotent(invocation, () => stopped)).value;
    }
    // C-759: a queued Run that never started holds no terminal. Cancel it
    // directly, even while a previous turn's session is still live; the
    // terminal and that session are not touched.
    if (tool === "host_ops_cancel_run") {
      const direct = await this.cancelQueued(context, project, p, invocation);
      if (direct) return direct;
    }
    // C-672: a worker terminal still live after its Agent CLI exited has
    // nothing left to stop. Close it and settle the session through the same
    // guarded path as maintenance (both host-ops locks, kernel exit proof, no
    // human stop, host operation, upgrade or started Run); dispatch then
    // starts the new session through the managed launch.
    if (
      tool === "host_ops_restart_assignment" &&
      p.context_session_id === undefined
    ) {
      const settled = await this.settleExitedAgent(
        project,
        p.target_id as AssignmentId,
      );
      if (settled)
        return unwrap(store.runIdempotent(invocation, () => settled)).value;
    }
    // C-730: a remote managed Assignment whose Agent the worker does not see
    // alive is released like a managed `assignment stop` (terminal closed,
    // exit proven, session settled); dispatch then starts a new session.
    const remote = await this.releaseRemoteSession(project, tool, p, actor);
    if (remote && "result" in remote)
      return unwrap(store.runIdempotent(invocation, () => remote.result)).value;
    const contextUsage =
      p.context_session_id === undefined
        ? undefined
        : (await this.sessions(project)).find(
            (v) =>
              v.assignment_id === p.target_id &&
              v.session_id === p.context_session_id &&
              !v.stale,
          )?.observation;
    if (
      p.context_session_id !== undefined &&
      (!contextUsage || tool === "host_ops_cancel_run")
    )
      throw new ToolError(
        "stale_target",
        "精确上下文数据缺失、过期或会话已更换，请重新读取诊断",
      );
    const paramsFor = (state: CommandState) => {
      const stall =
        p.dispatch_stall_id &&
        this.stallPatrol.current(
          state,
          p.target_id as AssignmentId,
          p.dispatch_stall_id,
        );
      if (p.dispatch_stall_id && !stall)
        throw new ToolError(
          "stale_target",
          "该指派已没有可以按此原因恢复的积压",
          { reason: "stall_not_current" },
        );
      return {
        ...(stall && stall.review_trigger_id
          ? { review_trigger_id: stall.review_trigger_id }
          : {}),
        ...(p.dispatch_stall_id
          ? { dispatch_stall_id: p.dispatch_stall_id }
          : {}),
        ...(contextUsage
          ? {
              context_usage: contextUsage,
              context_stale_after_ms:
                this.options.contextUsage?.staleAfterMs ??
                DEFAULT_CONTEXT_STALE_AFTER_MS,
            }
          : {}),
        tool,
        target_id: p.target_id as AssignmentId | RunId,
        reason: p.reason ?? "",
      };
    };
    const activity =
      tool === "host_ops_cancel_run"
        ? undefined
        : await this.observeUpstream(project, p.target_id as AssignmentId);
    const preflight = (() => {
      try {
        return store.uow.read((tx) => {
          const state = loadCommandState(tx, project);
          if (tool !== "host_ops_cancel_run")
            this.checkUpstream(
              state,
              p.target_id as AssignmentId,
              Boolean(contextUsage),
              undefined,
              activity,
            );
          return unwrap(prepareHostOpsAction(state, actor, paramsFor(state)))
            .data;
        });
      } catch (error) {
        // C-730: say why the remote release did not apply instead.
        if (
          remote &&
          (error as { message?: unknown } | null)?.message ===
            "Target must be a local managed Assignment"
        )
          throw new ToolError(
            "illegal_transition",
            `远程会话未释放：${remoteRefusalText(remote.refusal)}`,
            { reason: remote.refusal },
          );
        throw error;
      }
    })();
    if (p.dispatch_stall_id) {
      const state = store.uow.read((tx) => loadCommandState(tx, project));
      const stall = this.stallPatrol.current(
        state,
        preflight.assignment.id,
        p.dispatch_stall_id,
      );
      if (!stall)
        throw new ToolError(
          "stale_target",
          "该指派已没有可以按此原因恢复的积压",
          { reason: "stall_not_current" },
        );
      const evidence = await this.stallPatrol.evidence(
        state,
        preflight.assignment,
        stall,
      );
      if (!evidence.can_restart) {
        const unsafeWorkspace =
          !writableInPlace(evidence.workspace) &&
          evidence.workspace !== "no_worktree";
        throw new ToolError(
          "stale_target",
          unsafeWorkspace
            ? "工作区有改动或不能确认干净"
            : "不能确认原终端轮次已结束",
          {
            reason: unsafeWorkspace
              ? "workspace_unconfirmed"
              : "turn_end_unconfirmed",
            workspace: evidence.workspace,
            process_state: evidence.process_state,
            terminal_state: evidence.terminal_state,
            terminal_owner: evidence.terminal_owner,
          },
        );
      }
    }
    const snapshot =
      tool === "host_ops_cancel_run"
        ? undefined
        : await this.options
            .snapshot(preflight.assignment, project)
            .catch(() => {
              throw new ToolError(
                "validation_failed",
                "Target launch configuration could not be prepared",
              );
            });
    const freshActivity =
      tool === "host_ops_cancel_run"
        ? undefined
        : await this.observeUpstream(project, preflight.assignment.id);
    return unwrap(
      store.runIdempotent(invocation, (tx) => {
        context.revalidateToken?.();
        const state = loadCommandState(tx, project);
        const params = paramsFor(state);
        const fresh = unwrap(prepareHostOpsAction(state, actor, params)).data;
        const diagnosis =
          tool === "host_ops_cancel_run"
            ? undefined
            : this.checkUpstream(
                state,
                preflight.assignment.id,
                Boolean(contextUsage),
                undefined,
                freshActivity,
              );
        if (
          JSON.stringify(fresh.assignment) !==
            JSON.stringify(preflight.assignment) ||
          fresh.run?.id !== preflight.run?.id ||
          fresh.run?.status !== preflight.run?.status
        )
          throw new ToolError(
            "stale_target",
            "Target changed during preflight; read diagnostics again",
            { reason: "preflight_target_changed" },
          );
        if (
          unfinishedBellAttempts(store.database, project).some(
            (b) => b.assignment_id === fresh.assignment.id,
          )
        )
          throw new ToolError(
            "illegal_transition",
            "A delivery is in progress",
          );
        const effect = unwrap(
          beginHostOpsAction(
            state,
            actor,
            {
              ...params,
              ...(snapshot ? { snapshot } : {}),
              ...(diagnosis?.incident_id
                ? { upstream_incident_id: diagnosis.incident_id }
                : {}),
            },
            { clock: this.clock, ids: tx.ids },
          ),
        );
        persistEffect(tx, project, effect);
        return effect.data;
      }),
    ).value;
  }
  /**
   * C-759: cancel an untouched queued Run without stopping any terminal. The
   * launch lock keeps a launch from starting it meanwhile; a Run that was
   * dispatched in between takes the ordinary path. Undefined: not applicable.
   */
  private async cancelQueued(
    context: ToolContext,
    project: ProjectId,
    p: { target_id: string; reason?: string },
    invocation: Parameters<Store["runIdempotent"]>[0],
  ) {
    const { store } = this.options;
    const target = () =>
      store.uow.read((tx) => {
        const state = loadCommandState(tx, project);
        const run = state.runs.find((r) => r.id === p.target_id);
        return run && directlyCancellableRun(state, run) ? run : undefined;
      });
    const run = target();
    if (!run || !p.reason?.trim()) return;
    const unlock = await tryHostOpsLock(
      store,
      project,
      run.assignment_id,
      "launch",
    );
    if (!unlock)
      throw new ToolError("stale_target", "该 Run 正在派发，请重新读取诊断", {
        reason: "launch_in_progress",
      });
    try {
      if (!target()) return;
      return unwrap(
        store.runIdempotent(invocation, (tx) => {
          context.revalidateToken?.();
          // A bell being written to the session may start this Run.
          if (
            unfinishedBellAttempts(store.database, project, run.assignment_id)
              .length
          )
            throw new ToolError(
              "stale_target",
              "正在向该会话投递通知，请重新读取诊断",
              { reason: "delivery_in_progress" },
            );
          const effect = unwrap(
            cancelQueuedHostOpsRun(
              loadCommandState(tx, project),
              context.identity.actor,
              { run_id: run.id, reason: p.reason ?? "" },
              { clock: this.clock, ids: tx.ids },
            ),
          );
          persistEffect(tx, project, effect);
          return effect.data;
        }),
      ).value;
    } finally {
      await unlock();
    }
  }
  /**
   * C-759: managed stop of a work-item session whose previous turn ended and
   * that is idle (`stopIdleSession`). Never queues a Run; refusals say why.
   */
  private async stopIdle(
    context: ToolContext,
    project: ProjectId,
    p: { target_id: string; reason?: string },
  ) {
    const { store } = this.options;
    const actor = context.identity.actor;
    const reason = p.reason?.trim();
    if (!reason) throw new ToolError("validation_failed", "reason is required");
    const a = store.uow.read((tx) => {
      const state = loadCommandState(tx, project);
      unwrap(checkHostOpsAccess(state, actor, "host_ops_stop_assignment"));
      if (
        actor.kind === "assignment" &&
        hostOpsPending(state.events, actor.assignment_id)
      )
        throw new ToolError(
          "illegal_transition",
          "The operator has a pending session operation",
        );
      return state.assignments.find((v) => v.id === p.target_id);
    });
    if (!a || actor.kind !== "assignment")
      throw new ToolError("not_found", "Assignment not found");
    if (a.scope !== "work_item" || a.external)
      throw new ToolError(
        "illegal_transition",
        "只能停止受管工作项指派的会话",
        { reason: "not_managed" },
      );
    const ref = a.runtime_ref;
    const outcome = await stopIdleSession(
      store,
      project,
      a,
      this.options.runtime,
      this.clock,
      {
        trigger: "host_ops",
        requested_by: actor.assignment_id,
        tool: "host_ops_stop_assignment",
        reason,
      },
      {
        execution: this.stallExecution(project, a.machine_id),
        proof: this.options.unresponsiveProof,
      },
    );
    if (outcome.outcome === "refused")
      throw new ToolError(
        "illegal_transition",
        `会话未停止：${idleStopRefusalText(outcome.reason)}`,
        { reason: outcome.reason },
      );
    context.revalidateToken?.();
    if (ref)
      await this.options
        .scrubCredentials?.(project, a.id, ref)
        .catch(() => undefined);
    return {
      assignment_id: a.id,
      result: "session_stopped" as const,
      basis: outcome.basis,
      message:
        "已停止上一轮已结束的空闲会话：关闭终端、确认退出并结算；工作区、分支和排队的工作保留，系统按受管入口新起会话。",
    };
  }
  /**
   * C-730: restart or cancel on a remote managed Assignment. Only a session
   * whose terminal is live while the worker does not see its Agent CLI alive
   * is released; anything else returns the refusal and the ordinary path
   * (which handles remote exit-only recoveries) decides.
   */
  private async releaseRemoteSession(
    project: ProjectId,
    tool: HostOpsExecutionTool | "host_ops_recheck_merge",
    p: { target_id: string; reason?: string; context_session_id?: string },
    actor: ToolContext["identity"]["actor"],
  ) {
    const reason = p.reason?.trim();
    if (
      (tool !== "host_ops_restart_assignment" &&
        tool !== "host_ops_cancel_run") ||
      p.context_session_id !== undefined ||
      actor.kind !== "assignment" ||
      // The ordinary path reports a missing reason or the operator's own
      // pending operation, exactly as before.
      !reason
    )
      return;
    const { store } = this.options;
    if (
      store.uow.read((tx) =>
        hostOpsPending(
          loadCommandState(tx, project).events,
          actor.assignment_id,
        ),
      )
    )
      return;
    const found = store.uow.read((tx) => {
      const run =
        tool === "host_ops_cancel_run"
          ? tx.runs.get(project, p.target_id as RunId)
          : undefined;
      const a = tx.assignments.get(
        project,
        (run?.assignment_id ?? p.target_id) as AssignmentId,
      );
      return a ? { a, run } : undefined;
    });
    const a = found?.a;
    if (
      !a?.runtime_ref ||
      a.scope !== "work_item" ||
      a.external ||
      a.machine_id === "local" ||
      (tool === "host_ops_cancel_run" && !found?.run)
    )
      return;
    const ref = a.runtime_ref;
    const outcome = await releaseUnresponsiveAgent(
      store,
      project,
      a,
      this.options.runtime,
      this.clock,
      {
        trigger: "host_ops",
        requested_by: actor.assignment_id,
        tool,
        reason,
        ...(found?.run ? { run_id: found.run.id } : {}),
      },
      this.options.unresponsiveProof,
    );
    if (outcome.outcome === "refused") return { refusal: outcome.reason };
    await this.options
      .scrubCredentials?.(project, a.id, ref)
      .catch(() => undefined);
    return {
      result: {
        assignment_id: a.id,
        ...(found?.run ? { run_id: found.run.id } : {}),
        result: "session_released" as const,
        message:
          "远程会话的 Agent 进程未见存活：已关闭残留终端、确认会话退出并结算；有待办时系统按受管入口新起会话。",
      },
    };
  }
  private async settleExitedAgent(project: ProjectId, id: AssignmentId) {
    const { store } = this.options;
    const a = store.uow.read((tx) => tx.assignments.get(project, id));
    if (!a || a.scope !== "work_item" || !a.runtime_ref) return;
    const outcome = await releaseExitedAgent(
      store,
      project,
      a,
      this.options.runtime,
      this.clock,
    );
    if (outcome !== "settled") return;
    return {
      assignment_id: a.id,
      result: "agent_exited" as const,
      message:
        "Agent 已退出：已关闭仍在的终端并结算会话，系统按受管入口新起会话续办。",
    };
  }
  private async observeUpstream(
    project: ProjectId,
    only?: AssignmentId,
    samples?: SessionContextDiagnostic[] | Promise<SessionContextDiagnostic[]>,
  ) {
    const upstream = this.upstream;
    if (!upstream) return {};
    const state = this.options.store.uow.read((tx) =>
      loadCommandState(tx, project),
    );
    const [activity, sessions] = await Promise.all([
      upstream.observe(state, only),
      samples ?? this.sessions(project),
    ]);
    if (this.closing || this.upstream !== upstream)
      throw new ToolError(
        "stale_target",
        "线路采样期间配置已更换，请重新读取诊断",
      );
    const current = this.options.store.uow.read((tx) =>
      loadCommandState(tx, project),
    );
    for (const id of Object.keys(activity)) {
      const before = state.assignments.find((a) => a.id === id);
      const after = current.assignments.find((a) => a.id === id);
      if (
        !after ||
        JSON.stringify(before?.runtime_ref) !==
          JSON.stringify(after.runtime_ref) ||
        before?.session_ref !== after?.session_ref ||
        state.runs.findLast((r) => r.assignment_id === id)?.id !==
          current.runs.findLast((r) => r.assignment_id === id)?.id
      )
        throw new ToolError(
          "stale_target",
          "活动采样期间会话已更换，请重新读取诊断",
        );
    }
    const scope = assignmentActivityScope(current);
    for (const session of sessions) {
      if (!session.assignment_id) continue;
      const assignment = current.assignments.find(
        (a) => a.id === session.assignment_id,
      );
      const sample =
        assignment &&
        currentHarnessActivity(
          scope(assignment),
          assignment,
          this.clock.now(),
          session.activity,
        );
      const run = current.runs.findLast((r) => r.id === sample?.run_id);
      // `only` limits runtime IO, not recovery witnesses. Diagnostics and both
      // restart preflights need the same current harness evidence from peers;
      // the upstream policy selects the target's line when using that evidence.
      const runtimeSample = activity[session.assignment_id];
      const interaction =
        typeof runtimeSample === "object" && "interaction" in runtimeSample
          ? runtimeSample
          : undefined;
      if (
        sample &&
        assignment &&
        run &&
        (!interaction ||
          interaction.interaction === "unknown" ||
          Date.parse(sample.updated_at) > Date.parse(interaction.observed_at))
      ) {
        if (!sample.error)
          activity[session.assignment_id] = { working_at: sample.updated_at };
        else if (
          sample.error !== "unclassified" &&
          Date.parse(sample.updated_at) >= lastRunActivity(run, assignment)
        )
          activity[session.assignment_id] = {
            error: sample.error,
            at: sample.updated_at,
          };
      }
    }
    return activity;
  }
  /**
   * C-745: the upstream diagnosis is available for this session and the
   * stop gate would pass; a line fault or a failed classification keeps
   * the closed session closed.
   */
  private diagnosisRecovered(state: CommandState, id: AssignmentId) {
    if (!this.upstream) return false;
    try {
      const diagnosis = this.checkUpstream(state, id, true);
      return (
        !!diagnosis &&
        ![
          "upstream_diagnosis_unavailable",
          "upstream_recovery_not_ready",
        ].includes(upstreamHoldReason(diagnosis))
      );
    } catch {
      return false;
    }
  }
  private checkUpstream(
    state: CommandState,
    id: AssignmentId,
    contextRestart: boolean,
    ignoreAction?: HostOpsExecution["action_id"],
    activity?: SessionActivity,
  ) {
    const diagnosis = this.upstream?.diagnosis(
      state,
      id,
      ignoreAction,
      activity,
    );
    if (
      diagnosis &&
      (diagnosis.action === "wait" ||
        diagnosis.action === "human" ||
        (diagnosis.cause === "agent_busy" && !contextRestart))
    )
      throw new ToolError(
        "illegal_transition",
        `当前不能重启 ${id}：${diagnosis.cause}（${diagnosis.evidence.join(", ")}）；${diagnosis.action === "human" ? "复发须交人" : "请等待并核实诊断"}`,
      );
    return diagnosis;
  }
  async close() {
    this.closing = true;
    this.contextAbort.abort();
    await this.upstream?.close();
    await Promise.allSettled([
      ...this.retiring,
      ...this.upstreamPolls.values(),
      ...this.sessionPolls.values(),
      ...this.actionWorkers.values(),
      this.contextPoll,
      this.stallPoll,
    ]);
  }
  /** Runtime/context observations must precede clustering, without holding the dispatcher. */
  private pollUpstream(project: ProjectId) {
    const upstream = this.upstream;
    if (!upstream || this.closing || this.upstreamPolls.has(project)) return;
    const poll = this.observeUpstream(
      project,
      undefined,
      this.sessions(project, true),
    )
      .then((activity) => {
        if (!this.closing && this.upstream === upstream)
          upstream.reconcile(this.options.store, project, activity);
      })
      .catch((error) => {
        // C-745: a session that changed while sampled is a race; the next
        // poll samples again. Marking the whole project failed here held
        // every recovery and context restart until that poll.
        if (
          !this.closing &&
          this.upstream === upstream &&
          !staleObservation(error)
        )
          upstream.observationFailed(project, error);
      })
      .finally(() => this.upstreamPolls.delete(project));
    this.upstreamPolls.set(project, poll);
  }
  private async sessions(project: ProjectId, reuse = false) {
    if (this.closing) return Promise.resolve([]);
    const pending = this.sessionPolls.get(project);
    if (pending) return pending;
    const cached = this.sessionSamples.get(project);
    // Background upstream ticks must not bypass the context polling cadence.
    // Explicit diagnostics and restart checks still request a fresh sample.
    if (
      reuse &&
      cached &&
      Date.parse(this.clock.now()) >= cached.completedAt &&
      Date.parse(this.clock.now()) - cached.completedAt < 30_000
    )
      return Promise.resolve(cached.samples);
    const state = this.options.store.uow.read((tx) =>
      loadCommandState(tx, project),
    );
    const usage = this.options.contextUsage;
    const poll = readSessionContexts(
      state,
      usage
        ? {
            ...usage,
            ...(this.options.upstream ? { launch: this.options.upstream } : {}),
            signal: this.contextAbort.signal,
          }
        : usage,
      this.clock.now(),
      this.options.store.getProject(project)?.repo_path,
      (ref, p) => this.options.runtime.executionForRef?.(ref, p),
    )
      .then((samples) => {
        if (!this.closing)
          this.sessionSamples.set(project, {
            completedAt: Date.parse(this.clock.now()),
            samples,
          });
        return samples;
      })
      .finally(() => this.sessionPolls.delete(project));
    this.sessionPolls.set(project, poll);
    return poll;
  }
  /** One background round; ticks consume completed samples and never await IO. */
  private scheduleContexts() {
    if (
      this.closing ||
      this.contextPoll ||
      !this.options.contextUsage ||
      Date.parse(this.clock.now()) - this.lastContextPoll < 30_000
    )
      return;
    this.contextPoll = this.pollContexts()
      .catch((error) => {
        this.options.onError?.(error);
      })
      .finally(() => {
        this.lastContextPoll = Date.parse(this.clock.now());
        this.contextPoll = undefined;
      });
  }
  private async pollContexts() {
    for (const project of this.options.store.listProjects()) {
      if (this.closing) return;
      const sessions = await this.sessions(project.id, true);
      if (this.closing) return;
      writeContextSamples(
        this.options.store,
        project.id,
        sessions.flatMap((session) =>
          session.observation && !session.stale ? [session.observation] : [],
        ),
      );
      for (const session of sessions) {
        const usage = session.observation;
        if (!usage || session.stale) continue;
        this.options.store.uow.run((tx) => {
          const state = loadCommandState(tx, project.id);
          const effect = unwrap(
            recordContextUsageNotices(
              state,
              { kind: "system", project_id: project.id },
              usage,
              this.options.contextUsage?.staleAfterMs ??
                DEFAULT_CONTEXT_STALE_AFTER_MS,
              { clock: this.clock, ids: tx.ids },
            ),
          );
          persistEffect(tx, project.id, effect);
          for (const { event, recipient, notify_pm_ops } of effect.data) {
            if (notify_pm_ops)
              recordNotification(this.options.store.database, {
                project_id: project.id,
                event_id: event.id,
                seq: event.seq,
                kind: "context_usage",
                at: event.created_at,
                recipient: { kind: "pm_ops" },
              });
            recordNotification(this.options.store.database, {
              project_id: project.id,
              event_id: event.id,
              seq: event.seq,
              kind: "context_usage",
              at: event.created_at,
              recipient: { kind: "assignment", assignment_id: recipient },
              ...(event.card_id ? { card_id: event.card_id } : {}),
            });
          }
        });
        await this.scheduleAutomaticRestart(project.id, usage);
      }
    }
  }
  /** Dispatcher consumes only completed background samples; domain rechecks their generation/age. */
  harnessActivity(
    project: ProjectId,
    assignment: AssignmentId,
  ): HarnessActivity | undefined {
    const cached = this.sessionSamples.get(project);
    const row = cached?.samples.find((s) => s.assignment_id === assignment);
    if (cached && row?.activity?.source === "claude-code:session_metadata") {
      // Old progress in a recent inspection is useful; an old inspection is
      // not evidence that the same file is still present and silent.
      const age = Date.parse(this.clock.now()) - cached.completedAt;
      if (
        (row.activity_status !== "fresh" && row.activity_status !== "stale") ||
        age < 0 ||
        age > row.activity.stale_after_ms ||
        this.sessionPolls.has(project)
      )
        return;
    }
    return row?.activity;
  }
  /**
   * C-752: the completed background sample's Claude transcript write evidence,
   * under the same freshness rule as session metadata. It only lets the
   * dispatcher decide to start a stop-time read; the stop rereads it.
   */
  harnessFileActivity(
    project: ProjectId,
    assignment: AssignmentId,
  ): HarnessActivity | undefined {
    const cached = this.sessionSamples.get(project);
    const row = cached?.samples.find((s) => s.assignment_id === assignment);
    const file = row?.fileActivity;
    if (
      !cached ||
      !file ||
      row.activity_status === "read_failed" ||
      this.sessionPolls.has(project)
    )
      return;
    const age = Date.parse(this.clock.now()) - cached.completedAt;
    return age < 0 || age > file.stale_after_ms ? undefined : file;
  }

  /** C-806: see recordRunLaunchEvidence; never throws or blocks a stop. */
  recordLaunchEvidence(
    project: ProjectId,
    run: RunId,
    reason: NonNullable<Run["dispatch_stop"]>["reason"],
  ): Promise<void> {
    return recordRunLaunchEvidence(
      {
        store: this.options.store,
        workerExecution: this.options.workerExecution,
        runtime: this.options.runtime,
        now: () => this.clock.now(),
        ...(this.options.onError ? { onError: this.options.onError } : {}),
      },
      project,
      run,
      reason,
    );
  }
  /** Alerts can join an active poll. Destructive checks must start a new, target-only read. */
  async inspectHarnessActivity(
    project: ProjectId,
    stopTarget?: AssignmentId,
    localOnly = false,
  ): Promise<ReadonlyMap<AssignmentId, HarnessActivityInspection>> {
    let samples: SessionContextDiagnostic[];
    if (stopTarget || localOnly) {
      const usage = this.options.contextUsage;
      if (this.closing || !usage) return new Map();
      const state = this.options.store.uow.read((tx) =>
        loadCommandState(tx, project),
      );
      samples = await readSessionContexts(
        {
          ...state,
          assignments: state.assignments.filter(
            (a) =>
              (stopTarget ? a.id === stopTarget : a.machine_id === "local") &&
              !a.external,
          ),
        },
        {
          execution: usage.execution,
          ...(usage.staleAfterMs !== undefined
            ? { staleAfterMs: usage.staleAfterMs }
            : {}),
          signal: this.contextAbort.signal,
        },
        this.clock.now(),
        undefined,
        (ref, p) => this.options.runtime.executionForRef?.(ref, p),
      );
      if (this.closing) return new Map();
    } else samples = await this.sessions(project);
    return new Map(
      samples.flatMap((s) =>
        s.assignment_id
          ? [
              [
                s.assignment_id,
                {
                  ...(s.fileActivity ? { fileActivity: s.fileActivity } : {}),
                  ...(s.foreground ? { foreground: s.foreground } : {}),
                  status: s.activity_status ?? "missing",
                  ...(s.activity ? { activity: s.activity } : {}),
                  ...(s.startupFailure
                    ? { startupFailure: s.startupFailure }
                    : {}),
                },
              ] as const,
            ]
          : [],
      ),
    );
  }

  private async scheduleAutomaticRestart(
    project: ProjectId,
    usage: ContextObservation,
  ) {
    const { store } = this.options;
    const stale =
      this.options.contextUsage?.staleAfterMs ?? DEFAULT_CONTEXT_STALE_AFTER_MS;
    const state = store.uow.read((tx) => loadCommandState(tx, project));
    // C-745: a session closed only by an unavailable diagnosis gets one more
    // attempt, and only while the upstream gate would let it stop now.
    const recovered =
      contextRestartRetryState(
        state.events,
        usage.assignment_id,
        usage.session_id,
        this.clock.now(),
      ) === "recoverable" &&
      this.diagnosisRecovered(state, usage.assignment_id);
    if (
      !automaticContextRestartReady(
        state,
        usage,
        this.clock.now(),
        stale,
        undefined,
        recovered,
      )
    )
      return;
    const assignment = state.assignments.find(
      (a) => a.id === usage.assignment_id,
    );
    if (!assignment) return;
    let snapshot: HostOpsExecution["snapshot"];
    try {
      snapshot = await this.options.snapshot(assignment, project);
    } catch {
      /* Persist a single failed attempt below. */
    }
    if (this.closing) return;
    store.uow.run((tx) => {
      const effect = unwrap(
        beginAutomaticContextRestart(
          loadCommandState(tx, project),
          { kind: "system", project_id: project },
          {
            usage,
            stale_after_ms: stale,
            ...(snapshot ? { snapshot } : { preparation_failed: true }),
            ...(recovered ? { diagnosis_recovered: true } : {}),
          },
          { clock: this.clock, ids: tx.ids },
        ),
      );
      persistEffect(tx, project, effect);
      notifyAutomaticContextResult(store, project, effect, tx);
    });
  }

  private contextResult(
    project: ProjectId,
    action: HostOpsExecution,
    result: "succeeded" | "failed",
    reason: string,
    upstreamDetail?: UpstreamHoldDetail,
  ) {
    this.options.store.uow.run((tx) => {
      const effect = unwrap(
        recordAutomaticContextRestartResult(
          loadCommandState(tx, project),
          { kind: "system", project_id: project },
          {
            action_id: action.action_id,
            result,
            reason,
            ...(upstreamDetail ? { upstream_detail: upstreamDetail } : {}),
            ...(this.options.contextUsage?.restartRetryDelaysMs
              ? {
                  retry_delays_ms:
                    this.options.contextUsage.restartRetryDelaysMs,
                }
              : {}),
          },
          { clock: this.clock, ids: tx.ids },
        ),
      );
      persistEffect(tx, project, effect);
      notifyAutomaticContextResult(this.options.store, project, effect, tx);
    });
  }
  /**
   * C-232: read-only view of the latest persisted context poll for the Workbench. A
   * sample older than the stale limit is dropped at read time, so a stopped
   * patrol never leaves an old reading on screen.
   */
  contextUsage(
    project: ProjectId,
  ): ReadonlyMap<AssignmentId, ContextObservation> {
    const now = this.clock.now();
    const staleMs =
      this.options.contextUsage?.staleAfterMs ?? DEFAULT_CONTEXT_STALE_AFTER_MS;
    return new Map(
      readContextSamples(this.options.store, project)
        .map((usage) => [usage.assignment_id, usage] as const)
        .filter(([, usage]) => contextUsageFresh(usage, now, staleMs)),
    );
  }
  tick(): Promise<void> {
    const next = this.serial.then(async () => {
      this.upstream?.schedule();
      if (this.upstream)
        for (const project of this.options.store.listProjects())
          this.pollUpstream(project.id);
      this.scheduleContexts();
      if (
        !this.closing &&
        !this.stallPoll &&
        Date.parse(this.clock.now()) - this.lastStallPoll >= 30_000
      ) {
        this.lastStallPoll = Date.parse(this.clock.now());
        this.stallPoll = (async () => {
          for (const p of this.options.store.listProjects()) {
            if (this.closing) break;
            await this.stallPatrol.tick(p.id, this.options.snapshot);
          }
        })()
          .catch((e) => this.options.onError?.(e))
          .finally(() => {
            this.stallPoll = undefined;
          });
      }
      await this.drain();
    });
    this.serial = next.catch(() => {});
    return next;
  }
  /**
   * C-626: evidence of a system-ended turn's owner-bound stop: the idle basis
   * (hc status or the bound empty editor), the stop path, PID and signal, the
   * result and (as the event time) when. Bounded facts only, never screen text.
   */
  private recordTurnExit(
    project: ProjectId,
    action: HostOpsExecution,
    facts: {
      idle_basis: string | null;
      result: string;
    } & Partial<RetirementStop>,
  ) {
    this.options.store.uow.run((tx) => {
      const state = loadCommandState(tx, project);
      const a = state.assignments.find((v) => v.id === action.assignment_id);
      const card = state.work_items.find(
        (w) => w.id === a?.work_item_id,
      )?.card_id;
      tx.events.append(project, {
        id: tx.ids.nextEventId(),
        seq: tx.ids.nextEventSequence(project, card),
        ...(card ? { card_id: card } : {}),
        actor: { kind: "system", project_id: project },
        type: "dispatch_stall_turn_exit",
        created_at: this.clock.now(),
        payload: {
          action_id: action.action_id,
          assignment_id: action.assignment_id,
          system_finished_run_id: action.system_finished_run_id ?? null,
          idle_basis: facts.idle_basis,
          exit_path: facts.path ?? null,
          signal: facts.signal ?? null,
          pid: facts.pid ?? null,
          result: facts.result,
        },
      });
    });
  }
  /**
   * C-678: the session-ending action stays queued while a human is attached
   * (that protection is unchanged). Record why, with when the connection
   * began, so the attached human, the requester and PM see it at once; a
   * Needs You notice follows once the wait is overdue. After detaching, the
   * next drain takes the lock and the action continues without a new request.
   */
  private async noteAttachedHuman(
    project: ProjectId,
    action: HostOpsExecution,
  ) {
    const { store } = this.options;
    const holder = await hostOpsLockHolder(
      store,
      project,
      action.assignment_id,
    );
    if (!holder) return;
    const after =
      this.options.attachedHumanNoticeMs ?? DEFAULT_ATTACHED_HUMAN_NOTICE_MS;
    const seen = this.attachedWaits.get(action.action_id);
    if (
      seen?.started_at === holder.started_at &&
      (seen.overdue || Date.parse(this.clock.now()) < seen.since + after)
    )
      return;
    store.uow.run((tx) => {
      const state = loadCommandState(tx, project);
      const earlier = attachedHumanWaits(state.events, action.action_id);
      const effect = unwrap(
        recordAttachedHumanWait(
          state,
          { kind: "system", project_id: project },
          {
            action_id: action.action_id,
            attached: { mode: holder.mode, started_at: holder.started_at },
            notice_after_ms: after,
          },
          { clock: this.clock, ids: tx.ids },
        ),
      );
      persistEffect(tx, project, effect);
      const { waiting, overdue } = effect.data;
      if (waiting && earlier.length === 0) {
        const target = state.assignments.find(
          (a) => a.id === action.assignment_id,
        );
        const requester = state.events.find(
          (e) => e.id === action.action_id,
        )?.actor;
        const recipients: Parameters<
          typeof recordNotification
        >[1]["recipient"][] = [];
        // Never bell the attached session itself: it would type into the
        // terminal the human is using.
        if (
          requester?.kind === "assignment" &&
          requester.assignment_id !== action.assignment_id &&
          state.assignments.find((a) => a.id === requester.assignment_id)
            ?.status === "active"
        )
          recipients.push({
            kind: "assignment",
            assignment_id: requester.assignment_id,
          });
        // A standing PM target is the attached session itself.
        if (!(target?.scope === "standing" && target.role_id === "pm"))
          recipients.push({ kind: recoveryPm(target) });
        for (const recipient of recipients)
          recordNotification(store.database, {
            project_id: project,
            event_id: waiting.id,
            seq: waiting.seq,
            kind: "run_attention",
            at: waiting.created_at,
            recipient,
          });
      }
      this.attachedWaits.set(action.action_id, {
        started_at: holder.started_at,
        since: Date.parse(earlier[0]?.created_at ?? this.clock.now()),
        overdue:
          !!overdue ||
          eventsOfType(state.events, ATTACHED_HUMAN_WAIT_OVERDUE).some(
            (e) =>
              (e.payload as { action_id?: string }).action_id ===
              action.action_id,
          ),
      });
    });
  }
  private defer(
    project: ProjectId,
    action: string,
    reason: string,
    upstreamDetail?: UpstreamHoldDetail,
  ) {
    this.options.store.uow.run((tx) => {
      const events = loadCommandState(tx, project).events;
      if (
        !pendingHostOpsActions(events).some((a) => a.action_id === action) ||
        events.some(
          (e) =>
            e.type === "host_ops_action_deferred" &&
            (e.payload as { action_id: string; reason: string }).action_id ===
              action &&
            (e.payload as { reason: string }).reason === reason,
        )
      )
        return;
      tx.events.append(project, {
        id: tx.ids.nextEventId(),
        seq: tx.ids.nextEventSequence(project),
        type: "host_ops_action_deferred",
        actor: { kind: "system", project_id: project },
        payload: {
          action_id: action,
          reason,
          ...(upstreamDetail ? { upstream_detail: upstreamDetail } : {}),
        },
        created_at: this.clock.now(),
      });
    });
  }
  /**
   * C-152: a terminal on another runtime is settled only after a human
   * confirms it exited; until then a single Needs You item stays open.
   */
  private confirmedByHuman(project: ProjectId, action: HostOpsExecution) {
    const { store } = this.options;
    const state = store.uow.read((tx) => loadCommandState(tx, project));
    const confirmation = hostOpsExitConfirmation(state, action.action_id);
    if (confirmation.status === "confirmed") return true;
    if (confirmation.status !== "open")
      store.uow.run((tx) => {
        const effect = unwrap(
          requestHostOpsExitConfirmation(
            loadCommandState(tx, project),
            { kind: "system", project_id: project },
            {
              action_id: action.action_id,
              ...exitConfirmationText(
                action,
                this.options.runtimeLabel ?? "server 当前运行时",
                this.options.hcSession,
              ),
            },
            { clock: this.clock, ids: tx.ids },
          ),
        );
        persistEffect(tx, project, effect);
      });
    this.defer(
      project,
      action.action_id,
      "terminal_exit_confirmation_requested",
    );
    return false;
  }
  private async drain() {
    const { store } = this.options;
    for (const project of store.listProjects()) {
      const state = store.uow.read((tx) => loadCommandState(tx, project.id));
      for (const run of state.runs) {
        const action = automaticContextActionForRun(state.events, run);
        if (!action) continue;
        if (run.started_at)
          this.contextResult(
            project.id,
            action,
            "succeeded",
            "新会话已开始执行。",
          );
        else if (["failed", "cancelled"].includes(run.status))
          this.contextResult(project.id, action, "failed", "新会话启动失败。");
      }
      for (const action of pendingHostOpsActions(state.events)) {
        if (this.closing) return;
        const key = JSON.stringify([project.id, action.assignment_id]);
        if (this.actionWorkers.has(key)) continue;
        if (
          (this.upstream ||
            action.automatic_context_restart ||
            action.dispatch_stall_id) &&
          action.tool !== "host_ops_cancel_run"
        ) {
          // Keep the original stop-time safety checks and lock inside the worker.
          // A slow project sample must not hold routing or unrelated cancellations.
          const worker = this.drainAction(project.id, action)
            .catch((error) => {
              if (action.automatic_context_restart || action.dispatch_stall_id)
                this.contextResult(
                  project.id,
                  action,
                  "failed",
                  "自动换会话处理失败，请核对停止和启动记录。",
                );
              this.options.onError?.(error);
            })
            .finally(() => this.actionWorkers.delete(key));
          this.actionWorkers.set(key, worker);
        } else {
          await this.drainAction(project.id, action);
        }
      }
    }
  }
  private async drainAction(project: ProjectId, action: HostOpsExecution) {
    const { store, runtime } = this.options;
    const read = () => store.uow.read((tx) => loadCommandState(tx, project));
    const turnRecovery = !!(
      action.system_finished_run_id || action.retirement_handoff
    );
    // Every stall recovery (turn or ordinary row) preserves a writer checkout
    // and proves exit the same way before its successor is queued.
    const preserve = turnRecovery || !!action.dispatch_stall_id;
    const unlock = await tryHostOpsLock(store, project, action.assignment_id);
    if (!unlock) {
      await this.noteAttachedHuman(project, action);
      return;
    }
    this.attachedWaits.delete(action.action_id);
    let unlockLaunch: Awaited<ReturnType<typeof tryHostOpsLock>>;
    try {
      if (action.retirement_handoff) {
        unlockLaunch = await tryHostOpsLock(
          store,
          project,
          action.assignment_id,
          "launch",
        );
        if (!unlockLaunch) return;
      }
      if (this.closing) return;
      const lease = store.uow.run((tx) => {
        const effect = unwrap(
          claimHostOpsAction(
            loadCommandState(tx, project),
            { kind: "system", project_id: project },
            action.action_id,
            { clock: this.clock, ids: tx.ids },
          ),
        );
        persistEffect(tx, project, effect);
        return effect.data;
      });
      if (!lease) return;
      // Whether this attempt has a writer backup receipt on record. Reported on
      // withdrawal: a later receipt may stand for the incident only when no
      // earlier attempt may have written one.
      // A receipt that cannot be read now may still have been written by an
      // earlier lease of this same action: unknown, never "not written".
      const priorLease =
        read().events.filter(
          (e) =>
            e.type === "host_ops_action_claimed" &&
            (e.payload as { action_id?: string }).action_id ===
              action.action_id,
        ).length > 1;
      // C-671: the receipt sits on a card; the type index sees it when closed.
      let receiptRecorded: boolean | undefined = eventsOfType(
        read().events,
        "dispatch_stall_backup_verified",
      ).some(
        (e) =>
          (e.payload as { action_id?: string }).action_id === action.action_id,
      )
        ? true
        : priorLease
          ? undefined
          : false;
      let standingExitReason = "standing_exit_pending";
      const fail = (
        reason: string,
        blockedBy?: UpstreamDiagnosis,
        upstreamDetail?: UpstreamHoldDetail,
      ) => {
        standingExitReason = reason;
        if (action.dispatch_stall_id) {
          const withdrawn = store.uow.run((tx) => {
            const effect = unwrap(
              withdrawUnstartedStallRestart(
                loadCommandState(tx, project),
                { kind: "system", project_id: project },
                action.action_id,
                { clock: this.clock, ids: tx.ids },
                reason,
                receiptRecorded,
                blockedBy && upstreamDetail
                  ? { ...blockedBy, upstream_detail: upstreamDetail }
                  : blockedBy,
              ),
            );
            persistEffect(tx, project, effect);
            const e = effect.data;
            if (e)
              recordNotification(store.database, {
                project_id: project,
                event_id: e.id,
                seq: e.seq,
                kind: "run_attention",
                at: e.created_at,
                recipient: {
                  kind: recoveryPm(
                    tx.assignments.get(project, action.assignment_id),
                  ),
                },
              });
            return !!e;
          });
          if (withdrawn) return;
          if (
            !pendingHostOpsActions(read().events).some(
              (a) => a.action_id === action.action_id,
            )
          )
            return;
        }
        if (action.automatic_context_restart || action.dispatch_stall_id)
          this.contextResult(project, action, "failed", reason, upstreamDetail);
        else this.defer(project, action.action_id, reason, upstreamDetail);
      };
      const current = () => {
        const state = read();
        const claimed =
          state.events.findLast(
            (e) =>
              e.type === "host_ops_action_claimed" &&
              (e.payload as { action_id: string }).action_id ===
                action.action_id,
          )?.id === lease &&
          pendingHostOpsActions(state.events).some(
            (a) => a.action_id === action.action_id,
          );
        if (!claimed) return false;
        const bound =
          JSON.stringify(
            state.assignments.find((a) => a.id === action.assignment_id)
              ?.runtime_ref,
          ) === JSON.stringify(action.runtime_ref);
        if (action.retirement_handoff) {
          const owner = state.assignments.find(
            (a) => a.id === action.assignment_id,
          );
          const fresh =
            owner &&
            retirementStallHandoff(state, owner, action.dispatch_stall_id);
          if (
            !fresh ||
            fresh.phase !== action.retirement_handoff.phase ||
            fresh.observe_only !== action.retirement_handoff.observe_only ||
            fresh.started_at !== action.retirement_handoff.started_at ||
            fresh.queue_id !== action.run_id ||
            !action.dispatch_stall_id ||
            !this.stallPatrol.current(
              state,
              action.assignment_id,
              action.dispatch_stall_id,
            )
          ) {
            fail("retirement_handoff_changed");
            return false;
          }
        }
        if (!bound && turnRecovery) fail("terminal_binding_changed");
        return bound;
      };
      // Do not revoke credentials or release the Run slot until exit is proven.
      if (!current()) return;
      let activity: SessionActivity | undefined;
      let freshUsage = action.context_usage;
      const observationMonitor = this.upstream;
      if (action.tool !== "host_ops_cancel_run") {
        try {
          const samples = action.automatic_context_restart
            ? await this.sessions(project)
            : undefined;
          if (samples) {
            freshUsage = samples.find(
              (v) =>
                !v.stale &&
                v.assignment_id === action.assignment_id &&
                v.session_id === action.context_usage?.session_id,
            )?.observation;
            if (!freshUsage) {
              fail("停止前缺少当前会话的新鲜样本");
              return;
            }
          }
          activity = await this.observeUpstream(
            project,
            action.assignment_id,
            samples,
          );
        } catch (error) {
          if (this.upstream === observationMonitor && !staleObservation(error))
            observationMonitor?.observationFailed(project, error);
          fail("upstream_observation_failed");
          // C-625: a standing PM restart still observes its own terminal; the
          // upstream gate below then decides (bypassed only for confirmed idle).
          if (
            action.tool !== "host_ops_restart_standing_pm" ||
            action.automatic_context_restart ||
            preserve
          )
            return;
        }
      }
      let evidenceFailure: string | undefined;
      let idleBasis: string | null | undefined;
      const checkStall = async () => {
        if (!action.dispatch_stall_id) return;
        const state = read();
        const a = state.assignments.find((a) => a.id === action.assignment_id);
        const stall =
          a && this.stallPatrol.current(state, a.id, action.dispatch_stall_id);
        const view =
          a && stall && (await this.stallPatrol.evidence(state, a, stall));
        idleBasis = view ? view.idle_basis : undefined;
        evidenceFailure = !view
          ? "stall_not_current"
          : !view.can_restart
            ? `workspace=${view.workspace}; terminal_owner=${view.terminal_owner ?? "unknown"}; terminal_state=${view.terminal_state ?? "unknown"}`
            : undefined;
      };
      // Only inspect the fixed workspace here: the runtime already owns
      // its signal slot, so a nested runtime probe could wait on itself.
      let workspaceSeal: string | undefined;
      let placementChanged = false;
      let backup: { ref: string; sha: string } | undefined;
      const checkWorkspace = async () => {
        const state = read();
        const a = state.assignments.find((a) => a.id === action.assignment_id);
        const workspace = a
          ? await stallWorkspace(
              state,
              a,
              this.stallExecution(project, a.machine_id),
              this.contextAbort.signal,
              backup?.sha,
              !!backup && !!workspaceSeal,
            )
          : "unknown";
        if (writableInPlace(workspace) || workspace === "no_worktree") {
          if (
            !workspaceSeal ||
            (a &&
              (await writerPlacementSeal(
                project,
                a,
                action.runtime_ref,
                this.stallExecution(project, a.machine_id),
                this.contextAbort.signal,
              )) === workspaceSeal)
          )
            return true;
          evidenceFailure = "workspace_placement_changed";
          return false;
        }
        evidenceFailure = `workspace=${workspace}`;
        return false;
      };
      const reviewRestart =
        action.tool === "host_ops_restart_assignment" &&
        !action.dispatch_stall_id &&
        read().work_items.some(
          (w) =>
            w.assignment_id === action.assignment_id && w.kind === "verify",
        );
      const reviewStopGuard = (beforeRelease: boolean) =>
        store.uow.run((tx) => {
          const effect = unwrap(
            guardReviewRestartStop(
              loadCommandState(tx, project),
              { kind: "system", project_id: project },
              action.action_id,
              { clock: this.clock, ids: tx.ids },
              beforeRelease,
            ),
          );
          persistEffect(tx, project, effect);
          return effect.data;
        });
      // C-625: a confirmed idle standing PM past the threshold no longer
      // waits on the upstream diagnosis; nothing else is relaxed.
      const mayStop = (idleOverdue = false) => {
        if (this.closing || !current()) return false;
        if (
          action.dispatch_stall_id &&
          (evidenceFailure ||
            !this.stallPatrol.current(
              read(),
              action.assignment_id,
              action.dispatch_stall_id,
            ))
        ) {
          fail(evidenceFailure ?? "stall_not_current");
          return false;
        }
        if (reviewRestart && !reviewStopGuard(false)) return false;
        if (action.tool === "host_ops_cancel_run") return true;
        if (this.upstream !== observationMonitor) {
          fail("upstream_configuration_changed");
          return false;
        }
        if (
          action.automatic_context_restart &&
          (!freshUsage ||
            !automaticContextRestartReady(
              read(),
              freshUsage,
              this.clock.now(),
              this.options.contextUsage?.staleAfterMs ??
                DEFAULT_CONTEXT_STALE_AFTER_MS,
              action.action_id,
            ))
        ) {
          fail("停止前会话、样本或空闲状态已改变");
          return false;
        }
        const diagnosis = this.upstream?.diagnosis(
          read(),
          action.assignment_id,
          action.action_id,
          activity,
        );
        if (action.upstream_incident_id || diagnosis?.incident_id) {
          const withdrawn = store.uow.run((tx) => {
            const effect = unwrap(
              withdrawRecoveredHostOpsAction(
                loadCommandState(tx, project),
                { kind: "system", project_id: project },
                action.action_id,
                { clock: this.clock, ids: tx.ids },
                diagnosis?.incident_id,
              ),
            );
            persistEffect(tx, project, effect);
            return effect.data;
          });
          if (withdrawn) return false;
        }
        try {
          this.checkUpstream(
            read(),
            action.assignment_id,
            Boolean(action.context_usage),
            action.action_id,
            activity,
          );
          return true;
        } catch {
          if (idleOverdue) return true;
          // C-680: name the condition that actually held the stop; only a
          // line fault is "upstream not recovered".
          const held = this.upstream?.diagnosis(
            read(),
            action.assignment_id,
            action.action_id,
            activity,
          );
          fail(
            upstreamHoldReason(held),
            held,
            upstreamHoldDetail(
              held,
              this.upstream?.classificationFailure(project),
            ),
          );
          return false;
        }
      };
      const foreign =
        action.runtime_ref !== null &&
        this.options.ownsRuntimeRef?.(action.runtime_ref) === false;
      const cause = eventById(read().events, action.dispatch_stall_id);
      const exitOnly = observedLocalExitCause(cause);
      const stopStarted =
        action.retirement_handoff?.phase === "stopping" ||
        action.retirement_handoff?.observe_only ||
        (reviewRestart && reviewRestartStopStarted(read(), action.action_id)) ||
        ((action.automatic_context_restart === true ||
          !!action.dispatch_stall_id) &&
          read().events.some(
            (e) =>
              e.type === "host_ops_action_deferred" &&
              (e.payload as { action_id?: string }).action_id ===
                action.action_id &&
              (e.payload as { reason?: string }).reason ===
                "automatic_context_stop_started",
          ));
      // C-625: an ordinary standing PM restart first lets an idle session
      // leave on its own, then signals it once; a busy turn is never stopped.
      const standingRef =
        action.tool === "host_ops_restart_standing_pm" &&
        !preserve &&
        !foreign &&
        !action.automatic_context_restart
          ? action.runtime_ref
          : null;
      const remindStanding = () => {
        if (standingRef && !this.closing)
          remindStandingExitOverdue(
            store,
            project,
            this.clock,
            action,
            this.standingExitPolicy,
            standingExitReason,
          );
      };
      let standing: StandingExitOutcome | undefined;
      if (standingRef) {
        const last = read().runs.findLast(
          (r) => r.assignment_id === action.assignment_id && r.started_at,
        );
        standing = await exitStandingSession({
          store,
          project,
          clock: this.clock,
          runtime,
          action: { ...action, runtime_ref: standingRef },
          harness:
            last?.harness ??
            (last?.launch_profile_ref
              ? this.options.upstream?.profiles[last.launch_profile_ref]
                  ?.harness
              : undefined),
          policy: this.standingExitPolicy,
          mayStop,
          defer: (reason) => {
            standingExitReason = reason;
            this.defer(project, action.action_id, reason);
          },
        });
        if (standing === "waiting") {
          remindStanding();
          return;
        }
      }
      // A started stop can only observe its exit. The original notice may
      // already be ACKed; settlement rechecks it before allowing a new Run.
      if (standing === "exited") {
        // Exit observed above; continue to the shared settlement.
      } else if (!(turnRecovery && stopStarted) && !mayStop()) {
        remindStanding();
        return;
      } else if (foreign) {
        // Automatic sources never ask the human to confirm the exit: a
        // C-596 restart stays pending (one executor) and the standing-PM
        // patrol hands it to host operations.
        if (
          action.automatic_context_restart ||
          action.dispatch_stall_id ||
          action.standing_pm_stall
        ) {
          fail("当前主机无法确认旧会话退出");
          return;
        }
        if (!this.confirmedByHuman(project, action)) return;
      } else {
        const beforeSignal = () => {
          if (!mayStop()) return false;
          if (reviewRestart && !reviewStopGuard(true)) return false;
          if (action.automatic_context_restart || action.dispatch_stall_id)
            this.defer(
              project,
              action.action_id,
              "automatic_context_stop_started",
            );
          return true;
        };
        let result: string;
        if (preserve) {
          if (!stopStarted) {
            await checkStall();
            if (!mayStop()) return;
          }
          const a = read().assignments.find(
            (v) => v.id === action.assignment_id,
          );
          const write =
            a &&
            read().roles.find(
              (r) =>
                r.role_id === a.role_id && r.role_version === a.role_version,
            )?.worktree === "write";
          if (a && write && a.worktree_path) {
            try {
              workspaceSeal = await writerPlacementSeal(
                project,
                a,
                action.runtime_ref,
                this.stallExecution(project, a.machine_id),
                this.contextAbort.signal,
              );
              if (!workspaceSeal) throw new Error();
              // The incident's first backup record is the directory identity.
              // Same path, branch and commit do not prove uncommitted work is
              // there; a missing first record after a refusal is no proof either.
              const seal = workspaceSeal;
              const identity = (s: CommandState) =>
                incidentIdentity(s, action, seal);
              const first = identity(read());
              if (first === null) {
                placementChanged = true;
                throw new Error();
              }
              backup = await this.options.stallBackup?.(
                project,
                a,
                action.action_id,
              );
              if (first && backup && backup.sha !== first.sha) {
                placementChanged = true;
                throw new Error();
              }
              if (!backup || !(await checkWorkspace())) throw new Error();
              const verified = { ...backup, workspace_seal: workspaceSeal };
              store.uow.run((tx) => {
                const state = loadCommandState(tx, project);
                const current = state.assignments.find((v) => v.id === a.id);
                const fresh = identity(state);
                if (fresh === null || (fresh && fresh.sha !== verified.sha)) {
                  placementChanged = true;
                  throw new Error();
                }
                if (
                  !pendingHostOpsActions(state.events).some(
                    (v) => v.action_id === action.action_id,
                  ) ||
                  !current ||
                  !isDeepStrictEqual(recoveryBasis(current), recoveryBasis(a))
                )
                  throw new Error();
                const prior = eventsOfType(
                  state.events,
                  "dispatch_stall_backup_verified",
                ).find(
                  (e) =>
                    (e.payload as { action_id?: string }).action_id ===
                    action.action_id,
                );
                if (prior) {
                  const p = prior.payload as {
                    workspace_seal?: string;
                    sha?: string;
                    ref?: string;
                  };
                  if (
                    p.workspace_seal !== workspaceSeal ||
                    p.sha !== verified.sha ||
                    p.ref !== verified.ref
                  )
                    throw new Error();
                } else {
                  const card = state.work_items.find(
                    (w) => w.id === a.work_item_id,
                  )?.card_id;
                  tx.events.append(project, {
                    id: tx.ids.nextEventId(),
                    seq: tx.ids.nextEventSequence(project, card),
                    ...(card ? { card_id: card } : {}),
                    actor: { kind: "system", project_id: project },
                    type: "dispatch_stall_backup_verified",
                    created_at: this.clock.now(),
                    payload: {
                      action_id: action.action_id,
                      assignment_id: a.id,
                      system_finished_run_id:
                        action.system_finished_run_id ?? null,
                      ...verified,
                    },
                  });
                }
              });
              receiptRecorded = true;
            } catch {
              fail(
                placementChanged
                  ? "workspace_placement_changed"
                  : "workspace_backup_unconfirmed",
              );
              return;
            }
          }
          const remote = a && a.machine_id !== "local";
          if (action.retirement_handoff) {
            // Observe first. Only a still-waiting, locally registered launch can
            // reach the existing graceful stop. A transferred stop is never retried.
            const exited = () =>
              a &&
              transferredSessionExited(
                read(),
                a,
                runtime,
                this.stallExecution(project, a.machine_id),
              );
            if (await exited()) result = "exited";
            else if (
              remote ||
              stopStarted ||
              !a?.runtime_ref?.local_process_receipt
            )
              result = "terminal_exit_unconfirmed";
            else {
              result = await stopSystemTurn(
                runtime,
                action.runtime_ref,
                { project_id: project, assignment_id: a.id },
                false,
                checkWorkspace,
                beforeSignal,
                async () => !!(await exited()),
              );
              if (result === "exited" && !(await exited()))
                result = "terminal_exit_unconfirmed";
            }
          } else if (
            action.system_finished_run_id &&
            !action.runtime_ref &&
            a &&
            !a.runtime_ref &&
            !a.session_ref &&
            !remote
          ) {
            // Settled by an earlier recovery: no session left to stop.
            result = "exited";
          } else if (action.system_finished_run_id) {
            const execution = a && this.stallExecution(project, a.machine_id);
            // C-626: a macOS worker's live turn is stopped through its idle
            // owner or enrolled PID; other remote targets only settle an exit.
            const darwin = !!a && darwinTurnTarget(a, execution);
            const ended = action.system_finished_run_id;
            let stop: RetirementStop | undefined;
            let signalled = false;
            result =
              remote &&
              !darwin &&
              !(await remoteStallExit(read(), a, execution))
                ? "terminal_exit_unconfirmed"
                : await stopSystemTurn(
                    runtime,
                    action.runtime_ref,
                    systemTurnOwner(
                      read(),
                      action.assignment_id,
                      action.runtime_ref,
                      ended,
                    ),
                    (!!remote && !darwin) || stopStarted || exitOnly,
                    checkWorkspace,
                    () => (signalled = beforeSignal()),
                    async () =>
                      !!a &&
                      !!action.runtime_ref &&
                      (remote
                        ? await remoteStallExit(read(), a, execution)
                        : await localTurnExitProof(
                            read(),
                            a,
                            runtime,
                            action.runtime_ref,
                            execution,
                          )),
                    {
                      idlePrompt: a && turnIdlePrompt(read(), a, ended),
                      remoteSignal: darwin,
                      report: (value) => {
                        stop = value;
                      },
                    },
                  );
            if (signalled || stop)
              this.recordTurnExit(project, action, {
                idle_basis: idleBasis ?? null,
                ...(stop ?? {}),
                result,
              });
          } else {
            // Ordinary stall rows use the same guards: the evidence recheck and
            // writer backup above, one owner-bound idle stop and kernel exit
            // proof. Never force-release by address; without proof go to Ops.
            result = !action.runtime_ref
              ? a && !a.runtime_ref
                ? "exited" // Never provisioned: no session to stop.
                : "terminal_exit_unconfirmed"
              : !a || remote
                ? "terminal_exit_unconfirmed"
                : // C-669: a session already proven gone is settled as is;
                  // probing its stale terminal address only withdraws again.
                  isDeepStrictEqual(a.runtime_ref, action.runtime_ref) &&
                    (await sessionExitProof(
                      read(),
                      a,
                      runtime,
                      this.stallExecution(project, a.machine_id),
                    )) === "exited"
                  ? "exited"
                  : await stopSystemTurn(
                      runtime,
                      action.runtime_ref,
                      { project_id: project, assignment_id: a.id },
                      stopStarted,
                      checkWorkspace,
                      beforeSignal,
                      async () =>
                        !!action.runtime_ref &&
                        (await localTurnExitProof(
                          read(),
                          a,
                          runtime,
                          action.runtime_ref,
                          this.stallExecution(project, a.machine_id),
                        )),
                    );
          }
          // Exit can also be observed without sending anything. Exit alone
          // does not authorize clearing the session and queuing its successor.
          if (result === "exited" && !(await checkWorkspace()))
            result = "withdrawn";
          result = evidenceFailure ?? result;
        } else {
          result = await stopRunRuntime(
            runtime,
            action.runtime_ref,
            beforeSignal,
            stopStarted,
            !stopStarted,
          );
          if (result !== "exited") result = "terminal_exit_unconfirmed";
        }
        if (result !== "exited") {
          if (!this.closing) fail(result);
          remindStanding();
          return;
        }
      }
      if (!current()) return;
      try {
        await this.options.scrubCredentials?.(
          project,
          action.assignment_id,
          action.runtime_ref,
        );
      } catch {
        fail("credential_cleanup_failed");
        return;
      }
      // Credential scrubbing can wait on worker IO. Do not queue from a
      // workspace observation made before that wait.
      if (
        preserve &&
        this.options.scrubCredentials &&
        !(await checkWorkspace())
      ) {
        if (!this.closing) fail(evidenceFailure ?? "workspace=unknown");
        return;
      }
      let identityLost = false;
      store.uow.run((tx) => {
        const state = loadCommandState(tx, project);
        if (
          state.events.findLast(
            (e) =>
              e.type === "host_ops_action_claimed" &&
              (e.payload as { action_id: string }).action_id ===
                action.action_id,
          )?.id !== lease
        )
          return;
        // Settle only on positive evidence: the incident's first receipt is
        // readable and matches. "No first receipt yet" allows recording one
        // before the backup, never settling after it: no cleared binding,
        // revoked token or successor otherwise.
        if (
          preserve &&
          workspaceSeal &&
          !settlementIdentityHolds(state, action, workspaceSeal)
        ) {
          identityLost = true;
          return;
        }
        const effect = unwrap(
          finishHostOpsAction(
            state,
            { kind: "system", project_id: project },
            action.action_id,
            { clock: this.clock, ids: tx.ids },
            action.dispatch_stall_id
              ? this.stallPatrol.current(
                  state,
                  action.assignment_id,
                  action.dispatch_stall_id,
                )
              : undefined,
          ),
        );
        revokeStoppedRunTokens(tx, project, action.assignment_id);
        persistEffect(tx, project, effect);
        const { run, event } = effect.data;
        if (run)
          recordNotification(store.database, {
            project_id: project,
            event_id: event.id,
            seq: event.seq,
            kind: "assignment",
            at: this.clock.now(),
            recipient: {
              kind: "assignment",
              assignment_id: action.assignment_id,
            },
            ...(event.card_id ? { card_id: event.card_id } : {}),
          });
      });
      if (identityLost && !this.closing) fail("workspace_placement_changed");
    } finally {
      try {
        await unlockLaunch?.();
      } finally {
        await unlock();
      }
    }
  }
}

const OPERATION: Record<HostOpsExecution["tool"], string> = {
  host_ops_restart_assignment: "重启",
  host_ops_restart_standing_pm: "重启常驻 PM",
  host_ops_cancel_run: "取消 Run",
};

/** Every host-ops tool HostOpsService executes. */
type HostOpsToolName =
  | HostOpsExecutionTool
  | "host_ops_recheck_merge"
  | "host_ops_recheck_precheck"
  | "host_ops_stop_assignment";

/** C-759: why a managed stop of an idle session did not apply. */
export function idleStopRefusalText(reason: string) {
  const fixed: Record<string, string> = {
    no_session: "该指派没有在运行的终端",
    not_managed: "只能停止受管工作项指派的会话",
    terminal_unobserved: "读不到终端状态",
    terminal_not_live: "终端已不在运行，按原有替换路径处理",
    locked: "该指派正在启动、交接或执行其它主机操作，稍后再试",
    session_changed: "会话已更换，请重新读取诊断",
    delivery_in_progress: "正在向该会话投递通知",
    run_busy: "该会话上还有已开始或正在启动的 Run，上一轮没有结束",
    stopped_by_human: "人已停止该指派，只能由人启动",
    operation_pending: "该指派有主机操作、Run 停止或启动在途",
    upgrade_pending: "该指派有待完成的角色升级",
    shared_registration: "终端或工作区还有其它登记",
    agent_unobserved: "确认不了 Agent 是否空闲",
    release_failed: "关闭终端失败",
    failed: "内部错误",
  };
  if (fixed[reason]) return fixed[reason];
  if (reason.startsWith("agent_"))
    return `Agent 不是空闲状态（${reason.slice(6)}），不关闭终端`;
  if (reason.startsWith("exit_unconfirmed"))
    return "已关闭终端但未能证实会话退出，保留终端引用，不另起会话";
  return reason;
}

/** C-730: why a remote restart or cancel did not release the session. */
export function remoteRefusalText(reason: string) {
  return (
    (
      {
        agent_alive: "worker 显示 Agent 进程仍在运行，不关闭终端",
        agent_unobserved:
          "无法从 worker 确认 Agent 进程状态（连接失败或观测不完整），不关闭终端",
        terminal_not_live: "终端已不在运行，按原退出核对路径处理",
        stopped_by_human:
          "该指派已被人工停止，请用 cardigan assignment start 恢复",
        operation_pending: "还有会话操作或 Run 停止、启动在进行，稍后重试",
        upgrade_pending: "角色升级尚未收尾，稍后重试",
        shared_registration: "终端或工作区存在其它登记，不能释放",
        run_changed: "目标 Run 已结束",
        delivery_in_progress: "通知正在投递，稍后重试",
        locked: "会话正在接入或维护，稍后重试",
        release_failed: "关闭终端失败，稍后重试",
        exit_unconfirmed: "终端已关闭，但未能确认会话退出，保留引用等待核对",
        session_changed: "会话已更换，请重新读取诊断",
        not_managed: "目标不是受管的工作项指派",
        no_session: "没有在运行的会话",
      } as Record<string, string>
    )[reason] ?? "未满足释放条件"
  );
}

/** Numbered steps for the human; the terminal is never touched by the server. */
export function exitConfirmationText(
  action: Pick<
    HostOpsExecution,
    "tool" | "assignment_id" | "run_id" | "runtime_ref"
  >,
  runtimeLabel: string,
  session: string = DEFAULT_HC_SESSION,
) {
  const ref = action.runtime_ref;
  const terminal = ref?.terminal_ref ?? "（未记录）";
  const where =
    ref?.runtime_machine === "local"
      ? "本机（local 模式，以当时运行 cardigan 的主机账号启动）"
      : `机器 ${ref?.runtime_machine ?? "（未记录）"}`;
  const run = action.run_id ?? "（无）";
  // Same socket layout as HerdrRuntime: $XDG_RUNTIME_DIR/cardigan/<session>.sock.
  // HerdrRuntime only accepts [A-Za-z0-9_-] names; quote anything else anyway.
  const safe = /^[A-Za-z0-9_-]+$/u.test(session);
  const quoted = `'${session.replaceAll("'", "'\\''")}'`;
  const hc = safe
    ? `HC_SESSION=${session} HC_SOCKET="$XDG_RUNTIME_DIR/cardigan/${session}.sock" hc`
    : `HC_SESSION=${quoted} HC_SOCKET="$XDG_RUNTIME_DIR/cardigan/"${quoted}.sock hc`;
  return {
    instructions: [
      `主机运维要${OPERATION[action.tool] ?? "处理"} ${action.assignment_id}，但它记录的终端 ${terminal} 在${where}，不属于 server 当前运行时 ${runtimeLabel}，server 无法确认它已退出。请按以下步骤处理：`,
      `1. 在启动该终端的主机账号下打开一个没有加载 runtime.env 的 shell（${ref?.runtime_machine === "local" ? "即当时启动它的那类普通 shell" : "能访问该机器的 shell"}），运行 \`${hc} get ${terminal} --json\`，查看终端状态（state 为 live 表示仍在运行；会话名 ${session} 取自 server 登记的运行时 runtime.json）。`,
      `2. 如果仍在运行：先运行 \`${hc} kill ${terminal}\` 结束它；hc 不可用时，结束对应的 Agent 进程（如 claude）和终端占位进程。`,
      `3. 再次运行 \`${hc} get ${terminal} --json\`，确认 state 为 finished 或终端不存在，并确认该 Assignment 的 Agent 进程已不在运行。`,
      `4. 确认后把本事项标记为完成：server 会结束旧 Run ${run}、作废它的 Token、清理运行目录凭据，再按原动作重建。无法确认已退出时不要标记完成，在时间线说明情况；动作会继续等待，不会重建。`,
    ].join("\n"),
    why_human: `终端记录在 server 当前没有接入的运行时上，server 不能查询或结束它；在人确认之前，旧 Run 不会结束、Token 不会作废。`,
  };
}
