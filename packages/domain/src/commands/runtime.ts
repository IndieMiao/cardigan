import type { Actor, RunOutcome } from "../entities.js";
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
