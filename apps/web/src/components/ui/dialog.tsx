// shadcn/ui Radix composition (MIT). Compatibility exports deliberately retain legacy visuals.
import * as P from "@radix-ui/react-dialog";
import type * as React from "react";
import { cn } from "../../lib/utils.js";
export const Root = P.Root,
  Trigger = P.Trigger,
  Portal = P.Portal,
  Close = P.Close,
  Overlay = P.Overlay,
  Content = P.Content,
  Title = P.Title,
  Description = P.Description;
export function DialogOverlay({
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
export function DialogPanel({
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
export function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof P.Title>) {
  return <P.Title {...props} className={cn("ui-dialog-title", className)} />;
}
export function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof P.Description>) {
  return (
    <P.Description
      {...props}
      className={cn("ui-dialog-description", className)}
    />
  );
}
export function DialogContent({
  children,
  inlineFeedback = false,
  overlayClassName,
  className,
  ...props
}: React.ComponentProps<typeof DialogPanel> & {
  inlineFeedback?: boolean;
  overlayClassName?: string | undefined;
}) {
  return (
    <Portal>
      <DialogOverlay className={overlayClassName} />
      <DialogPanel
        {...props}
        className={cn(
          inlineFeedback &&
            "[&>form]:border-0 [&>form]:p-0 [&>.request-feedback-region:has([role=alert])]:mt-3 [&>.request-feedback-region]:static [&>.request-feedback-region]:max-w-none [&>.request-feedback-region]:items-stretch",
          className,
        )}
      >
        {children}
      </DialogPanel>
    </Portal>
  );
}
export {
  Close as DialogClose,
  Portal as DialogPortal,
  Root as Dialog,
  Trigger as DialogTrigger,
};
