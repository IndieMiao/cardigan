import type { CardView } from "../api.js";
import {
  dependencyGraphOf,
  dependencyStatusLabel,
  layoutDependencyGraph,
} from "../dependency-graph.js";
import { routeHash } from "../route.js";
import { StatusTag } from "./Foundation.js";
import { IdBadge } from "./IdTag.js";
import {
  DependencyGraph,
  DependencyGraphFacts,
  DependencyGraphNode,
  DependencyGraphNodeHead,
  DependencyGraphNodeTitle,
} from "./layout/DependencyGraphLayout.js";

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
  const graph = dependencyGraphOf(card);
  if (!graph || !card.dependency) return null;
  const layout = layoutDependencyGraph(graph, card.id);
  const muted = new Set(
    layout.nodes.filter((n) => n.muted).map((n) => n.card.id),
  );
  const wait = dependencyWaitLabel(card);
  const facts = [
    wait ?? (card.early_start ? "提前开工" : null),
    card.dependency.critical_path_length > 1
      ? `最长未完成链：${card.dependency.critical_path_length} 张`
      : null,
  ].filter((fact): fact is string => !!fact);
  return (
    <section className="card-section card-dependencies" aria-label="卡片依赖">
      <h2>卡片依赖</h2>
      {facts.length > 0 && (
        <DependencyGraphFacts>
          {facts.map((fact) => (
            <span key={fact}>{fact}</span>
          ))}
        </DependencyGraphFacts>
      )}
      <DependencyGraph
        label="依赖关系图"
        edges={layout.edges.map((edge) => ({
          ...edge,
          muted: muted.has(edge.from),
        }))}
      >
        {layout.nodes.map(({ card: node, column, row, current, muted }) => {
          const status = dependencyStatusLabel(node);
          return (
            <DependencyGraphNode
              key={node.id}
              id={node.id}
              column={column}
              row={row}
              current={current}
              muted={muted}
              href={routeHash({ kind: "card", projectId, cardId: node.id })}
              tooltip={`${node.id} ${node.title} · ${status}`}
            >
              <DependencyGraphNodeHead>
                <IdBadge id={node.id} />
                <StatusTag
                  status={node.status}
                  label={status}
                  subdued={muted}
                />
              </DependencyGraphNodeHead>
              <DependencyGraphNodeTitle>{node.title}</DependencyGraphNodeTitle>
            </DependencyGraphNode>
          );
        })}
      </DependencyGraph>
    </section>
  );
}
