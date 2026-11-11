import type { Actor, Run, RuntimeRef } from "../entities.js";
import type { RunId } from "../ids.js";
import type { Notification } from "../notification.js";
import { hasRunTarget } from "../run-target.js";
import { transition } from "../transitions.js";
import {
  type CommandPorts,
  type CommandState,
  command,
  ensure,
  unwrap,
} from "./core.js";
import { cancelRunDispatch, launchSettings } from "./launch.js";
import { dispatchTargetWaitMs } from "./run-target-wait.js";

const field = (payload: unknown, name: string): unknown =>
  payload && typeof payload === "object"
    ? (payload as Record<string, unknown>)[name]
    : undefined;
const finished = (run: Run) =>
  ["completed", "failed", "cancelled"].includes(run.status);
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

export const dispatchRecoveryFailed = (state: CommandState, run: Run) =>
  !run.started_at &&
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
    const card =
      a.scope === "work_item"
        ? d.get("cards", d.get("work_items", a.work_item_id).card_id)
        : undefined;
    const stop = run.dispatch_stop;
    if (p.stop_id !== undefined && stop?.attempt_id !== p.stop_id) return;
    const stopping = !!(p.stop_id && stop?.stopping);
    const stopped = stopping && "stopped_runtime" in p;
    const startupFailed = dispatchRecoveryFailed(state, run);
    if (stopping) {
      ensure(
        JSON.stringify(a.runtime_ref) === JSON.stringify(stop?.runtime_ref),
        "invariant_violation",
        "Stopped terminal reference changed",
      );
    } else if (
      a.status !== "active" ||
      run.started_at ||
      (!["dispatched"].includes(run.status) &&
        !startupFailed &&
        !(run.status === "queued" && dispatchRecoveryQueuedAt(state, run))) ||
      (card && ["done", "cancelled"].includes(card.status))
    )
      return;
    const started =
      dispatchedAt(state, run) ?? dispatchRecoveryQueuedAt(state, run);
    if (!started) return;
    const elapsed =
      Date.parse(d.now) -
      Date.parse(started) -
      dispatchTargetWaitMs(run, d.now);
    const reason = startupFailed
      ? "recovery_startup_failed"
      : stopping
        ? stop?.reason
        : elapsed >= p.timeout_ms
          ? "dispatch_timeout"
          : p.failed_attempts >= p.max_failures
            ? "delivery_retry_exhausted"
            : undefined;
    if (!reason) return;
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
    const recovered = state.events.some(
      (e) =>
        e.type === "run_dispatch_recovered" &&
        field(e.payload, "assignment_id") === a.id,
    );
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
    const context = `${card ? `${card.id}「${card.title}」` : "项目常驻任务"}的 ${a.id}（${run.id}）派发后已等待 ${minutes} 分钟，${startupFailed ? "自动恢复后的启动失败" : "仍未开始工作"}`;
    if (!recovered && !p.stop_failed && !startupFailed) {
      ensure(
        stopped &&
          JSON.stringify(p.stopped_runtime) ===
            JSON.stringify(stop?.runtime_ref),
        "validation_failed",
        "Automatic recovery requires a started stop fence and confirmed terminal exit",
      );
      const { dispatch_stop: _stop, ...unfenced } = run;
      if (finished(run)) d.put("runs", unfenced);
      else
        cancelRunDispatch(
          d,
          unfenced,
          `${context}；${reason}，确认终端退出后自动重排一次。`,
        );
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
      if (
        finished(run) ||
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
              (!finished(r) || r.dispatch_stop || r.inactivity_stop),
          ),
        "invariant_violation",
        "Assignment already has another unfinished Run",
      );
      const id = d.ids.next(state.project_id, "run");
      const body = `${context}；已取消旧执行并自动重排为 ${id}。此 Assignment 的自动恢复机会已使用。`;
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
    const body = `${context}；${p.stop_failed ? "无法确认旧终端已停止，已保留原 Run 和凭据，暂不重排" : "已自动恢复过一次，仍未成功"}。请检查终端与服务，必要时执行 cardigan assignment stop ${a.id}，再执行 cardigan assignment start ${a.id}，并回报处理结果。`;
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
      },
      { type: "system", body, run_id: run.id },
    );
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
  const event = state.events.find((e) => e.id === note.event_id);
  const diagnostic = [
    "run_inactive",
    "run_dispatch_stalled",
    "bell_delivery_failed",
    "bell_retry_exhausted",
  ].includes(event?.type ?? "");
  const runId = diagnostic ? field(event?.payload, "run_id") : note.run_id;
  const run = state.runs.find((r) => r.id === runId);
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
    field(event?.payload, "reason") === "recovery_startup_failed" &&
    note.recipient.kind !== "assignment"
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
        field(source?.payload, "dispatch_reason") === "recovery_startup_failed"
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
