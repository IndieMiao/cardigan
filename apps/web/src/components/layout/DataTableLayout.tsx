import type { ComponentProps } from "react";
import { cn } from "../../lib/utils.js";
import { Table, TableCell } from "../ui/table.js";
import styles from "./DataTableLayout.module.css";

/**
 * Card-list column policy: 48rem minimum, automatic content widths, local
 * scrolling. `stacked` uses the cards list's narrow record layout at ≤640px:
 * the header is visually hidden and each cell with `data-label` shows
 * "标签：值" on its own line.
 */
export function DataTableLayout({
  className,
  scrollClassName,
  stacked = false,
  ...props
}: ComponentProps<typeof Table> & {
  scrollClassName?: string;
  stacked?: boolean;
}) {
  return (
    <div className={cn("card-table-scroll", scrollClassName)}>
      <Table
        {...props}
        className={cn("card-table", stacked && styles.stacked, className)}
      />
    </div>
  );
}

/**
 * Short values (ids, statuses, names, times) keep one line on wide screens so
 * a long text column takes the remaining width; stacked records still wrap.
 */
export function DataTableCell({
  nowrap = false,
  className,
  ...props
}: ComponentProps<typeof TableCell> & { nowrap?: boolean }) {
  return (
    <TableCell {...props} className={cn(nowrap && styles.nowrap, className)} />
  );
}
