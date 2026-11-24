import type { ReactNode } from "react";
import styles from "./DialogFeedbackLayout.module.css";

/**
 * In-flow request feedback for a fixed-footer dialog: place it between
 * `DialogBody` and `DialogFooter` with the dialog's `RequestFeedback` inside.
 * Saving and its error then show above the buttons instead of over the
 * title; nothing takes room while there is no feedback.
 */
export function DialogFeedback({ children }: { children: ReactNode }) {
  return (
    <div data-feedback-host="" className={styles.feedback}>
      {children}
    </div>
  );
}
