// Adapted from shadcn/ui new-york Radix components (MIT). Workbench owns token styling.

import * as P from "@radix-ui/react-dropdown-menu";
import { Check } from "lucide-react";
import type * as React from "react";
import { cn } from "../../lib/utils.js";
export const Root = P.Root,
  Trigger = P.Trigger,
  Portal = P.Portal,
  Group = P.Group,
  RadioGroup = P.RadioGroup,
  ItemIndicator = P.ItemIndicator;
export function Content({
  className,
  ...props
}: React.ComponentProps<typeof P.Content>) {
  return (
    <P.Content
      {...props}
      data-ui="menu-content"
      className={cn("ui-menu-content", className)}
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
      data-ui="menu-item"
      className={cn("ui-menu-item", className)}
    />
  );
}
export function Label({
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
export function Separator({
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
export function RadioItem({
  className,
  ...props
}: React.ComponentProps<typeof P.RadioItem>) {
  return (
    <P.RadioItem
      {...props}
      data-ui="menu-item"
      className={cn("ui-menu-item", className)}
    />
  );
}
export function CheckboxItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof P.CheckboxItem>) {
  return (
    <P.CheckboxItem
      {...props}
      data-ui="menu-checkbox"
      className={cn("ui-menu-item ui-menu-checkbox", className)}
    >
      {children}
      <P.ItemIndicator className="ui-item-indicator">
        <Check aria-hidden="true" />
      </P.ItemIndicator>
    </P.CheckboxItem>
  );
}
export function DropdownMenuContent(
  props: React.ComponentProps<typeof Content>,
) {
  return (
    <Portal>
      <Content {...props} />
    </Portal>
  );
}
export {
  CheckboxItem as DropdownMenuCheckboxItem,
  Item as DropdownMenuItem,
  Label as DropdownMenuLabel,
  Root as DropdownMenu,
  Separator as DropdownMenuSeparator,
  Trigger as DropdownMenuTrigger,
};
