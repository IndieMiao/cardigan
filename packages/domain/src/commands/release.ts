import type { Actor, Decision, RuntimeRef } from "../entities.js";
import type { Result } from "../errors.js";
import { hostOpsPending } from "../host-ops.js";
import type { AssignmentId, RunId } from "../ids.js";
import { transition } from "../transitions.js";
import {
  type CommandEffect,
  type CommandPorts,
  type CommandState,
  command,
  ensure,
  text,
  unwrap,
} from "./core.js";
import { neverDispatchedQueue } from "./failed-placement.js";
import { cancelRunDispatch } from "./launch.js";
import { handoffWithoutOps } from "./ops-handoff.js";
import { WORKTREE_CLEANUP_PLAIN_SUMMARY } from "./plain-summary.js";

export function releaseAssignment(
  state: CommandState,
  actor: Actor,
  p: { assignment_id: AssignmentId; cancel_queued_run_id?: RunId },
  ports: CommandPorts,
) {
  return command(state, actor, "release_assignment", ports, (d) => {
    ensure(
      actor.kind !== "assignment" ||
        (d.assignment?.scope === "standing" &&
          d.assignment.standing_mode === "ops" &&
          actor.role_id === "pm" &&
          !actor.allowed_tools.includes("record_decision")),
      "unauthorized",
      "Only the human, system or PM Ops can release assignments",
    );
    const a = d.get("assignments", p.assignment_id);
    ensure(
      !hostOpsPending(state.events, a.id),
      "illegal_transition",
      "A host operation is pending",
    );
    ensure(
      a.scope === "work_item" || actor.kind === "human",
      "unauthorized",
      "Only the human can release standing assignments",
    );
    const card =
      a.scope === "work_item"
        ? d.card(d.work(a.work_item_id).card_id)
        : undefined;
    ensure(
      actor.kind !== "system" ||
        (card && ["done", "cancelled"].includes(card.status)),
      "illegal_transition",
      "Automatic release requires a closed work-item card",
    );
    if (p.cancel_queued_run_id !== undefined) {
      const run = d.get("runs", p.cancel_queued_run_id);
      ensure(
        actor.kind !== "system" &&
          a.scope === "work_item" &&
          !a.external &&
          a.status === "active" &&
          ["not_provisioned", "idle"].includes(a.runtime_state) &&
          !a.runtime_ref &&
          !a.session_ref &&
          !a.worktree_path &&
          !a.branch &&
          !a.base_sha &&
          run.assignment_id === a.id &&
          run.status === "queued" &&
          card !== undefined &&
          neverDispatchedQueue(d, run, card.id) &&
          ports.unreservedAssignment?.(state.project_id, a.id) === true,
        "illegal_transition",
        "只能取消从未派发、没有会话或启动占用的排队 Run；准备重试还须有清理记录。已有执行请走原停止流程。",
      );
      cancelRunDispatch(d, run, "取消未派发的排队 Run，释放指派以重新选机");
    }
    if (a.status === "released") {
      handoffWithoutOps(d, a);
      return a;
    }
    ensure(
      !d
        .list("runs")
        .some(
          (r) =>
            r.assignment_id === a.id &&
            (r.inactivity_stop ||
              r.dispatch_stop ||
              !["completed", "failed", "cancelled"].includes(r.status)),
        ),
      "illegal_transition",
      `Assignment ${a.id} 还有未结束的 Run；请先执行 cardigan assignment stop ${a.id}，再释放。`,
    );
    const next = {
      ...a,
      status: unwrap(transition("assignment", a.status, "release")),
      runtime_state: unwrap(transition("runtime", a.runtime_state, "release")),
      released_at: d.now,
    };
    d.put("assignments", next);
    d.emit(
      "assignment_released",
      card?.id,
      {
        assignment_id: a.id,
        ...(p.cancel_queued_run_id
          ? { cancelled_queued_run_id: p.cancel_queued_run_id }
          : {}),
        worktree_path: a.worktree_path ?? null,
        branch: a.branch ?? null,
        token_id: a.mcp_token_id,
        runtime_ref: a.runtime_ref ? { ...a.runtime_ref } : null,
      },
      { type: "status_change", body: `Released ${a.id}` },
    );
    handoffWithoutOps(d, next);
    return next;
  });
}
/** Host-confirmed missing terminals; never a caller-supplied cleanup flag. */
export function clearReleasedRuntimeRefs(
  state: CommandState,
  actor: Actor,
  p: {
    readonly missing: readonly {
      readonly assignment_id: AssignmentId;
      readonly runtime_ref: RuntimeRef;
    }[];
  },
  ports: CommandPorts,
) {
  return command(state, actor, "clear_released_runtime_refs", ports, (d) => {
    for (const missing of p.missing) {
      const a = d.get("assignments", missing.assignment_id);
      // The observation predates this transaction. A changed owner/ref wins;
      // repeated observations and retries after a commit are harmless.
      if (
        a.status !== "released" ||
        JSON.stringify(a.runtime_ref) !== JSON.stringify(missing.runtime_ref)
      )
        continue;
      d.put("assignments", { ...a, runtime_ref: null });
      d.emit("assignment_terminal_cleaned", undefined, {
        assignment_id: a.id,
        runtime_ref: { ...missing.runtime_ref },
      });
    }
  });
}

export function requestWorktreeCleanup(
  state: CommandState,
  actor: Actor,
  p: { assignment_id: AssignmentId; reason: string },
  ports: CommandPorts,
): Result<CommandEffect<Decision>> {
  return command(state, actor, "request_worktree_cleanup", ports, (d) => {
    const a = d.get("assignments", p.assignment_id);
    ensure(
      a.status === "released" && a.worktree_path,
      "illegal_transition",
      "Cleanup requires a released Assignment with a worktree",
    );
    text(p.reason, "reason");
    const old = d
      .list("decisions")
      .find(
        (q) =>
          q.trigger === "worktree_cleanup" &&
          q.assignment_id === a.id &&
          ["open", "provisional", "resolved"].includes(q.status),
      );
    if (old) return old;
    const card =
      a.scope === "work_item"
        ? d.card(d.work(a.work_item_id).card_id)
        : undefined;
    const id = d.ids.next(state.project_id, "decision");
    const decision: Decision = {
      id,
      key: id,
      ...(card ? { card_id: card.id } : {}),
      raised_by: "system",
      trigger: "worktree_cleanup",
      assignment_id: a.id,
      kind: "choose",
      category: "data_deletion",
      question: `保留还是强制清理 ${a.id} 的工作区？`,
      context: p.reason,
      options: [
        {
          key: "keep",
          description: "保留工作区",
          impact: "保留本地文件",
        },
        {
          key: "force_clean",
          description: "备份并清理工作区",
          impact: "先保存补丁，再删除工作区文件",
        },
      ],
      recommended: "keep",
      plain_summary: { ...WORKTREE_CLEANUP_PLAIN_SUMMARY },
      affected_cards: card ? [card.id] : [],
      affected_work_items: [],
      blocking: false,
      decider: "human",
      doc_refs: [],
      status: "open",
    };
    d.put("decisions", decision);
    d.emit(
      "decision_requested",
      card?.id,
      { decision_id: id, assignment_id: a.id, affected_work_items: [] },
      { type: "decision_request", decision_id: id, body: decision.question },
    );
    return decision;
  });
}
