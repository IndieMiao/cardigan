// Adapted from shadcn/ui new-york Skeleton (MIT). Workbench owns token styling.
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils.js";

/** Decorative loading placeholder: three lines in the content column. */
export function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      {...props}
      aria-hidden="true"
      data-ui="skeleton"
      className={cn("ui-skeleton", className)}
    >
      <div />
      <div />
      <div />
    </div>
  );
}
