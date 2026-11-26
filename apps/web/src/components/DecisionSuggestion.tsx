import { type ReactNode, useEffect, useRef, useState } from "react";
import type { DecisionSuggestionView, SuggestionProgressView } from "../api.js";
import { SUGGESTION_COPY } from "../suggestion-copy.js";
import { StatusTag } from "./Foundation.js";
import { Textarea } from "./ui/textarea.js";

/**
 * C-192: the raiser's suggestion with a one-click "按建议处理". A suggestion
 * written before the current deliveries or checks reads as stale and offers
 * no button. A suggested return shows its prefilled, editable reason.
 */
export function DecisionSuggestion({
  id,
  suggestion,
  label,
  explicitAction = false,
  actions,
  busy,
  reason,
  onReason,
  onApply,
}: {
  readonly id: string;
  readonly suggestion: DecisionSuggestionView;
  /** Human label of the suggested option. */
  readonly label: string;
  readonly explicitAction?: boolean;
  readonly actions?: ReactNode;
  readonly busy: boolean;
  readonly reason: string;
  readonly onReason: (value: string) => void;
  readonly onApply: (button: HTMLButtonElement) => void;
}) {
  const progress = suggestion.progress;
  const confirmationKey = JSON.stringify([suggestion.version, progress?.token]);
  const [confirming, setConfirming] = useState<string>();
  const trigger = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const confirmationOpen =
    !!progress && confirming === confirmationKey && !suggestion.stale;
  useEffect(() => {
    if (confirmationOpen) cancel.current?.focus();
    else if (confirming !== undefined) {
      setConfirming(undefined);
      trigger.current?.focus();
    }
  }, [confirmationOpen, confirming]);
  const dismiss = () => {
    setConfirming(undefined);
    trigger.current?.focus();
  };
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
      {progress && (
        <div className="suggestion-progress">
          <p className="hint">{SUGGESTION_COPY.progressHint}</p>
          <details>
            <summary className="suggestion-progress-toggle">
              {SUGGESTION_COPY.progress(progress.count)}
            </summary>
            <SuggestionProgressEntries progress={progress} />
          </details>
        </div>
      )}
      {suggestion.stale ? (
        <p className="hint">{SUGGESTION_COPY.staleHint}</p>
      ) : (
        <>
          {returning && (
            <label>
              {SUGGESTION_COPY.returnReason}
              <Textarea
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
              ref={trigger}
              aria-expanded={confirmationOpen}
              onClick={(event) =>
                progress
                  ? setConfirming(confirmationKey)
                  : onApply(event.currentTarget)
              }
            >
              {explicitAction ? `按建议：${label}` : SUGGESTION_COPY.apply}
            </button>
            {actions}
          </div>
          {confirmationOpen && (
            <fieldset
              className="suggestion-confirmation"
              aria-label={SUGGESTION_COPY.confirmHint}
            >
              <p>{SUGGESTION_COPY.confirmHint}</p>
              <div className="action-row">
                <button ref={cancel} type="button" onClick={dismiss}>
                  {SUGGESTION_COPY.cancel}
                </button>
                <button
                  type="button"
                  disabled={busy || (returning && !reason.trim())}
                  onClick={(event) => {
                    setConfirming(undefined);
                    onApply(event.currentTarget);
                  }}
                >
                  {SUGGESTION_COPY.confirm}
                </button>
              </div>
            </fieldset>
          )}
        </>
      )}
    </section>
  );
}

/** What happened after the suggestion was written, oldest first. */
export function SuggestionProgressEntries({
  progress,
}: {
  readonly progress: SuggestionProgressView;
}) {
  return (
    <ul>
      {progress.entries.map((entry) => (
        <li key={entry.id}>
          <p>
            <strong>{entry.author_display}</strong> ·{" "}
            <time dateTime={entry.at}>
              {new Date(entry.at).toLocaleString()}
            </time>{" "}
            · {entry.card_id}
          </p>
          <p>{entry.summary}</p>
        </li>
      ))}
    </ul>
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
