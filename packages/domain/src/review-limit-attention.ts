import type { CommandState } from "./commands/core.js";
import { CommandDraft } from "./commands/core.js";
import { currentReviewTarget, reviewRound } from "./commands/review-round.js";
import { flowAtLeast } from "./flow.js";
import type { CardId, DecisionId, EventId, WorkItemId } from "./ids.js";
import { parseId } from "./ids.js";

/** Full decision number (`Q-95` → 95; legacy `q(95)` too); unparseable sorts first. */
const sequence = (id: string): number => {
  const parsed = parseId("decision", id);
  return parsed.ok ? parsed.value.sequence : 0;
};

/** Read-only consistency check, including decisions resolved by older servers. */
export interface ReviewLimitAttention {
  kind: "review_limit_not_resumed" | "review_limit_auto_raise_exhausted";
  card_id: CardId;
  work_item_id: WorkItemId;
  decision_id?: DecisionId;
  event_id?: EventId;
  resolved_at: string;
  waited_ms: number;
  detail: string;
}

export function reviewLimitAttention(
  state: CommandState,
  now: string,
): ReviewLimitAttention[] {
  const draft = new CommandDraft(
    state,
    { kind: "human", project_id: state.project_id },
    "list_needs_you",
  );
  return state.work_items.flatMap<ReviewLimitAttention>((item) => {
    if (
      item.kind !== "verify" ||
      item.status !== "waiting_decision" ||
      !state.cards.some(
        (c) =>
          c.id === item.card_id && !["done", "cancelled"].includes(c.status),
      )
    )
      return [];
    const card = state.cards.find((c) => c.id === item.card_id);
    if (
      card &&
      (flowAtLeast(card, 5) || item.role_id === "independent_reviewer")
    ) {
      const target = currentReviewTarget(draft, item);
      const round = reviewRound(draft, item);
      const wait = state.events.findLast(
        (e) =>
          e.actor.kind === "system" &&
          e.card_id === item.card_id &&
          e.type === "review_limit_auto_raise_exhausted" &&
          (e.payload as Record<string, unknown>).work_item_id === item.id &&
          (e.payload as Record<string, unknown>).delivery_id === target?.id &&
          (e.payload as Record<string, unknown>).round === round,
      );
      return wait && target && round > item.max_review_rounds
        ? [
            {
              kind: "review_limit_auto_raise_exhausted" as const,
              card_id: item.card_id,
              work_item_id: item.id,
              event_id: wait.id,
              resolved_at: wait.created_at,
              waited_ms: Math.max(
                0,
                Date.parse(now) - Date.parse(wait.created_at),
              ),
              detail: `${item.id} 审核自动加轮额度未设置或已用完，保持等待；请项目经理排查。`,
            },
          ]
        : [];
    }
    // A later review-limit decision owns the current wait, even if it is paused.
    const decision = state.decisions
      .filter(
        (q) =>
          q.trigger === "review_limit" &&
          q.affected_work_items.includes(item.id),
      )
      .sort((a, b) => sequence(b.id) - sequence(a.id))[0];
    if (
      decision?.status !== "resolved" ||
      decision.resolution?.option !== "raise_limit"
    )
      return [];
    const resolvedAt = decision.resolution.at;
    const waited = Date.parse(now) - Date.parse(resolvedAt);
    if (!Number.isFinite(waited) || waited <= 10 * 60_000) return [];
    const resolved = state.events.findLast(
      (e) =>
        e.card_id === item.card_id &&
        e.type === "decision_resolved" &&
        typeof e.payload === "object" &&
        e.payload !== null &&
        "decision_id" in e.payload &&
        e.payload.decision_id === decision.id,
    );
    // Do not flag an old resolution after a successful resume and a new wait.
    if (
      state.events.some(
        (e) =>
          e.card_id === item.card_id &&
          (resolved
            ? e.seq >= resolved.seq
            : Date.parse(e.created_at) >= Date.parse(resolvedAt)) &&
          typeof e.payload === "object" &&
          e.payload !== null &&
          "resume_work_items" in e.payload &&
          Array.isArray(e.payload.resume_work_items) &&
          e.payload.resume_work_items.includes(item.id),
      )
    )
      return [];
    return [
      {
        kind: "review_limit_not_resumed" as const,
        card_id: item.card_id,
        work_item_id: item.id,
        decision_id: decision.id,
        resolved_at: resolvedAt,
        waited_ms: waited,
        detail: `审核上限拍板 ${decision.id} 已确认增加轮数，但 ${item.id} 超过 10 分钟仍在等待；请核查审核额度及其他阻塞。`,
      },
    ];
  });
}
