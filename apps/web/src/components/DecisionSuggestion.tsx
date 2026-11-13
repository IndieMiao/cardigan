import { useEffect, useRef, useState } from "react";
import type { DecisionSuggestionView } from "../api.js";
import { SUGGESTION_COPY } from "../suggestion-copy.js";
import { StatusTag } from "./Foundation.js";

/**
 * C-192: the raiser's suggestion with a one-click "按建议处理". A suggestion
 * written before the current deliveries or checks reads as stale and offers
 * no button. A suggested return shows its prefilled, editable reason.
 */
export function DecisionSuggestion({
  id,
  suggestion,
  label,
  busy,
  reason,
  onReason,
  onApply,
}: {
  readonly id: string;
  readonly suggestion: DecisionSuggestionView;
  /** Human label of the suggested option. */
  readonly label: string;
  readonly busy: boolean;
  readonly reason: string;
  readonly onReason: (value: string) => void;
  readonly onApply: () => void;
}) {
  const returning = suggestion.option === "request_changes";
  return (
    <section
      className={`decision-suggestion${suggestion.stale ? " stale" : ""}`}
      aria-label={`${id} ${SUGGESTION_COPY.region}`}
    >
      <p className="decision-suggestion-line">
        <strong>{SUGGESTION_COPY.line(label, suggestion.rationale)}</strong>
        {suggestion.stale && (
          <StatusTag status="superseded" label={SUGGESTION_COPY.stale} />
        )}
      </p>
      {suggestion.stale ? (
        <p className="hint">{SUGGESTION_COPY.staleHint}</p>
      ) : (
        <>
          {returning && (
            <label>
              {SUGGESTION_COPY.returnReason}
              <textarea
                aria-label={`${id} 建议的退回原因`}
                value={reason}
                onChange={(e) => onReason(e.target.value)}
              />
            </label>
          )}
          <div className="action-row">
            <button
              type="button"
              disabled={busy || (returning && !reason.trim())}
              onClick={onApply}
            >
              {SUGGESTION_COPY.apply}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

/**
 * The return reason box, prefilled from a fresh `request_changes` suggestion.
 * A suggestion arriving (or changing) while the page stays mounted refills
 * the box unless the human already typed their own text.
 */
export function usePrefilledReason(
  suggestion: DecisionSuggestionView | undefined,
) {
  const prefill =
    suggestion && !suggestion.stale ? (suggestion.return_reason ?? "") : "";
  const [reason, setReason] = useState(prefill);
  const last = useRef(prefill);
  useEffect(() => {
    if (prefill === last.current) return;
    const previous = last.current;
    last.current = prefill;
    setReason((current) =>
      current === previous || !current.trim() ? prefill : current,
    );
  }, [prefill]);
  return [reason, setReason] as const;
}
