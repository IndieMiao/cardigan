import type { CardDetail, RiskTag } from "../api.js";
import { decisionOption } from "../decision-labels.js";
import { routeHash } from "../route.js";
import { statusLabel } from "../status.js";
import { SystemAvatar } from "./EmployeeIdentity.js";
import { LongContent } from "./Foundation.js";
import { IdBadge } from "./IdTag.js";
import { StatusIcon } from "./StatusIcon.js";
import { Prose } from "./ui/prose.js";

export function CardSource({
  detail,
  projectId,
}: {
  detail: CardDetail;
  projectId: string;
}) {
  const source = detail.card.source,
    parent = detail.relations.source_card;
  const related = detail.relations.cards;
  const quote = source?.kind === "quote" ? source.text.trim() : "";
  if (!quote && !parent && !related.length) return null;
  const cardLink = (c: { id: string; title: string }) => (
    <a
      aria-label={`${c.id} ${c.title}`}
      title={c.title}
      key={c.id}
      href={routeHash({ kind: "card", projectId, cardId: c.id })}
    >
      <IdBadge id={c.id} />
      <span className="related-card-title">{c.title}</span>
    </a>
  );
  return (
    <section className="card-source" aria-label="来源和相关卡片">
      <h2 className="card-background-summary">
        <span>背景</span>
        <span>
          {[
            quote ? "来源原话" : parent ? "拍板来源" : undefined,
            related.length ? `${related.length}张相关卡片` : undefined,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </h2>
      {quote && (
        <blockquote>
          <LongContent>
            <Prose text={quote}>
              <p>{quote}</p>
            </Prose>
          </LongContent>
        </blockquote>
      )}
      {parent && (
        <p>
          来自 {cardLink(parent)} 的拍板{" "}
          <a
            href={routeHash({
              kind: "card",
              projectId,
              cardId: parent.id,
              anchor: `decision-${parent.decision_id}`,
            })}
          >
            <IdBadge id={parent.decision_id} />
          </a>
        </p>
      )}
      {!!related.length && (
        <div className="related-cards">
          <span>相关：</span>
          {related.slice(0, 3).map(cardLink)}
          {related.length > 3 && (
            <details>
              <summary>另外 {related.length - 3} 张</summary>
              {related.slice(3).map(cardLink)}
            </details>
          )}
        </div>
      )}
    </section>
  );
}

/** C-197 / Q-279: fixed Chinese copy; internal enum names never reach the page. */
const RISK_TAG_LABELS: Readonly<Record<RiskTag, string>> = {
  security: "安全",
  permission: "权限",
  numeric_rule: "数值规则",
};

/** Read-only risk tags; nothing renders when the card has none. */
export function CardRiskTags({
  tags,
}: {
  tags: readonly RiskTag[] | undefined;
}) {
  const labels = (tags ?? []).flatMap((tag) => {
    const label = RISK_TAG_LABELS[tag];
    return label ? [label] : [];
  });
  if (!labels.length) return null;
  return <span className="card-risk-tags">风险标签：{labels.join("、")}</span>;
}

export function RecentConclusions({
  detail,
  projectId,
  onLocate,
}: {
  detail: CardDetail;
  projectId: string;
  onLocate: ((anchor: string) => void) | undefined;
}) {
  const rows = (detail.recent_conclusions ?? [])
    .flatMap((entry) => {
      const summary = detail.overview?.conclusion_reviews.find(
        (r) => r.id === entry.review_id,
      );
      const full = detail.reviews.find((r) => r.id === entry.review_id);
      const review = summary ?? full;
      const decision = detail.decisions.find((d) => d.id === entry.decision_id);
      const work = detail.work_items.find((w) => w.id === full?.work_item_id);
      const delivery = detail.deliveries.find(
        (d) => d.id === review?.delivery_id,
      );
      const label = review
        ? `${review.id} ${summary?.work_title ?? work?.title ?? entry.author_role ?? "审核者"} ${statusLabel(review.verdict)} ${review.delivery_id} ${(summary?.delivery_kind ?? delivery?.kind) === "card_completion" ? "完成申请" : "交付"}${(summary?.delivery_status ?? delivery?.status) === "superseded" ? "（旧版本）" : ""}`
        : decision
          ? `${decision.id} ${entry.author_display ?? (entry.author === "human" ? "所有者" : (entry.author_role ?? "PM"))} ${entry.decision_option ? decisionOption(decision, entry.decision_option) : "已记录拍板结果"}`
          : undefined;
      return label
        ? [{ entry, label, tone: review?.verdict ?? decision?.status }]
        : [];
    })
    .slice(0, 3);
  if (!rows.length) return null;
  return (
    <section className="recent-conclusions" aria-label="最近结论">
      <h2>最近结论</h2>
      <ul>
        {rows.map(({ entry, label, tone }) => (
          <li key={entry.id}>
            <StatusIcon status={tone ?? "unknown"} decorative />
            {entry.author === "system" && <SystemAvatar />}
            <a
              title={label}
              href={routeHash({
                kind: "card",
                projectId,
                cardId: detail.card.id,
                anchor: `entry-${entry.id}`,
              })}
              onClick={
                onLocate
                  ? (event) => {
                      event.preventDefault();
                      onLocate(`entry-${entry.id}`);
                    }
                  : undefined
              }
            >
              {label}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
