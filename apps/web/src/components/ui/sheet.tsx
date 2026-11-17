// Adapted from shadcn/ui new-york Radix components (MIT). Workbench owns token styling.
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils.js";
import { Content as DialogContent, Overlay, Portal } from "./dialog.js";

export {
  Close,
  Close as SheetClose,
  Description,
  Description as SheetDescription,
  Overlay,
  Portal,
  Root,
  Root as Sheet,
  Title,
  Title as SheetTitle,
  Trigger,
  Trigger as SheetTrigger,
} from "./dialog.js";
export function Content({
  className,
  ...props
}: ComponentProps<typeof DialogContent>) {
  return <DialogContent {...props} className={cn("ui-sheet", className)} />;
}
export function SheetContent({
  children,
  ...props
}: ComponentProps<typeof Content>) {
  return (
    <Portal>
      <Overlay />
      <Content {...props}>{children}</Content>
    </Portal>
  );
}
