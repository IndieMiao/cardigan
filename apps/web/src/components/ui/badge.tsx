// Adapted from shadcn/ui new-york Radix components (MIT). Workbench owns token styling.
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils.js";
export function Badge({ className, ...props }: ComponentProps<"span">) {
  return (
    <span {...props} data-ui="badge" className={cn("ui-badge", className)} />
  );
}
