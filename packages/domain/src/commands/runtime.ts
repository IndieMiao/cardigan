import type { Actor, Run, RunOutcome, RuntimeRef } from "../entities.js";
import { hostOpsPending } from "../host-ops.js";
import type { RunId } from "../ids.js";
import {
  type CommandPorts,
  type CommandState,
  command,
  ensure,
  text,
} from "./core.js";

import { endRun } from "./end-run.js";

function validRunToken(state: CommandState, run: Run, ports: CommandPorts) {
  const token = ports.run_token;
  return token?.id.trim() &&
    token.project_id === state.project_id &&
    token.assignment_id === run.assignment_id &&
    token.role_version === run.role_version &&
    token.revoked_at === null &&
    token.allowed_tools.includes("finish_run")
    ? token
    : undefined;
}

export function heartbeat(
  state: CommandState,
  actor: Actor,
  p: { run_id: RunId; note?: string },
  ports: CommandPorts,
) {
  return command(state, actor, "heartbeat", ports, (d) => {
    const run = d.ownRun(p.run_id);
    ensure(
      run.status === "running",
      "illegal_transition",
      "Only a running Run can heartbeat",
    );
    const result = {
      ...run,
      heartbeat_at: d.now,
      ...(p.note !== undefined ? { heartbeat_note: p.note } : {}),
    };
    d.put("runs", result);
    return result;
  });
}
export function finishRun(
  state: CommandState,
  actor: Actor,
  p: { run_id: RunId; outcome: RunOutcome; summary: string },
  ports: CommandPorts,
) {
  return command(state, actor, "finish_run", ports, (d) => {
    const run = d.ownRun(p.run_id);
    text(p.summary, "summary");
    ensure(
      ["completed", "blocked", "failed"].includes(p.outcome),
      "validation_failed",
      "Unknown Run outcome",
    );
    // request_decision already ends the caller's Run; the protocol's explicit finish is a no-op.
    if (
      run.status === "completed" &&
      run.outcome === "blocked" &&
      p.outcome === "blocked"
    )
      return {
        ...run,
        finish_notice:
          "该执行已结束为 blocked；保留原结束结果和摘要，本次提交的结果和摘要未另行保存。补充结论请发评论。",
      };
    ensure(
      !["completed", "failed", "cancelled"].includes(run.status),
      "illegal_transition",
      `执行 ${run.id} 已结束（${run.status}，结果 ${run.outcome ?? "未记录"}）；本次提交的结果和摘要未保存，原结束记录保持不变。补充结论请发评论。`,
      {
        run_id: run.id,
        status: run.status,
        outcome: run.outcome,
        summary: run.summary,
        finished_at: run.finished_at,
      },
    );
    const token = validRunToken(state, run, ports);
    if (run.pending_finish)
      ensure(
        token &&
          run.pending_finish.outcome === p.outcome &&
          run.pending_finish.summary === p.summary &&
          run.pending_finish.token_id === token.id &&
          JSON.stringify(run.pending_finish.runtime_ref) ===
            JSON.stringify(d.assignment?.runtime_ref),
        "illegal_transition",
        "Run already has a pending finish request",
      );
    if (run.status === "unknown") {
      ensure(
        token,
        "unauthorized",
        "Deferred finish requires the authenticated, active Token record",
      );
      const assignment = d.assignment;
      ensure(
        assignment?.runtime_state === "unknown" &&
          assignment.runtime_ref &&
          !run.inactivity_stop &&
          !run.dispatch_stop,
        "illegal_transition",
        "Run must await reconnection of its original session",
      );
      if (run.pending_finish) return run;
      const next = {
        ...run,
        pending_finish: {
          outcome: p.outcome,
          summary: p.summary,
          runtime_ref: assignment.runtime_ref,
          token_id: token.id,
        },
      };
      d.put("runs", next);
      const card =
        assignment.scope === "work_item"
          ? d.work(assignment.work_item_id).card_id
          : undefined;
      d.emit("run_finish_deferred", card, {
        run_id: run.id,
        outcome: p.outcome,
      });
      return next;
    }
    return endRun(d, run, p.outcome, p.summary);
  });
}

/** Host-only: the caller has observed this exact RuntimeRef alive and reconnected the Run. */
export function settlePendingRunFinish(
  state: CommandState,
  actor: Actor,
  p: { run_id: RunId; runtime_ref: RuntimeRef },
  ports: CommandPorts,
) {
  return command(state, actor, "settle_pending_run_finish", ports, (d) => {
    const run = d.get("runs", p.run_id);
    const a = d.get("assignments", run.assignment_id);
    const pending = run.pending_finish;
    const token = validRunToken(state, run, ports);
    if (
      !pending ||
      !token ||
      run.status !== "running" ||
      a.status !== "active" ||
      !["idle", "running"].includes(a.runtime_state) ||
      run.role_version !== a.role_version ||
      pending.token_id !== token.id ||
      JSON.stringify(pending.runtime_ref) !== JSON.stringify(p.runtime_ref) ||
      JSON.stringify(a.runtime_ref) !== JSON.stringify(p.runtime_ref) ||
      run.dispatch_stop ||
      run.inactivity_stop ||
      hostOpsPending(state.events, a.id)
    )
      return run;
    return endRun(d, run, pending.outcome, pending.summary);
  });
}
