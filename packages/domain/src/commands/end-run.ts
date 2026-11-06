import type { Run, RunOutcome } from "../entities.js";
import { transition } from "../transitions.js";
import { type CommandDraft, unwrap } from "./core.js";

/** All business endings, including implicit blocking endings, release the runtime's busy state. */
export function endRun(
  d: CommandDraft,
  run: Run,
  outcome: RunOutcome,
  summary: string,
) {
  const next = {
    ...run,
    status: unwrap(
      transition("run", run.status, outcome === "failed" ? "fail" : "complete"),
    ),
    outcome,
    summary,
    finished_at: d.now,
  };
  d.put("runs", next);
  const assignment = d.get("assignments", run.assignment_id);
  if (assignment.runtime_state === "running")
    d.put("assignments", {
      ...assignment,
      runtime_state: unwrap(transition("runtime", "running", "run_finished")),
    });
  return next;
}
