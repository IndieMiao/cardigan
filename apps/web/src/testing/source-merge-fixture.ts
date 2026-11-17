import type { NeedsDecision } from "../api.js";
import { NOW } from "./fixtures.js";

/** c311-source-v1: one synthetic card, two decisions, zero persisted events. */
export function sourceMergeFixture(): NeedsDecision & {
  source_unrelated_suggestion: NonNullable<
    NeedsDecision["source_unrelated_suggestion"]
  >;
} {
  return {
    id: "Q-2",
    card_id: "C-1",
    related_cards: [{ id: "C-1", title: "来源拍板与本卡合并内容的关系" }],
    affected_cards: [],
    question: "确认合并标签调整",
    context: "合成示例",
    why: "等待确认",
    waited_ms: 0,
    trigger: "merge_confirmation",
    category: "general",
    assignment_id: null,
    status: "open",
    blocking: true,
    decider: "human",
    options: [],
    recommended: "merge",
    plain_summary: {
      changed: "调整卡片状态标签",
      impact: "标签更清楚",
      risk: "无",
    },
    source_unrelated_suggestion: {
      card_id: "C-1",
      source_decision_id: "Q-1",
      version: 1,
      by: "assignment:A-1",
      at: NOW,
      rationale: "本卡只调整标签，不使用来源拍板中的外部账号。",
      stale: false,
    },
    merge_confirmation: {
      blockers: ["敏感卡片的合并须由人亲自确认。"],
      completion: null,
      deliveries: [],
      reviews: [],
      known_gaps: [],
      merge_gate_enabled: true,
      merge_check: {
        status: "passed",
        completion_id: "D-1",
        attempt_id: "synthetic-check",
        checks: [],
        updated_at: NOW,
      },
    },
  };
}
