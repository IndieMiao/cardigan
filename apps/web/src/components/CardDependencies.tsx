import { useEffect, useState } from "react";
import {
  type CardiganClient,
  type CardListItem,
  type CardView,
  type DependencyCard,
  describeError,
} from "../api.js";
import {
  dependencyGraphOf,
  dependencyStatusLabel,
  layoutDependencyGraph,
} from "../dependency-graph.js";
import { routeHash } from "../route.js";
import { NextOwners } from "./EmployeeIdentity.js";
import { StatusTag, Time } from "./Foundation.js";
import { IdBadge } from "./IdTag.js";
import {
  CardPeek,
  CardPeekActions,
  CardPeekFact,
  CardPeekFacts,
  CardPeekHeading,
  CardPeekList,
} from "./layout/CardPeekLayout.js";
import {
  DependencyGraph,
  DependencyGraphFacts,
  DependencyGraphNode,
  DependencyGraphNodeHead,
  DependencyGraphNodeTitle,
} from "./layout/DependencyGraphLayout.js";
import { PRIORITY_LEVELS, PriorityGlyph } from "./Priority.js";
import { Button } from "./ui/button.js";

/** Work item states between starting and finishing. */
const ACTIVE_WORK = new Set([
  "in_progress",
  "delivered",
  "changes_requested",
  "blocked",
  "waiting_decision",
  "failed",
]);

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

/** Every card reachable from `start` along `links`. */
function reach(start: string, links: ReadonlyMap<string, readonly string[]>) {
  const seen = new Set<string>();
  const queue = [...(links.get(start) ?? [])];
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    if (seen.has(id) || id === start) continue;
    seen.add(id);
    queue.push(...(links.get(id) ?? []));
  }
  return seen;
}

/**
 * Cards that still hold up the open card: the unmet direct prerequisites, then
 * whatever an open, unmet card among them still waits on. A cancelled or
 * superseded prerequisite never counts as met, so it keeps holding.
 */
function holdingCards(
  waitingOn: readonly string[],
  nodes: readonly DependencyCard[],
  before: ReadonlyMap<string, readonly string[]>,
) {
  const cards = new Map(nodes.map((n) => [n.id, n]));
  const held = new Set<string>();
  const queue = [...waitingOn];
  for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
    const node = cards.get(id);
    if (held.has(id) || node?.satisfied) continue;
    held.add(id);
    // A closed card no longer waits on its own prerequisites.
    if (node && !["done", "cancelled"].includes(node.status))
      queue.push(...(before.get(id) ?? []));
  }
  return held;
}

export function CardDependencies({
  card,
  projectId,
  client,
}: {
  card: CardView;
  projectId: string;
  client: CardiganClient;
}) {
  // One popover at a time, and never carried over to another card's graph.
  const [opened, setOpened] = useState<{ card: string; node: string }>();
  const graph = dependencyGraphOf(card);
  if (!graph || !card.dependency) return null;
  const layout = layoutDependencyGraph(graph, card.id);
  const muted = new Set(
    layout.nodes.filter((n) => n.muted).map((n) => n.card.id),
  );
  const before = new Map<string, string[]>(),
    after = new Map<string, string[]>();
  for (const { from, to } of layout.edges) {
    before.set(to, [...(before.get(to) ?? []), from]);
    after.set(from, [...(after.get(from) ?? []), to]);
  }
  const ancestors = reach(card.id, before),
    descendants = reach(card.id, after),
    closed = ["done", "cancelled"].includes(card.status),
    waiting = new Set(card.dependency.waiting_on),
    holding = holdingCards(
      closed ? [] : card.dependency.waiting_on,
      graph.nodes,
      before,
    );
  const relationOf = (id: string) => {
    const direct = before.get(card.id)?.includes(id);
    if (direct || ancestors.has(id)) {
      const blocking = !closed && (direct ? waiting.has(id) : holding.has(id));
      return `${direct ? "直接" : "间接"}前置，${blocking ? "仍挡着当前卡" : "已不挡"}`;
    }
    if (after.get(card.id)?.includes(id)) return "直接后续";
    if (descendants.has(id)) return "间接后续";
    return "无先后关系";
  };
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
          const open = opened?.card === card.id && opened.node === node.id;
          return (
            <DependencyGraphNode
              key={node.id}
              id={node.id}
              column={column}
              row={row}
              current={current}
              muted={muted}
              open={open}
              onOpenChange={(value) =>
                // A late close from the previous node must not shut this one.
                setOpened((was) =>
                  value
                    ? { card: card.id, node: node.id }
                    : was?.node === node.id
                      ? undefined
                      : was,
                )
              }
              peek={
                <DependencyPeek
                  node={node}
                  status={status}
                  relation={relationOf(node.id)}
                  projectId={projectId}
                  client={client}
                  onLeave={() => setOpened(undefined)}
                />
              }
              tooltip={`${node.id} ${node.title} · ${status}`}
              before={before.get(node.id)}
              after={after.get(node.id)}
            >
              <DependencyGraphNodeHead>
                <IdBadge id={node.id} titled={false} />
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

/** Facts the graph already has show at once; the rest come from one read. */
function DependencyPeek({
  node,
  status,
  relation,
  projectId,
  client,
  onLeave,
}: {
  node: DependencyCard;
  status: string;
  relation: string;
  projectId: string;
  client: CardiganClient;
  onLeave: () => void;
}) {
  const [attempt, setAttempt] = useState(0);
  const [summary, setSummary] = useState<CardListItem>();
  return (
    <CardPeek aria-label={`卡片 ${node.id}`}>
      <CardPeekHeading>
        <IdBadge id={node.id} titled={false} /> {summary?.title ?? node.title}
      </CardPeekHeading>
      <CardPeekFacts>
        <CardPeekFact label="状态">
          <StatusTag status={node.status} label={status} />
        </CardPeekFact>
        <CardPeekFact label="关系">{relation}</CardPeekFact>
        <PeekSummary
          key={attempt}
          id={node.id}
          projectId={projectId}
          client={client}
          onRead={setSummary}
          onRetry={() => setAttempt((n) => n + 1)}
        />
      </CardPeekFacts>
      <CardPeekActions>
        <Button asChild>
          <a
            href={routeHash({ kind: "card", projectId, cardId: node.id })}
            onClick={onLeave}
          >
            打开卡片
          </a>
        </Button>
      </CardPeekActions>
    </CardPeek>
  );
}

function PeekSummary({
  id,
  projectId,
  client,
  onRead,
  onRetry,
}: {
  id: string;
  projectId: string;
  client: CardiganClient;
  onRead: (card: CardListItem) => void;
  onRetry: () => void;
}) {
  const [read, setRead] = useState<
    { card: CardListItem } | { error: string }
  >();
  useEffect(() => {
    const controller = new AbortController();
    client.cards(projectId, "all", { ids: id }, controller.signal).then(
      (page) => {
        if (controller.signal.aborted) return;
        const card = page.cards.find((c) => c.id === id);
        setRead(card ? { card } : { error: "没有找到这张卡" });
        if (card) onRead(card);
      },
      (error: unknown) => {
        if (!controller.signal.aborted)
          setRead({ error: describeError(error) });
      },
    );
    return () => controller.abort();
  }, [client, projectId, id, onRead]);
  if (read && "error" in read)
    return (
      <CardPeekFact label="详情">
        <span role="alert">读取失败：{read.error}</span>
        <Button variant="secondary" onClick={onRetry}>
          重试
        </Button>
      </CardPeekFact>
    );
  const card = read?.card;
  const pending = "读取中…";
  const work =
    card && (card.work_items ?? []).filter((w) => ACTIVE_WORK.has(w.status));
  return (
    <>
      <CardPeekFact label="优先级">
        {card ? (
          <>
            <PriorityGlyph value={card.priority} />
            {PRIORITY_LEVELS[card.priority]?.label ?? "无"}
          </>
        ) : (
          pending
        )}
      </CardPeekFact>
      <CardPeekFact label="负责人">
        {card ? (
          <NextOwners
            owners={card.next_owners}
            empty="无人负责"
            avatarSize={24}
          />
        ) : (
          pending
        )}
      </CardPeekFact>
      <CardPeekFact label="工作项">
        {!work ? (
          pending
        ) : work.length ? (
          <CardPeekList>
            {work.map((item) => (
              <li key={item.id}>
                {item.title}
                <StatusTag status={item.status} />
              </li>
            ))}
          </CardPeekList>
        ) : (
          "无进行中"
        )}
      </CardPeekFact>
      <CardPeekFact label="更新于">
        {card ? <Time value={card.updated_at} /> : pending}
      </CardPeekFact>
    </>
  );
}
