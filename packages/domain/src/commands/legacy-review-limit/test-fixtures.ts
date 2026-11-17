import type {
  CommandPorts,
  CommandState,
  Decision,
  WorkItemId,
} from "../../index.js";
import { command } from "../core.js";
import { assignDecision } from "../delegation.js";
import { endRun } from "../end-run.js";
import type { mergeFixture } from "../merge/test-fixtures.js";
import { REVIEW_LIMIT_PLAIN_SUMMARY } from "../plain-summary.js";

/** A persisted pre-Flow-Lite question, used to test compatibility command entry points. */
export function seedLegacyReviewLimit(
  f: ReturnType<typeof mergeFixture>,
  max = 1,
) {
  return f.commit(
    legacyReviewLimitEffect(
      f.state,
      f.reviewer.work_item_id as WorkItemId,
      f.io,
      max,
    ),
  );
}

export function legacyReviewLimitEffect(
  state: CommandState,
  workItemId: WorkItemId,
  io: CommandPorts,
  max = 1,
) {
  return command(
    state,
    { kind: "human", project_id: state.project_id },
    "upgrade_card_flow",
    io,
    (d) => {
      const item = d.work(workItemId);
      for (const run of d.list("runs"))
        if (run.assignment_id === item.assignment_id)
          d.put("runs", { ...run, review_limit_changes: [] });
      d.put("work_items", {
        ...item,
        status: "waiting_decision",
        max_review_rounds: max,
      } as typeof item);
      const id = d.ids.next(state.project_id, "decision");
      const q: Decision = assignDecision(d, {
        id,
        key: id,
        card_id: item.card_id,
        raised_by: "system",
        kind: "choose",
        category: "general",
        trigger: "review_limit",
        question: "Legacy review limit",
        context: "Persisted before Flow Lite",
        options: [
          {
            key: "raise_limit",
            description: "Raise",
            impact: "One more round",
          },
          { key: "pause", description: "Pause", impact: "Wait" },
        ],
        recommended: "raise_limit",
        plain_summary: REVIEW_LIMIT_PLAIN_SUMMARY,
        affected_cards: [item.card_id],
        affected_work_items: [item.id],
        blocking: true,
        decider: "human",
        doc_refs: [],
        status: "open",
      });
      d.put("decisions", q);
      for (const run of d.list("runs"))
        if (
          run.assignment_id === item.assignment_id &&
          run.status === "running"
        )
          endRun(d, run, "blocked", q.question);
      d.emit("decision_requested", item.card_id, {
        decision_id: id,
        affected_work_items: [item.id],
      });
      return q;
    },
  );
}
