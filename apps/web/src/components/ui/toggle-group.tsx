// Adapted from shadcn/ui new-york Radix components (MIT). Workbench owns token styling.

import * as P from "@radix-ui/react-toggle-group";
import type * as React from "react";
import { cn } from "../../lib/utils.js";
export function Root({
  className,
  ...props
}: React.ComponentProps<typeof P.Root>) {
  return (
    <P.Root
      {...props}
      data-ui="toggle-group"
      className={cn("ui-toggle-group", className)}
    />
  );
}
export function Item({
  className,
  ...props
}: React.ComponentProps<typeof P.Item>) {
  return (
    <P.Item
      {...props}
      data-ui="toggle-item"
      className={cn("ui-toggle-item", className)}
    />
  );
}
export { Item as ToggleGroupItem, Root as ToggleGroup };
