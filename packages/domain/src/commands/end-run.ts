import type { Run, RunOutcome } from "../entities.js";
import type { DecisionId } from "../ids.js";
import { transition } from "../transitions.js";
import { type CommandDraft, unwrap } from "./core.js";

/** All business endings, including implicit blocking endings, release the runtime's busy state. */
export function endRun(
  d: CommandDraft,
  run: Run,
  outcome: RunOutcome,
  summary: string,
  systemEnding?: {
    reason: "blocking_decision" | "review_limit";
    decision_id: DecisionId;
  },
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
  delete next.pending_finish;
  d.put("runs", next);
  const assignment = d.get("assignments", run.assignment_id);
  if (assignment.runtime_state === "running")
    d.put("assignments", {
      ...assignment,
      runtime_state: unwrap(transition("runtime", "running", "run_finished")),
    });
  const card =
    assignment.scope === "work_item"
      ? d.get("work_items", assignment.work_item_id).card_id
      : undefined;
  const body = systemEnding
    ? `系统因${systemEnding.reason === "blocking_decision" ? "阻塞拍板" : "审核轮数用尽"}（${systemEnding.decision_id}）结束 ${run.id}：${summary}`
    : summary;
  d.emit(
    "run_finished",
    card,
    {
      run_id: run.id,
      outcome,
      summary,
      ...(next.wait_for ? { wait_for: { ...next.wait_for.condition } } : {}),
      ...(systemEnding
        ? {
            assignment_id: assignment.id,
            finished_by: "system",
            ...systemEnding,
            body,
          }
        : {}),
    },
    systemEnding
      ? {
          type: "system",
          author: "system",
          body,
          run_id: run.id,
          decision_id: systemEnding.decision_id,
        }
      : undefined,
  );
  return next;
}
