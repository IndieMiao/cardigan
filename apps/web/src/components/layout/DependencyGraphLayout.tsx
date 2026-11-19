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
}

interface Path {
  readonly key: string;
  readonly d: string;
  readonly muted: boolean;
}

const ARROW = 6;

/**
 * Left-to-right node graph. Callers place nodes on grid cells; the arrows are
 * measured from the rendered nodes, so sizes stay in theme tokens.
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
  const edgeKey = edges
    .map((e) => `${e.from}>${e.to}${e.muted ? "~" : ""}`)
    .join(" ");
  // biome-ignore lint/correctness/useExhaustiveDependencies: edgeKey is the edges' value identity.
  const draw = useCallback(() => {
    const root = list.current;
    if (!root) return;
    const nodes = new Map<string, HTMLElement>();
    for (const element of root.querySelectorAll<HTMLElement>("[data-node]"))
      nodes.set(element.dataset.node ?? "", element);
    const paths = edges.flatMap((edge) => {
      const from = nodes.get(edge.from),
        to = nodes.get(edge.to);
      if (!from || !to) return [];
      const x1 = from.offsetLeft + from.offsetWidth,
        y1 = from.offsetTop + from.offsetHeight / 2,
        x2 = to.offsetLeft - ARROW,
        y2 = to.offsetTop + to.offsetHeight / 2,
        bend = Math.max(ARROW, Math.abs(x2 - x1) / 2);
      return [
        {
          key: `${edge.from}>${edge.to}`,
          d: `M${x1} ${y1}C${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2} ${y2}`,
          muted: !!edge.muted,
        },
      ];
    });
    setFrame({ width: root.scrollWidth, height: root.scrollHeight, paths });
  }, [edgeKey]);
  useLayoutEffect(() => {
    draw();
    const root = list.current;
    // Open with the current card in view; later resizes keep the reader's scroll.
    const current = root
      ?.querySelector("[aria-current]")
      ?.closest<HTMLElement>("[data-node]");
    const scroller = scroll.current;
    if (current && scroller)
      scroller.scrollLeft =
        current.offsetLeft + current.offsetWidth / 2 - scroller.clientWidth / 2;
    if (!root || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(draw);
    observer.observe(root);
    return () => observer.disconnect();
  }, [draw]);
  const arrow = (muted: boolean) => `${marker}-${muted ? "muted" : "edge"}`;
  return (
    <div className={styles.scroll} ref={scroll}>
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
        </ul>
      </div>
    </div>
  );
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
  children,
}: {
  id: string;
  column: number;
  row: number;
  href?: string | undefined;
  current?: boolean;
  muted?: boolean;
  tooltip?: string;
  children: ReactNode;
}) {
  const className = cn(
    styles.node,
    current && styles.current,
    muted && styles.muted,
  );
  return (
    <li
      className={styles.item}
      data-node={id}
      style={{ gridColumn: column + 1, gridRow: `${row + 1} / span 2` }}
    >
      {current || !href ? (
        <div className={className} aria-current={current ? "page" : undefined}>
          {children}
        </div>
      ) : (
        <Tooltip content={tooltip}>
          <a className={className} href={href}>
            {children}
          </a>
        </Tooltip>
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
