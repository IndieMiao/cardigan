import type { ReactNode } from "react";
import { createPortal } from "react-dom";

/** Keep form state with its action while placing the panel below the toolbar. */
export function CardFormOutlet({
  container,
  children,
}: {
  container: HTMLElement | null | undefined;
  children: ReactNode;
}) {
  return container ? createPortal(children, container) : children;
}
