import {
  type Assignment,
  type AssignmentId,
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
  finishHostOpsAction,
  type HarnessActivity,
  type HostOpsExecution,
  type HostOpsExecutionTool,
  hostOpsExitConfirmation,
  hostOpsReadDiagnostics,
  lastRunActivity,
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
  type SessionActivity,
  withdrawRecoveredHostOpsAction,
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
import { DEFAULT_HC_SESSION, type HerdrRuntime } from "@cardigan/runtime-herdr";
import {
  readContextSamples,
  recordNotification,
  type Store,
  unfinishedBellAttempts,
  writeContextSamples,
} from "@cardigan/store";
import { readAttention } from "./attention.js";
import { notifyAutomaticContextResult } from "./automatic-context-restart.js";
import {
  type ContextUsageOptions,
  contextThresholdView,
  DEFAULT_CONTEXT_STALE_AFTER_MS,
  type HarnessActivityInspection,
  readSessionContexts,
  type SessionContextDiagnostic,
} from "./context-usage.js";
import { readDeploymentDiagnostics } from "./deployment-diagnostics.js";
import { tryHostOpsLock } from "./host-ops-lock.js";
import { revokeStoppedRunTokens, stopRunRuntime } from "./stop-run.js";
import { UpstreamHealthMonitor } from "./upstream-health.js";

interface Options {
  upstream?: LaunchConfig;
  upstreamMonitor?: UpstreamHealthMonitor;
  store: Store;
  runtime: Runtime & Partial<Pick<HerdrRuntime, "diagnostics" | "interaction">>;
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
  private readonly upstream: UpstreamHealthMonitor | undefined;
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
  private lastContextPoll = Number.NEGATIVE_INFINITY;
  private serial: Promise<void> = Promise.resolve();
  constructor(private readonly options: Options) {
    this.clock = options.clock ?? { now: () => new Date().toISOString() };
    this.upstream =
      options.upstreamMonitor ??
      (options.upstream
        ? new UpstreamHealthMonitor(
            options.upstream,
            options.runtime,
            this.clock,
            undefined,
            options.store,
            () =>
              options.onError?.(new Error("upstream probe publication failed")),
          )
        : undefined);
  }
  readonly tools: NonNullable<HostOpsToolOptions["hostOps"]> = {
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
    const [sessions, deployment] = await Promise.all([
      this.sessions(actor.project_id),
      readDeploymentDiagnostics(this.options.store, actor.project_id),
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
        // Full read-only state stays visible; C-56 failures are excluded from patrol work.
        runs,
        patrol_runs: runs.filter(
          (r) =>
            r.recovery_owner === "host_ops" &&
            ["dispatched", "acked", "unknown"].includes(r.status),
        ),
        context_thresholds: contextThresholdView(state),
        sessions: sessions.map(
          ({ observation: _observation, activity: _activity, ...view }) => view,
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
    const params = {
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
      return unwrap(prepareHostOpsAction(state, actor, params)).data;
    });
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
    if (!this.upstream) return {};
    const state = this.options.store.uow.read((tx) =>
      loadCommandState(tx, project),
    );
    const [activity, sessions] = await Promise.all([
      this.upstream.observe(state, only),
      samples ?? this.sessions(project),
    ]);
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
      ...this.upstreamPolls.values(),
      ...this.sessionPolls.values(),
      ...this.actionWorkers.values(),
      this.contextPoll,
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
        if (!this.closing)
          upstream.reconcile(this.options.store, project, activity);
      })
      .catch(() => upstream.observationFailed(project))
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
  ): Promise<ReadonlyMap<AssignmentId, HarnessActivityInspection>> {
    let samples: SessionContextDiagnostic[];
    if (stopTarget) {
      const usage = this.options.contextUsage;
      if (this.closing || !usage) return new Map();
      const state = this.options.store.uow.read((tx) =>
        loadCommandState(tx, project),
      );
      samples = await readSessionContexts(
        {
          ...state,
          assignments: state.assignments.filter(
            (a) => a.id === stopTarget && !a.external,
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
                  status: s.activity_status ?? "missing",
                  ...(s.activity ? { activity: s.activity } : {}),
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
      notifyAutomaticContextResult(store, project, effect);
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
      notifyAutomaticContextResult(this.options.store, project, effect);
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
          (this.upstream || action.automatic_context_restart) &&
          action.tool !== "host_ops_cancel_run"
        ) {
          // Keep the original stop-time safety checks and lock inside the worker.
          // A slow project sample must not hold routing or unrelated cancellations.
          const worker = this.drainAction(project.id, action)
            .catch((error) => {
              if (action.automatic_context_restart)
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
    const unlock = await tryHostOpsLock(store, project, action.assignment_id);
    if (!unlock) return;
    try {
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
      const fail = (reason: string) => {
        if (action.automatic_context_restart)
          this.contextResult(project, action, "failed", reason);
        else this.defer(project, action.action_id, reason);
      };
      const current = () => {
        const state = read();
        return (
          state.events.findLast(
            (e) =>
              e.type === "host_ops_action_claimed" &&
              (e.payload as { action_id: string }).action_id ===
                action.action_id,
          )?.id === lease &&
          pendingHostOpsActions(state.events).some(
            (a) => a.action_id === action.action_id,
          ) &&
          JSON.stringify(
            state.assignments.find((a) => a.id === action.assignment_id)
              ?.runtime_ref,
          ) === JSON.stringify(action.runtime_ref)
        );
      };
      // Do not revoke credentials or release the Run slot until exit is proven.
      if (!current()) return;
      let activity: SessionActivity | undefined;
      let freshUsage = action.context_usage;
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
          this.upstream?.observationFailed(project);
          fail("upstream_observation_failed");
          return;
        }
      }
      const mayStop = () => {
        if (this.closing || !current()) return false;
        if (action.tool === "host_ops_cancel_run") return true;
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
      if (!mayStop()) return;
      const foreign =
        action.runtime_ref !== null &&
        this.options.ownsRuntimeRef?.(action.runtime_ref) === false;
      const stopStarted =
        action.automatic_context_restart === true &&
        read().events.some(
          (e) =>
            e.type === "host_ops_action_deferred" &&
            (e.payload as { action_id?: string }).action_id ===
              action.action_id &&
            (e.payload as { reason?: string }).reason ===
              "automatic_context_stop_started",
        );
      if (foreign) {
        if (action.automatic_context_restart) {
          fail("当前主机无法确认旧会话退出");
          return;
        }
        if (!this.confirmedByHuman(project, action)) return;
      } else if (
        (await stopRunRuntime(
          runtime,
          action.runtime_ref,
          () => {
            if (!mayStop()) return false;
            // Persist before the external stop: after a crash only observe its exit.
            if (action.automatic_context_restart)
              this.defer(
                project,
                action.action_id,
                "automatic_context_stop_started",
              );
            return true;
          },
          stopStarted,
          !stopStarted,
        )) !== "exited"
      ) {
        if (!this.closing) fail("terminal_exit_unconfirmed");
        return;
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
            loadCommandState(tx, project),
            { kind: "system", project_id: project },
            action.action_id,
            { clock: this.clock, ids: tx.ids },
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
      await unlock();
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
