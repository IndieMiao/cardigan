// shadcn/ui input, MIT.

import { Search } from "lucide-react";
import { type ComponentProps, forwardRef } from "react";
import { cn } from "../../lib/utils.js";

const Input = forwardRef<HTMLInputElement, ComponentProps<"input">>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      data-ui="input"
      className={cn("ui-input", className)}
      {...props}
    />
  ),
);
Input.displayName = "Input";
const SearchInput = forwardRef<HTMLInputElement, ComponentProps<"input">>(
  ({ className, ...props }, ref) => (
    <span className={cn("ui-search", className)}>
      <Search aria-hidden="true" />
      <Input ref={ref} type="search" {...props} />
    </span>
  ),
);
SearchInput.displayName = "SearchInput";

export function RadioChoice({
  children,
  ...props
}: Omit<ComponentProps<"input">, "type">) {
  return (
    <label className="grid min-h-control grid-cols-[auto_1fr] items-center gap-2">
      <input {...props} type="radio" className="m-0 size-4 accent-(--accent)" />
      <span>{children}</span>
    </label>
  );
}

export { Input, SearchInput };
