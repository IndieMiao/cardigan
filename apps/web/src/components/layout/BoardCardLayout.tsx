import type { ComponentProps } from "react";
import { cn } from "../../lib/utils.js";
import styles from "./BoardCardLayout.module.css";
export function BoardCardLayout({
  className,
  ...props
}: ComponentProps<"div">) {
  return <div {...props} className={cn(styles.card, className)} />;
}

/** C-660: what a board card waits on, highest priority first. */
export type BoardCardSignalKind =
  | "blocked"
  | "decision"
  | "human_action"
  | "closeout";

/**
 * Short colored text tag for a waiting/blocked card. Inside a board card it
 * sits in the bottom-right corner after the metadata row; elsewhere (the help
 * legend) it is a plain inline tag.
 */
export function BoardCardSignal({
  kind,
  className,
  ...props
}: ComponentProps<"a"> & { kind: BoardCardSignalKind }) {
  return (
    <a
      {...props}
      data-card-signal={kind}
      className={cn(styles.signal, className)}
    />
  );
}
