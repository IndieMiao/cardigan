import type { DecisionHistoryRecord } from "../api.js";
import { categoryLabels, decisionOption } from "../decision-labels.js";
import { DecisionRouting } from "./DecisionRouting.js";
import { EmployeeIdentity } from "./EmployeeIdentity.js";
import { StatusTag, Time } from "./Foundation.js";
import { CardDetailLayout } from "./layout/CardDetailLayout.js";
import { CardLink, Markdown } from "./Operations.js";
import { DecisionContext, PlainSummary } from "./PlainSummary.js";

export const decisionMakerLabels: Readonly<
  Record<DecisionHistoryRecord["decision_maker"], string>
> = { human: "所有者", pm: "PM 代拍", system: "系统代批" };

export function decisionCards(q: DecisionHistoryRecord): string[] {
  return [...new Set([...(q.card_id ? [q.card_id] : []), ...q.affected_cards])];
}

/** C-457: one resolved decision in the shared detail drawer layout. */
export function DecisionHistoryDetail({
  q,
  projectId,
}: {
  q: DecisionHistoryRecord;
  projectId: string;
}) {
  return (
    <CardDetailLayout
      className="card-page-drawer"
      aria-label={`拍板记录 ${q.id} 详情`}
    >
      <div className="card-metadata">
        <StatusTag status={q.status} />
        <span>{decisionMakerLabels[q.decision_maker]}</span>
        <span>{categoryLabels[q.category] ?? q.category}</span>
        <Time value={q.resolution.at} />
        {decisionCards(q).map((id) => (
          <CardLink key={id} projectId={projectId} id={id} />
        ))}
      </div>
      <DecisionRouting decision={q} />
      <div className="card-purpose">
        {q.plain_summary && (
          <section>
            <h2>人话概述</h2>
            <PlainSummary id={q.id} summary={q.plain_summary} />
          </section>
        )}
        <DecisionContext
          context={q.context}
          summary={q.plain_summary}
          legacy="详细信息"
        />
        <section aria-label="选项">
          <h2>选项</h2>
          <dl className="questions">
            {q.options.map((o) => (
              <div key={o.key}>
                <dt>
                  {decisionOption(q, o.key)}
                  {o.key === q.recommended ? "（推荐）" : ""}
                  {o.key === q.resolution.option ? "（已选）" : ""}
                </dt>
                <dd>影响：{o.impact || "—"}</dd>
              </div>
            ))}
          </dl>
        </section>
        <section aria-label="结果">
          <h2>结果</h2>
          <dl className="questions">
            <div>
              <dt>所选方案</dt>
              <dd>{decisionOption(q, q.resolution.option)}</dd>
            </div>
            <div>
              <dt>理由</dt>
              <dd>
                <Markdown body={q.resolution.rationale} />
              </dd>
            </div>
            {q.resolution.proxy_authority && (
              <div>
                <dt>授权依据</dt>
                <dd>{q.resolution.proxy_authority}</dd>
              </div>
            )}
            <div>
              <dt>记录人</dt>
              <dd>
                <EmployeeIdentity
                  {...q.resolution}
                  author={q.resolution.resolved_by}
                  showTitle={false}
                />
              </dd>
            </div>
          </dl>
        </section>
      </div>
    </CardDetailLayout>
  );
}
