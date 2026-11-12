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
  type HostOpsExecution,
  type HostOpsExecutionTool,
  hostOpsExitConfirmation,
  hostOpsReadDiagnostics,
  type ProjectId,
  pendingHostOpsActions,
  prepareHostOpsAction,
  type RunId,
  type Runtime,
  type RuntimeRef,
  recheckMerge,
  requestHostOpsExitConfirmation,
} from "@cardigan/domain";
import {
  type HostOpsToolOptions,
  loadCommandState,
  persistEffect,
  type ToolContext,
  ToolError,
  unwrap,
} from "@cardigan/mcp-server";
import { DEFAULT_HC_SESSION } from "@cardigan/runtime-herdr";
import {
  recordNotification,
  type Store,
  unfinishedBellAttempts,
} from "@cardigan/store";
import { readAttention } from "./attention.js";
import { tryHostOpsLock } from "./host-ops-lock.js";
import { revokeStoppedRunTokens, stopRunRuntime } from "./stop-run.js";

interface Options {
  store: Store;
  runtime: Runtime;
  snapshot: (
    a: Assignment,
    project: ProjectId,
  ) => Promise<NonNullable<HostOpsExecution["snapshot"]>>;
  settings?: (project: ProjectId) => CommandState["project_settings"];
  clock?: Clock;
  contextThresholdPct?: number;
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
                        [
                          "session_replaced",
                          "assignment_resumed",
                          "standing_session_restarted",
                        ].includes(e.type) &&
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
    const { store, runtime } = this.options;
    for (const project of store.listProjects()) {
      const read = () =>
        store.uow.read((tx) => loadCommandState(tx, project.id));
      for (const action of pendingHostOpsActions(read().events)) {
        const unlock = await tryHostOpsLock(
          store,
          project.id,
          action.assignment_id,
        );
        if (!unlock) continue;
        try {
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
          const foreign =
            action.runtime_ref !== null &&
            this.options.ownsRuntimeRef?.(action.runtime_ref) === false;
          if (foreign) {
            if (!this.confirmedByHuman(project.id, action)) continue;
          } else if (
            (await stopRunRuntime(runtime, action.runtime_ref, current)) !==
            "exited"
          ) {
            this.defer(
              project.id,
              action.action_id,
              "terminal_exit_unconfirmed",
            );
            continue;
          }
          if (!current()) continue;
          try {
            await this.options.scrubCredentials?.(
              project.id,
              action.assignment_id,
              action.runtime_ref,
            );
          } catch {
            this.defer(
              project.id,
              action.action_id,
              "credential_cleanup_failed",
            );
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
        } finally {
          await unlock();
        }
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
