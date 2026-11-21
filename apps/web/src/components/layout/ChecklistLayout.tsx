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
