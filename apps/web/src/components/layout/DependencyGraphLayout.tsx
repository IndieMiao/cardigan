import { CircleHelp } from "lucide-react";
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { cn } from "../../lib/utils.js";
import { Tooltip } from "../Tooltip.js";
import { IconButton } from "../ui/button.js";
import { Popover, PopoverTrigger } from "../ui/popover.js";
import styles from "./DependencyGraphLayout.module.css";

/** One line of dependency facts above the graph. */
export function DependencyGraphFacts({ children }: { children: ReactNode }) {
  return <p className={styles.facts}>{children}</p>;
}

/** How to read the graph's lines, on hover or focus; never as page text. */
export function DependencyGraphHelp({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <Tooltip content={children}>
      <IconButton aria-label={label} variant="ghost" className={styles.help}>
        <CircleHelp aria-hidden="true" />
      </IconButton>
    </Tooltip>
  );
}

export interface DependencyGraphEdge {
  readonly from: string;
  readonly to: string;
  readonly muted?: boolean;
  /**
   * `parent` joins a story to a child card: dashed and without an arrow, so it
   * never reads as an order. The default is a dependency arrow.
   */
  readonly kind?: "dependency" | "parent";
  /** Empty cells a long edge runs through, one per column it crosses. */
  readonly via?: readonly { readonly column: number; readonly row: number }[];
}

interface Path {
  readonly key: string;
  readonly d: string;
  readonly muted: boolean;
  readonly parent: boolean;
}

interface Box {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly height: number;
}

const ARROW = 6;
/** A press that moves farther than this pans instead of clicking. */
const PAN_SLOP = 4;
/** Arrow-key pan step, a browser's usual line scroll. */
const KEY_STEP = 40;

const boxOf = (element: HTMLElement): Box => ({
  left: element.offsetLeft,
  right: element.offsetLeft + element.offsetWidth,
  top: element.offsetTop,
  height: element.offsetHeight,
});
const middle = (box: Box) => box.top + box.height / 2;
const edgeKeyOf = (edge: DependencyGraphEdge) => `${edge.from}>${edge.to}`;
const curve = (x1: number, y1: number, x2: number, y2: number) => {
  const bend = Math.max(ARROW, Math.abs(x2 - x1) / 2);
  return `C${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2} ${y2}`;
};

/**
 * Spread a node's edges over its side, ordered by where they come from or
 * go to, so every edge leaves and arrives at its own point.
 */
function ports(
  ends: readonly { key: string; node: string; toward: number }[],
  boxes: ReadonlyMap<string, Box>,
) {
  const result = new Map<string, number>(),
    byNode = new Map<string, { key: string; toward: number }[]>();
  for (const end of ends)
    byNode.set(end.node, [...(byNode.get(end.node) ?? []), end]);
  for (const [node, list] of byNode) {
    const box = boxes.get(node);
    if (!box) continue;
    list.sort((a, b) => a.toward - b.toward);
    for (const [i, end] of list.entries())
      result.set(end.key, box.top + (box.height * (i + 1)) / (list.length + 1));
  }
  return result;
}

/**
 * Left-to-right node graph. Callers place nodes on grid cells; the arrows are
 * measured from the rendered nodes, so sizes stay in theme tokens. A soft edge
 * marks each side that has nodes scrolled out of view.
 */
export function DependencyGraph({
  label,
  edges,
  children,
}: {
  label: string;
  edges: readonly DependencyGraphEdge[];
  children: ReactNode;
}) {
  const list = useRef<HTMLUListElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const marker = useId().replace(/[^\w-]/g, "");
  const [frame, setFrame] = useState<{
    width: number;
    height: number;
    paths: readonly Path[];
  }>({ width: 0, height: 0, paths: [] });
  const [clipped, setClipped] = useState({
    start: false,
    end: false,
    pannable: false,
  });
  const panning = useDragPan(scroll);
  const edgeKey = edges
    .map(
      (e) =>
        `${edgeKeyOf(e)}${e.muted ? "~" : ""}${e.kind === "parent" ? "^" : ""}${(
          e.via ?? []
        )
          .map((w) => `@${w.column}:${w.row}`)
          .join("")}`,
    )
    .join(" ");
  // biome-ignore lint/correctness/useExhaustiveDependencies: edgeKey is the edges' value identity.
  const draw = useCallback(() => {
    const root = list.current;
    if (!root) return;
    const boxes = new Map<string, Box>();
    for (const element of root.querySelectorAll<HTMLElement>("[data-node]"))
      boxes.set(element.dataset.node ?? "", boxOf(element));
    for (const element of root.querySelectorAll<HTMLElement>("[data-waypoint]"))
      boxes.set(`@${element.dataset.waypoint ?? ""}`, boxOf(element));
    const routes = edges.flatMap((edge) => {
      const key = edgeKeyOf(edge),
        from = boxes.get(edge.from),
        to = boxes.get(edge.to),
        via = (edge.via ?? []).map((w) => boxes.get(`@${key}:${w.column}`));
      if (!from || !to || via.some((box) => !box)) return [];
      return [{ edge, key, from, to, via: via as Box[] }];
    });
    const starts = ports(
      routes.map((r) => ({
        key: r.key,
        node: r.edge.from,
        toward: middle(r.via[0] ?? r.to),
      })),
      boxes,
    );
    const ends = ports(
      routes.map((r) => ({
        key: r.key,
        node: r.edge.to,
        toward: middle(r.via.at(-1) ?? r.from),
      })),
      boxes,
    );
    const paths = routes.map(({ edge, key, from, to, via }) => {
      let x = from.right,
        y = starts.get(key) ?? middle(from),
        d = `M${x} ${y}`;
      for (const box of via) {
        d += `${curve(x, y, box.left, middle(box))}L${box.right} ${middle(box)}`;
        x = box.right;
        y = middle(box);
      }
      const parent = edge.kind === "parent";
      // A parent line has no arrowhead, so it runs all the way to the child.
      d += curve(
        x,
        y,
        to.left - (parent ? 0 : ARROW),
        ends.get(key) ?? middle(to),
      );
      return { key, d, muted: !!edge.muted, parent };
    });
    setFrame({ width: root.scrollWidth, height: root.scrollHeight, paths });
  }, [edgeKey]);
  const measureClip = useCallback(() => {
    const scroller = scroll.current;
    if (!scroller) return;
    const start = scroller.scrollLeft > 1,
      end =
        scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 1,
      pannable =
        scroller.scrollWidth > scroller.clientWidth ||
        scroller.scrollHeight > scroller.clientHeight;
    setClipped((was) =>
      was.start === start && was.end === end && was.pannable === pannable
        ? was
        : { start, end, pannable },
    );
  }, []);
  useLayoutEffect(() => {
    draw();
    const root = list.current,
      scroller = scroll.current;
    if (root && scroller) {
      const { left, top } = openingScroll(root, scroller);
      scroller.scrollLeft = left;
      scroller.scrollTop = top;
    }
    measureClip();
    if (!root || !scroller || typeof ResizeObserver === "undefined") return;
    // Later resizes keep the reader's scroll.
    const observer = new ResizeObserver(() => {
      draw();
      measureClip();
    });
    observer.observe(root);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [draw, measureClip]);
  const arrow = (muted: boolean) => `${marker}-${muted ? "muted" : "edge"}`;
  return (
    <div
      className={cn(
        styles.frame,
        clipped.start && styles.clipStart,
        clipped.end && styles.clipEnd,
      )}
    >
      <div
        className={cn(
          styles.scroll,
          clipped.pannable && styles.pannable,
          panning && styles.panning,
        )}
        ref={scroll}
        onScroll={measureClip}
      >
        <div className={styles.canvas}>
          <svg
            className={styles.edges}
            width={frame.width}
            height={frame.height}
            aria-hidden="true"
            focusable="false"
          >
            <defs>
              {[false, true].map((muted) => (
                <marker
                  key={String(muted)}
                  id={arrow(muted)}
                  viewBox={`0 0 ${ARROW} ${ARROW}`}
                  refX={0}
                  refY={ARROW / 2}
                  markerWidth={ARROW}
                  markerHeight={ARROW}
                  markerUnits="userSpaceOnUse"
                  orient="auto"
                >
                  <path
                    className={cn(styles.arrow, muted && styles.edgeMuted)}
                    d={`M0 0L${ARROW} ${ARROW / 2}L0 ${ARROW}Z`}
                  />
                </marker>
              ))}
            </defs>
            {frame.paths.map((path) => (
              <path
                key={path.key}
                data-edge={path.key}
                data-edge-kind={path.parent ? "parent" : "dependency"}
                className={cn(
                  styles.edge,
                  path.muted && styles.edgeMuted,
                  path.parent && styles.edgeParent,
                )}
                d={path.d}
                markerEnd={
                  path.parent ? undefined : `url(#${arrow(path.muted)})`
                }
              />
            ))}
          </svg>
          <ul className={styles.graph} ref={list} aria-label={label}>
            {children}
            {edges.flatMap((edge) =>
              (edge.via ?? []).map((cell) => (
                <li
                  key={`${edgeKeyOf(edge)}:${cell.column}`}
                  className={styles.waypoint}
                  data-waypoint={`${edgeKeyOf(edge)}:${cell.column}`}
                  aria-hidden="true"
                  style={{
                    gridColumn: cell.column + 1,
                    gridRow: `${cell.row + 1} / span 2`,
                  }}
                />
              )),
            )}
          </ul>
        </div>
      </div>
    </div>
  );
}

/**
 * Opening scroll: the current card centred where possible, but never cut, and
 * its direct prerequisites kept in view before anything downstream. A cut that
 * falls in a column gap is moved left so the hidden column peeks out. A graph
 * taller than its view centres the current card's row.
 */
function openingScroll(
  root: HTMLElement,
  scroller: HTMLElement,
): { left: number; top: number } {
  const max = scroller.scrollWidth - scroller.clientWidth;
  const nodes = new Map<string, Box>();
  let current: (Box & { before: readonly string[] }) | undefined;
  for (const element of root.querySelectorAll<HTMLElement>("[data-node]")) {
    const box = boxOf(element);
    nodes.set(element.dataset.node ?? "", box);
    if (element.querySelector("[aria-current]"))
      current = { ...box, before: (element.dataset.before ?? "").split(" ") };
  }
  if (!current) return { left: 0, top: 0 };
  const top = Math.max(
    0,
    Math.min(
      scroller.scrollHeight - scroller.clientHeight,
      current.top + (current.height - scroller.clientHeight) / 2,
    ),
  );
  if (max <= 0) return { left: 0, top };
  // Keep the edge marks off the cards that must stay readable.
  const edge =
    (scroller.parentElement &&
      Number.parseFloat(
        getComputedStyle(scroller.parentElement, "::after").width,
      )) ||
    0;
  const lowest = Math.max(
      0,
      Math.min(current.right + edge, scroller.scrollWidth) -
        scroller.clientWidth,
    ),
    highest = Math.max(
      0,
      Math.min(
        current.left,
        ...current.before.flatMap((id) => {
          const box = nodes.get(id);
          return box ? [box.left] : [];
        }),
      ) - edge,
    );
  let left = Math.min(
    Math.max((current.left + current.right - scroller.clientWidth) / 2, lowest),
    Math.max(highest, lowest),
  );
  const columns = [...new Set([...nodes.values()].map((n) => n.left))].sort(
      (a, b) => a - b,
    ),
    width = current.right - current.left,
    gap = (columns[1] ?? 0) - (columns[0] ?? 0) - width;
  // A cut in a gap, or one that barely nicks a node, looks like the graph's
  // real edge; show a strip of the hidden column instead.
  const hidden = columns.filter((l) => l + width <= left).at(-1);
  if (left > 0 && !columns.some((l) => l + gap <= left && left < l + width))
    left = Math.max(lowest, hidden === undefined ? 0 : hidden + width - gap);
  return { left: Math.max(0, Math.min(left, max)), top };
}

/**
 * Mouse and pen press-and-drag pans the graph, from a node or the empty space
 * between them. A press that stays within PAN_SLOP is still a click; a drag
 * swallows its click so it never opens a node, even when the graph fits and
 * there is nothing to pan. Touch keeps native scrolling,
 * and the scrollbar keeps its own drag. Arrow keys pan too.
 */
function useDragPan(scroller: RefObject<HTMLElement | null>): boolean {
  const [panning, setPanning] = useState(false);
  useEffect(() => {
    const view = scroller.current;
    if (!view) return;
    let pan: {
      pointerId: number;
      x: number;
      y: number;
      left: number;
      top: number;
      dragging: boolean;
      /** A graph that fits still tells a drag from a click; it just won't move. */
      scrollable: boolean;
    } | null = null;
    let suppressClick = false;
    const stop = () => {
      const previous = pan;
      pan = null;
      setPanning(false);
      if (previous && view.hasPointerCapture?.(previous.pointerId))
        view.releasePointerCapture(previous.pointerId);
    };
    const down = (event: PointerEvent) => {
      suppressClick = false;
      if (
        pan ||
        event.pointerType === "touch" ||
        !event.isPrimary ||
        event.button !== 0
      )
        return;
      const rect = view.getBoundingClientRect();
      if (
        event.clientY >= rect.top + view.clientTop + view.clientHeight ||
        event.clientX >= rect.left + view.clientLeft + view.clientWidth
      )
        return;
      pan = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        left: view.scrollLeft,
        top: view.scrollTop,
        dragging: false,
        scrollable:
          view.scrollWidth > view.clientWidth ||
          view.scrollHeight > view.clientHeight,
      };
    };
    const move = (event: PointerEvent) => {
      if (!pan || event.pointerId !== pan.pointerId) return;
      if ((event.buttons & 1) === 0) {
        stop();
        return;
      }
      const dx = event.clientX - pan.x,
        dy = event.clientY - pan.y;
      if (!pan.dragging) {
        if (Math.hypot(dx, dy) <= PAN_SLOP) return;
        pan.dragging = true;
        suppressClick = true;
        setPanning(pan.scrollable);
        view.setPointerCapture?.(event.pointerId);
        window.getSelection()?.removeAllRanges();
      }
      event.preventDefault();
      view.scrollLeft = Math.max(
        0,
        Math.min(view.scrollWidth - view.clientWidth, pan.left - dx),
      );
      view.scrollTop = Math.max(
        0,
        Math.min(view.scrollHeight - view.clientHeight, pan.top - dy),
      );
    };
    const end = (event: PointerEvent) => {
      if (event.pointerId === pan?.pointerId) stop();
    };
    const click = (event: MouseEvent) => {
      // Only the pointer click that ends this drag; keyboard activation
      // (detail 0) and the next press behave normally.
      if (!suppressClick || event.detail === 0) return;
      suppressClick = false;
      event.preventDefault();
      event.stopPropagation();
    };
    const key = (event: KeyboardEvent) => panByKey(view, event);
    view.addEventListener("pointerdown", down);
    view.addEventListener("click", click, true);
    view.addEventListener("keydown", key);
    view.addEventListener("lostpointercapture", end);
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    window.addEventListener("blur", stop);
    return () => {
      stop();
      view.removeEventListener("pointerdown", down);
      view.removeEventListener("click", click, true);
      view.removeEventListener("keydown", key);
      view.removeEventListener("lostpointercapture", end);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("blur", stop);
    };
  }, [scroller]);
  return panning;
}

/** Arrow keys pan while focus is on the graph; at an edge they fall through. */
function panByKey(view: HTMLElement, event: KeyboardEvent) {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey)
    return;
  const [dx, dy] =
    {
      ArrowLeft: [-KEY_STEP, 0],
      ArrowRight: [KEY_STEP, 0],
      ArrowUp: [0, -KEY_STEP],
      ArrowDown: [0, KEY_STEP],
    }[event.key] ?? [];
  if (dx === undefined || dy === undefined) return;
  const left = Math.max(
      0,
      Math.min(view.scrollWidth - view.clientWidth, view.scrollLeft + dx),
    ),
    top = Math.max(
      0,
      Math.min(view.scrollHeight - view.clientHeight, view.scrollTop + dy),
    );
  if (left === view.scrollLeft && top === view.scrollTop) return;
  view.scrollLeft = left;
  view.scrollTop = top;
  event.preventDefault();
}

/** A node on 1-based grid lines: `row` is the first of two half-rows. */
export function DependencyGraphNode({
  id,
  column,
  row,
  peek,
  open = false,
  onOpenChange,
  current = false,
  muted = false,
  tooltip,
  before = [],
  after = [],
  childOf,
  parentOf = [],
  children,
}: {
  id: string;
  column: number;
  row: number;
  /** A `CardPeek` the node opens in place; without one it is plain text. */
  peek?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  current?: boolean;
  muted?: boolean;
  tooltip?: string;
  /** Direct prerequisites and dependents, read out instead of the lines. */
  before?: readonly string[] | undefined;
  after?: readonly string[] | undefined;
  /** The story this node is a child of, read out like the dependency links. */
  childOf?: string | undefined;
  /** Child cards of this story node. */
  parentOf?: readonly string[] | undefined;
  children: ReactNode;
}) {
  const descriptionId = useId();
  const relations = [
    childOf ? `父卡 ${childOf}` : "",
    parentOf.length ? `子卡 ${parentOf.join("、")}` : "",
    before.length ? `前置 ${before.join("、")}` : "",
    after.length ? `后续 ${after.join("、")}` : "",
  ]
    .filter(Boolean)
    .join("；");
  const className = cn(
    styles.node,
    current && styles.current,
    muted && styles.muted,
  );
  const describedBy = relations ? descriptionId : undefined;
  return (
    <li
      className={styles.item}
      data-node={id}
      data-before={before.join(" ")}
      style={{ gridColumn: column + 1, gridRow: `${row + 1} / span 2` }}
    >
      {current || !peek ? (
        <div
          className={className}
          aria-current={current ? "page" : undefined}
          aria-describedby={describedBy}
        >
          {children}
        </div>
      ) : (
        <Popover open={open} onOpenChange={onOpenChange}>
          <Tooltip content={tooltip}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className={className}
                aria-describedby={describedBy}
              >
                {children}
              </button>
            </PopoverTrigger>
          </Tooltip>
          {peek}
        </Popover>
      )}
      {relations && (
        <span id={descriptionId} className="visually-hidden">
          {relations}
        </span>
      )}
    </li>
  );
}

export function DependencyGraphNodeHead({ children }: { children: ReactNode }) {
  return <span className={styles.head}>{children}</span>;
}

export function DependencyGraphNodeTitle({
  children,
}: {
  children: ReactNode;
}) {
  return <span className={styles.title}>{children}</span>;
}
