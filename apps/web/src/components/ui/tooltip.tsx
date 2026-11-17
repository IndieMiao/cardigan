// Adapted from shadcn/ui new-york Radix components (MIT). Workbench owns token styling.

import * as P from "@radix-ui/react-tooltip";
import type * as React from "react";
import { cn } from "../../lib/utils.js";
export const Root = P.Root,
  Trigger = P.Trigger,
  Provider = P.Provider,
  Portal = P.Portal,
  Arrow = P.Arrow;
export function Content({
  className,
  ...props
}: React.ComponentProps<typeof P.Content>) {
  return (
    <P.Content
      {...props}
      data-ui="tooltip"
      className={cn("ui-tooltip", className)}
    />
  );
}
export function TooltipContent(props: React.ComponentProps<typeof Content>) {
  return (
    <Portal>
      <Content {...props} />
    </Portal>
  );
}
export {
  Provider as TooltipProvider,
  Root as Tooltip,
  Trigger as TooltipTrigger,
};
