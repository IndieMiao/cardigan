import type { CardDetail } from "../api.js";
import { decisionOption } from "../decision-labels.js";
import { routeHash } from "../route.js";
import { statusLabel } from "../status.js";
import { LongContent } from "./Foundation.js";

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
    <a key={c.id} href={routeHash({ kind: "card", projectId, cardId: c.id })}>
      {c.id} {c.title}
    </a>
  );
  return (
    <section className="card-source" aria-label="来源和相关卡片">
      {quote && (
        <LongContent lines={2}>
          <blockquote>
            来源：你的原话<p>{quote}</p>
          </blockquote>
        </LongContent>
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
            {parent.decision_id}
          </a>
        </p>
      )}
      {!!related.length && (
        <div className="related-cards">
          相关：{related.slice(0, 3).map(cardLink)}
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
      const review = detail.reviews.find((r) => r.id === entry.review_id);
      const decision = detail.decisions.find((d) => d.id === entry.decision_id);
      const work = detail.work_items.find((w) => w.id === review?.work_item_id);
      const delivery = detail.deliveries.find(
        (d) => d.id === review?.delivery_id,
      );
      const label = review
        ? `${review.id} ${work?.title ?? entry.author_role ?? "审核者"} ${statusLabel(review.verdict)} ${review.delivery_id} ${delivery?.kind === "card_completion" ? "完成申请" : "交付"}${delivery?.status === "superseded" ? "（旧版本）" : ""}`
        : decision
          ? `${decision.id} ${entry.author === "human" ? "你" : (entry.author_role ?? "PM")} ${entry.decision_option ? decisionOption(decision, entry.decision_option) : "已记录拍板结果"}`
          : undefined;
      return label ? [{ entry, label }] : [];
    })
    .slice(0, 3);
  if (!rows.length) return null;
  return (
    <section className="recent-conclusions" aria-label="最近结论">
      <h3>最近结论</h3>
      <ul>
        {rows.map(({ entry, label }) => (
          <li key={entry.id}>
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
