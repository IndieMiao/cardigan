import type { Decision, WorkItem } from "../entities.js";
import { flowAtLeast } from "../flow.js";
import type { DecisionId } from "../ids.js";
import { transition } from "../transitions.js";
import { type CommandDraft, ensure, text, unwrap } from "./core.js";
import {
  delegationAllowed,
  delegationAuthority,
  independentReviewDelegationAuthority,
} from "./delegation.js";
import { independentReviewLimitTarget } from "./independent-review-limit-delegation.js";
import { REVIEW_LIMIT_PLAIN_SUMMARY } from "./plain-summary.js";
import { queueResumedRun, resumeWork } from "./resumption.js";
import { currentReviewTarget } from "./review-round.js";

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
      delegationAllowed(d, q) &&
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
      ...(item.role_id === "independent_reviewer"
        ? {
            human_required_reason: `独立复核加轮已由项目经理升级给人：${p.rationale}`,
          }
        : {}),
      context: `${q.context}\n\n项目经理升级给你：${p.rationale}`,
      // C-202: review-limit decisions raised before plain summaries get one.
      plain_summary: q.plain_summary ?? { ...REVIEW_LIMIT_PLAIN_SUMMARY },
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
  const independent = item.role_id === "independent_reviewer";
  const target = independent ? currentReviewTarget(d, item) : undefined;
  recordDecisionResolution(d, q, {
    option: p.option,
    rationale: p.rationale,
    raw_quote: p.rationale,
    resolved_by: d.author,
    via: "delegated",
    proxy_authority: independent
      ? independentReviewDelegationAuthority(d)
      : delegationAuthority(d, q.category ?? "general"),
    ...(target
      ? { review_limit_target: independentReviewLimitTarget(target) }
      : {}),
    ...(independent
      ? {
          notice: `按常驻授权代批独立复核${p.option === "raise_limit" ? "增加一轮" : "暂停"}：${p.rationale}。加轮不等于复核通过或确认合并。`,
        }
      : {}),
    via_chain: [d.author],
    at: d.now,
  });
  return d.work(item.id);
}

function raiseReviewLimit(d: CommandDraft, q: Decision, rationale: string) {
  for (const id of new Set(q.affected_work_items)) {
    const item = d.work(id);
    ensure(
      !["done", "cancelled"].includes(d.card(item.card_id).status),
      "illegal_transition",
      "Card is closed",
    );
    ensure(
      item.kind === "verify",
      "validation_failed",
      "Review limits require a verifier",
    );
    ensure(
      item.role_id === "independent_reviewer" ||
        !flowAtLeast(d.card(item.card_id), 5),
      "illegal_transition",
      "新版普通审核额度由系统规则处理，旧拍板不能再次加轮",
    );
    const limit = item.max_review_rounds + 1;
    ensure(
      Number.isSafeInteger(limit),
      "validation_failed",
      "Review limit is too large",
    );
    d.put("work_items", { ...item, max_review_rounds: limit });
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
        body: `审核上限增加到 ${limit} 轮：${rationale}`,
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
}

/** All authorized decision entry points share the budget, audit and resumption effects. */
export function recordDecisionResolution(
  d: CommandDraft,
  q: Decision,
  resolution: NonNullable<Decision["resolution"]>,
): Decision {
  const result: Decision = {
    ...q,
    status: unwrap(
      transition(
        "decision",
        q.status,
        q.trigger === "review_limit" && resolution.option === "pause"
          ? "provisionally_resolve"
          : "resolve",
      ),
    ),
    resolution,
  };
  // Validate the transition before incrementing; repeat resolutions cannot add rounds.
  if (q.trigger === "review_limit" && resolution.option === "raise_limit")
    raiseReviewLimit(d, q, resolution.rationale);
  d.put("decisions", result);
  const resumed: WorkItem[] = [];
  for (const id of new Set(q.affected_work_items)) {
    const item = d.work(id);
    if (q.blocking && resumeWork(d, item)) resumed.push(item);
  }
  const cards = [
    ...new Set([...(q.card_id ? [q.card_id] : []), ...q.affected_cards]),
  ];
  const reviewItemId =
    q.trigger === "review_limit" &&
    resolution.via === "delegated" &&
    q.affected_work_items.length === 1
      ? q.affected_work_items[0]
      : undefined;
  for (const card of cards.length ? cards : [undefined]) {
    const unblocked = resumed.filter((w) => w.card_id === card);
    const event = d.emit(
      result.status === "provisional"
        ? "decision_provisionally_resolved"
        : "decision_resolved",
      card,
      {
        decision_id: q.id,
        ...(q.role_rule_basis
          ? { role_rule_basis: JSON.parse(JSON.stringify(q.role_rule_basis)) }
          : {}),
        option: resolution.option,
        option_description:
          q.options.find((o) => o.key === resolution.option)?.description ?? "",
        impact:
          q.options.find((o) => o.key === resolution.option)?.impact ?? "",
        rationale: resolution.rationale,
        raised_by: q.raised_by,
        via: resolution.via,
        ...(resolution.review_limit_target
          ? {
              review_limit_target: {
                delivery_id: resolution.review_limit_target.delivery_id,
                subject: { ...resolution.review_limit_target.subject },
              },
            }
          : {}),
        ...(resolution.human_decided_merge_basis
          ? {
              human_decided_merge_basis: {
                preference_version:
                  resolution.human_decided_merge_basis.preference_version,
                entries: resolution.human_decided_merge_basis.entries.map(
                  (e) => ({ ...e }),
                ),
              },
            }
          : {}),
        ...(resolution.proxy_authority
          ? { proxy_authority: resolution.proxy_authority }
          : {}),
        ...(resolution.notice ? { notice: resolution.notice } : {}),
        ...(resolution.taken_over_from
          ? { taken_over_from: resolution.taken_over_from }
          : {}),
        ...(resolution.via_suggestion ? { via_suggestion: true } : {}),
        ...(resolution.merge_override
          ? { merge_override: resolution.merge_override }
          : {}),
        status: result.status,
        resume_work_items: unblocked.map((w) => w.id),
      },
      {
        type: "decision_resolved",
        decision_id: q.id,
        ...(reviewItemId ? { work_item_id: reviewItemId } : {}),
        body: resolution.human_decided_merge_basis
          ? `${resolution.notice ?? resolution.raw_quote}\n\n拍板对应依据：\n${resolution.human_decided_merge_basis.entries.map((e) => `- ${e.decision_id} / ${e.option} → ${e.completion_id} / ${e.delivery_id} / ${e.target_sha}：${e.evidence}`).join("\n")}`
          : resolution.merge_override
            ? `强行确认合并；理由：${resolution.merge_override.reason}\n当时缺项：${resolution.merge_override.blockers.length ? `\n${resolution.merge_override.blockers.map((b) => `- ${b}`).join("\n")}` : "无"}\n${resolution.raw_quote}`
            : resolution.review_limit_target && resolution.via === "delegated"
              ? (resolution.notice ?? resolution.raw_quote)
              : resolution.raw_quote,
      },
    );
    for (const item of unblocked) queueResumedRun(d, item, event);
  }
  return result;
}
