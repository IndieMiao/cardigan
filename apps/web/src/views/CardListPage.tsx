import { useCallback, useEffect, useRef, useState } from "react";
import {
  type CardFilter,
  type CardiganClient,
  type CardPage,
  type CardView,
  describeError,
} from "../api.js";
import { routeHash } from "../route.js";
import { BOARD_STATUSES, cardStatusLabel, nextOwnersLabel } from "../status.js";

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
}

type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly page: CardPage };

const FILTERS: readonly {
  readonly value: CardFilter;
  readonly label: string;
}[] = [
  { value: "all", label: "全部" },
  { value: "needs_me", label: "等我处理" },
  { value: "agent", label: "等 Agent 处理" },
];

export function CardListPage({ client, projectId, view }: CardListPageProps) {
  const [filter, setFilter] = useState<CardFilter>("all");
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  // Monotonic request id: a slow answer for an abandoned filter must not
  // overwrite the current one.
  const latest = useRef(0);

  const reload = useCallback(() => {
    const request = latest.current + 1;
    latest.current = request;
    setState({ kind: "loading" });
    client.cards(projectId, filter).then(
      (page) => {
        if (latest.current === request) setState({ kind: "ready", page });
      },
      (error: unknown) => {
        if (latest.current === request) {
          setState({ kind: "error", message: describeError(error) });
        }
      },
    );
  }, [client, projectId, filter]);

  useEffect(() => {
    reload();
  }, [reload]);

  const counts = state.kind === "ready" ? state.page.counts : undefined;
  return (
    <section className="cards-page" aria-label="卡片">
      <div className="toolbar">
        <fieldset className="filters">
          <legend className="visually-hidden">筛选</legend>
          {FILTERS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={option.value === filter ? "filter active" : "filter"}
              aria-pressed={option.value === filter}
              onClick={() => setFilter(option.value)}
            >
              {option.label}
              {counts !== undefined && (
                <span className="filter-count">
                  {option.value === "all"
                    ? counts.total
                    : option.value === "needs_me"
                      ? counts.needs_me
                      : counts.agent}
                </span>
              )}
            </button>
          ))}
        </fieldset>
      </div>

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
      {state.kind === "ready" && state.page.cards.length === 0 && (
        <p className="empty">
          {filter === "all"
            ? "这个项目还没有卡片。"
            : filter === "needs_me"
              ? "没有等你处理的卡片。"
              : "没有等 Agent 处理的卡片。"}
        </p>
      )}
      {state.kind === "ready" &&
        state.page.cards.length > 0 &&
        (view === "board" ? (
          <Board cards={state.page.cards} projectId={projectId} />
        ) : (
          <CardTable cards={state.page.cards} projectId={projectId} />
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
              <span className={`status status-${status}`}>
                {cardStatusLabel(status)}
              </span>
              <span className="board-column-count">{column.length}</span>
            </h3>
            {column.length === 0 ? (
              <p className="board-column-empty">没有卡片</p>
            ) : (
              <ul className="board-list">
                {column.map((card) => (
                  <li key={card.id}>
                    <a className="card-tile" href={cardHref(projectId, card)}>
                      <span className="card-id">{card.id}</span>
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
            <td className="card-id">{card.id}</td>
            <td>
              <a href={cardHref(projectId, card)}>{card.title}</a>
            </td>
            <td>
              <span className={`status status-${card.status}`}>
                {cardStatusLabel(card.status)}
              </span>
            </td>
            <td>{nextOwnersLabel(card.next_owners)}</td>
            <td className="card-why">{card.why}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
