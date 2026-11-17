import { type ComponentProps, forwardRef } from "react";
import { cn } from "../../lib/utils.js";
/** Multiline fields retain their rows and surrounding form layout. */
export const Textarea = forwardRef<
  HTMLTextAreaElement,
  ComponentProps<"textarea">
>(({ className, ...props }, ref) => (
  <textarea
    {...props}
    ref={ref}
    data-ui="textarea"
    className={cn("ui-textarea", className)}
  />
));
Textarea.displayName = "Textarea";
