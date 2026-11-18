import type { ComponentProps } from "react";
import { cn } from "../../lib/utils.js";
import { Table } from "../ui/table.js";
import styles from "./DataTableLayout.module.css";

/**
 * Card-list column policy: 48rem minimum, automatic content widths, local
 * scrolling. `records` switches to the cards page's stacked records at
 * ≤640px: cells with `data-label` show it as a prefix and a
 * `data-record="aside"` cell sits at the end of the first line. Short cells
 * (status, time) take `data-nowrap` so long text cannot squeeze them.
 */
export function DataTableLayout({
  className,
  scrollClassName,
  records = false,
  label,
  ...props
}: ComponentProps<typeof Table> & {
  scrollClassName?: string;
  records?: boolean;
  /** Names the scroll region; consecutive tables are spaced apart. */
  label?: string;
}) {
  const table = (
    <Table
      {...props}
      className={cn(
        "card-table",
        styles.table,
        records && styles.records,
        className,
      )}
    />
  );
  const scroll = cn("card-table-scroll", styles.scroll, scrollClassName);
  return label ? (
    <section className={scroll} aria-label={label}>
      {table}
    </section>
  ) : (
    <div className={scroll}>{table}</div>
  );
}

/** Folded raw record shown in a full-width row under its table row. */
export function DataTableDetail({
  className,
  ...props
}: ComponentProps<"pre">) {
  return <pre {...props} className={cn(styles.detail, className)} />;
}
