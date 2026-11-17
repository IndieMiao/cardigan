// Adapted from shadcn/ui new-york Radix components (MIT). Workbench owns token styling.

import * as P from "@radix-ui/react-toggle";
import { cva } from "class-variance-authority";
import type * as React from "react";
import { cn } from "../../lib/utils.js";
export const toggleVariants = cva("ui-toggle");
export function Toggle({
  className,
  ...props
}: React.ComponentProps<typeof P.Root>) {
  return (
    <P.Root
      {...props}
      data-ui="toggle"
      className={cn("ui-toggle", className)}
    />
  );
}
