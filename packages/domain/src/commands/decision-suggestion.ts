import type { Decision, DecisionSuggestion } from "../entities.js";
import {
  attempt,
  type CommandDraft,
  type CommandState,
  ensure,
  text,
} from "./core.js";
import { mergeContext } from "./merge.js";
import { latestMergeCheck } from "./merge-check.js";

/** C-192: suggestion parameters accepted from request_decision / escalation. */
export interface DecisionSuggestionInput {
  readonly option: string;
  readonly rationale: string;
  readonly return_reason?: string;
}

type Scope = Pick<Decision, "card_id" | "affected_cards">;

/**
 * Fingerprint of what a suggestion was written against, per card: every
 * delivery (a newer version adds one), the current completion's latest merge
 * check attempt and status, and the pre-merge checks.
 */
export function suggestionBasis(state: CommandState, q: Scope): string {
  const cards = [
    ...new Set([...(q.card_id ? [q.card_id] : []), ...q.affected_cards]),
  ].sort();
  const cardOf = new Map(state.work_items.map((w) => [w.id, w.card_id]));
  return JSON.stringify(
    cards.map((card_id) => {
      const card = state.cards.find((c) => c.id === card_id);
      const deliveries = state.deliveries
        .filter((x) => cardOf.get(x.work_item_id) === card_id)
        .map((x) => x.id)
        .sort();
      const context = attempt(() => mergeContext(state, card_id));
      const check = context.ok
        ? latestMergeCheck(state.events, card_id, context.value.target.id)
        : undefined;
      return [
        card_id,
        deliveries,
        check ? `${check.attempt_id}:${check.status}` : null,
        (card?.pre_merge_checks ?? []).map(
          (c) => `${c.label}:${c.status}:${c.updated_at}`,
        ),
      ];
    }),
  );
}

/** Validate a suggestion against the decision it will be attached to. */
export function buildSuggestion(
  d: CommandDraft,
  q: Pick<Decision, "options" | "trigger"> & Scope,
  input: DecisionSuggestionInput,
): DecisionSuggestion {
  text(input.option, "suggestion.option");
  text(input.rationale, "suggestion.rationale");
  ensure(
    q.options.some((o) => o.key === input.option),
    "validation_failed",
    "建议的选项不在这条拍板的选项里",
  );
  ensure(
    q.trigger !== "merge_confirmation" ||
      ["merge", "request_changes"].includes(input.option),
    "validation_failed",
    "合并确认的建议只能是 merge 或 request_changes；暂缓需要人填写原因和时间，不支持一键处理",
  );
  const returning = input.option === "request_changes";
  if (returning) text(input.return_reason, "suggestion.return_reason");
  ensure(
    returning || input.return_reason === undefined,
    "validation_failed",
    "只有建议 request_changes 时才能预填退回原因",
  );
  return {
    option: input.option,
    rationale: input.rationale.trim(),
    ...(returning ? { return_reason: (input.return_reason ?? "").trim() } : {}),
    by: d.author,
    at: d.now,
    basis: suggestionBasis(d.state, q),
  };
}

/** Stale once the cards' deliveries, merge check or pre-merge checks changed. */
export function suggestionStale(state: CommandState, q: Decision): boolean {
  return !q.suggestion || suggestionBasis(state, q) !== q.suggestion.basis;
}

/** Read model: the suggestion without its fingerprint, plus `stale`. */
export function suggestionView(state: CommandState, q: Decision) {
  if (!q.suggestion) return undefined;
  const { basis: _basis, ...rest } = q.suggestion;
  return { ...rest, stale: suggestionStale(state, q) };
}
