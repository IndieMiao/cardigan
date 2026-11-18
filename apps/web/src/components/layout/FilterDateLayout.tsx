import type { ReactNode } from "react";
import styles from "./FilterDateLayout.module.css";

/** Frame of a toolbar date filter; the visible prefix reuses the select prefix. */
export function FilterDateLayout({ children }: { children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: FilterDate passes the date input as a child.
    <label className={styles.field}>{children}</label>
  );
}
