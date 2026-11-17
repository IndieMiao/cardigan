import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../lib/utils.js";
import * as Dialog from "../ui/dialog.js";
import styles from "./MergeBatchLayout.module.css";

const colors = [styles.color0, styles.color1, styles.color2, styles.color3];

export function MergeBatchCard({
  batchColor,
  className,
  ...props
}: ComponentProps<"div"> & { batchColor?: number | undefined }) {
  return (
    <div
      {...props}
      className={cn(
        className,
        batchColor !== undefined && styles.card,
        batchColor !== undefined && colors[batchColor % colors.length],
      )}
    />
  );
}

export function MergeBatchStage({
  href,
  color = 0,
  culprit = false,
  children,
}: {
  href?: string;
  color?: number;
  culprit?: boolean;
  children: ReactNode;
}) {
  const className = cn(
    "merge-stage",
    styles.stage,
    href && styles.link,
    colors[color % colors.length],
    culprit && styles.culprit,
  );
  return href ? (
    <a href={href} className={className}>
      {children}
    </a>
  ) : (
    <span className={className}>{children}</span>
  );
}

export function MergeBatchHeading({ children }: { children: ReactNode }) {
  return (
    <div className={cn("merge-batch-heading", styles.heading)}>{children}</div>
  );
}
export function MergeBatchSoloLabel({
  children,
  htmlFor,
}: {
  children: ReactNode;
  htmlFor: string;
}) {
  return (
    <label htmlFor={htmlFor} className={cn("merge-solo-toggle", styles.solo)}>
      {children}
    </label>
  );
}
export function MergeBatchAction({ children }: { children: ReactNode }) {
  return <span className={styles.action}>{children}</span>;
}
export function MergeBatchDrawer({ children }: { children: ReactNode }) {
  return (
    <Dialog.Content
      className={cn("merge-batch-drawer", styles.drawer)}
      aria-describedby={undefined}
    >
      {children}
    </Dialog.Content>
  );
}
export function MergeBatchMembers({ children }: { children: ReactNode }) {
  return (
    <ol className={cn("merge-batch-members", styles.members)}>{children}</ol>
  );
}
