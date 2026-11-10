import type { Decision, WorkItem } from "../entities.js";
import type { DecisionId } from "../ids.js";
import { transition } from "../transitions.js";
import { type CommandDraft, ensure, text, unwrap } from "./core.js";
import { queueResumedRun, resumeWork } from "./resumption.js";

export interface ReviewLimitResolution {
  readonly decision_id: DecisionId;
  readonly option: "raise_limit" | "pause" | "escalate";
  readonly rationale: string;
}

/** Narrow PM Ops authority, without granting the Office's record_decision tool. */
export function resolveReviewLimit(
  d: CommandDraft,
  item: WorkItem,
  p: ReviewLimitResolution,
): WorkItem {
  ensure(
    d.assignment?.scope === "standing" &&
      d.assignment.standing_mode === "ops" &&
      d.assignment.role_id === "pm",
    "forbidden_tool",
    "Only PM Ops may handle a delegated review limit",
  );
  const q = d.get("decisions", p.decision_id);
  ensure(
    item.kind === "verify" &&
      q.trigger === "review_limit" &&
      q.decider === "role:pm" &&
      q.affected_work_items.length === 1 &&
      q.affected_work_items[0] === item.id &&
      ["open", "provisional"].includes(q.status),
    "illegal_transition",
    "Review limit decision is not pending for this verifier",
  );
  text(p.rationale, "rationale");
  ensure(
    ["raise_limit", "pause", "escalate"].includes(p.option),
    "validation_failed",
    "Unknown review limit option",
  );
  if (p.option === "escalate") {
    d.put("decisions", {
      ...q,
      decider: "human",
      context: `${q.context}\n\n项目经理升级给你：${p.rationale}`,
    });
    d.emit(
      "decision_requested",
      item.card_id,
      {
        decision_id: q.id,
        affected_work_items: [item.id],
        previous_decider: q.decider,
        reason: p.rationale,
      },
      {
        type: "decision_request",
        decision_id: q.id,
        work_item_id: item.id,
        body: `审核上限拍板升级给你：${p.rationale}`,
      },
    );
    return item;
  }
  let next = item;
  if (p.option === "raise_limit") {
    const limit = item.max_review_rounds + 1;
    ensure(
      Number.isSafeInteger(limit),
      "validation_failed",
      "Review limit is too large",
    );
    next = { ...item, max_review_rounds: limit };
    d.put("work_items", next);
    const event = d.emit(
      "work_item_updated",
      item.card_id,
      {
        work_item_id: item.id,
        max_review_rounds: limit,
        resume_work_items: [],
      },
      {
        type: "status_change",
        work_item_id: item.id,
        body: `审核上限增加到 ${limit} 轮：${p.rationale}`,
      },
    );
    const run = d
      .list("runs")
      .filter((r) => r.assignment_id === item.assignment_id)
      .sort((a, b) => Number(b.id.slice(2)) - Number(a.id.slice(2)))[0];
    if (run)
      d.put("runs", {
        ...run,
        review_limit_changes: [
          ...(run.review_limit_changes ?? []),
          {
            event_id: event.id,
            max_review_rounds: limit,
            actor: d.author,
            at: event.created_at,
          },
        ],
      });
  }
  const result: Decision = {
    ...q,
    status: unwrap(
      transition(
        "decision",
        q.status,
        p.option === "pause" ? "provisionally_resolve" : "resolve",
      ),
    ),
    resolution: {
      option: p.option,
      rationale: p.rationale,
      raw_quote: p.rationale,
      resolved_by: d.author,
      via: "delegated",
      via_chain: [d.author],
      at: d.now,
    },
  };
  d.put("decisions", result);
  const resumed = resumeWork(d, next);
  const event = d.emit(
    result.status === "provisional"
      ? "decision_provisionally_resolved"
      : "decision_resolved",
    item.card_id,
    {
      decision_id: q.id,
      option: p.option,
      status: result.status,
      resume_work_items: resumed ? [item.id] : [],
    },
    {
      type: "decision_resolved",
      decision_id: q.id,
      work_item_id: item.id,
      body: p.rationale,
    },
  );
  if (resumed) queueResumedRun(d, item, event);
  return resumed ?? next;
}
