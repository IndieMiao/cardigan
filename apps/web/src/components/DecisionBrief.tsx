import { DECISION_OTHER_OPTION } from "@cardigan/domain";
import type { ReactNode } from "react";
import type { DecisionView } from "../api.js";
import {
  decisionOption,
  decisionOptionNote,
  decisionTitle,
} from "../decision-labels.js";
import { PLAIN_SUMMARY_COPY } from "../plain-summary-copy.js";
import { routeHash } from "../route.js";
import { DecisionAttachments } from "./DecisionAttachments.js";
import { DecisionRouting } from "./DecisionRouting.js";
import { DetailChoice, DetailChoices } from "./layout/CardDetailLayout.js";
import {
  DecisionBriefCriteria,
  DecisionBriefDetails,
  DecisionBriefLayout,
  DecisionBriefMore,
  DecisionBriefOption,
  DecisionBriefOptions,
  DecisionBriefPart,
  DecisionBriefQuestion,
} from "./layout/DecisionBriefLayout.js";
import { Markdown } from "./Operations.js";
import { PlainSummary } from "./PlainSummary.js";

type Option = DecisionView["options"][number];

/**
 * C-810: one decision as Needs You, the card's “下一步” and the timeline all
 * show it. First what to confirm, the attachments as thumbnails, the
 * acceptance criteria and the plain summary; then the options (`children`);
 * last 详细信息, holding who must decide and why, routing, the secondary facts
 * a place passes in `details` and the original context with its internal
 * numbers.
 */
export function DecisionBrief({
  decision,
  projectId,
  question = false,
  details,
  children,
}: {
  readonly decision: DecisionView;
  readonly projectId: string;
  /** Show the question; off where the surrounding row already titles it. */
  readonly question?: boolean;
  readonly details?: ReactNode;
  readonly children?: ReactNode;
}) {
  const cardId = decision.card_id;
  const omitted = decision.attachments_omitted ?? 0;
  const criteria = decision.acceptance_criteria_snapshot ?? [];
  const context = decision.context?.trim() ? decision.context : undefined;
  const routed =
    !!decision.human_required_reason ||
    (decision.decider === "role:pm" && !!decision.delegation_authority);
  return (
    <DecisionBriefLayout aria-label={`拍板内容 ${decision.id}`}>
      {question && (
        <DecisionBriefQuestion>{decisionTitle(decision)}</DecisionBriefQuestion>
      )}
      <DecisionAttachments
        attachments={decision.attachments}
        more={
          omitted > 0 &&
          (cardId ? (
            <DecisionBriefMore
              href={routeHash({
                kind: "card",
                projectId,
                cardId,
                anchor: `card-${cardId}-attachments`,
              })}
            >
              还有 {omitted} 个
            </DecisionBriefMore>
          ) : (
            <span>还有 {omitted} 个</span>
          ))
        }
      />
      {criteria.length > 0 && (
        <DecisionBriefPart title="验收标准">
          <DecisionBriefCriteria>
            {criteria.map((text, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a frozen snapshot; equal criteria may repeat.
              <li key={i}>{text}</li>
            ))}
          </DecisionBriefCriteria>
        </DecisionBriefPart>
      )}
      <PlainSummary id={decision.id} summary={decision.plain_summary} />
      {children}
      {(routed || details || context) && (
        <DecisionBriefDetails summary={PLAIN_SUMMARY_COPY.details}>
          {routed && <DecisionRouting decision={decision} />}
          {details}
          {context && <Markdown body={context} />}
        </DecisionBriefDetails>
      )}
    </DecisionBriefLayout>
  );
}

/** The detail line of an option: a fixed name's stored text, then the impact. */
function optionDetail(q: Pick<DecisionView, "trigger" | "options">, o: Option) {
  if (o.key === DECISION_OTHER_OPTION) return undefined;
  return (
    [decisionOptionNote(q, o.key), o.impact].filter(Boolean).join("；") ||
    undefined
  );
}

/**
 * C-810: the options answered in place (Needs You, “下一步”), by their
 * Chinese names; the stored keys are never shown.
 */
export function DecisionChoices({
  q,
  options,
  name,
  selected,
  onSelect,
  tag,
  detail,
  legend = "选择方案",
  disabled,
  focus = false,
}: {
  readonly q: Pick<DecisionView, "trigger" | "options">;
  readonly options: readonly Option[];
  readonly name: string;
  readonly selected: string;
  readonly onSelect: (key: string) => void;
  readonly tag?: (key: string) => ReactNode;
  /** Replaces the default detail line of an option. */
  readonly detail?: (option: Option) => string | undefined;
  readonly legend?: string;
  readonly disabled?: boolean;
  /** Needs You: “处理” lands on these options. */
  readonly focus?: boolean;
}) {
  return (
    <DetailChoices
      legend={legend}
      disabled={disabled}
      {...(focus ? { "data-needs-focus": "" } : {})}
    >
      {options.map((o) => (
        <DetailChoice
          key={o.key}
          name={name}
          value={o.key}
          checked={selected === o.key}
          onChange={() => onSelect(o.key)}
          label={decisionOption(q, o.key)}
          tags={tag?.(o.key)}
          detail={detail?.(o) ?? optionDetail(q, o)}
        />
      ))}
    </DetailChoices>
  );
}

/** C-810: the options where the decision is not answered (timeline). */
export function DecisionOptionList({
  q,
  tag,
}: {
  readonly q: Pick<DecisionView, "trigger" | "options">;
  readonly tag?: (key: string) => ReactNode;
}) {
  return (
    <DecisionBriefOptions aria-label="选项">
      {q.options.map((o) => (
        <DecisionBriefOption
          key={o.key}
          label={decisionOption(q, o.key)}
          tags={tag?.(o.key)}
          detail={optionDetail(q, o)}
        />
      ))}
    </DecisionBriefOptions>
  );
}
