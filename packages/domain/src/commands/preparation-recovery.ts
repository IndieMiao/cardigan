import { assignmentCardId } from "../card-hold.js";
import type { Actor, Run, RuntimeRef } from "../entities.js";
import { eventsOfType, eventsOfTypes } from "../event-index.js";
import { automaticContextActionForRun, hostOpsPending } from "../host-ops.js";
import type { RunId } from "../ids.js";
import {
  recoveryChainUsed,
  recoveryPolicy,
  recoveryTargetCurrent,
} from "../run-recovery.js";
import {
  type CommandPorts,
  type CommandState,
  command,
  ensure,
} from "./core.js";
import { unreadableCommentTrigger } from "./dispatch-recovery.js";
import { checkEmployeeSeparation } from "./employee-assignment.js";
import { launchSettings } from "./launch.js";
import { stoppedByHuman } from "./stop-state.js";

/** Host-only settlement after preparation failed, before any token/provision. */
export function recoverPreparation(
  state: CommandState,
  actor: Actor,
  p: {
    run_id: RunId;
    category: string;
    execution_exited: boolean;
    cleanup_complete: boolean;
    expected_runtime_ref: RuntimeRef | null;
    backoff_ms: number;
  },
  ports: CommandPorts,
) {
  return command(state, actor, "recover_dispatch", ports, (d) => {
    ensure(
      Number.isSafeInteger(p.backoff_ms) &&
        p.backoff_ms > 0 &&
        p.backoff_ms <= 2_147_483_647,
      "validation_failed",
      "Invalid preparation backoff",
    );
    const run = d.get("runs", p.run_id),
      a = d.get("assignments", run.assignment_id);
    if (
      automaticContextActionForRun(state.events, run) ||
      unreadableCommentTrigger(state, run)
    )
      return;
    const recorded = eventsOfTypes(state.events, [
      "run_preparation_recovered",
      "run_preparation_stalled",
    ]).find((e) => (e.payload as { run_id?: string }).run_id === run.id);
    if (recorded) return;
    const sourceCard = assignmentCardId(a, state, run.trigger_event_id);
    const card = sourceCard ? d.get("cards", sourceCard) : undefined;
    const item =
      a.scope === "work_item" ? d.get("work_items", a.work_item_id) : undefined;
    if (
      card?.hold ||
      a.external ||
      a.status !== "active" ||
      run.status !== "cancelled" ||
      run.started_at ||
      run.dispatch_stop ||
      run.inactivity_stop ||
      hostOpsPending(state.events, a.id) ||
      stoppedByHuman(state.events, a.id) ||
      (card && ["done", "cancelled"].includes(card.status)) ||
      JSON.stringify(a.runtime_ref) !==
        JSON.stringify(p.expected_runtime_ref) ||
      a.role_version !== run.role_version ||
      (item && (item.assignment_id !== a.id || item.role_id !== a.role_id)) ||
      !eventsOfType(state.events, "run_dispatch_aborted").some(
        (e) =>
          (e.payload as { run_id?: string; reason?: string }).run_id ===
            run.id &&
          (e.payload as { reason?: string }).reason ===
            "directory preparation failed",
      ) ||
      state.runs.some(
        (r) =>
          r.assignment_id === a.id &&
          r.id !== run.id &&
          (Number(r.id.slice(2)) > Number(run.id.slice(2)) ||
            !["completed", "failed", "cancelled"].includes(r.status) ||
            r.dispatch_stop ||
            r.inactivity_stop),
      )
    )
      return;
    const policy = recoveryPolicy(state, run);
    if (policy && !recoveryTargetCurrent(state, run)) return;
    const retryable =
      (p.execution_exited &&
        p.cleanup_complete &&
        [
          "preparation_queue_timeout",
          "repository_lock_timeout",
          "git_lock_conflict",
          "git_network",
          "git_timeout",
        ].includes(p.category)) ||
      !!(
        policy &&
        p.category === "runtime_unavailable" &&
        p.execution_exited &&
        p.cleanup_complete &&
        p.expected_runtime_ref === null
      );
    if (retryable && !run.preparation_retry && !recoveryChainUsed(state, run)) {
      if (policy && a.scope === "work_item")
        checkEmployeeSeparation(d, d.work(a.work_item_id), a.employee_id);
      const id = d.ids.next(state.project_id, "run");
      const ready_at = new Date(Date.parse(d.now) + p.backoff_ms).toISOString();
      const body = `工作目录准备暂时失败，已排队为 ${id}，退避后自动再试一次。`;
      const event = d.emit(
        "run_preparation_recovered",
        card?.id,
        {
          run_id: run.id,
          assignment_id: a.id,
          replacement_run_id: id,
          original_trigger_event_id: run.trigger_event_id,
          category: p.category,
          ready_at,
          ...(policy
            ? {
                recovery_root_run_id: policy.root_run_id,
                recovery_policy: policy.version,
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
        ...(policy ? { recovery_policy: policy } : {}),
        role_version: run.role_version,
        model: run.model,
        agent_cli_version: run.agent_cli_version,
        ...launchSettings(run),
        ...(run.employee_id ? { employee_id: run.employee_id } : {}),
        ...(run.launch_profile_ref
          ? { launch_profile_ref: run.launch_profile_ref }
          : {}),
        preparation_retry: { source_run_id: run.id, ready_at },
        outcome: null,
        summary: "",
      };
      d.put("runs", next);
      return next;
    }
    // Do not silently retry permission/path failures or an uncertain remote process.
    const body = `工作目录准备失败（${p.category}），${run.preparation_retry ? "一次自动重试已用尽" : "未满足安全重试条件"}；请主机运维核查。`;
    d.emit(
      "run_preparation_stalled",
      card?.id,
      {
        run_id: run.id,
        assignment_id: a.id,
        category: p.category,
        body,
        ...(policy ? { recovery_root_run_id: policy.root_run_id } : {}),
      },
      { type: "system", body, run_id: run.id },
    );
    const id = d.ids.next(state.project_id, "human_action");
    d.put("human_actions", {
      id,
      key: id,
      requested_by: "system",
      status: "open",
      triage: "human",
      ...(card ? { card_id: card.id } : {}),
      blocked_work_items: [],
      instructions: body,
      why_human: "准备失败未能自动恢复，需要核查主机执行状态。",
      expected_return: "核实旧执行退出，说明恢复结果并标记完成",
    });
    d.emit(
      "human_action_requested",
      card?.id,
      {
        human_action_id: id,
        blocked_work_items: [],
        preparation_run_id: run.id,
      },
      { type: "human_action", body, human_action_id: id },
    );
  });
}
