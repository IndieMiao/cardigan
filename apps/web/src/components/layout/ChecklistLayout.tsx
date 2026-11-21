import { type ReactNode, useId } from "react";
import styles from "./ChecklistLayout.module.css";

export function ChecklistSection({
  label,
  title,
  children,
}: {
  label: string;
  title: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className={styles.section} aria-label={label}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

/** Keep native list numbering, group names and disabled-fieldset semantics. */
export function ChecklistPanel({
  title,
  disabled,
  children,
  actions,
}: {
  title: ReactNode;
  disabled: boolean;
  children: ReactNode;
  actions: ReactNode;
}) {
  const id = useId();
  return (
    <fieldset className={styles.panel} disabled={disabled} aria-labelledby={id}>
      <div id={id} className={styles.title}>
        {title}
      </div>
      <ol>{children}</ol>
      {actions}
    </fieldset>
  );
}

export function ChecklistItem({
  title,
  context,
  children,
}: {
  title: ReactNode;
  context: ReactNode;
  children: ReactNode;
}) {
  return (
    <li>
      <strong>{title}</strong>
      <p className={styles.context}>{context}</p>
      {children}
    </li>
  );
}

/** C-503: one item's longer text, folded until opened; one per item. */
export function ChecklistDetails({
  summary,
  children,
}: {
  summary: ReactNode;
  children: ReactNode;
}) {
  return (
    <details className={styles.details}>
      <summary>{summary}</summary>
      {children}
    </details>
  );
}

/** C-503: the panel's buttons in one wrapping row, primary first. */
export function ChecklistActions({ children }: { children: ReactNode }) {
  return <div className={styles.actions}>{children}</div>;
}

/** C-503: a refusal shown where the action was taken, with what to do next. */
export function ChecklistAlert({ children }: { children: ReactNode }) {
  return (
    <div className={styles.alert} role="alert">
      {children}
    </div>
  );
}
