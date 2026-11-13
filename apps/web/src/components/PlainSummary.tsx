import type { PlainSummaryView } from "../api.js";
import { noRisk, PLAIN_SUMMARY_COPY } from "../plain-summary-copy.js";
import { Markdown } from "./Operations.js";

/**
 * C-202: the plain-language summary shown first on a decision: what changed,
 * the impact on the human, and the risk (flagged unless it is "无"). Older
 * decisions have none and render nothing here.
 */
export function PlainSummary({
  id,
  summary,
  compact = false,
  omitRisk = false,
}: {
  readonly id: string;
  readonly summary: PlainSummaryView | undefined;
  /** Sidebar lists: smaller type, same three rows. */
  readonly compact?: boolean;
  /** The card header already displays this risk. */
  readonly omitRisk?: boolean;
}) {
  if (!summary) return null;
  return (
    <section
      className={`plain-summary${compact ? " compact" : ""}`}
      aria-label={`${id} ${PLAIN_SUMMARY_COPY.region}`}
    >
      <dl>
        <div>
          <dt>{PLAIN_SUMMARY_COPY.changed}</dt>
          <dd>{summary.changed}</dd>
        </div>
        <div>
          <dt>{PLAIN_SUMMARY_COPY.impact}</dt>
          <dd>{summary.impact}</dd>
        </div>
        {!omitRisk && <PlainSummaryRisk risk={summary.risk} />}
      </dl>
    </section>
  );
}

/** Shared with the card header so the risk is visible only once. */
export function PlainSummaryRisk({ risk }: { readonly risk: string }) {
  const risky = !noRisk(risk);
  return (
    <div
      className={risky ? "plain-summary-risk risky" : "plain-summary-risk"}
      {...(risky ? { role: "note" } : {})}
    >
      <dt>{PLAIN_SUMMARY_COPY.risk}</dt>
      <dd>
        {risky && (
          <strong className="plain-summary-flag">
            {PLAIN_SUMMARY_COPY.riskFlag}
          </strong>
        )}
        {risk}
      </dd>
    </div>
  );
}

/**
 * C-202: with a plain summary the original context folds into "详细信息";
 * without one (older decisions) it shows exactly as before, under `legacy`.
 */
export function DecisionContext({
  context,
  summary,
  legacy,
}: {
  readonly context: string | undefined;
  readonly summary: PlainSummaryView | undefined;
  /** Label of the pre-C-202 fold; `null` means older decisions show none. */
  readonly legacy: string | null;
}) {
  if (!context?.trim()) return null;
  const label = summary ? PLAIN_SUMMARY_COPY.details : legacy;
  if (!label) return null;
  return (
    <details className="needs-context">
      <summary>{label}</summary>
      <Markdown body={context} />
    </details>
  );
}
