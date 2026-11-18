import { CircleHelp, TriangleAlert } from "lucide-react";
import { type ComponentProps, type ReactNode, useId } from "react";
import { cn } from "../../lib/utils.js";
import { Tooltip } from "../Tooltip.js";
import { IconButton } from "../ui/button.js";
import { Input } from "../ui/input.js";
import styles from "./SettingsLayout.module.css";

/**
 * Settings shell inside the shared workspace (same padding as the cards page):
 * page header, a text navigation list and the selected panel.
 */
export function SettingsLayout({
  header,
  nav,
  children,
}: {
  header: ReactNode;
  nav: ReactNode;
  children: ReactNode;
}) {
  // `settings-layout` keeps the legacy panels (roles, templates…) styled until migrated.
  return (
    <div className={cn("ui-workspace", styles.workspace)}>
      {header}
      <div className={cn("settings-layout", styles.layout)}>
        <nav aria-label="设置分栏" className={styles.nav}>
          {nav}
        </nav>
        <div className={styles.main}>{children}</div>
      </div>
    </div>
  );
}

export function SettingsNavItem({
  current,
  ...props
}: Omit<ComponentProps<"button">, "type" | "className"> & {
  current: boolean;
}) {
  return (
    <button
      {...props}
      type="button"
      className={styles.navItem}
      aria-current={current ? "page" : undefined}
    />
  );
}

/** One settings panel with a bounded line length; groups stack inside it. */
export function SettingsPanel({
  title,
  titleId,
  help,
  children,
  ...props
}: Omit<ComponentProps<"section">, "title" | "className"> & {
  title: ReactNode;
  titleId: string;
  help?: ReactNode;
}) {
  return (
    <section
      {...props}
      aria-labelledby={titleId}
      className={styles.panel}
      data-settings-content=""
    >
      <div className={styles.panelHeading}>
        <h2 id={titleId}>{title}</h2>
        {help && <SettingsHelp label={`${title}说明`}>{help}</SettingsHelp>}
      </div>
      {children}
    </section>
  );
}

/** A titled group of rows. `caution` marks settings only the human may loosen. */
export function SettingsGroup({
  title,
  description,
  tone,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  tone?: "caution";
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      className={styles.group}
      data-tone={tone}
      data-settings-group=""
    >
      <div className={styles.groupHeading}>
        <h3 id={id}>
          {tone === "caution" && <TriangleAlert aria-hidden="true" />}
          {title}
        </h3>
        {description && <p>{description}</p>}
      </div>
      <div className={styles.rows}>{children}</div>
    </section>
  );
}

/**
 * Name and short description on the left, the control on the right.
 * Controls save themselves; request feedback stays out of the page flow.
 */
export function SettingsRow({
  label,
  labelId,
  htmlFor,
  description,
  descriptionId,
  help,
  warning,
  status,
  children,
}: {
  label: ReactNode;
  labelId?: string;
  htmlFor?: string;
  description?: ReactNode;
  descriptionId?: string;
  help?: ReactNode;
  warning?: ReactNode;
  status?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={styles.row} data-settings-row="">
      <div className={styles.text}>
        <div className={styles.label}>
          {htmlFor ? (
            <label id={labelId} htmlFor={htmlFor}>
              {label}
            </label>
          ) : (
            <span id={labelId}>{label}</span>
          )}
          {help && <SettingsHelp label={`${label}说明`}>{help}</SettingsHelp>}
        </div>
        {description && (
          <p id={descriptionId} className={styles.description}>
            {description}
          </p>
        )}
        {warning && (
          <p className={styles.warning}>
            <TriangleAlert aria-hidden="true" />
            {warning}
          </p>
        )}
      </div>
      <div className={styles.control}>
        {status}
        {children}
      </div>
    </div>
  );
}

/**
 * Integer field with its unit; commits on blur or Enter (instant save).
 * An unsaved edit tints the border without taking space.
 */
export function SettingsNumberField({
  unit,
  dirty = false,
  invalid = false,
  onCommit,
  ...props
}: Omit<ComponentProps<"input">, "type" | "className"> & {
  unit: string;
  dirty?: boolean;
  invalid?: boolean;
  onCommit: () => void;
}) {
  return (
    <span className={styles.number} data-dirty={dirty || undefined}>
      <Input
        {...props}
        aria-invalid={invalid || undefined}
        type="number"
        step="1"
        inputMode="numeric"
        onBlur={(event) => {
          props.onBlur?.(event);
          onCommit();
        }}
        onKeyDown={(event) => {
          props.onKeyDown?.(event);
          if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
          event.preventDefault();
          onCommit();
        }}
      />
      <span aria-hidden="true">{unit}</span>
    </span>
  );
}

export function SettingsHelp({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <Tooltip content={children}>
      <IconButton aria-label={label} variant="ghost" className={styles.help}>
        <CircleHelp aria-hidden="true" />
      </IconButton>
    </Tooltip>
  );
}

/** Settings dialogs keep request feedback in their own flow, below the actions. */
export const settingsDialogClassName = styles.dialog;

/** Dialog body fields for multi-value settings that save together. */
export function SettingsDialogFields({ children }: { children: ReactNode }) {
  return <div className={styles.dialogFields}>{children}</div>;
}
export function SettingsDialogActions({ children }: { children: ReactNode }) {
  return <div className={styles.dialogActions}>{children}</div>;
}
