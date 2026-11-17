import type { CardView, DependencyCard } from "../api.js";
import { routeHash } from "../route.js";
import { STATUS_LABELS } from "../status.js";
import { IdBadge } from "./IdTag.js";

export function dependencyWaitLabel(
  card: Pick<CardView, "dependency" | "early_start" | "status">,
): string | null {
  if (
    ["done", "cancelled"].includes(card.status) ||
    !card.dependency?.waiting_on.length
  )
    return null;
  return `${card.early_start ? "提前开工 · 完成仍等" : "等"} ${card.dependency.waiting_on.join("、")}`;
}

export function CardDependencies({
  card,
  projectId,
}: {
  card: CardView;
  projectId: string;
}) {
  const dependency = card.dependency;
  if (
    !dependency ||
    (!dependency.predecessors.length && !dependency.successors.length)
  )
    return null;
  const wait = dependencyWaitLabel(card);
  const group = (title: string, cards: readonly DependencyCard[]) =>
    cards.length > 0 && (
      <div className="card-dependency-group">
        <h3>{title}</h3>
        <ul className="card-dependency-list">
          {cards.map((item) => (
            <li key={item.id}>
              <a href={routeHash({ kind: "card", projectId, cardId: item.id })}>
                <IdBadge id={item.id} />
                <span className="card-dependency-title">{item.title}</span>
                <span>
                  {item.resolution === "duplicate"
                    ? "重复"
                    : item.resolution === "wontdo"
                      ? "不做"
                      : (STATUS_LABELS[
                          (item.resolution && item.resolution !== "done"
                            ? item.resolution
                            : item.status) as keyof typeof STATUS_LABELS
                        ] ?? "状态未知")}
                  {item.status === "done" &&
                    !item.satisfied &&
                    (!item.resolution || item.resolution === "done") &&
                    "（待核）"}
                </span>
              </a>
            </li>
          ))}
        </ul>
      </div>
    );
  return (
    <section className="card-section card-dependencies" aria-label="卡片依赖">
      <h2>卡片依赖</h2>
      {wait && <p>{wait}</p>}
      {card.early_start && !wait && <p>提前开工</p>}
      {dependency.critical_path_length > 1 && (
        <p>最长未完成链：{dependency.critical_path_length} 张</p>
      )}
      {group("前置", dependency.predecessors)}
      {group("后续", dependency.successors)}
    </section>
  );
}
