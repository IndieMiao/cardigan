import { type ComponentProps, Fragment } from "react";
import { cn } from "../../lib/utils.js";
import { Table, TableCell } from "../ui/table.js";
import styles from "./DataTableLayout.module.css";

/**
 * Card-list column policy: 48rem minimum, automatic content widths, local
 * scrolling. `stacked` uses the cards list's narrow record layout at ≤640px:
 * the header is visually hidden and each cell with `data-label` shows
 * "标签：值" on its own line. `records` extends it for grouped tables: hidden
 * group bodies stay hidden, a `data-record="lead"` / `"aside"` cell shares the
 * first line, and each record has one divider instead of per-cell lines.
 */
export function DataTableLayout({
  className,
  scrollClassName,
  stacked = false,
  records = false,
  recordsAlways = false,
  label,
  ...props
}: ComponentProps<typeof Table> & {
  scrollClassName?: string;
  stacked?: boolean;
  records?: boolean;
  /** The record layout at every width, not only ≤640px (C-494). */
  recordsAlways?: boolean;
  /** Names the scroll region; consecutive tables are spaced apart. */
  label?: string;
}) {
  const table = (
    <Table
      {...props}
      className={cn(
        "card-table",
        (stacked || records) && styles.stacked,
        records && styles.records,
        recordsAlways && styles.always,
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

/**
 * An identifier (a key or id such as `integration_verification_long_key`)
 * that may wrap only after `_`, `-` or `.`, never inside a word. The text is
 * unchanged; only line-break opportunities are added.
 */
export function DataTableId({ children }: { children: string }) {
  const parts = children.split(/(?<=[_.-])/u);
  return (
    <>
      {parts.map((part, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional.
        <Fragment key={index}>
          {index > 0 && <wbr />}
          {part}
        </Fragment>
      ))}
    </>
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

/** Folded raw record shown in a full-width row under its table row. */
export function DataTableDetail({
  className,
  ...props
}: ComponentProps<"pre">) {
  return <pre {...props} className={cn(styles.detail, className)} />;
}
