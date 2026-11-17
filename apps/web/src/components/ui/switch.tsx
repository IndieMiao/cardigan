// Adapted from shadcn/ui new-york Radix components (MIT). Workbench owns token styling.

import * as P from "@radix-ui/react-switch";
import type * as React from "react";
import { cn } from "../../lib/utils.js";
export function Switch({
  className,
  ...props
}: React.ComponentProps<typeof P.Root>) {
  return (
    <P.Root {...props} data-ui="switch" className={cn("ui-switch", className)}>
      <P.Thumb className="ui-switch-thumb" />
    </P.Root>
  );
}
