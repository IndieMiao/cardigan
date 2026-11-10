import type { Actor, Decision } from "../entities.js";
import type { Result } from "../errors.js";
import type { AssignmentId } from "../ids.js";
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
import { handoffWithoutOps } from "./delegation.js";

export function releaseAssignment(
  state: CommandState,
  actor: Actor,
  p: { assignment_id: AssignmentId },
  ports: CommandPorts,
) {
  return command(state, actor, "release_assignment", ports, (d) => {
    ensure(
      actor.kind !== "assignment" ||
        (d.assignment?.scope === "standing" &&
          actor.role_id === "pm" &&
          !actor.allowed_tools.includes("record_decision")),
      "unauthorized",
      "Only the human, system or PM Ops can release assignments",
    );
    const a = d.get("assignments", p.assignment_id);
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
              !["completed", "failed", "cancelled"].includes(r.status)),
        ),
      "illegal_transition",
      "Assignment has an unfinished Run",
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
