// Adapted from shadcn/ui new-york Radix components (MIT). Workbench owns token styling.

import * as P from "@radix-ui/react-popover";
import type * as React from "react";
import { cn } from "../../lib/utils.js";
export const Root = P.Root,
  Trigger = P.Trigger,
  Anchor = P.Anchor,
  Portal = P.Portal,
  Close = P.Close,
  Arrow = P.Arrow;
export function Content({
  className,
  ...props
}: React.ComponentProps<typeof P.Content>) {
  return (
    <P.Content
      {...props}
      data-ui="popover"
      className={cn("ui-popover", className)}
    />
  );
}
export function PopoverContent(props: React.ComponentProps<typeof Content>) {
  return (
    <Portal>
      <Content {...props} />
    </Portal>
  );
}
export { Anchor as PopoverAnchor, Root as Popover, Trigger as PopoverTrigger };
