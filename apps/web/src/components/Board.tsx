import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type { CardListItem } from "../api.js";
import type { CardDisplay } from "../card-display.js";
import { BOARD_STATUSES, cardStatusLabel } from "../status.js";
import { BoardCard } from "./BoardCard.js";
import { StatusTag } from "./Foundation.js";

const BATCH_SIZE = 10;

/** The lane owns its scroll root and batch size; headings stay outside it. */
function BoardLaneCards({
  id,
  label,
  cards,
  collapsed,
  children,
}: {
  id: string;
  label: string;
  cards: readonly CardListItem[];
  collapsed: boolean;
  children: (visibleCards: readonly CardListItem[]) => ReactNode;
}) {
  const [visibleCount, setVisibleCount] = useState(BATCH_SIZE);
  const scroller = useRef<HTMLElement>(null);
  const sentinel = useRef<HTMLButtonElement>(null);
  const hasMore = visibleCount < cards.length;
  useEffect(() => {
    const root = scroller.current;
    const target = sentinel.current;
    if (
      !root ||
      !target ||
      !hasMore ||
      collapsed ||
      typeof IntersectionObserver === "undefined"
    )
      return;
    let active = true;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!active || !entries.some((entry) => entry.isIntersecting)) return;
        // One batch per observation, including browsers that queue callbacks.
        active = false;
        observer.disconnect();
        setVisibleCount(visibleCount + BATCH_SIZE);
      },
      { root, rootMargin: "0px 0px 100px 0px" },
    );
    observer.observe(target);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [visibleCount, hasMore, collapsed]);
  return (
    <section
      id={id}
      className="board-lane-cards"
      ref={scroller}
      hidden={collapsed}
      aria-label={`${label}卡片`}
      tabIndex={collapsed ? undefined : 0}
    >
      {!collapsed && (
        <>
          {children(cards.slice(0, visibleCount))}
          {hasMore ? (
            <button
              ref={sentinel}
              type="button"
              className="quiet board-load-more"
              aria-label={`加载更多${label}卡片`}
              onClick={() => setVisibleCount((count) => count + BATCH_SIZE)}
            >
              加载更多
            </button>
          ) : (
            <p className="board-lane-total">已显示全部 {cards.length} 张</p>
          )}
        </>
      )}
    </section>
  );
}

export function Board({
  cards,
  projectId,
  expanded,
  onExpanded,
  display,
  onOpenCard,
  resetKey = "",
}: {
  cards: readonly CardListItem[];
  projectId: string;
  expanded: string;
  onExpanded: (value: string) => void;
  display: CardDisplay;
  onOpenCard?: (cardId: string, trigger: HTMLElement) => void;
  /** Only filtering/sorting resets batches, not live refresh or the drawer. */
  resetKey?: string;
}) {
  const id = useId();
  const open = new Set(expanded.split(","));
  /** §9 U6a: one row that scrolls inside the board; the hint only flags more columns. */
  const scroller = useRef<HTMLElement>(null);
  const [more, setMore] = useState(false);
  const measure = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    setMore(element.scrollWidth - element.scrollLeft - element.clientWidth > 1);
  }, []);
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.shiftKey || event.deltaX !== 0 || event.deltaY === 0) return;
      const unit =
        event.deltaMode === 1
          ? Number.parseFloat(getComputedStyle(element).lineHeight) || 16
          : event.deltaMode === 2
            ? element.clientWidth
            : 1;
      event.preventDefault();
      element.scrollLeft = Math.max(
        0,
        Math.min(
          element.scrollWidth - element.clientWidth,
          element.scrollLeft + event.deltaY * unit,
        ),
      );
      measure();
    };
    element.addEventListener("scroll", measure, { passive: true });
    element.addEventListener("wheel", onWheel, { passive: false });
    const resize =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(measure);
    resize?.observe(element);
    return () => {
      element.removeEventListener("scroll", measure);
      element.removeEventListener("wheel", onWheel);
      resize?.disconnect();
    };
  }, [measure]);
  // Columns change width when a strip expands or a status fills up.
  useEffect(measure);
  return (
    <>
      <p className="hint board-hint">空列默认收起。</p>
      <div className="board-scroll">
        <section
          className="board"
          ref={scroller}
          aria-label="看板"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: A scroll region needs keyboard scrolling.
          tabIndex={0}
        >
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
                <BoardLaneCards
                  key={resetKey}
                  id={`${id}-${status}`}
                  label={cardStatusLabel(status)}
                  cards={column}
                  collapsed={collapsed}
                >
                  {(visibleCards) =>
                    !column.length ? (
                      <p className="board-column-empty">没有卡片</p>
                    ) : (
                      <ul className="board-list">
                        {visibleCards.map((card) => (
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
                    )
                  }
                </BoardLaneCards>
              </section>
            );
          })}
        </section>
        {more && <span className="board-fade" aria-hidden="true" />}
      </div>
    </>
  );
}
