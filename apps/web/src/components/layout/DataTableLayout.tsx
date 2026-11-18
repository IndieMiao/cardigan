import type { ComponentProps } from "react";
import { cn } from "../../lib/utils.js";
import { Table } from "../ui/table.js";

/** Card-list column policy: 48rem minimum, automatic content widths, local scrolling. */
export function DataTableLayout({
  className,
  scrollClassName,
  ...props
}: ComponentProps<typeof Table> & { scrollClassName?: string }) {
  return (
    <div className={cn("card-table-scroll", scrollClassName)}>
      <Table {...props} className={cn("card-table", className)} />
    </div>
  );
}
