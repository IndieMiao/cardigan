// shadcn/ui Sheet (MIT). Existing Drawer imports raw compatibility primitives.
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils.js";
import { DialogOverlay, DialogPanel, Portal } from "./dialog.js";

export {
  Close,
  Close as SheetClose,
  Content,
  Description,
  DialogDescription as SheetDescription,
  DialogTitle as SheetTitle,
  Overlay,
  Portal,
  Root,
  Root as Sheet,
  Title,
  Trigger,
  Trigger as SheetTrigger,
} from "./dialog.js";
export function SheetContent({
  className,
  children,
  ...props
}: ComponentProps<typeof DialogPanel>) {
  return (
    <Portal>
      <DialogOverlay />
      <DialogPanel {...props} className={cn("ui-sheet", className)}>
        {children}
      </DialogPanel>
    </Portal>
  );
}
