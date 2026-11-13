import type { DecisionView } from "../api.js";
import { routeHash } from "../route.js";
import { StatusTag } from "./Foundation.js";
import { IdBadge } from "./IdTag.js";

export function DecisionAffectedCards({
  decision,
  projectId,
}: {
  readonly decision: DecisionView | undefined;
  readonly projectId: string;
}) {
  const cards = (decision?.affected_card_views ?? []).filter(
    (card) => card.id !== decision?.card_id,
  );
  if (!cards.length) return null;
  return (
    <div className="decision-affected-cards">
      <span>影响：</span>
      <ul aria-label="影响的卡片">
        {cards.map((card) => (
          <li key={card.id}>
            <a
              className="decision-affected-card"
              href={routeHash({ kind: "card", projectId, cardId: card.id })}
              title={`${card.id} ${card.title}`}
            >
              <IdBadge id={card.id} />{" "}
              <span className="decision-affected-title">{card.title}</span>{" "}
              <StatusTag status={card.status} />
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
