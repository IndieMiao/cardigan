import type {
  Actor,
  Decision,
  HumanAction,
  Run,
  RuntimeRef,
} from "../entities.js";
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
import { handoffWithoutOps } from "./delegation.js";
import { WORKTREE_CLEANUP_PLAIN_SUMMARY } from "./plain-summary.js";

/** Preserve a provisioned target even when dispatch failed before publishing its ref. */
export function retainUnconfirmedLaunch(
  state: CommandState,
  actor: Actor,
  p: { run_id: RunId } & (
    | { runtime_ref: RuntimeRef }
    | { provision_intent: NonNullable<Run["unconfirmed_provision"]> }
  ),
  ports: CommandPorts,
) {
  return command(state, actor, "retain_unconfirmed_launch", ports, (d) => {
    const run = d.get("runs", p.run_id);
    if (run.unconfirmed_runtime_ref || run.unconfirmed_provision) return;
    const scope = "runtime_ref" in p ? p.runtime_ref : p.provision_intent;
    const retained =
      "runtime_ref" in p
        ? { unconfirmed_runtime_ref: p.runtime_ref }
        : { unconfirmed_provision: p.provision_intent };
    d.put("runs", { ...run, ...retained });
    d.emit("run_launch_exit_unconfirmed", undefined, {
      run_id: run.id,
      assignment_id: run.assignment_id,
      ...("runtime_ref" in p
        ? { runtime_ref: { ...p.runtime_ref } }
        : { provision_intent: { ...p.provision_intent } }),
      reason: "launch_cleanup_unconfirmed",
    });
    const a = d.get("assignments", run.assignment_id);
    if (a.scope === "work_item") {
      const card = d.work(a.work_item_id).card_id;
      const id = d.ids.next(state.project_id, "human_action");
      const action: HumanAction = {
        id,
        key: id,
        card_id: card,
        requested_by: d.author,
        instructions: `启动退出核实 ${a.id} ${run.id} ${JSON.stringify(scope)}\n保留原目标、容量、凭据及目录；请获授权操作员核实此精确启动范围和脱离进程，不得按名称扫杀。未取得终端引用时只能按原启动意图核实，不能虚构终端退出。`,
        why_human: "启动补偿未获得全部进程退出证明，不能清理或开始后继。",
        expected_return:
          "记录原目标和启动代次的可信核实结果；完成本待办不解除退出栅栏。",
        status: "open",
        triage: "human",
        blocked_work_items: [],
      };
      d.put("human_actions", action);
      d.emit(
        "human_action_requested",
        card,
        { human_action_id: id, blocked_work_items: [] },
        {
          type: "human_action",
          body: action.instructions,
          human_action_id: id,
        },
      );
    }
  });
}

/** Fixed host safety notice, never an Agent-supplied exit or deletion grant. */
export function requestRuntimeExitInspection(
  state: CommandState,
  actor: Actor,
  p: { assignment_id: AssignmentId; runtime_ref: RuntimeRef | null },
  ports: CommandPorts,
) {
  return command(
    state,
    actor,
    "request_runtime_exit_inspection",
    ports,
    (d) => {
      const a = d.get("assignments", p.assignment_id);
      if (
        a.scope !== "work_item" ||
        JSON.stringify(a.runtime_ref) !== JSON.stringify(p.runtime_ref)
      )
        return;
      const identity = `进程退出核实 ${a.id} ${JSON.stringify(a.runtime_ref)}`;
      // A completed notice does not manufacture evidence or permit deletion.
      if (
        d.list("human_actions").some((h) => h.instructions.startsWith(identity))
      )
        return;
      const card = d.work(a.work_item_id).card_id;
      const id = d.ids.next(state.project_id, "human_action");
      const action: HumanAction = {
        id,
        key: id,
        card_id: card,
        requested_by: d.author,
        instructions: `${identity}\n全部进程退出尚未获可信证明，保留工作区、构建目录及原清理归属。请获授权操作员核实原机器和启动代次的脱离进程及端口，不得按名称扫杀。`,
        why_human:
          "运行时不提供完整进程容器退出证据；终端消失或成功释放不能证明后台任务退出。",
        expected_return:
          "记录精确目标、启动代次及核实结果。完成本待办不自动授权删除目录或创建后继。",
        blocked_work_items: [],
        status: "open",
        triage: "human",
      };
      d.put("human_actions", action);
      d.emit(
        "human_action_requested",
        card,
        { human_action_id: id, blocked_work_items: [] },
        {
          type: "human_action",
          body: action.instructions,
          human_action_id: id,
        },
      );
    },
  );
}

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
            (r.unconfirmed_runtime_ref ||
              r.unconfirmed_provision ||
              r.inactivity_stop ||
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
