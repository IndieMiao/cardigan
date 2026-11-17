import type { ComponentProps } from "react";
import { cn } from "../../lib/utils.js";
import styles from "./BoardCardLayout.module.css";
export function BoardCardLayout({
  className,
  ...props
}: ComponentProps<"div">) {
  return <div {...props} className={cn(styles.card, className)} />;
}
