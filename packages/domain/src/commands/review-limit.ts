import type { Decision, WorkItem } from "../entities.js";
import type { CommandDraft } from "./core.js";
import { endRun } from "./end-run.js";

export function pendingReviewLimit(d: CommandDraft, item: WorkItem) {
  return d
    .list("decisions")
    .find(
      (q) =>
        q.trigger === "review_limit" &&
        ["open", "provisional"].includes(q.status) &&
        q.affected_work_items.includes(item.id),
    );
}

// Both a final non-pass review and a new target with no remaining budget use this path.
export function requestReviewLimit(d: CommandDraft, item: WorkItem) {
  if (item.status !== "waiting_decision")
    d.put("work_items", d.move(item, "review_limit_exceeded"));
  const existing = pendingReviewLimit(d, item);
  const id = existing?.id ?? d.ids.next(d.state.project_id, "decision");
  const decision: Decision = existing ?? {
    id,
    key: id,
    card_id: item.card_id,
    raised_by: d.author,
    kind: "choose",
    category: "general",
    trigger: "review_limit",
    question: `Review limit reached for ${item.id}`,
    context: "A decision is required before another review round",
    options: [
      {
        key: "raise_limit",
        description: "Ask PM Ops or the human to raise the review limit",
        impact: "Allows another round",
      },
      {
        key: "pause",
        description: "Keep the work paused",
        impact: "No rework run is requested",
      },
    ],
    recommended: "pause",
    affected_cards: [item.card_id],
    affected_work_items: [item.id],
    blocking: true,
    decider: "human",
    doc_refs: [],
    status: "open",
  };
  const runs = d
    .list("runs")
    .filter(
      (r) => r.assignment_id === item.assignment_id && r.status === "running",
    );
  for (const run of runs) endRun(d, run, "blocked", decision.question);
  if (existing) return;
  d.put("decisions", decision);
  d.emit(
    "decision_requested",
    item.card_id,
    { decision_id: id, affected_work_items: [item.id] },
    {
      type: "decision_request",
      body: decision.question,
      decision_id: id,
      work_item_id: item.id,
      ...(runs[0] ? { run_id: runs[0].id } : {}),
    },
  );
}
