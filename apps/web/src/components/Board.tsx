import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { CardListItem } from "../api.js";
import type { CardDisplay } from "../card-display.js";
import { BOARD_STATUSES, cardStatusLabel } from "../status.js";
import { BoardCard } from "./BoardCard.js";
import { StatusTag } from "./Foundation.js";

export function Board({
  cards,
  projectId,
  expanded,
  onExpanded,
  display,
  onOpenCard,
}: {
  cards: readonly CardListItem[];
  projectId: string;
  expanded: string;
  onExpanded: (value: string) => void;
  display: CardDisplay;
  onOpenCard?: (cardId: string, trigger: HTMLElement) => void;
}) {
  const id = useId();
  const open = new Set(expanded.split(","));
  /** §9 U6a: one row that scrolls inside the board; the hint only flags more columns. */
  const scroller = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  const measure = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    setMore(element.scrollWidth - element.scrollLeft - element.clientWidth > 1);
  }, []);
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    element.addEventListener("scroll", measure, { passive: true });
    const resize =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(measure);
    resize?.observe(element);
    return () => {
      element.removeEventListener("scroll", measure);
      resize?.disconnect();
    };
  }, [measure]);
  // Columns change width when a strip expands or a status fills up.
  useEffect(measure);
  return (
    <>
      <p className="hint board-hint">空列默认收起。</p>
      <div className="board-scroll">
        <div className="board" ref={scroller}>
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
                      {!collapsed && <span aria-hidden="true">−</span>}
                    </button>
                  ) : (
                    <>
                      <StatusTag status={status} />
                      <span className="board-column-count">
                        {column.length}
                      </span>
                    </>
                  )}
                </h3>
                <div id={`${id}-${status}`} hidden={collapsed}>
                  {collapsed ? null : !column.length ? (
                    <p className="board-column-empty">没有卡片</p>
                  ) : (
                    <ul className="board-list">
                      {column.map((card) => (
                        <li key={card.id}>
                          <BoardCard
                            card={card}
                            projectId={projectId}
                            display={display}
                            onOpenCard={onOpenCard}
                          />
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </section>
            );
          })}
        </div>
        {more && <span className="board-fade" aria-hidden="true" />}
      </div>
    </>
  );
}
