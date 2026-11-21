import { CircleHelp, TriangleAlert } from "lucide-react";
import {
  type ComponentProps,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { cn } from "../../lib/utils.js";
import { renderMarkdown } from "../../markdown.js";
import { Tooltip } from "../Tooltip.js";
import { Button, IconButton } from "../ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "../ui/dialog.js";
import { Input } from "../ui/input.js";
import { cardDetailDrawerClassName } from "./CardDetailLayout.js";
import { DataTableLayout } from "./DataTableLayout.js";
import styles from "./SettingsLayout.module.css";

/**
 * Settings shell inside the shared workspace (same padding as the cards page):
 * page header, a text navigation list and the selected panel. On wide screens
 * the header and the navigation stay in view while the panel scrolls.
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
  return (
    <div className={cn("ui-workspace", styles.workspace)}>
      <div className={styles.header}>{header}</div>
      <div className={styles.layout}>
        <nav aria-label="设置分栏" className={styles.nav}>
          <div className={styles.navList}>{nav}</div>
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
  actions,
  children,
  ...props
}: Omit<ComponentProps<"section">, "title" | "className"> & {
  title: ReactNode;
  titleId: string;
  help?: ReactNode;
  /** Panel-wide actions (search, "新建…") at the right of the title. */
  actions?: ReactNode;
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
        {actions && <div className={styles.panelActions}>{actions}</div>}
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
  children?: ReactNode;
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
      {(status || children) && (
        <div className={styles.control}>
          {status}
          {children}
        </div>
      )}
    </div>
  );
}

/**
 * Rows in the bordered group frame without a group heading, for a settings
 * drawer section that already has its title (e.g. a machine's Agent limit).
 */
export function SettingsRows({ children }: { children: ReactNode }) {
  return <div className={styles.rows}>{children}</div>;
}

/** A read-only value in a row's control column (13px/20px, like descriptions). */
export function SettingsValue({ children }: { children: ReactNode }) {
  return <span className={styles.value}>{children}</span>;
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

/**
 * List settings (roles, templates, people) use the shared data table, fitted
 * to the settings column instead of the cards list's 48rem minimum; ≤640px
 * shows `records`: the `data-record="lead"` / `"aside"` cells share the first
 * line, the rest follow as labelled lines, one divider per record.
 */
export function SettingsTable(props: ComponentProps<typeof DataTableLayout>) {
  return <DataTableLayout records {...props} className={styles.table} />;
}

/** Read-only name/value pairs in a settings drawer (role or template detail). */
export function SettingsFacts({ children }: { children: ReactNode }) {
  return <dl className={styles.facts}>{children}</dl>;
}
export function SettingsFact({
  label,
  children,
}: {
  label: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={styles.fact}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** A titled block inside a settings drawer (diff, history, work items). */
export function SettingsSection({
  title,
  children,
}: {
  title: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={styles.section}>
      <h3 id={id}>{title}</h3>
      {children}
    </section>
  );
}

/** Long text (instructions, JSON, line diffs): monospace, scrolls inside. */
export function SettingsText(props: Omit<ComponentProps<"pre">, "className">) {
  return <pre {...props} className={styles.longText} />;
}
/** Rendered Markdown (a role description preview): bounded, scrolls inside. */
export function SettingsMarkdown({
  source,
  label,
}: {
  source: string;
  label: string;
}) {
  return (
    <section
      aria-label={label}
      className={cn("markdown", styles.markdown)}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: long previews scroll by keyboard.
      tabIndex={0}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: `renderMarkdown` escapes raw HTML and filters links.
      dangerouslySetInnerHTML={{ __html: renderMarkdown(source) }}
    />
  );
}

/**
 * C-494: closing a drawer form with unapplied edits asks first. Keeping the
 * edits is the default action; the dialog and its overlay sit above the
 * drawer (`--ui-layer-confirm`).
 */
export function SettingsDiscardDialog({
  open,
  onKeep,
  onDiscard,
}: {
  open: boolean;
  onKeep: () => void;
  onDiscard: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onKeep();
      }}
    >
      <DialogContent
        className={cn(styles.dialog, styles.confirm)}
        overlayClassName={styles.confirm}
      >
        <DialogTitle>放弃未应用的修改？</DialogTitle>
        <DialogDescription className="visually-hidden">
          关闭后这次填写的内容不会保留。
        </DialogDescription>
        <SettingsDialogActions>
          <Button onClick={onKeep}>继续编辑</Button>
          <Button variant="destructive" onClick={onDiscard}>
            放弃修改
          </Button>
        </SettingsDialogActions>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Unapplied drawer edits: closing the tab or reloading asks through the
 * browser; `ask(leave)` routes every in-app way out (closing the drawer,
 * cancelling an edit) through the dialog and only leaves on "放弃修改".
 */
export function useDiscardGuard(dirty: boolean, close: () => void) {
  const [pending, setPending] = useState<() => void>();
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const ask = useCallback(
    (leave: () => void) => {
      if (dirty) setPending(() => leave);
      else leave();
    },
    [dirty],
  );
  const confirmClose = useCallback(() => ask(close), [ask, close]);
  const dialog = (
    <SettingsDiscardDialog
      open={pending !== undefined}
      onKeep={() => setPending(undefined)}
      onDiscard={() => {
        const leave = pending;
        setPending(undefined);
        leave?.();
      }}
    />
  );
  return { ask, confirmClose, dialog };
}

/**
 * A file picker that looks like the other 28px buttons: the native input
 * stays hidden and the button opens it. The value is reset after each
 * choice so choosing the same file again still reports it.
 */
export function SettingsFileButton({
  label,
  accept,
  disabled,
  onFile,
}: {
  label: string;
  accept: string;
  disabled?: boolean;
  onFile: (file: File | undefined) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <span className={styles.fileButton}>
      <Button disabled={disabled} onClick={() => input.current?.click()}>
        {label}
      </Button>
      <input
        ref={input}
        type="file"
        hidden
        tabIndex={-1}
        aria-hidden="true"
        accept={accept}
        onChange={(event) => {
          onFile(event.target.files?.[0]);
          event.target.value = "";
        }}
      />
    </span>
  );
}

/** One diff line or value; additions and removals use the status colours. */
export function SettingsDiff({
  op,
  ...props
}: Omit<ComponentProps<"span">, "className"> & {
  op?: "add" | "remove" | undefined;
}) {
  return <span {...props} className={styles.diff} data-op={op} />;
}

/**
 * C-516: one labelled form field whose problem is shown right below it and
 * tied to the control (`aria-invalid` red border + `aria-describedby`).
 */
export function SettingsField({
  label,
  error,
  children,
}: {
  label: ReactNode;
  error?: string | undefined;
  children: (field: {
    invalid: true | undefined;
    describedBy: string | undefined;
  }) => ReactNode;
}) {
  const id = useId();
  return (
    <>
      {/* biome-ignore lint/a11y/noLabelWithoutControl: the control comes from `children`. */}
      <label>
        {label}
        {children({
          invalid: error ? true : undefined,
          describedBy: error ? id : undefined,
        })}
      </label>
      {error && <SettingsWarning id={id}>{error}</SettingsWarning>}
    </>
  );
}

/** A risk or validation note inside a settings form: danger colour, icon first. */
export function SettingsWarning({
  children,
  ...props
}: Omit<ComponentProps<"div">, "className">) {
  return (
    <div {...props} className={styles.notice}>
      <TriangleAlert aria-hidden="true" />
      <div>{children}</div>
    </div>
  );
}

/** Library portrait or uploaded avatar at identity size (24px, 64px preview). */
export function SettingsAvatar({
  large = false,
  ...props
}: Omit<ComponentProps<"img">, "className" | "width" | "height"> & {
  large?: boolean;
}) {
  return (
    <img
      alt=""
      {...props}
      className={styles.avatar}
      data-large={large || undefined}
    />
  );
}
/** Avatar and name on one line, wrapping the name when narrow. */
export function SettingsIdentity({ children }: { children: ReactNode }) {
  return <span className={styles.identity}>{children}</span>;
}

/**
 * Request feedback for a drawer's own content (loading, a failed read and its
 * retry) shown in the drawer body where it sits, not in the floating stacks.
 * While it is mounted the page stack moves to the bottom corner, so a page
 * notice never covers the drawer's retry.
 */
export function SettingsDrawerFeedback({ children }: { children: ReactNode }) {
  return (
    <div data-feedback-host="" className={styles.drawerFeedback}>
      {children}
    </div>
  );
}

/**
 * Settings drawers use the card detail drawer frame. While one is open the
 * request feedback stacks (the drawer's own and the page's) start below the
 * drawer header, so a toast never covers its actions or the close button.
 */
export const settingsDrawerClassName = cn(
  cardDetailDrawerClassName,
  styles.drawer,
);

/**
 * Drawers opened from a table row or a panel button are controlled (no Radix
 * trigger): remember the opener when opening and give it focus back once the
 * drawer is gone. An opener removed meanwhile (a person now taken) gives way
 * to `fallback`. Call `remember` right before opening; `forget` when the
 * opener is known to disappear.
 */
export function useDrawerReturnFocus(
  open: boolean,
  /** Where focus goes when the opener is gone (e.g. a row that changed). */
  fallback?: () => HTMLElement | null | undefined,
) {
  const fallbackRef = useRef(fallback);
  fallbackRef.current = fallback;
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(open);
  useEffect(() => {
    if (wasOpen.current && !open) {
      const target = opener.current;
      opener.current = null;
      // After the dialog's own focus restoration, which runs on unmount.
      window.setTimeout(() => {
        const active = document.activeElement;
        if (active && active !== document.body && active.isConnected) return;
        if (target?.isConnected) target.focus();
        else fallbackRef.current?.()?.focus();
      }, 0);
    }
    wasOpen.current = open;
  }, [open]);
  const remember = useCallback(() => {
    if (wasOpen.current) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body)
      opener.current = active;
  }, []);
  /** The opener is about to go away (e.g. the person was just taken): use the fallback. */
  const forget = useCallback(() => {
    opener.current = null;
  }, []);
  return { remember, forget };
}
