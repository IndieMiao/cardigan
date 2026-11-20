import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../lib/utils.js";
import { PopoverContent } from "../ui/popover.js";
import styles from "./CardPeekLayout.module.css";

/**
 * A card's facts in a popover next to the control that opened it; the page
 * stays where it is. Place inside a `Popover` root; Radix keeps it in the
 * viewport, Escape and an outside press close it. Closing gives focus back to
 * the trigger only when it has nowhere else to go: opening another peek from
 * the same group must keep focus there, not pull it back and dismiss it.
 */
export function CardPeek({
  className,
  onCloseAutoFocus,
  ...props
}: ComponentProps<typeof PopoverContent>) {
  return (
    <PopoverContent
      side="bottom"
      align="start"
      sideOffset={4}
      collisionPadding={12}
      {...props}
      onCloseAutoFocus={(event) => {
        onCloseAutoFocus?.(event);
        const focused = document.activeElement;
        if (focused && focused !== document.body) event.preventDefault();
      }}
      className={cn(styles.panel, className)}
    />
  );
}

/** Identifier and the full title, wrapping instead of truncating. */
export function CardPeekHeading({ children }: { children: ReactNode }) {
  return <p className={styles.heading}>{children}</p>;
}

export function CardPeekFacts({ children }: { children: ReactNode }) {
  return <dl className={styles.facts}>{children}</dl>;
}

export function CardPeekFact({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className={styles.fact}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** One entry per line, e.g. work items with their status. */
export function CardPeekList({ children }: { children: ReactNode }) {
  return <ul className={styles.list}>{children}</ul>;
}

export function CardPeekActions({ children }: { children: ReactNode }) {
  return <div className={styles.actions}>{children}</div>;
}
