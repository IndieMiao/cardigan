import type { ReactNode } from "react";
import styles from "./RunRingLayout.module.css";

/**
 * C-531: decorative run ring around one avatar. The slot keeps the avatar's
 * size: a running avatar shrinks inside a 2px orbiting ring plus a 1px
 * isolation line; a queued one sits in a static 1px dashed ring. Never
 * focusable or hit-testable; the caller owns the name and status text.
 */
export function RunRing({
  state,
  size,
  children,
}: {
  readonly state: "running" | "queued";
  readonly size?: number | undefined;
  readonly children: ReactNode;
}) {
  return (
    <span
      className={styles.ring}
      data-run={state}
      style={size ? { width: size, height: size } : undefined}
      aria-hidden="true"
    >
      <span className={styles.disc} />
      {children}
    </span>
  );
}
