import { reviewImpactLabel } from "@cardigan/domain";
import type {
  MergeConfirmationReview,
  NeedsDecision,
  PreMergeCheckView,
} from "../api.js";
import { EmployeeIdentity } from "../components/EmployeeIdentity.js";
import { IdTag, StatusTag } from "../components/Foundation.js";
import { IdentityRow } from "../components/IdentityRow.js";
import { MergeCheck } from "../components/MergeCheck.js";
import { CardLink } from "../components/Operations.js";
import { DecisionContext } from "../components/PlainSummary.js";
import { PRE_MERGE_COPY } from "../pre-merge-copy.js";
import { routeHash } from "../route.js";

function ReviewLine({ review }: { readonly review: MergeConfirmationReview }) {
  const label =
    [review.work_item_title, review.role_id].filter(Boolean).join(" ") ||
    "验证";
  return (
    <li>
      <IdentityRow className="needs-review-head">
        <EmployeeIdentity {...review} showTitle={false} />
        <IdTag id={review.work_item_id} label={label} />
        <StatusTag status={review.verdict} />
        {review.followup_card_id && (
          <IdTag id={review.followup_card_id} label="后续卡" />
        )}
      </IdentityRow>
      {review.issues.length > 0 && (
        <details className="needs-review-issues">
          <summary>问题（{review.issues.length}）</summary>
          <ul>
            {review.issues.map((issue) => (
              <li key={`${review.id}-${issue.severity}-${issue.description}`}>
                <strong>
                  {issue.must_fix ? "必须修" : "非阻塞"} · {issue.severity}
                  {issue.impact && ` · ${reviewImpactLabel[issue.impact]}`}
                </strong>
                <span>{issue.description}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}
export function PreMergeCheckList({
  checks,
}: {
  checks: readonly PreMergeCheckView[];
}) {
  return (
    <ul className="pre-merge-check-list">
      {checks.map((c) => (
        <li key={c.label}>
          <strong>{c.label}</strong>：{PRE_MERGE_COPY.status[c.status]}
          {c.stale && (
            <span className="hint">（{PRE_MERGE_COPY.staleNote}）</span>
          )}
          {c.note && <span className="hint">（{c.note}）</span>}
        </li>
      ))}
    </ul>
  );
}
/**
 * The folded evidence of a merge confirmation (deliveries, reviews, known
 * gaps, check details, pre-merge checks, context, steps). Needs You shows it
 * under the controls; card details behind the panel's “合并详情” (C-697).
 */
export function MergeEvidence({
  q,
  projectId,
  cardId,
}: {
  readonly q: NeedsDecision;
  readonly projectId: string;
  readonly cardId: string | null;
}) {
  const merge = q.merge_confirmation;
  const check = merge?.merge_check;
  const preChecks = merge?.pre_merge_checks ?? [];
  return (
    <div className="merge-evidence">
      <details
        className="needs-merge-section"
        aria-label="要合并的交付"
        open={!q.plain_summary}
      >
        <summary>要合并的交付（{merge?.deliveries.length ?? 0} 项）</summary>
        {!merge || merge.deliveries.length === 0 ? (
          <p className="hint">还没有可合并的交付。</p>
        ) : (
          <ul className="needs-delivery-list">
            {merge.deliveries.map((delivery) => (
              <li key={delivery.id}>
                <IdentityRow className="needs-delivery-head">
                  <EmployeeIdentity {...delivery} showTitle={false} />
                  <IdTag
                    id={delivery.work_item_id}
                    label={delivery.work_item_title}
                  />
                  <code title={delivery.subject.value}>
                    {delivery.subject.value.slice(0, 12)}
                  </code>
                  {cardId && (
                    <a
                      href={routeHash({
                        kind: "card",
                        projectId,
                        cardId,
                        anchor: `delivery-${delivery.id}`,
                      })}
                    >
                      查看改动
                    </a>
                  )}
                </IdentityRow>
                <p>{delivery.summary}</p>
              </li>
            ))}
          </ul>
        )}
      </details>
      <details className="needs-merge-section" aria-label="审核与验收">
        <summary>审核与验收（{merge?.reviews.length ?? 0} 项）</summary>
        {!merge || merge.reviews.length === 0 ? (
          <p className="hint">还没有审核或验收结论。</p>
        ) : (
          <ul className="needs-review-list">
            {merge.reviews.map((review) => (
              <ReviewLine key={review.id} review={review} />
            ))}
          </ul>
        )}
      </details>
      <details
        className="needs-merge-section"
        aria-label="已知遗留"
        open={!merge?.known_gaps || merge.known_gaps.length > 0}
      >
        <summary>
          已知遗留{" "}
          {merge?.known_gaps ? `${merge.known_gaps.length} 项` : "资料未提供"}
        </summary>
        {!merge?.known_gaps ? (
          <p>遗留资料未提供，不能视为无遗留</p>
        ) : merge.known_gaps.length === 0 ? (
          <p className="hint">没有已知遗留。</p>
        ) : (
          <ul className="needs-gap-list">
            {merge.known_gaps.map((gap) => (
              <li
                key={`${gap.description}-${gap.followup_card_id ?? ""}-${gap.precondition ?? ""}`}
              >
                <span>{gap.description}</span>
                {gap.followup_card_id && (
                  <CardLink
                    projectId={projectId}
                    id={gap.followup_card_id}
                    label="后续卡"
                  />
                )}
                {gap.precondition && (
                  <span className="hint">前置条件：{gap.precondition}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </details>
      {merge?.merge_gate_enabled &&
        !merge.merge_noop &&
        !merge.merge_gate_invalid && (
          <details className="needs-merge-section">
            <summary>合并检查详情</summary>
            <MergeCheck
              check={check ?? null}
              projectId={projectId}
              live
              detailsOnly
            />
          </details>
        )}
      {!!preChecks.length && (
        <details className="needs-merge-section">
          <summary>合并前核对（{preChecks.length} 项）</summary>
          <PreMergeCheckList checks={preChecks} />
        </details>
      )}
      <DecisionContext
        context={q.context}
        summary={q.plain_summary}
        legacy="上下文原文"
      />
      <details className="needs-merge-section">
        <summary>操作说明</summary>
        <ol className="pre-merge-steps">
          {PRE_MERGE_COPY.readySteps(
            !!merge?.merge_gate_enabled && !merge.merge_noop,
          ).map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        <p>两种确认都会记录你的合并决定，“按建议”另记为采纳建议。</p>
      </details>
    </div>
  );
}
