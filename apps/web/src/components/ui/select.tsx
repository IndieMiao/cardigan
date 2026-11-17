// Adapted from shadcn/ui new-york Radix components (MIT). Workbench owns token styling.

import * as P from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import type * as React from "react";
import { cn } from "../../lib/utils.js";
export const Select = P.Root,
  SelectGroup = P.Group,
  SelectValue = P.Value;
export function SelectTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof P.Trigger>) {
  return (
    <P.Trigger
      {...props}
      data-ui="select-trigger"
      className={cn("ui-select-trigger", className)}
    >
      {children}
      <P.Icon asChild>
        <ChevronDown aria-hidden="true" />
      </P.Icon>
    </P.Trigger>
  );
}
export function SelectContent({
  className,
  children,
  position = "popper",
  ...props
}: React.ComponentProps<typeof P.Content>) {
  return (
    <P.Portal>
      <P.Content
        {...props}
        position={position}
        data-ui="select-content"
        className={cn("ui-select-content", className)}
      >
        <P.ScrollUpButton className="ui-menu-scroll">
          <ChevronUp aria-hidden="true" />
        </P.ScrollUpButton>
        <P.Viewport>{children}</P.Viewport>
        <P.ScrollDownButton className="ui-menu-scroll">
          <ChevronDown aria-hidden="true" />
        </P.ScrollDownButton>
      </P.Content>
    </P.Portal>
  );
}
export function SelectItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof P.Item>) {
  return (
    <P.Item
      {...props}
      data-ui="select-item"
      className={cn("ui-select-item", className)}
    >
      <P.ItemText>{children}</P.ItemText>
      <P.ItemIndicator className="ui-item-indicator">
        <Check aria-hidden="true" />
      </P.ItemIndicator>
    </P.Item>
  );
}
export function SelectLabel({
  className,
  ...props
}: React.ComponentProps<typeof P.Label>) {
  return (
    <P.Label
      {...props}
      data-ui="menu-label"
      className={cn("ui-menu-label", className)}
    />
  );
}
export function SelectSeparator({
  className,
  ...props
}: React.ComponentProps<typeof P.Separator>) {
  return (
    <P.Separator
      {...props}
      data-ui="separator"
      className={cn("ui-separator", className)}
    />
  );
}
