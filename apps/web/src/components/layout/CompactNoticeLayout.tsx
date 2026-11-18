import type { ComponentProps } from "react";
import { cn } from "../../lib/utils.js";
import { AlertIcon, ChevronDownIcon } from "../ui/icons.js";
import styles from "./CompactNoticeLayout.module.css";

/** One-line attention row that expands in place; body content stays in the flow. */
export function CompactNotice({
  className,
  ...props
}: ComponentProps<"section">) {
  return <section {...props} className={cn(styles.notice, className)} />;
}
export function CompactNoticeLine(props: ComponentProps<"div">) {
  return <div {...props} className={styles.line} />;
}
/** Leading/trailing decoration for the toggle Button; the caller owns state. */
export function CompactNoticeToggleContent({
  children,
}: {
  children: ComponentProps<"span">["children"];
}) {
  return (
    <>
      <ChevronDownIcon aria-hidden="true" className={styles.chevron} />
      <AlertIcon aria-hidden="true" />
      <span>{children}</span>
    </>
  );
}
export const compactNoticeToggleClassName = styles.toggle;
export function CompactNoticeEnd(props: ComponentProps<"span">) {
  return <span {...props} className={styles.end} />;
}
export function CompactNoticeBody(props: ComponentProps<"div">) {
  return <div {...props} className={styles.body} />;
}
/** Padding/flow for a compact status popover. */
export const compactNoticePanelClassName = styles.panel;
