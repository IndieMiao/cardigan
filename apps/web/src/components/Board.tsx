import {
  type MouseEvent,
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
import { useBoardPan } from "../useBoardPan.js";
import { BoardCard } from "./BoardCard.js";
import { StatusTag } from "./Foundation.js";
import { Tooltip } from "./Tooltip.js";
import { Button } from "./ui/button.js";

const BATCH_SIZE = 10;
type RemoteLane = {
  total: number;
  held_total?: number;
  next_cursor: string | null;
};
type RemoteBoard = {
  lanes: Readonly<Record<string, RemoteLane>>;
  pending: boolean;
  load: (status: string) => void;
};

/** Board lane settings: true = folded, false = unfolded; missing = default. */
export type BoardLanes = Readonly<Record<string, boolean>>;

/** Empty lanes start folded unless the human has set the lane by hand. */
export function laneCollapsed(
  lanes: BoardLanes,
  status: string,
  count: number,
): boolean {
  return Object.hasOwn(lanes, status) ? lanes[status] === true : count === 0;
}

const laneIcon = (path: string) => (
  <svg
    className="lane-toggle-icon"
    viewBox="0 0 20 20"
    width="16"
    height="16"
    aria-hidden="true"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d={path} />
  </svg>
);
// Original geometry in the StatusIcon stroke style: two chevrons meeting on a
// centre rule (fold) or leaving it (unfold).
const FoldIcon = () =>
  laneIcon("M10 3v14M3 6.5 6.5 10 3 13.5M17 6.5 13.5 10l3.5 3.5");
const UnfoldIcon = () =>
  laneIcon("M10 3v14M6.5 6.5 3 10l3.5 3.5M13.5 6.5 17 10l-3.5 3.5");

/** The lane owns its scroll root and batch size; headings stay outside it. */
function BoardLaneCards({
  id,
  label,
  cards,
  collapsed,
  remote,
  children,
}: {
  id: string;
  label: string;
  cards: readonly CardListItem[];
  collapsed: boolean;
  remote?:
    | { total: number; hasMore: boolean; pending: boolean; load: () => void }
    | undefined;
  children: (visibleCards: readonly CardListItem[]) => ReactNode;
}) {
  const [visibleCount, setVisibleCount] = useState(BATCH_SIZE);
  const scroller = useRef<HTMLElement>(null);
  const sentinel = useRef<HTMLButtonElement>(null);
  const hasMore = remote ? remote.hasMore : visibleCount < cards.length;
  const loadMore = () =>
    remote ? remote.load() : setVisibleCount((count) => count + BATCH_SIZE);
  useEffect(() => {
    const root = scroller.current;
    const target = sentinel.current;
    if (
      !root ||
      !target ||
      !hasMore ||
      remote?.pending ||
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
        if (remote) remote.load();
        else setVisibleCount(visibleCount + BATCH_SIZE);
      },
      { root, rootMargin: "0px 0px 100px 0px" },
    );
    observer.observe(target);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [visibleCount, hasMore, collapsed, remote]);
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
          {children(remote ? cards : cards.slice(0, visibleCount))}
          {hasMore ? (
            <Button
              variant="ghost"
              ref={sentinel}
              type="button"
              className="quiet board-load-more"
              aria-label={`加载更多${label}卡片`}
              disabled={remote?.pending}
              onClick={loadMore}
            >
              {remote?.pending ? "加载中…" : "加载更多"}
            </Button>
          ) : (
            <p className="board-lane-total">
              已显示全部 {remote?.total ?? cards.length} 张
            </p>
          )}
        </>
      )}
    </section>
  );
}

export function Board({
  cards,
  projectId,
  lanes,
  onLaneChange,
  display,
  onOpenCard,
  resetKey = "",
  remote,
}: {
  cards: readonly CardListItem[];
  projectId: string;
  /** The human's lane settings; they override the empty-lane default. */
  lanes: BoardLanes;
  onLaneChange: (status: string, collapsed: boolean) => void;
  display: CardDisplay;
  onOpenCard?: (cardId: string, trigger: HTMLElement) => void;
  /** Only filtering/sorting resets batches, not live refresh or the drawer. */
  resetKey?: string;
  remote?: RemoteBoard | undefined;
}) {
  const id = useId();
  const [announcement, setAnnouncement] = useState("");
  // The toggled control is replaced by its counterpart; keep focus on it.
  const focusLane = useRef<string | null>(null);
  const toggles = useRef(new Map<string, HTMLButtonElement>());
  /** §9 U6a: one row that scrolls inside the board; the hint only flags more columns. */
  const scroller = useRef<HTMLElement>(null);
  const [more, setMore] = useState(false);
  useBoardPan(scroller);
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
  useEffect(() => {
    const status = focusLane.current;
    if (status === null) return;
    focusLane.current = null;
    toggles.current.get(status)?.focus();
  });
  const toggleRef = (status: string) => (node: HTMLButtonElement | null) => {
    if (node) toggles.current.set(status, node);
    else toggles.current.delete(status);
  };
  return (
    <>
      <p className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>
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
              heldCount =
                remote?.lanes[status]?.held_total ??
                column.filter((c) => c.hold).length,
              activeCount =
                (remote?.lanes[status]?.total ?? column.length) - heldCount,
              label = cardStatusLabel(status),
              collapsed = laneCollapsed(
                lanes,
                status,
                remote?.lanes[status]?.total ?? column.length,
              );
            const toggle = (event: MouseEvent<HTMLButtonElement>) => {
              // Keyboard / assistive activation (detail 0) keeps focus on the
              // replacement control; a mouse click would only pop its tooltip.
              if (event.detail === 0) focusLane.current = status;
              setAnnouncement(`${collapsed ? "已展开" : "已折叠"} ${label}列`);
              onLaneChange(status, !collapsed);
            };
            return (
              <section
                key={status}
                className={`board-column${collapsed ? " board-column-collapsed" : ""}`}
                aria-label={label}
              >
                <h3 className="board-column-title">
                  {collapsed ? (
                    // The whole strip is the expand control.
                    <Tooltip content="展开此列" side="right">
                      <Button
                        variant="ghost"
                        size="stretch"
                        ref={toggleRef(status)}
                        type="button"
                        className="quiet column-toggle lane-strip ui-lane-strip"
                        aria-label={`展开${label}列`}
                        aria-expanded={false}
                        aria-controls={`${id}-${status}`}
                        onClick={toggle}
                      >
                        <UnfoldIcon />
                        <StatusTag status={status} />
                        <span className="board-column-count">
                          {activeCount}
                        </span>
                      </Button>
                    </Tooltip>
                  ) : (
                    <>
                      <span className="board-column-heading">
                        <StatusTag status={status} />
                        <span className="board-column-count">
                          {activeCount}
                        </span>
                      </span>
                      <Tooltip content="折叠此列">
                        <Button
                          variant="ghost"
                          ref={toggleRef(status)}
                          type="button"
                          className="quiet column-toggle lane-fold"
                          aria-label={`折叠${label}列`}
                          aria-expanded={true}
                          aria-controls={`${id}-${status}`}
                          onClick={toggle}
                        >
                          <FoldIcon />
                        </Button>
                      </Tooltip>
                    </>
                  )}
                </h3>
                <BoardLaneCards
                  key={resetKey}
                  id={`${id}-${status}`}
                  label={label}
                  cards={column}
                  collapsed={collapsed}
                  remote={
                    remote
                      ? {
                          total: remote.lanes[status]?.total ?? 0,
                          hasMore: !!remote.lanes[status]?.next_cursor,
                          pending: remote.pending,
                          load: () => remote.load(status),
                        }
                      : undefined
                  }
                >
                  {(visibleCards) =>
                    !column.length ? (
                      <p className="board-column-empty">没有卡片</p>
                    ) : (
                      <>
                        <ul className="board-list">
                          {visibleCards
                            .filter((card) => !card.hold)
                            .map((card) => (
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
                        {heldCount > 0 && (
                          <details className="board-held">
                            <summary>已暂停 · {heldCount} 张</summary>
                            <ul className="board-list">
                              {visibleCards
                                .filter((card) => card.hold)
                                .map((card) => (
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
                            {visibleCards.filter((c) => c.hold).length <
                              heldCount && (
                              <p className="hint">
                                继续加载可查看其余暂停卡片。
                              </p>
                            )}
                          </details>
                        )}
                      </>
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
