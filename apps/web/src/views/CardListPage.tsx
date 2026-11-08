import { useCallback } from "react";
import type {
  CardFilter,
  CardiganClient,
  CardListItem,
  CardPage,
} from "../api.js";
import { Board } from "../components/Board.js";
import { FilterBar } from "../components/FilterBar.js";
import {
  EmptyState,
  IdTag,
  PageTitle,
  StatusTag,
  Time,
} from "../components/Foundation.js";
import { routeHash, useRouteFilters } from "../route.js";
import { inSnapshotGroup, SNAPSHOT_GROUPS } from "../snapshot-groups.js";
import { BOARD_STATUSES, cardStatusLabel, nextOwnersLabel } from "../status.js";
import { useResource } from "../useResource.js";

/**
 * The board and the list (M5 plan §4 M5.3; Phase 1.5 §4.3).
 *
 * Both views read the same card rows. The list exposes the §4.3 filters in the
 * route, so a copied URL keeps the status, next owner, role, search and sort.
 */

export interface CardListPageProps {
  readonly client: CardiganClient;
  readonly projectId: string;
  readonly view: "board" | "list";
  readonly revision?: number;
}

type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly page: CardPage };

const statusesOf = (value: string | undefined): string[] =>
  (value ?? "").split(",").filter(Boolean);
const idNumber = (id: string): number => {
  const digits = /(\d+)\)?$/.exec(id)?.[1];
  return digits === undefined ? 0 : Number(digits);
};
const nextKind = (card: CardListItem): "human" | "agent" | "none" => {
  if (
    card.next_owners.some((owner) => owner.kind === "human") ||
    card.waiting_on.some(
      (waiting) =>
        waiting.kind === "decision" || waiting.kind === "human_action",
    )
  )
    return "human";
  if (
    card.next_owners.some(
      (owner) => owner.kind === "role" || owner.kind === "assignment",
    )
  )
    return "agent";
  return "none";
};
function filteredCards(
  cards: readonly CardListItem[],
  filters: Readonly<Record<string, string>>,
): readonly CardListItem[] {
  const selected = new Set(statusesOf(filters.status)),
    q = (filters.q ?? "").trim().toLocaleLowerCase(),
    next = filters.next ?? "",
    role = filters.role ?? "";
  const matched = cards.filter(
    (card) =>
      (selected.size === 0 || selected.has(card.status)) &&
      inSnapshotGroup(card, filters.overview ?? "") &&
      (next === "" || nextKind(card) === next) &&
      (role === "" || card.roles.includes(role)) &&
      `${card.id} ${card.title}`.toLocaleLowerCase().includes(q),
  );
  return [...matched].sort((left, right) => {
    if (filters.sort === "id") return idNumber(left.id) - idNumber(right.id);
    if (filters.sort === "priority")
      return (
        right.priority - left.priority || idNumber(left.id) - idNumber(right.id)
      );
    return (
      right.updated_at.localeCompare(left.updated_at) ||
      idNumber(right.id) - idNumber(left.id)
    );
  });
}
export function CardListPage({
  client,
  projectId,
  view,
  revision = 0,
}: CardListPageProps) {
  const [filters, setFilters] = useRouteFilters({ kind: view, projectId });
  const load = useCallback(
    () => client.cards(projectId, "all" as CardFilter),
    [client, projectId],
  );
  const { data, error, reload } = useResource(load, revision);
  const state: LoadState = data
    ? { kind: "ready", page: data }
    : error
      ? { kind: "error", message: error }
      : { kind: "loading" };
  const cards = data ? filteredCards(data.cards, filters) : [];
  const roles = [
    ...new Set((data?.cards ?? []).flatMap((card) => card.roles)),
  ].sort();
  const activeFilters = Object.entries(filters).some(
    ([key, value]) => key !== "expanded" && value,
  );
  return (
    <section className="cards-page" aria-label="卡片">
      <PageTitle
        title={view === "board" ? "看板" : "列表"}
        description="查看卡片进度与下一步负责人。"
      />
      {data && error && (
        <p role="alert" className="error-panel">
          {error}{" "}
          <button type="button" onClick={reload}>
            重试
          </button>
        </p>
      )}
      <FilterBar
        fields={[
          ...(filters.overview
            ? [{ key: "overview", label: "概览", options: SNAPSHOT_GROUPS }]
            : []),
          {
            key: "status",
            label: "状态",
            multiple: true,
            options: BOARD_STATUSES.map((status) => ({
              value: status,
              label: cardStatusLabel(status),
            })),
          },
          {
            key: "next",
            label: "下一步谁做",
            options: [
              { value: "human", label: "你" },
              { value: "agent", label: "Agent" },
              { value: "none", label: "无人" },
            ],
          },
          {
            key: "role",
            label: "角色",
            options: roles.map((role) => ({ value: role, label: role })),
          },
          { key: "q", label: "搜索标题或编号" },
          {
            key: "sort",
            label: "排序",
            options: [
              { value: "updated", label: "更新时间" },
              { value: "id", label: "编号" },
              { value: "priority", label: "优先级" },
            ],
          },
        ]}
        values={filters}
        onChange={setFilters}
      />

      {state.kind === "loading" && (
        <p className="loading" role="status">
          正在加载卡片…
        </p>
      )}
      {state.kind === "error" && (
        <div className="error-panel" role="alert">
          <p>{state.message}</p>
          <button type="button" onClick={reload}>
            重试
          </button>
        </div>
      )}
      {state.kind === "ready" && cards.length === 0 && (
        <EmptyState>
          {activeFilters
            ? "没有匹配的卡片，请调整筛选条件。"
            : "这个项目还没有卡片。向 PM 描述目标后，卡片会出现在这里。"}
        </EmptyState>
      )}
      {state.kind === "ready" &&
        (view === "board" ? (
          <Board
            cards={cards}
            projectId={projectId}
            expanded={filters.expanded ?? ""}
            onExpanded={(expanded) => setFilters({ ...filters, expanded })}
          />
        ) : cards.length > 0 ? (
          <CardTable cards={cards} projectId={projectId} />
        ) : null)}
    </section>
  );
}

function cardHref(projectId: string, card: CardListItem): string {
  return routeHash({ kind: "card", projectId, cardId: card.id });
}

function CardTable({
  cards,
  projectId,
}: {
  readonly cards: readonly CardListItem[];
  readonly projectId: string;
}) {
  return (
    <table className="card-table">
      <thead>
        <tr>
          <th scope="col">编号</th>
          <th scope="col">标题</th>
          <th scope="col">状态</th>
          <th scope="col">下一步</th>
          <th scope="col">进度</th>
          <th scope="col">更新时间</th>
        </tr>
      </thead>
      <tbody>
        {cards.map((card) => (
          <tr key={card.id} title={card.why}>
            <td>
              <IdTag id={card.id} label="卡片" detail={card.title} />
            </td>
            <td>
              <a href={cardHref(projectId, card)} title={card.why}>
                {card.title}
              </a>
            </td>
            <td>
              <StatusTag status={card.status} />
            </td>
            <td>{nextOwnersLabel(card.next_owners)}</td>
            <td>
              {card.progress.completed}/{card.progress.total}
            </td>
            <td>
              <Time value={card.updated_at} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
