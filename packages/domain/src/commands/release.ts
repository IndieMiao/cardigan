import type {
  Actor,
  Assignment,
  Decision,
  Run,
  RuntimeRef,
} from "../entities.js";
import type { Result } from "../errors.js";
import { hostOpsPending } from "../host-ops.js";
import type { AssignmentId, CardId, RunId } from "../ids.js";
import { transition } from "../transitions.js";
import {
  type CommandDraft,
  type CommandEffect,
  type CommandPorts,
  type CommandState,
  command,
  ensure,
  text,
  unwrap,
} from "./core.js";
import {
  assignDecision,
  routeDelegatedWorktreeCleanups,
} from "./delegation.js";
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
      const refusal = cancelQueuedRunRefusal(
        d,
        actor,
        a,
        run,
        card?.id,
        () => ports.unreservedAssignment?.(state.project_id, a.id) === true,
      );
      ensure(refusal === undefined, "illegal_transition", refusal ?? "");
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
/**
 * Only a never-dispatched queue without a session or launch reservation may be
 * cancelled to reselect the machine. C-624: say which condition failed and
 * what the operator can run next, instead of one catch-all sentence.
 */
function cancelQueuedRunRefusal(
  d: CommandDraft,
  actor: Actor,
  a: Assignment,
  run: Run,
  card: CardId | undefined,
  unreserved: () => boolean,
): string | undefined {
  if (
    actor.kind === "system" ||
    a.scope !== "work_item" ||
    a.external ||
    a.status !== "active" ||
    card === undefined
  )
    return `${a.id} 不是在岗的工作项指派，不能用 --cancel-queued-run 取消排队 Run。`;
  if (run.assignment_id !== a.id || run.status !== "queued")
    return `${run.id} 不是 ${a.id} 的排队 Run（当前状态 ${run.status}），没有可取消的排队。`;
  if (
    !["not_provisioned", "idle"].includes(a.runtime_state) ||
    a.runtime_ref ||
    a.session_ref ||
    a.worktree_path ||
    a.branch ||
    a.base_sha ||
    !neverDispatchedQueue(d, run, card)
  )
    return `${a.id} 已有会话、工作区或派发记录，${run.id} 不能取消后改派到别的机器。要放弃 ${run.id}：先执行 cardigan assignment stop ${a.id}（取消排队的 Run，保留工作区），再执行 cardigan assignment release ${a.id}；要让它继续：执行 cardigan assignment start ${a.id}。`;
  if (!unreserved())
    return `${a.id} 正在启动（有未结束的启动记录，或资源租约还没完成释放核验），${run.id} 暂不能取消；等这次启动结束后重试。`;
  return undefined;
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
  p: {
    assignment_id: AssignmentId;
    reason: string;
    /**
     * C-664: the host-observed directory of a released work-item record that
     * lost its path, located by project, machine and id. It is recorded so
     * the decision and every later round name the same worktree.
     */
    worktree_path?: string;
  },
  ports: CommandPorts,
): Result<CommandEffect<Decision>> {
  return command(state, actor, "request_worktree_cleanup", ports, (d) => {
    let a = d.get("assignments", p.assignment_id);
    ensure(
      a.status === "released" && (a.worktree_path || p.worktree_path),
      "illegal_transition",
      "Cleanup requires a released Assignment with a worktree",
    );
    text(p.reason, "reason");
    if (p.worktree_path !== undefined) {
      const path = p.worktree_path;
      ensure(
        a.scope === "work_item" &&
          path.startsWith("/") &&
          !path.split("/").some((part) => part === "." || part === "..") &&
          path.split("/").at(-1) === a.id &&
          (a.worktree_path === undefined || a.worktree_path === path),
        "invariant_violation",
        "Observed worktree must be this work-item Assignment's own directory",
      );
      if (a.worktree_path === undefined) {
        a = { ...a, worktree_path: path };
        d.put("assignments", a);
      }
    }
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
    // C-747: routed like any data_deletion question; delegated to PM when
    // the project authorized it and PM Ops can take it.
    const decision: Decision = assignDecision(d, {
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
    });
    d.put("decisions", decision);
    const delegated = decision.decider === "role:pm";
    d.emit(
      "decision_requested",
      card?.id,
      {
        decision_id: id,
        assignment_id: a.id,
        affected_work_items: [],
        ...(delegated
          ? {
              routed_to: decision.decider,
              routing_reason: decision.delegation_authority ?? null,
            }
          : {}),
      },
      {
        type: "decision_request",
        decision_id: id,
        body: delegated
          ? `${decision.question}\n已按常驻授权转给 PM`
          : decision.question,
      },
    );
    return decision;
  });
}

/**
 * C-747: the cleanup loop moves open worktree cleanup questions to PM once
 * the project delegates data_deletion and PM Ops is active. This covers
 * questions raised before C-747 (moved after deployment, e.g. Q-1370) and
 * ones raised while PM Ops was unavailable. No change when nothing moves.
 */
export function routeWorktreeCleanupDecisions(
  state: CommandState,
  actor: Actor,
  ports: CommandPorts,
) {
  return command(state, actor, "request_worktree_cleanup", ports, (d) => {
    ensure(
      actor.kind === "system",
      "unauthorized",
      "Only the cleanup loop routes worktree cleanup questions",
    );
    return routeDelegatedWorktreeCleanups(
      d,
      "已按“删除数据”的常驻授权，将待处理的工作区清理拍板转给 PM 代拍。",
    );
  });
}
