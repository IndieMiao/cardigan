import {
  type ComponentProps,
  type ReactNode,
  useId,
  useRef,
  useState,
} from "react";
import { cn } from "../../lib/utils.js";
import { Button, IconButton } from "../ui/button.js";
import { Checkbox } from "../ui/checkbox.js";
import { ChevronRightIcon } from "../ui/icons.js";
import styles from "./NeedsRowLayout.module.css";

/**
 * C-459: one Needs You group. The header bar matches the card table header;
 * batch actions sit on its right edge. Rows are separated like table rows.
 */
export function NeedsList({
  label,
  title,
  actions,
  children,
  className,
  headingRef,
}: {
  label: string;
  title: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  headingRef?: React.Ref<HTMLHeadingElement>;
}) {
  return (
    <section
      className={cn("needs-group", styles.group, className)}
      aria-label={label}
    >
      <header className={styles.groupHead}>
        <h2 ref={headingRef} tabIndex={headingRef ? -1 : undefined}>
          {title}
        </h2>
        {actions && <div className={styles.batch}>{actions}</div>}
      </header>
      <div className={styles.rows}>{children}</div>
    </section>
  );
}

/** Trailing row of a list, e.g. "显示更多" or an empty fact. */
export function NeedsListFooter({ children }: { children: ReactNode }) {
  return <div className={styles.footer}>{children}</div>;
}

/** Banner area above the lists (pause notice, checks still running). */
export function NeedsNotice({ className, ...props }: ComponentProps<"div">) {
  return <div {...props} className={cn(styles.notice, className)} />;
}

export interface NeedsRowProps {
  /** Accessible name of the article, e.g. "拍板 Q-1". */
  readonly label: string;
  /** Card link and the item's own typed id, in that order. */
  readonly ids: ReactNode;
  readonly title: ReactNode;
  /** One-line plain summary under the title. */
  readonly summary?: ReactNode;
  /** C-503: why the row's direct action was refused; stays visible when folded. */
  readonly alert?: ReactNode;
  readonly time?: ReactNode;
  readonly status?: ReactNode;
  /** The single primary action; always the right-most control. */
  readonly action?: ReactNode;
  readonly urgent?: boolean;
  readonly muted?: boolean;
  /** Folded details; absent for rows that are complete on one line. */
  readonly children?: ReactNode;
  readonly defaultOpen?: boolean;
  readonly bodyClassName?: string | undefined;
  readonly className?: string | undefined;
}

/**
 * The single Needs You row: left ids + title + summary, right time, status
 * and primary action. Details fold under the title disclosure.
 */
export function NeedsRow({
  label,
  ids,
  title,
  summary,
  alert,
  time,
  status,
  action,
  urgent = false,
  muted = false,
  children,
  defaultOpen = false,
  bodyClassName,
  className,
}: NeedsRowProps) {
  const id = useId();
  const [open, setOpen] = useState(defaultOpen);
  return (
    <article
      aria-label={label}
      data-needs-row=""
      data-urgent={urgent ? "" : undefined}
      data-muted={muted ? "" : undefined}
      data-open={children && open ? "" : undefined}
      className={cn(styles.row, urgent && "urgent", className)}
    >
      <div className={styles.head}>
        <span className={styles.gutter}>
          {children && (
            <IconButton
              variant="ghost"
              className={styles.toggle}
              data-needs-row-toggle=""
              aria-label={`详情 ${label}`}
              aria-expanded={open}
              aria-controls={`${id}-body`}
              onClick={() => setOpen((value) => !value)}
            >
              <ChevronRightIcon aria-hidden="true" />
            </IconButton>
          )}
        </span>
        <div className={styles.lead}>
          <div className={styles.ids} data-needs-row-ids="">
            {ids}
          </div>
          <h3 className={styles.title} data-needs-row-title="">
            {title}
          </h3>
          {summary && <p className={styles.summary}>{summary}</p>}
          {alert && (
            <div className={styles.alert} role="alert">
              {alert}
            </div>
          )}
        </div>
        <div className={styles.trail}>
          {time && <span className={styles.time}>{time}</span>}
          {status && <span className={styles.status}>{status}</span>}
          {action && (
            <span className={styles.action} data-needs-row-action="">
              {action}
            </span>
          )}
        </div>
      </div>
      {children && (
        <div
          id={`${id}-body`}
          data-needs-row-body=""
          className={cn(styles.body, bodyClassName)}
          data-open={open ? "" : undefined}
        >
          {children}
        </div>
      )}
    </article>
  );
}

/**
 * C-832: several values to tick inside a row's details form (e.g. the
 * projects a device is for); checkboxes sit side by side and wrap.
 */
export function NeedsChoices({
  legend,
  children,
}: {
  legend: ReactNode;
  children: ReactNode;
}) {
  return (
    <fieldset className={styles.choices}>
      <legend>{legend}</legend>
      <div className={styles.choiceList}>{children}</div>
    </fieldset>
  );
}

/** One checkbox of `NeedsChoices` with its name. */
export function NeedsChoice({
  children,
  ...props
}: ComponentProps<typeof Checkbox> & { children: ReactNode }) {
  return (
    <label className={styles.choice}>
      <Checkbox {...props} />
      {children}
    </label>
  );
}

/** A details form's buttons in one row at their own width. */
export function NeedsFormActions({ children }: { children: ReactNode }) {
  return <div className={styles.formActions}>{children}</div>;
}

/** Keeps a details form's RequestFeedback in the row, under its buttons. */
export function NeedsFormFeedback({ children }: { children: ReactNode }) {
  return (
    <div data-feedback-host="" className={styles.formFeedback}>
      {children}
    </div>
  );
}

const FOCUSABLE =
  "input:not([type=hidden]), textarea, select, button, summary, a[href]";
const usable = (element: Element) =>
  !element.closest("[hidden], .needs-meta") &&
  !(element as HTMLButtonElement).disabled;

/**
 * The control "处理" lands on: the first usable control inside the details'
 * `data-needs-focus` regions (options, result field, merge actions), else the
 * first usable control outside the requester line.
 */
export function needsFocusTarget(body: Element): HTMLElement | undefined {
  const marked = [...body.querySelectorAll("[data-needs-focus]")].flatMap(
    (region) => [...region.querySelectorAll<HTMLElement>(FOCUSABLE)],
  );
  const target =
    marked.find(usable) ??
    [...body.querySelectorAll<HTMLElement>(FOCUSABLE)].find(usable);
  // A radio group is entered at its checked option.
  if (target instanceof HTMLInputElement && target.type === "radio")
    return (
      [
        ...body.querySelectorAll<HTMLInputElement>(
          `input[type=radio][name="${CSS.escape(target.name)}"]`,
        ),
      ].find((radio) => radio.checked && usable(radio)) ?? target
    );
  return target;
}

/**
 * Primary action for rows whose decision needs input: opens the details and
 * moves focus to their first actionable control. Uses the shared 28px button;
 * rows that do not wait on the human use the secondary variant.
 */
export function NeedsOpenAction({
  name,
  children = "处理",
  secondary = false,
}: {
  /** Accessible name including the item id, e.g. "处理 Q-1". */
  name: string;
  children?: ReactNode;
  secondary?: boolean;
}) {
  const self = useRef<HTMLButtonElement>(null);
  return (
    <Button
      ref={self}
      variant={secondary ? "default" : "primary"}
      aria-label={name}
      onClick={() => {
        const row = self.current?.closest("[data-needs-row]");
        const toggle = row?.querySelector<HTMLButtonElement>(
          "[data-needs-row-toggle]",
        );
        if (toggle?.getAttribute("aria-expanded") === "false") toggle.click();
        requestAnimationFrame(() => {
          const body = row?.querySelector("[data-needs-row-body]");
          if (body) needsFocusTarget(body)?.focus();
        });
      }}
    >
      {children}
    </Button>
  );
}
