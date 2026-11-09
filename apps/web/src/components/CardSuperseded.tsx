import type { CardView } from "../api.js";
import { routeHash } from "../route.js";

export function CardSuperseded({
  card,
  projectId,
}: {
  card: CardView;
  projectId?: string;
}) {
  if (card.resolution !== "superseded") return null;
  const label = card.superseded_by
    ? `已被 ${card.superseded_by} 取代`
    : "已被取代";
  return (
    <span className="card-superseded-notice">
      {projectId && card.superseded_by ? (
        <a
          href={routeHash({
            kind: "card",
            projectId,
            cardId: card.superseded_by,
          })}
        >
          {label}
        </a>
      ) : (
        label
      )}
    </span>
  );
}
