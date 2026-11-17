// Adapted from shadcn/ui new-york Radix components (MIT). Workbench owns token styling.

import * as P from "@radix-ui/react-checkbox";
import { Check } from "lucide-react";
import type * as React from "react";
import { cn } from "../../lib/utils.js";
export function Checkbox({
  className,
  ...props
}: React.ComponentProps<typeof P.Root>) {
  return (
    <P.Root
      {...props}
      data-ui="checkbox"
      className={cn("ui-checkbox", className)}
    >
      <P.Indicator>
        <Check aria-hidden="true" />
      </P.Indicator>
    </P.Root>
  );
}
