import {
  type ReactNode,
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { cn } from "../../lib/utils.js";
import { Tooltip } from "../Tooltip.js";
import styles from "./DependencyGraphLayout.module.css";

/** One line of dependency facts above the graph. */
export function DependencyGraphFacts({ children }: { children: ReactNode }) {
  return <p className={styles.facts}>{children}</p>;
}

export interface DependencyGraphEdge {
  readonly from: string;
  readonly to: string;
  readonly muted?: boolean;
  /** Empty cells a long edge runs through, one per column it crosses. */
  readonly via?: readonly { readonly column: number; readonly row: number }[];
}

interface Path {
  readonly key: string;
  readonly d: string;
  readonly muted: boolean;
}

interface Box {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly height: number;
}

const ARROW = 6;

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
  const [clipped, setClipped] = useState({ start: false, end: false });
  const edgeKey = edges
    .map(
      (e) =>
        `${edgeKeyOf(e)}${e.muted ? "~" : ""}${(e.via ?? [])
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
      d += curve(x, y, to.left - ARROW, ends.get(key) ?? middle(to));
      return { key, d, muted: !!edge.muted };
    });
    setFrame({ width: root.scrollWidth, height: root.scrollHeight, paths });
  }, [edgeKey]);
  const measureClip = useCallback(() => {
    const scroller = scroll.current;
    if (!scroller) return;
    const start = scroller.scrollLeft > 1,
      end =
        scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 1;
    setClipped((was) =>
      was.start === start && was.end === end ? was : { start, end },
    );
  }, []);
  useLayoutEffect(() => {
    draw();
    const root = list.current,
      scroller = scroll.current;
    if (root && scroller) scroller.scrollLeft = openingScroll(root, scroller);
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
      <div className={styles.scroll} ref={scroll} onScroll={measureClip}>
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
                className={cn(styles.edge, path.muted && styles.edgeMuted)}
                d={path.d}
                markerEnd={`url(#${arrow(path.muted)})`}
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
 * falls in a column gap is moved left so the hidden column peeks out.
 */
function openingScroll(root: HTMLElement, scroller: HTMLElement): number {
  const max = scroller.scrollWidth - scroller.clientWidth;
  const nodes = new Map<string, Box>();
  let current: (Box & { before: readonly string[] }) | undefined;
  for (const element of root.querySelectorAll<HTMLElement>("[data-node]")) {
    const box = boxOf(element);
    nodes.set(element.dataset.node ?? "", box);
    if (element.querySelector("[aria-current]"))
      current = { ...box, before: (element.dataset.before ?? "").split(" ") };
  }
  if (!current || max <= 0) return 0;
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
  return Math.max(0, Math.min(left, max));
}

/** A node on 1-based grid lines: `row` is the first of two half-rows. */
export function DependencyGraphNode({
  id,
  column,
  row,
  href,
  current = false,
  muted = false,
  tooltip,
  before = [],
  after = [],
  children,
}: {
  id: string;
  column: number;
  row: number;
  href?: string | undefined;
  current?: boolean;
  muted?: boolean;
  tooltip?: string;
  /** Direct prerequisites and dependents, read out instead of the lines. */
  before?: readonly string[] | undefined;
  after?: readonly string[] | undefined;
  children: ReactNode;
}) {
  const descriptionId = useId();
  const relations = [
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
      {current || !href ? (
        <div
          className={className}
          aria-current={current ? "page" : undefined}
          aria-describedby={describedBy}
        >
          {children}
        </div>
      ) : (
        <Tooltip content={tooltip}>
          <a className={className} href={href} aria-describedby={describedBy}>
            {children}
          </a>
        </Tooltip>
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
