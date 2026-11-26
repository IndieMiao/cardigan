import { type ComponentProps, forwardRef } from "react";
import { Tooltip } from "../Tooltip.js";
import { IconButton } from "./button.js";
import { MoreHorizontalIcon } from "./icons.js";

/**
 * The ⋯ trigger of a "more actions" menu: a 28px ghost icon button named by
 * `label`, with the same text as its tooltip. Pass it as `Menu.trigger`; the
 * menu's trigger props and ref reach the button. Beside 32px buttons (the
 * “下一步” panel) use `size="regular" variant="default"`.
 */
export const MoreButton = forwardRef<
  HTMLButtonElement,
  Omit<ComponentProps<typeof IconButton>, "aria-label" | "children"> & {
    label: string;
  }
>(({ label, variant = "ghost", ...props }, ref) => (
  <Tooltip content={label}>
    <IconButton {...props} ref={ref} variant={variant} aria-label={label}>
      <MoreHorizontalIcon aria-hidden="true" />
    </IconButton>
  </Tooltip>
));
MoreButton.displayName = "MoreButton";
