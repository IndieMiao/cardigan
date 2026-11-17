// Adapted from shadcn/ui new-york Radix components (MIT). Workbench owns token styling.

import * as P from "@radix-ui/react-tabs";
import type * as React from "react";
import { cn } from "../../lib/utils.js";
export const Tabs = P.Root;
export function TabsList({
  className,
  ...props
}: React.ComponentProps<typeof P.List>) {
  return (
    <P.List
      {...props}
      data-ui="tabs-list"
      className={cn("ui-tabs-list", className)}
    />
  );
}
export function TabsTrigger({
  className,
  ...props
}: React.ComponentProps<typeof P.Trigger>) {
  return (
    <P.Trigger
      {...props}
      data-ui="tabs-trigger"
      className={cn("ui-tabs-trigger", className)}
    />
  );
}
export function TabsContent({
  className,
  ...props
}: React.ComponentProps<typeof P.Content>) {
  return (
    <P.Content
      {...props}
      data-ui="tabs-content"
      className={cn("ui-tabs-content", className)}
    />
  );
}
