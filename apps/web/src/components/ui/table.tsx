// Adapted from shadcn/ui new-york Radix components (MIT). Workbench owns token styling.

import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils.js";
import { Button } from "./button.js";
export function Table({ className, ...props }: ComponentProps<"table">) {
  return (
    <table {...props} data-ui="table" className={cn("ui-table", className)} />
  );
}
export function TableHeader({ className, ...props }: ComponentProps<"thead">) {
  return (
    <thead
      {...props}
      data-ui="table-header"
      className={cn("ui-table-header", className)}
    />
  );
}
export function TableBody({ className, ...props }: ComponentProps<"tbody">) {
  return (
    <tbody
      {...props}
      data-ui="table-body"
      className={cn("ui-table-body", className)}
    />
  );
}
export function TableFooter({ className, ...props }: ComponentProps<"tfoot">) {
  return (
    <tfoot
      {...props}
      data-ui="table-footer"
      className={cn("ui-table-footer", className)}
    />
  );
}
/** `current` marks the row a link pointed at (shared selected background). */
export function TableRow({
  className,
  current,
  ...props
}: ComponentProps<"tr"> & { current?: boolean }) {
  return (
    <tr
      {...props}
      aria-current={current ? "true" : props["aria-current"]}
      data-ui="table-row"
      className={cn("ui-table-row", className)}
    />
  );
}
export function TableCell({ className, ...props }: ComponentProps<"td">) {
  return (
    <td
      {...props}
      data-ui="table-cell"
      className={cn("ui-table-cell", className)}
    />
  );
}
export function TableCaption({
  className,
  ...props
}: ComponentProps<"caption">) {
  return (
    <caption
      {...props}
      data-ui="table-caption"
      className={cn("ui-table-caption", className)}
    />
  );
}
export function TableHead({
  className,
  children,
  sort,
  onSort,
  ...props
}: ComponentProps<"th"> & {
  sort?: "ascending" | "descending" | "none";
  onSort?: (() => void) | undefined;
}) {
  const Arrow =
    sort === "ascending"
      ? ArrowUp
      : sort === "descending"
        ? ArrowDown
        : ArrowUpDown;
  return (
    <th
      {...props}
      scope="col"
      data-ui="table-head"
      className={cn("ui-table-head", className)}
      aria-sort={onSort ? sort : undefined}
    >
      {onSort ? (
        <Button variant="ghost" className="ui-sort" onClick={onSort}>
          {children}
          <Arrow aria-hidden="true" />
        </Button>
      ) : (
        children
      )}
    </th>
  );
}
