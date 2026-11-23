import { assignmentCardId, standingRunDormant } from "../card-hold.js";
import type { Actor, Run, RuntimeRef } from "../entities.js";
import { eventById } from "../event-index.js";
import { hostOpsPending } from "../host-ops.js";
import type { RunId } from "../ids.js";
import {
  dispatchReasonText,
  MCP_SESSION_FAILURE,
  mcpSessionMissing,
} from "../mcp-session.js";
import { assignmentCanReadCard, type Notification } from "../notification.js";
import {
  DEFAULT_PROVIDER_COOLDOWN_MS,
  DEFAULT_PROVIDER_FAILURES,
  recordProviderFailure,
} from "../provider-start.js";
import { runById } from "../run-index.js";
import {
  c3ExitCandidate,
  recoveryChainUsed,
  recoveryPolicy,
  recoveryTargetCurrent,
} from "../run-recovery.js";
import { hasRunTarget } from "../run-target.js";
import {
  canParkForDiscussion,
  reviewRunWakeDisposition,
} from "../shared-review-wake.js";
import { transition } from "../transitions.js";
import {
  type CommandPorts,
  type CommandState,
  command,
  ensure,
  unwrap,
} from "./core.js";
import { checkEmployeeSeparation } from "./employee-assignment.js";
import { cancelRunDispatch, launchSettings } from "./launch.js";
import { dispatchTargetWaitMs } from "./run-target-wait.js";

const field = (payload: unknown, name: string): unknown =>
  payload && typeof payload === "object"
    ? (payload as Record<string, unknown>)[name]
    : undefined;
const finished = (run: Run) =>
  ["completed", "failed", "cancelled"].includes(run.status);

/** Only comment-triggered work is obsolete; cross-card business events remain valid. */
export function unreadableCommentTrigger(state: CommandState, run: Run) {
  const a = state.assignments.find((a) => a.id === run.assignment_id);
  if (!a) return undefined;
  let source = run;
  const visited = new Set<RunId>();
  while (!visited.has(source.id)) {
    visited.add(source.id);
    const event = eventById(state.events, source.trigger_event_id);
    if (event?.type === "comment_posted")
      return event.card_id &&
        !assignmentCanReadCard(a, event.card_id, state.work_items)
        ? event
        : undefined;
    if (
      !event ||
      !["run_dispatch_recovered", "run_preparation_recovered"].includes(
        event?.type ?? "",
      ) ||
      field(event.payload, "assignment_id") !== a.id ||
      field(event.payload, "replacement_run_id") !== source.id
    )
      return undefined;
    const original = state.runs.find(
      (r) =>
        r.id === field(event.payload, "run_id") &&
        r.assignment_id === a.id &&
        r.trigger_event_id ===
          field(event.payload, "original_trigger_event_id"),
    );
    if (!original) return undefined;
    source = original;
  }
  return undefined;
}

/** Host must also exclude in-flight BellAttempts in the same store transaction. */
export function retireObsoleteQueuedRun(
  state: CommandState,
  actor: Actor,
  p: { run_id: RunId },
  ports: CommandPorts,
) {
  return command(state, actor, "recover_dispatch", ports, (d) => {
    const run = d.get("runs", p.run_id),
      a = d.get("assignments", run.assignment_id);
    const source = unreadableCommentTrigger(state, run);
    if (
      (!source && reviewRunWakeDisposition(state, a, run) !== "obsolete") ||
      a.external ||
      run.status !== "queued" ||
      run.started_at ||
      run.dispatch_stop ||
      run.inactivity_stop
    )
      return;
    const { queue_reason: _queue, ...rest } = run;
    const body = source
      ? `${a.id}（${run.id}）无权读取触发评论所在卡片 ${source.card_id}，已取消尚未派发的执行，不再重排。`
      : `${a.id}（${run.id}）的审核目标已变更，不再派发。`;
    // A queued Run owns no terminal. Preserve the Assignment's existing idle session.
    d.put("runs", {
      ...rest,
      status: unwrap(transition("run", run.status, "cancel")),
      outcome: "failed",
      summary: body,
      finished_at: d.now,
    });
    d.emit(
      source
        ? "run_unreadable_trigger_cancelled"
        : "run_obsolete_review_cancelled",
      source?.card_id ?? assignmentCardId(a, state, run.trigger_event_id),
      {
        run_id: run.id,
        assignment_id: a.id,
        source_event_id: source?.id ?? run.trigger_event_id,
        reason: source
          ? "recipient_cannot_read_card"
          : "obsolete_review_target",
      },
      { type: "system", body, run_id: run.id },
    );
  });
}
export const retireUnreadableQueuedRun = retireObsoleteQueuedRun;
export const dispatchedAt = (state: CommandState, run: Run) =>
  state.events.findLast(
    (e) => e.type === "run_dispatched" && field(e.payload, "run_id") === run.id,
  )?.created_at;
export const dispatchRecoveryQueuedAt = (state: CommandState, run: Run) =>
  state.events.find(
    (e) =>
      e.type === "run_dispatch_recovered" &&
      field(e.payload, "replacement_run_id") === run.id,
  )?.created_at;

/**
 * C-247: whether the Assignment's single automatic recovery is spent. A
 * requeue after a confirmed-gone terminal at server startup is not a dispatch
 * failure of the Agent, so it never counts against that budget.
 */
export const dispatchRecoveryUsed = (
  events: CommandState["events"],
  assignment: string,
) =>
  events.some(
    (e) =>
      e.type === "run_dispatch_recovered" &&
      field(e.payload, "assignment_id") === assignment &&
      !["server_restart", "provider_unavailable"].includes(
        String(field(e.payload, "reason")),
      ),
  );

export const dispatchRecoveryFailed = (state: CommandState, run: Run) =>
  !run.started_at &&
  run.failure_reason !== "provider_unavailable" &&
  ["cancelled", "failed"].includes(run.status) &&
  !!dispatchRecoveryQueuedAt(state, run) &&
  state.events.some(
    (e) =>
      e.type === "run_dispatch_aborted" &&
      field(e.payload, "run_id") === run.id,
  );

function startupFailureResolved(state: CommandState, run: Run): boolean {
  return (
    state.assignments.find((a) => a.id === run.assignment_id)?.status ===
      "released" ||
    state.runs.some(
      (r) =>
        r.assignment_id === run.assignment_id &&
        r.started_at &&
        Number(r.id.slice(2)) > Number(run.id.slice(2)),
    )
  );
}

/** Host supplies durable delivery attempt counts; business eligibility is rechecked here. */
export function recoverDispatch(
  state: CommandState,
  actor: Actor,
  p: {
    run_id: RunId;
    timeout_ms: number;
    failed_attempts: number;
    max_failures: number;
    provider_failure_threshold?: number;
    provider_cooldown_ms?: number;
    stopped_runtime?: RuntimeRef | null;
    stop_failed?: boolean;
    stop_id?: string;
  },
  ports: CommandPorts,
) {
  return command(state, actor, "recover_dispatch", ports, (d) => {
    ensure(
      [p.timeout_ms, p.max_failures].every(
        (n) => Number.isSafeInteger(n) && n > 0,
      ) &&
        Number.isSafeInteger(p.failed_attempts) &&
        p.failed_attempts >= 0,
      "validation_failed",
      "Invalid dispatch recovery policy",
    );
    const run = d.get("runs", p.run_id),
      a = d.get("assignments", run.assignment_id);
    const sourceCard = assignmentCardId(a, state, run.trigger_event_id);
    const card = sourceCard ? d.get("cards", sourceCard) : undefined;
    if (hostOpsPending(state.events, a.id)) return;
    const policy = recoveryPolicy(state, run);
    const reviewWake = reviewRunWakeDisposition(state, a, run);
    const targetCurrent =
      !reviewWake && (!policy || recoveryTargetCurrent(state, run));
    const stop = run.dispatch_stop;
    if (p.stop_id !== undefined && stop?.attempt_id !== p.stop_id) return;
    const stopping = !!(p.stop_id && stop?.stopping);
    if (reviewWake === "paused" && !stopping) return;
    const exitRecovery = stop?.reason === "runtime_exited";
    if (exitRecovery && !policy) return;
    const stopped = stopping && "stopped_runtime" in p;
    const startupFailed = dispatchRecoveryFailed(state, run);
    if (stopping) {
      if (
        policy &&
        JSON.stringify(a.runtime_ref) !== JSON.stringify(stop?.runtime_ref)
      )
        return;
      ensure(
        JSON.stringify(a.runtime_ref) === JSON.stringify(stop?.runtime_ref),
        "invariant_violation",
        "Stopped terminal reference changed",
      );
    } else if (
      a.status !== "active" ||
      (card?.hold && run.status === "queued") ||
      run.started_at ||
      (!["dispatched"].includes(run.status) &&
        !startupFailed &&
        !(run.status === "queued" && dispatchRecoveryQueuedAt(state, run))) ||
      (card && ["done", "cancelled"].includes(card.status))
    )
      return;
    const started =
      dispatchedAt(state, run) ??
      dispatchRecoveryQueuedAt(state, run) ??
      (exitRecovery ? run.started_at : undefined);
    if (!started) return;
    const elapsed =
      Date.parse(d.now) -
      Date.parse(started) -
      dispatchTargetWaitMs(run, d.now);
    // C-600: a session proven to lack native Card tools needs no timeout.
    const mcpMissing =
      run.status === "dispatched" && !run.started_at && mcpSessionMissing(a);
    const reason = startupFailed
      ? "recovery_startup_failed"
      : stopping
        ? stop?.reason
        : mcpMissing
          ? "mcp_unavailable"
          : elapsed >= p.timeout_ms
            ? "dispatch_timeout"
            : p.failed_attempts >= p.max_failures
              ? "delivery_retry_exhausted"
              : undefined;
    if (!reason) return;
    // C-600: a session without Card tools settles only through its own stop
    // fence and exit proof, never by escalation that leaves it running.
    if (reason === "mcp_unavailable" && !stopping) return;
    // A prior unconfirmed-stop alert cannot prevent later exit settlement.
    if (
      !stopped &&
      state.events.some(
        (e) =>
          e.type === "run_dispatch_stalled" &&
          field(e.payload, "run_id") === run.id,
      )
    )
      return;
    const restart = reason === "server_restart";
    const provider = reason === "provider_unavailable";
    const recovered =
      !provider &&
      ((!restart && dispatchRecoveryUsed(state.events, a.id)) ||
        recoveryChainUsed(state, run));
    const unreadable = unreadableCommentTrigger(state, run);
    // C-600: a session without Card tools is never left running, also once
    // its single rebuild is spent: the confirmed stop settles it as a failed
    // start before the escalation below.
    const mcp = reason === "mcp_unavailable";
    // Report the whole recovery episode without changing this Run's timeout.
    const recovery = state.events.find(
      (e) =>
        e.type === "run_dispatch_recovered" &&
        field(e.payload, "replacement_run_id") === run.id,
    );
    const original = state.runs.find(
      (r) =>
        r.id === field(recovery?.payload, "run_id") && r.assignment_id === a.id,
    );
    const waitingSince = (original && dispatchedAt(state, original)) ?? started;
    const waitedMs = Date.parse(d.now) - Date.parse(waitingSince);
    const minutes = Math.max(0, Math.floor(waitedMs / 60000));
    const context = `${card ? `${card.id}「${card.title}」` : "项目常驻任务"}的 ${a.id}（${run.id}）派发后已等待 ${minutes} 分钟，${exitRecovery ? "原终端已异常退出" : startupFailed ? "自动恢复后的启动失败" : "仍未开始工作"}`;
    if (
      (!recovered ||
        unreadable ||
        reviewWake === "obsolete" ||
        (stopped && (policy || mcp))) &&
      !p.stop_failed &&
      !startupFailed
    ) {
      ensure(
        stopped &&
          JSON.stringify(p.stopped_runtime) ===
            JSON.stringify(stop?.runtime_ref),
        "validation_failed",
        "Automatic recovery requires a started stop fence and confirmed terminal exit",
      );
      const { dispatch_stop: _stop, ...unfenced } = run;
      if (finished(run)) d.put("runs", unfenced);
      else {
        const cancelled = cancelRunDispatch(
          d,
          unfenced,
          provider
            ? "模型服务不可用，未开工。"
            : unreadable
              ? `${context}；无权读取触发评论所在卡片，确认终端退出后取消，不再重排。`
              : reviewWake
                ? `${context}；审核目标已暂停或变更，确认终端退出后不再重排。`
                : mcp && recovered
                  ? `${context}；${MCP_SESSION_FAILURE}，已确认终端退出，记为启动失败，不再重排。`
                  : `${context}；${dispatchReasonText(reason)}，确认终端退出后自动重排一次。`,
        );
        if (mcp)
          d.put("runs", { ...cancelled, failure_reason: "mcp_unavailable" });
        if (provider) {
          d.put("runs", {
            ...cancelled,
            failure_reason: "provider_unavailable",
          });
          recordProviderFailure(
            d,
            run,
            p.provider_failure_threshold ?? DEFAULT_PROVIDER_FAILURES,
            p.provider_cooldown_ms ?? DEFAULT_PROVIDER_COOLDOWN_MS,
          );
        }
      }
      // Preserve any host-recorded terminal outcome, but always settle credentials.
      if (["unknown", "lost"].includes(a.runtime_state))
        d.put("assignments", {
          ...a,
          runtime_state: unwrap(
            transition("runtime", a.runtime_state, "session_replaced"),
          ),
          runtime_ref: null,
        });
      else if (a.runtime_state === "idle")
        d.put("assignments", { ...a, runtime_ref: null });
      d.emit("run_dispatch_stop_finished", card?.id, {
        run_id: run.id,
        assignment_id: a.id,
        attempt_id: stop?.attempt_id ?? "",
        cancelled: !finished(run),
      });
      if (unreadable) {
        const body = `${a.id}（${run.id}）无权读取触发评论所在卡片 ${unreadable.card_id}，已确认旧终端退出并收尾，不再重排。`;
        d.emit(
          "run_unreadable_trigger_cancelled",
          unreadable.card_id,
          {
            run_id: run.id,
            assignment_id: a.id,
            source_event_id: unreadable.id,
            reason: "recipient_cannot_read_card",
          },
          { type: "system", body, run_id: run.id },
        );
        return;
      }
      if (
        finished(run) ||
        !targetCurrent ||
        card?.hold ||
        (exitRecovery && !c3ExitCandidate(state, run)) ||
        a.status !== "active" ||
        !hasRunTarget(a, d.state) ||
        (card && ["done", "cancelled"].includes(card.status))
      )
        return;
      ensure(
        !d
          .list("runs")
          .some(
            (r) =>
              r.id !== run.id &&
              r.assignment_id === a.id &&
              !standingRunDormant(a, r) &&
              !canParkForDiscussion(state, a, r, run) &&
              (!finished(r) ||
                r.dispatch_stop ||
                r.inactivity_stop ||
                (r.launch_publication &&
                  !["started", "exited"].includes(r.launch_publication.phase))),
          ),
        "invariant_violation",
        "Assignment already has another unfinished Run",
      );
      if (!recovered) {
        if (policy && a.scope === "work_item")
          checkEmployeeSeparation(d, d.work(a.work_item_id), a.employee_id);
        const id = d.ids.next(state.project_id, "run");
        const body = provider
          ? `${context}；模型服务不可用，已排队重试（${id}），不计开工或返工。`
          : restart
            ? `${context}；服务重启后核对发现终端已不存在，已取消旧执行并重排为 ${id}。不占用此 Assignment 的自动恢复机会。${policy ? "本业务根链的一次后继额度已使用。" : ""}`
            : `${context}；${reason === "mcp_unavailable" ? `${MCP_SESSION_FAILURE}，` : ""}已取消旧执行并自动重排为 ${id}（新会话）。此 Assignment 的自动恢复机会已使用。`;
        const event = d.emit(
          "run_dispatch_recovered",
          card?.id,
          {
            assignment_id: a.id,
            run_id: run.id,
            replacement_run_id: id,
            reason,
            original_trigger_event_id: run.trigger_event_id,
            waited_ms: elapsed,
            ...(policy
              ? {
                  recovery_root_run_id: policy.root_run_id,
                  recovery_policy: policy.version,
                  exit_evidence: stop?.runtime_ref
                    ? {
                        machine_id: stop.runtime_ref.machine_id,
                        terminal_ref: stop.runtime_ref.terminal_ref,
                        target: stop.runtime_ref.target
                          ? { ...stop.runtime_ref.target }
                          : null,
                        launch_generation: stop.runtime_ref.launch_generation
                          ? { ...stop.runtime_ref.launch_generation }
                          : null,
                      }
                    : null,
                }
              : {}),
            body,
          },
          { type: "system", body, run_id: run.id },
        );
        const next: Run = {
          id,
          assignment_id: a.id,
          trigger_event_id: event.id,
          kind: run.kind,
          status: "queued",
          ...(provider
            ? { queue_reason: "provider_unavailable" as const }
            : {}),
          ...(policy ? { recovery_policy: policy } : {}),
          model: run.model,
          ...launchSettings(run),
          role_version: run.role_version,
          agent_cli_version: run.agent_cli_version,
          outcome: null,
          summary: "",
          ...(run.employee_id ? { employee_id: run.employee_id } : {}),
          ...(run.launch_profile_ref
            ? { launch_profile_ref: run.launch_profile_ref }
            : {}),
        };
        d.put("runs", next);
        return next;
      }
    }
    const body = `${context}；${mcp ? `${MCP_SESSION_FAILURE}，${stopped && !p.stop_failed ? "已确认终端退出并记为启动失败，" : ""}` : ""}${p.stop_failed ? "无法确认旧终端已停止，已保留原 Run 和凭据，暂不重排" : "已自动恢复过一次，仍未成功"}。请检查${mcp ? "该机器到 Card MCP 的网络路径（可运行机器检查，含系统代理）、" : ""}终端与服务，必要时执行 cardigan assignment stop ${a.id}，再执行 cardigan assignment start ${a.id}，并回报处理结果。`;
    // C-600: settling a session without Card tools after an earlier report
    // for this Run (e.g. an unconfirmed stop) reports nothing twice.
    if (
      mcp &&
      state.events.some(
        (e) =>
          e.type === "run_dispatch_stalled" &&
          field(e.payload, "run_id") === run.id,
      )
    )
      return;
    const ops = state.assignments.find(
      (candidate) =>
        candidate.status === "active" &&
        candidate.scope === "standing" &&
        candidate.role_id === "pm" &&
        candidate.standing_mode === "ops" &&
        candidate.id !== a.id,
    );
    d.emit(
      "run_dispatch_stalled",
      card?.id,
      {
        assignment_id: a.id,
        run_id: run.id,
        reason,
        waited_ms: waitedMs,
        body,
        audience: ops ? "pm_ops" : "needs_you",
        ...(policy ? { recovery_root_run_id: policy.root_run_id } : {}),
      },
      { type: "system", body, run_id: run.id },
    );
    // C-600: Needs You always learns of a session without Card tools, also
    // when PM Ops owns the follow-up.
    if (mcp)
      d.emit("mcp_session_failed", card?.id, {
        assignment_id: a.id,
        run_id: run.id,
        notice: body,
      });
    if (!ops) {
      const id = d.ids.next(state.project_id, "human_action");
      d.put("human_actions", {
        id,
        key: id,
        requested_by: "system",
        status: "open",
        ...(card ? { card_id: card.id } : {}),
        blocked_work_items: [],
        instructions: body,
        why_human:
          "自动恢复仍失败，当前没有可接手的 PM Ops，需要主机管理员检查运行环境。",
        expected_return: "说明处理结果并标记完成",
      });
      d.emit(
        "human_action_requested",
        card?.id,
        {
          human_action_id: id,
          blocked_work_items: [],
          dispatch_run_id: run.id,
          dispatch_reason: reason,
          ...(policy ? { recovery_root_run_id: policy.root_run_id } : {}),
        },
        { type: "human_action", body, human_action_id: id },
      );
    }
  });
}

/** Escalation notifications refer to the source Run, not the PM Run that reads them. */
export function obsoleteDispatchAttention(
  state: CommandState,
  note: Notification,
): boolean {
  if (["acked", "resolved"].includes(note.status)) return false;
  const event = eventById(state.events, note.event_id);
  const diagnostic = [
    "run_inactive",
    "run_dispatch_stalled",
    "bell_delivery_failed",
    "bell_retry_exhausted",
  ].includes(event?.type ?? "");
  const runId = diagnostic ? field(event?.payload, "run_id") : note.run_id;
  // C-244: keyed per Run snapshot; same first match as runs.find.
  const run = runById(state.runs, runId);
  if (
    !diagnostic &&
    !["needs_attention", "delivery_failed"].includes(note.status) &&
    run?.status !== "cancelled"
  )
    return false;
  const assignmentId = diagnostic
    ? field(event?.payload, "assignment_id")
    : (run?.assignment_id ??
      (note.recipient.kind === "assignment"
        ? note.recipient.assignment_id
        : undefined));
  const a = state.assignments.find((a) => a.id === assignmentId);
  if (
    run &&
    (!!field(event?.payload, "recovery_root_run_id") ||
      ["recovery_startup_failed", "runtime_exited"].includes(
        String(field(event?.payload, "reason")),
      )) &&
    // Only the failed Assignment's own diagnostic marker retires with its Run.
    // Other recipients still need to handle the unresolved startup failure.
    (note.recipient.kind !== "assignment" ||
      note.recipient.assignment_id !== run.assignment_id)
  )
    return startupFailureResolved(state, run);
  return (
    a?.status === "released" ||
    !!(
      run &&
      (finished(run) ||
        (event?.type === "run_dispatch_stalled" && run.status === "running"))
    )
  );
}

export function resolveDispatchAttention(
  state: CommandState,
  actor: Actor,
  ports: CommandPorts,
) {
  return command(state, actor, "resolve_dispatch_attention", ports, (d) => {
    for (const action of state.human_actions) {
      if (action.requested_by !== "system" || action.status !== "open")
        continue;
      const source = state.events.find(
        (e) =>
          e.type === "human_action_requested" &&
          field(e.payload, "human_action_id") === action.id,
      );
      const run = state.runs.find(
        (r) => r.id === field(source?.payload, "dispatch_run_id"),
      );
      if (!run) continue;
      const a = d.get("assignments", run.assignment_id);
      if (
        field(source?.payload, "recovery_root_run_id") ||
        ["recovery_startup_failed", "runtime_exited"].includes(
          String(field(source?.payload, "dispatch_reason")),
        )
      ) {
        if (!startupFailureResolved(state, run)) continue;
      } else if (
        a.status !== "released" &&
        !finished(run) &&
        run.status !== "running"
      )
        continue;
      d.put("human_actions", { ...action, status: "cancelled" });
      d.emit(
        "dispatch_attention_resolved",
        action.card_id,
        { human_action_id: action.id, run_id: run.id },
        {
          type: "system",
          body: `${a.id} 的派发告警已解除，自动关闭过期的处理提醒。`,
          human_action_id: action.id,
        },
      );
    }
  });
}

/** A queued automatic successor owns no terminal; callers exclude all in-flight launch/bell intents. */
export function retireRecoveryQueuedRun(
  state: CommandState,
  actor: Actor,
  p: { run_id: RunId },
  ports: CommandPorts,
) {
  return command(state, actor, "recover_dispatch", ports, (d) => {
    const run = d.get("runs", p.run_id),
      policy = recoveryPolicy(state, run);
    if (
      !policy ||
      policy.root_run_id === run.id ||
      run.status !== "queued" ||
      run.dispatch_stop ||
      run.inactivity_stop ||
      (run.launch_publication &&
        !["started", "exited"].includes(run.launch_publication.phase)) ||
      recoveryTargetCurrent(state, run)
    )
      return;
    const body =
      "自动恢复排队后原业务目标或执行资格已变化，已取消该后继；额度不退还，请核对后续工作。";
    // No terminal belongs to a queued successor; never touch a newer session's credentials/ref.
    const { queue_reason: _queue, ...rest } = run;
    d.put("runs", {
      ...rest,
      status: unwrap(transition("run", run.status, "cancel")),
      outcome: "failed",
      summary: body,
      finished_at: d.now,
    });
    const ops = state.assignments.some(
      (a) =>
        a.scope === "standing" &&
        a.role_id === "pm" &&
        a.standing_mode === "ops" &&
        a.status === "active",
    );
    d.emit(
      "run_recovery_abandoned",
      policy.card_id,
      {
        run_id: run.id,
        assignment_id: run.assignment_id,
        recovery_root_run_id: policy.root_run_id,
        reason: "recovery_target_unavailable",
        audience: ops ? "pm_ops" : "needs_you",
        body,
      },
      { type: "system", body, run_id: run.id },
    );
  });
}
