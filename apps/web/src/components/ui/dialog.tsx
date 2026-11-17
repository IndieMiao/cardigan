// Adapted from shadcn/ui new-york Radix components (MIT). Workbench owns token styling.

import * as P from "@radix-ui/react-dialog";
import type * as React from "react";
import { cn } from "../../lib/utils.js";
export const Root = P.Root,
  Trigger = P.Trigger,
  Portal = P.Portal,
  Close = P.Close;
export function Overlay({
  className,
  ...props
}: React.ComponentProps<typeof P.Overlay>) {
  return (
    <P.Overlay
      {...props}
      data-ui="overlay"
      className={cn("ui-overlay", className)}
    />
  );
}
export function Content({
  className,
  ...props
}: React.ComponentProps<typeof P.Content>) {
  return (
    <P.Content
      {...props}
      data-ui="dialog"
      className={cn("ui-dialog", className)}
    />
  );
}
export function Title({
  className,
  ...props
}: React.ComponentProps<typeof P.Title>) {
  return (
    <P.Title
      {...props}
      data-ui="dialog-title"
      className={cn("ui-dialog-title", className)}
    />
  );
}
export function Description({
  className,
  ...props
}: React.ComponentProps<typeof P.Description>) {
  return (
    <P.Description
      {...props}
      data-ui="dialog-description"
      className={cn("ui-dialog-description", className)}
    />
  );
}
export function DialogContent({
  children,
  ...props
}: React.ComponentProps<typeof Content>) {
  return (
    <Portal>
      <Overlay />
      <Content {...props}>{children}</Content>
    </Portal>
  );
}
export {
  Close as DialogClose,
  Description as DialogDescription,
  Overlay as DialogOverlay,
  Portal as DialogPortal,
  Root as Dialog,
  Title as DialogTitle,
  Trigger as DialogTrigger,
};
