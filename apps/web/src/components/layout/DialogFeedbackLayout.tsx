import type { ReactNode } from "react";
import styles from "./DialogFeedbackLayout.module.css";

/**
 * Holds `RequestFeedback` in a dialog body's flow (after `DialogFields`), so a
 * failure shows inside the dialog under the inputs instead of floating.
 */
export function DialogFeedback({ children }: { children: ReactNode }) {
  return (
    <div data-feedback-host="" className={styles.feedback}>
      {children}
    </div>
  );
}
