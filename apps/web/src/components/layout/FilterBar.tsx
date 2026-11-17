import type { ComponentProps } from "react";
import { cn } from "../../lib/utils.js";
export function FilterBarLayout({
  className,
  ...props
}: ComponentProps<"div">) {
  return (
    <div
      {...props}
      className={cn("filter-controls ui-filter-row", className)}
    />
  );
}
