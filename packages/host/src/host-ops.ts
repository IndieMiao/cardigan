import {
  type Assignment,
  type AssignmentId,
  beginHostOpsAction,
  type CardId,
  type Clock,
  type CommandState,
  checkHostOpsAccess,
  claimHostOpsAction,
  dispatchRecoveryQueuedAt,
  finishHostOpsAction,
  type HostOpsExecutionTool,
  hostOpsReadDiagnostics,
  type ProjectId,
  pendingHostOpsActions,
  prepareHostOpsAction,
  type Run,
  type RunId,
  type Runtime,
  recheckMerge,
} from "@cardigan/domain";
import {
  type HostOpsToolOptions,
  loadCommandState,
  persistEffect,
  type ToolContext,
  ToolError,
  unwrap,
} from "@cardigan/mcp-server";
import {
  recordNotification,
  type Store,
  unfinishedBellAttempts,
} from "@cardigan/store";
import { readAttention } from "./attention.js";
import { revokeStoppedRunTokens, stopRunRuntime } from "./stop-run.js";

interface Options {
  store: Store;
  runtime: Runtime;
  snapshot: (
    a: Assignment,
    project: ProjectId,
  ) => Promise<Pick<Run, "model" | "agent_cli_version" | "launch_profile_ref">>;
  settings?: (project: ProjectId) => CommandState["project_settings"];
  clock?: Clock;
  contextThresholdPct?: number;
  scrubCredentials?: (
    project: ProjectId,
    assignment: AssignmentId,
  ) => Promise<void>;
}
/** Requests commit first. The dispatch loop drains intents; a restart resumes unfinished work. */
export class HostOpsService {
  private readonly clock: Clock;
  private serial: Promise<void> = Promise.resolve();
  constructor(private readonly options: Options) {
    this.clock = options.clock ?? { now: () => new Date().toISOString() };
  }
  readonly tools: NonNullable<HostOpsToolOptions["hostOps"]> = {
    read: (context, project) => this.read(context, project),
    execute: (context, tool, params) => this.execute(context, tool, params),
  };
  private read(context: ToolContext, project?: string) {
    context.revalidateToken?.();
    const actor = context.identity.actor;
    if (project !== undefined && project !== actor.project_id)
      throw new ToolError(
        "unauthorized",
        "Diagnostics are limited to the authenticated project",
      );
    return this.options.store.uow.read((tx) => {
      const state = loadCommandState(tx, actor.project_id);
      const view = unwrap(
        hostOpsReadDiagnostics(state, actor, this.clock.now()),
      ).data;
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
        lost: attention.lost.map(summary),
        paused: attention.paused.map(summary),
        findings: attention.findings.map((f) => ({
          kind: f.kind,
          first_seen_at: f.first_seen_at,
          last_seen_at: f.last_seen_at,
        })),
        needs_you: view.needs_you,
        actions: view.actions,
        // Full read-only state stays visible; C-56 failures are excluded from patrol work.
        runs,
        patrol_runs: runs.filter(
          (r) =>
            r.recovery_owner === "host_ops" &&
            ["dispatched", "acked", "unknown"].includes(r.status),
        ),
        sessions: state.assignments
          .filter((a) => a.status === "active")
          .map((a) => ({
            assignment_id: a.id,
            context_usage_pct: Math.min(
              100,
              state.runs.filter(
                (r) =>
                  r.assignment_id === a.id &&
                  r.started_at &&
                  r.started_at >=
                    (state.events.findLast(
                      (e) =>
                        ["session_replaced", "assignment_resumed"].includes(
                          e.type,
                        ) &&
                        (e.payload as { assignment_id?: string })
                          .assignment_id === a.id,
                    )?.created_at ?? a.created_at),
              ).length,
            ),
            context_usage_estimated: true,
            context_usage_basis: "one_percent_per_started_run",
            context_usage_threshold_pct: this.options.contextThresholdPct ?? 80,
          })),
      };
    });
  }
  private async execute(
    context: ToolContext,
    tool: HostOpsExecutionTool | "host_ops_recheck_merge",
    p: { target_id: string; reason?: string; idempotency_key: string },
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
    const params = {
      tool,
      target_id: p.target_id as AssignmentId | RunId,
      reason: p.reason ?? "",
    };
    const preflight = store.uow.read(
      (tx) =>
        unwrap(
          prepareHostOpsAction(loadCommandState(tx, project), actor, params),
        ).data,
    );
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
    return unwrap(
      store.runIdempotent(invocation, (tx) => {
        context.revalidateToken?.();
        const state = loadCommandState(tx, project);
        const fresh = unwrap(prepareHostOpsAction(state, actor, params)).data;
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
            { ...params, ...(snapshot ? { snapshot } : {}) },
            { clock: this.clock, ids: tx.ids },
          ),
        );
        persistEffect(tx, project, effect);
        return effect.data;
      }),
    ).value;
  }
  tick(): Promise<void> {
    const next = this.serial.then(() => this.drain());
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
  private async drain() {
    const { store, runtime } = this.options;
    for (const project of store.listProjects()) {
      const read = () =>
        store.uow.read((tx) => loadCommandState(tx, project.id));
      for (const action of pendingHostOpsActions(read().events)) {
        const lease = store.uow.run((tx) => {
          const effect = unwrap(
            claimHostOpsAction(
              loadCommandState(tx, project.id),
              { kind: "system", project_id: project.id },
              action.action_id,
              { clock: this.clock, ids: tx.ids },
            ),
          );
          persistEffect(tx, project.id, effect);
          return effect.data;
        });
        if (!lease) continue;
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
        if (!current()) continue;
        if (
          (await stopRunRuntime(runtime, action.runtime_ref, current)) !==
          "exited"
        ) {
          this.defer(project.id, action.action_id, "terminal_exit_unconfirmed");
          continue;
        }
        if (!current()) continue;
        try {
          await this.options.scrubCredentials?.(
            project.id,
            action.assignment_id,
          );
        } catch {
          this.defer(project.id, action.action_id, "credential_cleanup_failed");
          continue;
        }
        store.uow.run((tx) => {
          const state = loadCommandState(tx, project.id);
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
              loadCommandState(tx, project.id),
              { kind: "system", project_id: project.id },
              action.action_id,
              { clock: this.clock, ids: tx.ids },
            ),
          );
          revokeStoppedRunTokens(tx, project.id, action.assignment_id);
          persistEffect(tx, project.id, effect);
          const { run, event } = effect.data;
          if (run)
            recordNotification(store.database, {
              project_id: project.id,
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
      }
    }
  }
}
