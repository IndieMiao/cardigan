import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../lib/utils.js";
import styles from "./PageStatsLayout.module.css";

/** Borderless header summary: label/value links that wrap on narrow pages. */
export function PageStats({ className, ...props }: ComponentProps<"nav">) {
  return <nav {...props} className={cn(styles.stats, className)} />;
}

export function PageStat({
  label,
  value,
  className,
  ...props
}: Omit<ComponentProps<"a">, "children"> & {
  label: ReactNode;
  value: ReactNode;
}) {
  return (
    <a {...props} className={cn(styles.stat, className)}>
      <span>{label}</span> <span className={styles.value}>{value}</span>
    </a>
  );
}
