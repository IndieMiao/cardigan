import { useCallback } from "react";
import type { CardFilter, CardiganClient, CardPage, CardView } from "../api.js";
import { FilterBar } from "../components/FilterBar.js";
import {
  EmptyState,
  IdTag,
  PageTitle,
  StatusTag,
} from "../components/Foundation.js";
import { routeHash, useRouteFilters } from "../route.js";
import { BOARD_STATUSES, cardStatusLabel, nextOwnersLabel } from "../status.js";
import { useResource } from "../useResource.js";

/**
 * The board and the list (M5 plan §4 M5.3; development plan §8.7).
 *
 * Both views are the same data: `GET /api/projects/:id/cards?filter=…` returns
 * every card with its domain-derived status, `why` and next owners, so the
 * board only groups by status and the list only prints one row per card. The
 * two filters are the ones the plan names: 等我处理 and 等 Agent 处理.
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

export function CardListPage({
  client,
  projectId,
  view,
  revision = 0,
}: CardListPageProps) {
  const [filters, setFilters] = useRouteFilters({ kind: view, projectId });
  const filter: CardFilter =
    filters.filter === "needs_me" || filters.filter === "agent"
      ? filters.filter
      : "all";
  const load = useCallback(
    () => client.cards(projectId, filter),
    [client, projectId, filter],
  );
  const { data, error, reload } = useResource(load, revision);
  const state: LoadState = data
    ? { kind: "ready", page: data }
    : error
      ? { kind: "error", message: error }
      : { kind: "loading" };
  const cards =
    data?.cards.filter((c) =>
      `${c.id} ${c.title}`
        .toLocaleLowerCase()
        .includes((filters.q ?? "").trim().toLocaleLowerCase()),
    ) ?? [];
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
          {
            key: "filter",
            label: "下一步",
            options: [
              { value: "needs_me", label: "等我处理" },
              { value: "agent", label: "等 Agent 处理" },
            ],
          },
          { key: "q", label: "搜索标题或编号" },
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
          {filters.q
            ? "没有匹配的卡片，请调整筛选条件。"
            : filter === "all"
              ? "这个项目还没有卡片。向 PM 描述目标后，卡片会出现在这里。"
              : filter === "needs_me"
                ? "没有等你处理的卡片。有事项需要你时会出现在这里。"
                : "没有等 Agent 处理的卡片。指派工作后可在这里查看。"}
        </EmptyState>
      )}
      {state.kind === "ready" &&
        cards.length > 0 &&
        (view === "board" ? (
          <Board cards={cards} projectId={projectId} />
        ) : (
          <CardTable cards={cards} projectId={projectId} />
        ))}
    </section>
  );
}

function cardHref(projectId: string, card: CardView): string {
  return routeHash({ kind: "card", projectId, cardId: card.id });
}

function Board({
  cards,
  projectId,
}: {
  readonly cards: readonly CardView[];
  readonly projectId: string;
}) {
  return (
    <div className="board">
      {BOARD_STATUSES.map((status) => {
        const column = cards.filter((card) => card.status === status);
        return (
          <section
            className="board-column"
            key={status}
            aria-label={cardStatusLabel(status)}
          >
            <h3 className="board-column-title">
              <StatusTag status={status} />
              <span className="board-column-count">{column.length}</span>
            </h3>
            {column.length === 0 ? (
              <p className="board-column-empty">没有卡片</p>
            ) : (
              <ul className="board-list">
                {column.map((card) => (
                  <li key={card.id}>
                    <a className="card-tile" href={cardHref(projectId, card)}>
                      <IdTag id={card.id} label="卡片" detail={card.title} />
                      <span className="card-title">{card.title}</span>
                      <span className="card-why">{card.why}</span>
                      <span className="card-next">
                        下一步：{nextOwnersLabel(card.next_owners)}
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

function CardTable({
  cards,
  projectId,
}: {
  readonly cards: readonly CardView[];
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
          <th scope="col">原因</th>
        </tr>
      </thead>
      <tbody>
        {cards.map((card) => (
          <tr key={card.id}>
            <td>
              <IdTag id={card.id} label="卡片" detail={card.title} />
            </td>
            <td>
              <a href={cardHref(projectId, card)}>{card.title}</a>
            </td>
            <td>
              <StatusTag status={card.status} />
            </td>
            <td>{nextOwnersLabel(card.next_owners)}</td>
            <td className="card-why">{card.why}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
