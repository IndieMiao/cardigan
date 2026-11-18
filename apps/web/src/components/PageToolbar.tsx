import type { ComponentProps, ReactNode } from "react";
import { FilterBar } from "./FilterBar.js";

/** Left fields wrap independently; the right action group stays together. */
export function PageToolbar({
  children,
  ...props
}: Omit<ComponentProps<typeof FilterBar>, "children"> & {
  children?: ReactNode;
}) {
  return (
    <FilterBar {...props}>
      {children && (
        <div className="cards-page-actions ui-action-row">{children}</div>
      )}
    </FilterBar>
  );
}
