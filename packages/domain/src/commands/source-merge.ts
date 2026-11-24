import type { Actor, Decision } from "../entities.js";
import { appendEvents } from "../event-index.js";
import type { CardId, DecisionId } from "../ids.js";
import { sourceMergeBasis, sourceMergeConfirmation } from "../source-merge.js";
import {
  type CommandDraft,
  type CommandPorts,
  type CommandState,
  command,
  ensure,
  text,
} from "./core.js";
import { suggestionBasis } from "./decision-suggestion.js";
import { assignDecision } from "./delegation.js";
import { mergeContext, syncSystemMerge } from "./merge.js";

function target(state: CommandState, q: Decision) {
  const card = state.cards.find((c) => c.id === q.card_id);
  ensure(
    card &&
      card.status === "awaiting_merge" &&
      q.trigger === "merge_confirmation" &&
      ["open", "provisional", "snoozed"].includes(q.status) &&
      q.kind === "approve" &&
      "delivery_id" in q.target &&
      mergeContext(state, card.id).target.id === q.target.delivery_id,
    "stale_target",
    "合并确认已失效，请刷新后重新建议",
  );
  const source = state.decisions.find(
    (s) => card.source.kind === "decision" && s.id === card.source.decision_id,
  );
  ensure(
    source && source.status === "resolved" && !source.superseded_by,
    "stale_target",
    "来源拍板缺失或已变更，请重新核对",
  );
  return { card, source };
}

/** Called only inside the existing PM Ops command, without resolving anything. */
export function suggestSourceMergeUnrelated(
  d: CommandDraft,
  q: Decision,
  input: { decision_id: DecisionId; rationale: string },
) {
  const { card, source } = target(d.state, q);
  ensure(
    input.decision_id === source.id,
    "stale_target",
    "建议与当前来源拍板不符",
  );
  text(input.rationale, "source_unrelated.rationale");
  ensure(
    !sourceMergeConfirmation(card, source, d.state.events),
    "illegal_transition",
    "人已确认当前来源无关，无需重复建议",
  );
  const suggestion = {
    card_id: card.id,
    source_decision_id: source.id,
    version: (q.source_unrelated_suggestion?.version ?? 0) + 1,
    rationale: input.rationale.trim(),
    by: d.author,
    at: d.now,
    source_basis: sourceMergeBasis(card, source, d.state.events),
    basis: suggestionBasis(d.state, q),
  };
  const updated = { ...q, source_unrelated_suggestion: suggestion };
  d.put("decisions", updated);
  d.emit(
    "source_merge_unrelated_suggested",
    card.id,
    { decision_id: q.id, ...suggestion },
    {
      type: "system",
      decision_id: q.id,
      body: `PM 建议来源拍板 ${source.id} 与本卡合并无关：${suggestion.rationale}`,
    },
  );
  return updated;
}

export function sourceMergeSuggestionView(state: CommandState, q: Decision) {
  const suggestion = q.source_unrelated_suggestion;
  if (!suggestion) return undefined;
  const { basis, source_basis, ...view } = suggestion;
  const card = state.cards.find((c) => c.id === q.card_id);
  const source = state.decisions.find(
    (s) => s.id === suggestion.source_decision_id,
  );
  const confirmation =
    card && source
      ? sourceMergeConfirmation(card, source, state.events)
      : undefined;
  let stale = true;
  try {
    const current = target(state, q);
    stale =
      suggestion.card_id !== current.card.id ||
      suggestion.source_decision_id !== current.source.id ||
      source_basis !==
        sourceMergeBasis(current.card, current.source, state.events) ||
      basis !== suggestionBasis(state, q);
  } catch {
    /* Historical suggestions remain visible but cannot be applied. */
  }
  return {
    ...view,
    stale,
    ...(confirmation
      ? {
          confirmed: {
            at: confirmation.created_at,
            by: "human" as const,
            event_id: confirmation.id,
          },
        }
      : {}),
  };
}

/** Human-only marker. It neither answers the merge decision nor grants business authority. */
export function confirmSourceMergeUnrelated(
  state: CommandState,
  actor: Actor,
  p: {
    decision_id: DecisionId;
    card_id: CardId;
    source_decision_id: DecisionId;
    version: number;
  },
  ports: CommandPorts,
) {
  return command(state, actor, "record_decision", ports, (d) => {
    ensure(
      actor.kind === "human" && ports.human_confirmation === "workbench",
      "forbidden_tool",
      "来源无关标记只能由人在 Workbench 亲自确认",
    );
    const q = d.get("decisions", p.decision_id);
    const { card, source } = target(state, q);
    d.card(card.id);
    const suggestion = q.source_unrelated_suggestion;
    const view = sourceMergeSuggestionView(state, q);
    ensure(
      suggestion &&
        view &&
        !view.stale &&
        p.version === suggestion.version &&
        p.card_id === card.id &&
        p.source_decision_id === source.id,
      "stale_target",
      "来源无关建议已失效，请刷新并请 PM 重新核对",
    );
    if (view.confirmed) return view;
    const sourceOnly =
      q.source_human_reason?.decision_id === source.id &&
      q.source_human_reason.reason === q.human_required_reason;
    const retained =
      q.source_unrelated_human_required ||
      (!!q.human_required_reason && !sourceOnly);
    if (retained)
      d.put("decisions", { ...q, source_unrelated_human_required: true });
    else if (sourceOnly) {
      const {
        human_required_reason: _reason,
        source_human_reason: _source,
        ...remaining
      } = q;
      d.put("decisions", remaining);
    }
    d.emit(
      "source_merge_unrelated_confirmed",
      card.id,
      {
        decision_id: q.id,
        ...suggestion,
        confirmed_by: "human",
        ...(retained
          ? {
              retained_human_reason:
                q.human_required_reason ?? "保留其它人工确认原因",
            }
          : {}),
      },
      {
        type: "system",
        decision_id: q.id,
        body: `人已确认来源拍板 ${source.id} 与本卡合并无关：${suggestion.rationale}`,
        refs: [{ kind: "decision", id: source.id }],
      },
    );
    // Reuse the same synchronization as preference/risk changes, including
    // the legacy flow-4 authorization before auto_merge existed.
    syncSystemMerge(d, card);
    const current = d.get("decisions", q.id);
    const assigned =
      current.status === "superseded" ? current : assignDecision(d, current);
    if (assigned.decider !== current.decider) {
      d.put("decisions", assigned);
      d.emit(
        "decision_requested",
        card.id,
        {
          decision_id: q.id,
          previous_decider: q.decider,
          affected_work_items: [...q.affected_work_items],
          reason: "人已确认来源与本卡合并无关，按当前规则重新分派",
        },
        {
          type: "system",
          decision_id: q.id,
          body: "来源无关已确认，合并继续按当前授权处理。",
        },
      );
    }
    return sourceMergeSuggestionView(
      {
        ...state,
        decisions: d.list("decisions"),
        events: appendEvents(state.events, d.events),
      },
      d.get("decisions", q.id),
    );
  });
}
