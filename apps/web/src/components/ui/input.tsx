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

export { Input, SearchInput };
