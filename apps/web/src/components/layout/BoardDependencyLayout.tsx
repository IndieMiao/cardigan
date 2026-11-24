import { useId } from "react";
import { LINE_ARROW } from "../../board-dependency-lines.js";
import styles from "./BoardDependencyLayout.module.css";

export interface BoardDependencyLine {
  /** `from>to`, matching the dependency order. */
  readonly key: string;
  readonly d: string;
}

/**
 * C-659 / C-668: faint curves between the hovered card and its
 * prerequisites and dependents. Rendered after the board, so a curve stays
 * whole where it passes over an unrelated card; the 1px hover-border colour
 * keeps the text under it readable.
 */
export function BoardDependencyLines({
  lines,
}: {
  lines: readonly BoardDependencyLine[];
}) {
  const marker = `${useId()}-arrow`;
  return (
    <svg
      className={styles.lines}
      aria-hidden="true"
      focusable="false"
      data-board-dependencies=""
    >
      <defs>
        <marker
          id={marker}
          viewBox={`0 0 ${LINE_ARROW} ${LINE_ARROW}`}
          refX={0}
          refY={LINE_ARROW / 2}
          markerWidth={LINE_ARROW}
          markerHeight={LINE_ARROW}
          markerUnits="userSpaceOnUse"
          orient="auto"
        >
          <path
            className={styles.arrow}
            d={`M0 0L${LINE_ARROW} ${LINE_ARROW / 2}L0 ${LINE_ARROW}Z`}
          />
        </marker>
      </defs>
      {lines.map((line) => (
        <path
          key={line.key}
          data-edge={line.key}
          className={styles.line}
          d={line.d}
          markerEnd={`url(#${marker})`}
        />
      ))}
    </svg>
  );
}
