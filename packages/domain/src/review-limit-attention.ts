import type { CommandState } from "./commands/core.js";

/** Read-only consistency check, including decisions resolved by older servers. */
export function reviewLimitAttention(state: CommandState, now: string) {
  return state.work_items.flatMap((item) => {
    if (
      item.kind !== "verify" ||
      item.status !== "waiting_decision" ||
      !state.cards.some(
        (c) =>
          c.id === item.card_id && !["done", "cancelled"].includes(c.status),
      )
    )
      return [];
    // A later review-limit decision owns the current wait, even if it is paused.
    const decision = state.decisions
      .filter(
        (q) =>
          q.trigger === "review_limit" &&
          q.affected_work_items.includes(item.id),
      )
      .sort((a, b) => Number(b.id.slice(2, -1)) - Number(a.id.slice(2, -1)))[0];
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
