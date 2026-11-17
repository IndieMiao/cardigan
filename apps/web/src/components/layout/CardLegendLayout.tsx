import type { ComponentProps } from "react";
import { cn } from "../../lib/utils.js";
import styles from "./CardLegendLayout.module.css";
export function CardLegendPreview({
  className,
  ...props
}: ComponentProps<"div">) {
  return (
    <div
      {...props}
      className={cn("card-guide-preview", styles.preview, className)}
    />
  );
}
