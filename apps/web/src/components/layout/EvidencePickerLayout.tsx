import { type ReactNode, useId } from "react";
import { Checkbox } from "../ui/checkbox.js";
import styles from "./EvidencePickerLayout.module.css";

/**
 * C-696: choose files in a dialog (e.g. the evidence of “标记完成”). The head
 * row holds the label, a muted count and the actions; the list below has
 * 32px rows and scrolls inside itself after seven rows.
 */
export function EvidencePicker({
  label,
  count,
  actions,
  children,
}: {
  label: string;
  count?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <fieldset aria-labelledby={id} className={styles.picker}>
      <div className={styles.head}>
        <span id={id} className={styles.label}>
          {label}
        </span>
        {count !== undefined && <span className={styles.count}>{count}</span>}
        {actions && <span className={styles.actions}>{actions}</span>}
      </div>
      {children}
    </fieldset>
  );
}

export function EvidenceList({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <ul className={styles.list} aria-label={label}>
      {children}
    </ul>
  );
}

/** A whole-row label: clicking anywhere on it toggles the checkbox. */
export function EvidenceRow({
  checked,
  disabled = false,
  onCheckedChange,
  icon,
  name,
  trailing,
}: {
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
  icon?: ReactNode;
  name: string;
  trailing?: ReactNode;
}) {
  return (
    <li>
      <label className={styles.row} data-selected={checked || undefined}>
        <Checkbox
          checked={checked}
          disabled={disabled}
          onCheckedChange={(next) => onCheckedChange(next === true)}
        />
        {icon}
        <span className={styles.name} title={name}>
          {name}
        </span>
        {trailing}
      </label>
    </li>
  );
}

/** The list's place when there is nothing to choose: the shortest fact. */
export function EvidenceEmpty({ children }: { children: ReactNode }) {
  return <p className={styles.empty}>{children}</p>;
}

export const evidenceIconClassName = styles.icon;
