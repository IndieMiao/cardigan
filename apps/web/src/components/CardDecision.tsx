import { DECISION_OTHER_OPTION, humanDecisionOptions } from "@cardigan/domain";
import { type ReactNode, useRef, useState } from "react";
import {
  type CardiganClient,
  type DecisionView,
  describeWriteError,
} from "../api.js";
import { PLAIN_SUMMARY_COPY } from "../plain-summary-copy.js";
import { SUGGESTION_COPY } from "../suggestion-copy.js";
import { usePrefilledReason } from "./DecisionSuggestion.js";
import { StatusTag } from "./Foundation.js";
import {
  DetailChoice,
  DetailChoiceField,
  DetailChoiceForm,
  DetailChoices,
  DetailChoiceTag,
  DetailNextStepFeedback,
  DetailNextStepLine,
} from "./layout/CardDetailLayout.js";
import { PlainSummaryRisk } from "./PlainSummary.js";
import { RequestFeedback } from "./RequestFeedback.js";
import { Button } from "./ui/button.js";
import { Textarea } from "./ui/textarea.js";

/**
 * Decisions whose answer needs more than one option and words (review limits,
 * rework of an accepted delivery, worktree cleanup, merge confirmations,
 * grouped questions) keep their dedicated controls in Needs You.
 */
const NEEDS_YOU_ONLY = new Set([
  "merge_confirmation",
  "review_limit",
  "accepted_delivery_rework",
  "worktree_cleanup",
]);

/** C-698: a decision the “下一步” panel can answer in place. */
export function decidableInCard(
  q: DecisionView | undefined,
): q is DecisionView {
  return (
    !!q &&
    q.decider === "human" &&
    ["open", "provisional", "snoozed"].includes(q.status) &&
    !NEEDS_YOU_ONLY.has(q.trigger ?? "") &&
    !q.grouped_decisions?.length
  );
}

/**
 * C-698: answer a decision inside “下一步”: every option plus the system
 * “其他（自己填写）” (C-682), a fresh suggestion preselected, “确认选择”
 * submits. Same write and option rules as the Needs You decision row
 * (`recordDecision`); nothing is written until the button is pressed, and a
 * failure stays in the panel with the selection kept.
 */
export function useCardDecision({
  q,
  client,
  projectId,
  onSaved,
  busy = false,
}: {
  readonly q: DecisionView | undefined;
  readonly client: CardiganClient;
  readonly projectId: string;
  readonly onSaved: () => void;
  /** Another card form is open: the write waits. */
  readonly busy?: boolean;
}): { readonly body: ReactNode; readonly action: ReactNode } | undefined {
  const [picked, setPicked] = useState<{ id: string; option: string }>();
  const [words, setWords] = useState<{ id: string; text: string }>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const sending = useRef(false);
  const keys = useRef(new Map<string, string>());
  const suggestion = q?.suggestion;
  const fresh = suggestion && !suggestion.stale ? suggestion : undefined;
  const [reason, setReason] = usePrefilledReason(fresh);
  if (!decidableInCard(q)) return undefined;
  const options = humanDecisionOptions(q.options);
  const known = (key: string | undefined) =>
    !!key && options.some((o) => o.key === key);
  // A fresh suggestion without newer progress is the default; with progress
  // or a stale suggestion the human picks.
  const preset =
    fresh && !fresh.progress && known(fresh.option) ? fresh.option : "";
  const selected =
    picked?.id === q.id && known(picked.option) ? picked.option : preset;
  const other = selected === DECISION_OTHER_OPTION;
  const returning =
    !!fresh &&
    selected === fresh.option &&
    fresh.option === "request_changes" &&
    fresh.return_reason !== undefined;
  const typed = words?.id === q.id ? words.text : "";
  const quote = other ? typed : returning ? reason : "";
  const formId = `card-decision-${q.id}`;
  const submit = async () => {
    if (sending.current || !selected || (other && !quote.trim())) return;
    sending.current = true;
    const request = JSON.stringify([projectId, q.id, selected, quote]);
    const key = keys.current.get(request) ?? crypto.randomUUID();
    keys.current.set(request, key);
    setPending(true);
    setError("");
    setMessage("");
    try {
      await client.recordDecision(projectId, q.id, selected, quote, key);
      keys.current.delete(request);
      setMessage("已提交");
      onSaved();
    } catch (cause) {
      setError(describeWriteError(cause));
    } finally {
      sending.current = false;
      setPending(false);
    }
  };
  const label = (key: string) =>
    options.find((o) => o.key === key)?.description ?? key;
  const summary = q.plain_summary;
  const body = (
    <DetailChoiceForm
      id={formId}
      aria-label={`拍板 ${q.id}`}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <DetailNextStepLine strong>{q.question}</DetailNextStepLine>
      {q.human_required_reason && (
        <DetailNextStepLine>
          须由你亲自决定：{q.human_required_reason}
        </DetailNextStepLine>
      )}
      {summary && (
        <>
          <DetailNextStepLine>
            <dl>
              <dt>{PLAIN_SUMMARY_COPY.impact}</dt>
              <dd>{summary.impact}</dd>
            </dl>
          </DetailNextStepLine>
          <DetailNextStepLine>
            <dl>
              <PlainSummaryRisk risk={summary.risk} />
            </dl>
          </DetailNextStepLine>
        </>
      )}
      {suggestion && (
        <DetailNextStepLine>
          <span>
            {SUGGESTION_COPY.line(
              label(suggestion.option),
              suggestion.rationale,
            )}
          </span>
          {suggestion.stale && (
            <StatusTag status="superseded" label={SUGGESTION_COPY.stale} />
          )}
          {!suggestion.stale && suggestion.progress && (
            <span>{SUGGESTION_COPY.progress(suggestion.progress.count)}</span>
          )}
        </DetailNextStepLine>
      )}
      <DetailChoices legend="选择方案" disabled={pending}>
        {options.map((o) => (
          <DetailChoice
            key={o.key}
            name={`card-decision-${q.id}`}
            value={o.key}
            checked={selected === o.key}
            onChange={() => setPicked({ id: q.id, option: o.key })}
            label={o.description}
            tags={
              suggestion?.option === o.key ? (
                <DetailChoiceTag>建议</DetailChoiceTag>
              ) : (
                !suggestion &&
                q.recommended === o.key && (
                  <DetailChoiceTag>推荐</DetailChoiceTag>
                )
              )
            }
            detail={o.key === DECISION_OTHER_OPTION ? undefined : o.impact}
          />
        ))}
      </DetailChoices>
      {other && (
        <DetailChoiceField
          label="你的决定（必填，会作为你的原话记录）"
          htmlFor={`${formId}-words`}
        >
          <Textarea
            id={`${formId}-words`}
            required
            aria-label={`${q.id} 你的决定`}
            value={typed}
            disabled={pending}
            onChange={(event) =>
              setWords({ id: q.id, text: event.target.value })
            }
          />
        </DetailChoiceField>
      )}
      {returning && (
        <DetailChoiceField
          label={SUGGESTION_COPY.returnReason}
          htmlFor={`${formId}-reason`}
        >
          <Textarea
            id={`${formId}-reason`}
            aria-label={`${q.id} 建议的退回原因`}
            value={reason}
            disabled={pending}
            onChange={(event) => setReason(event.target.value)}
          />
        </DetailChoiceField>
      )}
      <DetailNextStepFeedback>
        <RequestFeedback
          interactive
          pending={pending}
          pendingMessage="提交中…"
          error={error}
          message={message}
        />
      </DetailNextStepFeedback>
    </DetailChoiceForm>
  );
  const action = (
    <Button
      type="submit"
      form={formId}
      size="regular"
      variant="emphasis"
      disabled={pending || busy || !selected}
    >
      确认选择
    </Button>
  );
  return { body, action };
}
