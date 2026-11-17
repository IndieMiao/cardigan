// shadcn/ui button, MIT. Only semantic variants; all sizing lives in theme.css.
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { type ButtonHTMLAttributes, forwardRef } from "react";
import { cn } from "../../lib/utils.js";

const buttonVariants = cva("ui-button", {
  variants: {
    variant: {
      default: "ui-button-default",
      primary: "ui-button-primary",
      secondary: "ui-button-secondary",
      outline: "ui-button-default",
      ghost: "ui-button-ghost",
      destructive: "ui-button-destructive",
      link: "ui-button-link",
    },
    size: {
      default: "h-control",
      sm: "h-control",
      regular: "h-control-regular",
      icon: "size-control",
      "icon-regular": "size-control-regular",
    },
  },
  defaultVariants: { variant: "default", size: "default" },
});
export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}
const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { className, variant, size, asChild = false, type = "button", ...props },
    ref,
  ) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        ref={ref}
        type={asChild ? undefined : type}
        data-ui="button"
        className={cn(buttonVariants({ variant, size }), className)}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";
const IconButton = forwardRef<
  HTMLButtonElement,
  Omit<ButtonProps, "size"> & { "aria-label": string }
>((props, ref) => <Button {...props} ref={ref} size="icon" />);
IconButton.displayName = "IconButton";

export { Button, buttonVariants, IconButton };
