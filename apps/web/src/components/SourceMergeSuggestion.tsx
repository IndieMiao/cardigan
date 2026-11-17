import { useEffect, useRef, useState } from "react";
import type { CardiganClient, DecisionView } from "../api.js";
import { describeWriteError } from "../api.js";

export function SourceMergeSuggestion({
  client,
  projectId,
  decision,
  done,
}: {
  client: CardiganClient;
  projectId: string;
  decision: DecisionView;
  done: () => void;
}) {
  const suggestion = decision.source_unrelated_suggestion;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const sending = useRef(false);
  const submitted = useRef(false);
  const keys = useRef(new Map<string, string>());
  const region = useRef<HTMLElement>(null);
  const identity = JSON.stringify([
    projectId,
    decision.id,
    suggestion?.card_id,
    suggestion?.source_decision_id,
    suggestion?.version,
  ]);
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  useEffect(() => {
    // A refreshed proposal has its own feedback and idempotency identity.
    if (identity) {
      setError(undefined);
      submitted.current = false;
    }
  }, [identity]);
  useEffect(() => {
    if (suggestion?.confirmed && submitted.current) region.current?.focus();
  }, [suggestion?.confirmed]);
  if (!suggestion) return null;
  const confirm = async () => {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setError(undefined);
    const target = [
      suggestion.card_id,
      suggestion.source_decision_id,
      suggestion.version,
    ] as const;
    const request = identity;
    const key = keys.current.get(request) ?? crypto.randomUUID();
    keys.current.set(request, key);
    try {
      await client.confirmSourceUnrelated(
        projectId,
        decision.id,
        ...target,
        key,
      );
      if (currentIdentity.current === request) {
        submitted.current = true;
        done();
      }
    } catch (e) {
      if (currentIdentity.current === request) setError(describeWriteError(e));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };
  return (
    <section
      className="source-merge-suggestion"
      aria-label="来源拍板与合并的关系"
      tabIndex={-1}
      ref={region}
    >
      <p>
        <strong>
          {suggestion.confirmed ? "已确认来源无关" : "PM 建议来源无关"} ·{" "}
          {suggestion.source_decision_id}
        </strong>
      </p>
      <p>{suggestion.rationale}</p>
      {suggestion.confirmed ? (
        <p role="status">
          由本人确认 ·{" "}
          <time dateTime={suggestion.confirmed.at}>
            {new Date(suggestion.confirmed.at).toLocaleString()}
          </time>
        </p>
      ) : suggestion.stale ? (
        <p role="status">建议已失效，请 PM 重新核对</p>
      ) : (
        <button type="button" disabled={busy} onClick={() => void confirm()}>
          确认来源无关
        </button>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
  );
}
