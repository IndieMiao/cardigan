import type { Actor, RunOutcome, RuntimeRef } from "../entities.js";
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
      return run;
    if (run.pending_finish)
      ensure(
        run.pending_finish.outcome === p.outcome &&
          run.pending_finish.summary === p.summary &&
          run.pending_finish.token_id === d.assignment?.mcp_token_id &&
          JSON.stringify(run.pending_finish.runtime_ref) ===
            JSON.stringify(d.assignment?.runtime_ref),
        "illegal_transition",
        "Run already has a pending finish request",
      );
    if (run.status === "unknown") {
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
          token_id: assignment.mcp_token_id,
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
    const result = endRun(d, run, p.outcome, p.summary);
    const item =
      d.assignment?.scope === "work_item"
        ? d.work(d.assignment.work_item_id)
        : undefined;
    d.emit("run_finished", item?.card_id, {
      run_id: run.id,
      outcome: p.outcome,
      summary: p.summary,
    });
    return result;
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
    if (
      !pending ||
      run.status !== "running" ||
      a.status !== "active" ||
      !["idle", "running"].includes(a.runtime_state) ||
      run.role_version !== a.role_version ||
      pending.token_id !== a.mcp_token_id ||
      JSON.stringify(pending.runtime_ref) !== JSON.stringify(p.runtime_ref) ||
      JSON.stringify(a.runtime_ref) !== JSON.stringify(p.runtime_ref) ||
      run.dispatch_stop ||
      run.inactivity_stop ||
      hostOpsPending(state.events, a.id)
    )
      return run;
    const result = endRun(d, run, pending.outcome, pending.summary);
    const card =
      a.scope === "work_item"
        ? d.get("work_items", a.work_item_id).card_id
        : undefined;
    d.emit("run_finished", card, {
      run_id: run.id,
      outcome: pending.outcome,
      summary: pending.summary,
    });
    return result;
  });
}
