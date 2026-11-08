import { useId } from "react";
import type { CardListItem } from "../api.js";
import { routeHash } from "../route.js";
import { BOARD_STATUSES, cardStatusLabel, nextOwnersLabel } from "../status.js";
import { IdTag, StatusTag, Time } from "./Foundation.js";

export function Board({
  cards,
  projectId,
  expanded,
  onExpanded,
}: {
  cards: readonly CardListItem[];
  projectId: string;
  expanded: string;
  onExpanded: (value: string) => void;
}) {
  const id = useId();
  const open = new Set(expanded.split(","));
  return (
    <>
      <p className="hint board-hint">列按状态顺序自动换行，空列默认收起。</p>
      <div className="board">
        {BOARD_STATUSES.map((status) => {
          const column = cards.filter((c) => c.status === status),
            collapsed = !column.length && !open.has(status);
          const toggle = () => {
            if (open.has(status)) open.delete(status);
            else open.add(status);
            onExpanded(BOARD_STATUSES.filter((s) => open.has(s)).join(","));
          };
          return (
            <section
              key={status}
              className={`board-column${collapsed ? " board-column-collapsed" : ""}`}
              aria-label={cardStatusLabel(status)}
            >
              <h3 className="board-column-title">
                {!column.length ? (
                  <button
                    type="button"
                    className="quiet column-toggle"
                    aria-label={`${collapsed ? "展开" : "收起"}${cardStatusLabel(status)}空列`}
                    aria-expanded={!collapsed}
                    aria-controls={`${id}-${status}`}
                    onClick={toggle}
                  >
                    <StatusTag status={status} />
                    <span className="board-column-count">0</span>
                    <span aria-hidden="true">{collapsed ? "+" : "−"}</span>
                  </button>
                ) : (
                  <>
                    <StatusTag status={status} />
                    <span className="board-column-count">{column.length}</span>
                  </>
                )}
              </h3>
              <div id={`${id}-${status}`} hidden={collapsed}>
                {collapsed ? null : !column.length ? (
                  <p className="board-column-empty">没有卡片</p>
                ) : (
                  <ul className="board-list">
                    {column.map((card) => {
                      const reasons = new Set(
                        card.waiting_on.map((w) => w.kind),
                      );
                      const blocked = reasons.has("blocked");
                      const decision = reasons.has("decision");
                      const humanAction = reasons.has("human_action");
                      return (
                        <li key={card.id}>
                          <a
                            className={`card-tile${blocked ? " card-tile-blocked" : decision || humanAction ? " card-tile-waiting" : ""}`}
                            href={routeHash({
                              kind: "card",
                              projectId,
                              cardId: card.id,
                            })}
                          >
                            <IdTag
                              id={card.id}
                              label="卡片"
                              detail={card.title}
                            />
                            <span className="card-title">{card.title}</span>
                            {(blocked || decision || humanAction) && (
                              <span className="metadata">
                                {decision && (
                                  <span className="status status-waiting">
                                    等你拍板
                                  </span>
                                )}
                                {humanAction && (
                                  <span className="status status-waiting">
                                    待你执行
                                  </span>
                                )}
                                {blocked && <StatusTag status="blocked" />}
                              </span>
                            )}
                            <span className="card-why">{card.why}</span>
                            <span>
                              负责角色：{card.roles.join("、") || "尚未配置"}
                            </span>
                            <span>
                              进度：{card.progress.completed}/
                              {card.progress.total} 工作项完成
                            </span>
                            <span>
                              更新于 <Time value={card.updated_at} />
                            </span>
                            <span className="card-next">
                              下一步：{nextOwnersLabel(card.next_owners)}
                            </span>
                          </a>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </>
  );
}
