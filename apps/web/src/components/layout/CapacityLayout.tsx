import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../lib/utils.js";
import { Badge } from "../ui/badge.js";
import { PopoverContent } from "../ui/popover.js";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../ui/table.js";
import styles from "./CapacityLayout.module.css";

/**
 * C-824: the header capacity popover. Sized to its table (no fixed width);
 * on a narrow screen the columns wrap inside the viewport instead of
 * scrolling sideways.
 */
export function CapacityPanel({
  className,
  ...props
}: ComponentProps<typeof PopoverContent>) {
  return <PopoverContent {...props} className={cn(styles.panel, className)} />;
}

export function CapacityHeading({ children }: { children: ReactNode }) {
  return <p className={styles.heading}>{children}</p>;
}

/** One table for Agent machines and CI targets; the header appears once. */
export function CapacityTable({
  resources,
  children,
}: {
  /** Show the resource column (some machine has resources or CI slots). */
  resources: boolean;
  children: ReactNode;
}) {
  return (
    <Table className={styles.table}>
      <TableHeader>
        <tr>
          <TableHead>名称</TableHead>
          <TableHead>占用/上限</TableHead>
          <TableHead>排队</TableHead>
          {resources && (
            <TableHead className={styles.resourcesHead}>资源</TableHead>
          )}
        </tr>
      </TableHeader>
      {children}
    </Table>
  );
}

/** A labelled group of rows (Agent, CI) inside `CapacityTable`. */
export function CapacityGroup({
  label,
  columns,
  children,
}: {
  label: string;
  columns: number;
  children: ReactNode;
}) {
  return (
    <TableBody>
      <TableRow className={styles.group}>
        <TableCell colSpan={columns} className={styles.groupCell}>
          {label}
        </TableCell>
      </TableRow>
      {children}
    </TableBody>
  );
}

/**
 * `attention` rows (full or queued) keep full contrast; the others are
 * muted. Values that need action use `tone="wait"`.
 */
export function CapacityRow({
  attention,
  children,
}: {
  attention: boolean;
  children: ReactNode;
}) {
  return (
    <TableRow
      data-attention={attention ? "true" : undefined}
      className={styles.row}
    >
      {children}
    </TableRow>
  );
}

export function CapacityCell({
  tone,
  kind,
  colSpan,
  children,
}: {
  tone?: "wait" | undefined;
  /**
   * `name` stays on one line on wide screens; `numeric` always does;
   * `resources` moves to its own line on narrow screens.
   */
  kind?: "name" | "numeric" | "resources";
  colSpan?: number;
  children: ReactNode;
}) {
  return (
    <TableCell
      colSpan={colSpan}
      data-tone={tone}
      className={cn(styles.cell, kind && styles[kind])}
    >
      {children}
    </TableCell>
  );
}

export function CapacityTags({ children }: { children: ReactNode }) {
  return <span className={styles.tags}>{children}</span>;
}

/** A named slot count: `full` uses the status colour, `idle` is muted. */
export function CapacityTag({
  state,
  children,
}: {
  state: "full" | "used" | "idle";
  children: ReactNode;
}) {
  return (
    <Badge data-state={state} className={styles.tag}>
      {children}
    </Badge>
  );
}

export function CapacityLinks({ children }: { children: ReactNode }) {
  return <p className={styles.links}>{children}</p>;
}

export function CapacityLink(props: ComponentProps<"a">) {
  return <a {...props} className={styles.link} />;
}
