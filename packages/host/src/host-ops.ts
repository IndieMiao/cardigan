import { isDeepStrictEqual } from "node:util";
import {
  type Assignment,
  type AssignmentId,
  admitWorkerInspection,
  automaticContextActionForRun,
  automaticContextRestartReady,
  beginAutomaticContextRestart,
  beginHostOpsAction,
  type CardId,
  type Clock,
  type CommandState,
  type ContextObservation,
  checkHostOpsAccess,
  claimHostOpsAction,
  contextUsageFresh,
  currentHarnessActivity,
  dispatchRecoveryQueuedAt,
  eventById,
  finishHostOpsAction,
  guardReviewRestartStop,
  type HarnessActivity,
  type HostOpsExecution,
  type HostOpsExecutionTool,
  hostOpsExitConfirmation,
  hostOpsReadDiagnostics,
  lastRunActivity,
  observedLocalExitCause,
  type ProjectId,
  pendingHostOpsActions,
  prepareHostOpsAction,
  type RunId,
  type Runtime,
  type RuntimeRef,
  recheckMerge,
  recordAutomaticContextRestartResult,
  recordContextUsageNotices,
  requestHostOpsExitConfirmation,
  retirementStallHandoff,
  reviewRestartStopStarted,
  type SessionActivity,
  systemTurnOwner,
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
  type ContextUsageOptions,
  contextThresholdView,
  DEFAULT_CONTEXT_STALE_AFTER_MS,
  type HarnessActivityInspection,
  type ResolveActivityExecution,
  readSessionContexts,
  type SessionContextDiagnostic,
} from "./context-usage.js";
import { readDeploymentDiagnostics } from "./deployment-diagnostics.js";
import { tryHostOpsLock } from "./host-ops-lock.js";
import { incidentIdentity, writerPlacementSeal } from "./retained-writer.js";
import {
  localTurnExitProof,
  remoteStallExit,
  stallWorkspace,
  transferredSessionExited,
  writableInPlace,
} from "./stall-evidence.js";
import { recoveryBasis, StallPatrol } from "./stall-patrol.js";
import {
  revokeStoppedRunTokens,
  stopRunRuntime,
  stopSystemTurn,
} from "./stop-run.js";
import { UpstreamHealthMonitor } from "./upstream-health.js";

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
  private readonly contextAbort = new AbortController();
  private contextPoll: Promise<void> | undefined;
  private closing = false;
  private readonly stallPatrol: StallPatrol;
  private stallPoll: Promise<void> | undefined;
  private lastStallPoll = Number.NEGATIVE_INFINITY;
  private lastContextPoll = Number.NEGATIVE_INFINITY;
  private serial: Promise<void> = Promise.resolve();
  constructor(private readonly options: Options) {
    this.clock = options.clock ?? { now: () => new Date().toISOString() };
    this.stallPatrol = new StallPatrol(
      options.store,
      this.clock,
      options.runtime,
      (project, machine) => this.stallExecution(project, machine),
      this.contextAbort.signal,
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
    const result = await inspectWorker(
      execution,
      project,
      assignment,
      run,
      current,
      platform,
      harness,
      this.options.runtime,
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
              state.events.some(
                (e) =>
                  e.type === "bell_delivery_attempt_failed" &&
                  (e.payload as { run_id?: string }).run_id === r.id,
              )))
            ? "automatic"
            : "host_ops",
      }));
      return {
        ...attention,
        dispatch_stalls: stalls,
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
    tool: HostOpsExecutionTool | "host_ops_recheck_merge",
    p: {
      target_id: string;
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
    const preflight = store.uow.read((tx) => {
      const state = loadCommandState(tx, project);
      if (tool !== "host_ops_cancel_run")
        this.checkUpstream(
          state,
          p.target_id as AssignmentId,
          Boolean(contextUsage),
          undefined,
          activity,
        );
      return unwrap(prepareHostOpsAction(state, actor, paramsFor(state))).data;
    });
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
    for (const session of sessions) {
      if (!session.assignment_id) continue;
      const assignment = current.assignments.find(
        (a) => a.id === session.assignment_id,
      );
      const sample =
        assignment &&
        currentHarnessActivity(
          current,
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
      .catch(() => {
        if (!this.closing && this.upstream === upstream)
          upstream.observationFailed(project);
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
    if (!automaticContextRestartReady(state, usage, this.clock.now(), stale))
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
  ) {
    this.options.store.uow.run((tx) => {
      const effect = unwrap(
        recordAutomaticContextRestartResult(
          loadCommandState(tx, project),
          { kind: "system", project_id: project },
          { action_id: action.action_id, result, reason },
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
  private defer(project: ProjectId, action: string, reason: string) {
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
        payload: { action_id: action, reason },
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
    if (!unlock) return;
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
      let receiptRecorded = read().events.some(
        (e) =>
          e.type === "dispatch_stall_backup_verified" &&
          (e.payload as { action_id?: string }).action_id === action.action_id,
      );
      const fail = (reason: string) => {
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
          this.contextResult(project, action, "failed", reason);
        else this.defer(project, action.action_id, reason);
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
        } catch {
          if (this.upstream === observationMonitor)
            observationMonitor?.observationFailed(project);
          fail("upstream_observation_failed");
          return;
        }
      }
      let evidenceFailure: string | undefined;
      const checkStall = async () => {
        if (!action.dispatch_stall_id) return;
        const state = read();
        const a = state.assignments.find((a) => a.id === action.assignment_id);
        const stall =
          a && this.stallPatrol.current(state, a.id, action.dispatch_stall_id);
        const view =
          a && stall && (await this.stallPatrol.evidence(state, a, stall));
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
      const mayStop = () => {
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
          fail("upstream_recovery_not_ready");
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
      // A started stop can only observe its exit. The original notice may
      // already be ACKed; settlement rechecks it before allowing a new Run.
      if (!(turnRecovery && stopStarted) && !mayStop()) return;
      if (foreign) {
        if (action.automatic_context_restart || action.dispatch_stall_id) {
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
                const prior = state.events.find(
                  (e) =>
                    e.type === "dispatch_stall_backup_verified" &&
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
            result =
              remote &&
              !(await remoteStallExit(
                read(),
                a,
                this.stallExecution(project, a.machine_id),
              ))
                ? "terminal_exit_unconfirmed"
                : await stopSystemTurn(
                    runtime,
                    action.runtime_ref,
                    systemTurnOwner(
                      read(),
                      action.assignment_id,
                      action.runtime_ref,
                      action.system_finished_run_id,
                    ),
                    !!remote || stopStarted || exitOnly,
                    checkWorkspace,
                    beforeSignal,
                    async () =>
                      !!a &&
                      !!action.runtime_ref &&
                      (await localTurnExitProof(
                        read(),
                        a,
                        runtime,
                        action.runtime_ref,
                        this.stallExecution(project, a.machine_id),
                      )),
                  );
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
