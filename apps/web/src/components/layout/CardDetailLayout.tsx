import {
  type ComponentProps,
  forwardRef,
  type ReactNode,
  useId,
  useState,
} from "react";
import { cn } from "../../lib/utils.js";
import { ChevronRightIcon } from "../ui/icons.js";
import { DetailProse } from "../ui/prose.js";
import styles from "./CardDetailLayout.module.css";

export const cardDetailDrawerClassName = styles.drawer;
export const CardDetailLayout = forwardRef<
  HTMLElement,
  ComponentProps<"article">
>(({ className, children, ...props }, ref) => (
  <DetailProse value={true}>
    <article {...props} ref={ref} className={cn(styles.page, className)}>
      {children}
    </article>
  </DetailProse>
));
CardDetailLayout.displayName = "CardDetailLayout";
export function CardDetailHeading(props: ComponentProps<"div">) {
  return <div {...props} className={styles.heading} />;
}
/**
 * C-531: an inline owner avatar (24px slot) inside a 20px text line. The box
 * keeps the line's own height; the avatar overflows it evenly, so adding an
 * owner never pushes the following rows down.
 */
export function CardDetailInlineOwner(props: ComponentProps<"span">) {
  return <span {...props} className={styles.inlineOwner} />;
}
export function CardDetailTabs(props: ComponentProps<"div">) {
  return <div {...props} className={cn(styles.tabs, "card-section-nav")} />;
}

/**
 * C-695: the line under the title: facts (status, update time, risk) on the
 * left, the card's own actions (编辑, ⋯) on the right. 13/20.
 */
export function DetailStatusRow({
  actions,
  children,
  ...props
}: Omit<ComponentProps<"section">, "className"> & {
  readonly actions?: ReactNode;
}) {
  return (
    <section {...props} className={styles.statusRow}>
      <div className={styles.statusFacts}>{children}</div>
      {actions && <div className={styles.statusActions}>{actions}</div>}
    </section>
  );
}

/**
 * C-695: “下一步”: the one place that says who the card waits for and holds
 * the page's only emphasis button. `mine` marks a wait on you (--status-wait
 * border and a 3px leading line).
 */
export const DetailNextStep = forwardRef<
  HTMLElement,
  {
    readonly title: ReactNode;
    readonly mine?: boolean;
    readonly actions?: ReactNode;
    readonly children?: ReactNode;
    readonly "aria-label"?: string;
  }
>(({ title, mine = false, actions, children, ...props }, ref) => (
  <section
    ref={ref}
    aria-label={props["aria-label"] ?? "下一步"}
    data-mine={mine || undefined}
    className={styles.next}
  >
    <div className={styles.nextBody}>
      <h2 className={styles.nextTitle}>{title}</h2>
      {children}
    </div>
    {actions && (
      <div className={styles.nextActions} data-next-actions>
        {actions}
      </div>
    )}
  </section>
));
DetailNextStep.displayName = "DetailNextStep";
/**
 * One 13/20 muted fact line inside DetailNextStep; `strong` is the line the
 * panel asks about (a decision's question): text colour, 600.
 */
export function DetailNextStepLine({
  strong = false,
  ...props
}: Omit<ComponentProps<"div">, "className"> & { readonly strong?: boolean }) {
  return (
    <div
      {...props}
      data-strong={strong || undefined}
      className={styles.nextLine}
    />
  );
}
/** C-698: a write answered inside DetailNextStep; its rows 8px apart. */
export function DetailChoiceForm(
  props: Omit<ComponentProps<"form">, "className">,
) {
  return <form {...props} className={styles.choiceForm} />;
}
/**
 * C-698: options answered inside DetailNextStep (a decision): a fieldset of
 * bordered single-choice rows, 4px apart. The legend is for screen readers.
 */
export function DetailChoices({
  legend,
  children,
  ...props
}: Omit<ComponentProps<"fieldset">, "className"> & {
  readonly legend: string;
}) {
  return (
    <fieldset {...props} className={styles.choices}>
      <legend className="visually-hidden">{legend}</legend>
      {children}
    </fieldset>
  );
}
/** One option row: radio, name (14/20) with tags, a 13/20 muted detail line. */
export function DetailChoice({
  label,
  tags,
  detail,
  ...props
}: Omit<ComponentProps<"input">, "type" | "className" | "children"> & {
  readonly label: ReactNode;
  readonly tags?: ReactNode;
  readonly detail?: ReactNode;
}) {
  return (
    <label className={styles.choice} data-selected={props.checked || undefined}>
      <input {...props} type="radio" className={styles.choiceRadio} />
      <span className={styles.choiceText}>
        <span className={styles.choiceName}>
          {label}
          {tags}
        </span>
        {detail && <span className={styles.choiceDetail}>{detail}</span>}
      </span>
    </label>
  );
}
/** A short tag after an option name (“建议”). */
export function DetailChoiceTag({
  children,
}: {
  readonly children: ReactNode;
}) {
  return <span className={styles.choiceTag}>{children}</span>;
}
/** A text field under the options; label 13/20 600 above the control. */
export function DetailChoiceField({
  label,
  htmlFor,
  children,
}: {
  readonly label: ReactNode;
  /** The id of the control in `children`. */
  readonly htmlFor: string;
  readonly children: ReactNode;
}) {
  return (
    <div className={styles.choiceField}>
      <label htmlFor={htmlFor}>{label}</label>
      {children}
    </div>
  );
}
/** Keeps a panel write's RequestFeedback in the panel, under its controls. */
export function DetailNextStepFeedback({
  children,
}: {
  readonly children: ReactNode;
}) {
  return (
    <div data-feedback-host="" className={styles.nextFeedback}>
      {children}
    </div>
  );
}
/**
 * C-702: one fact of a panel line kept together when the line wraps.
 * C-703: `separated` ends it with a muted “·” glued to its last piece
 * (`tail`), so a wrapped line never starts with the dot.
 */
export function DetailNextStepFact({
  separated = false,
  tail,
  children,
  ...props
}: Omit<ComponentProps<"span">, "className"> & {
  readonly separated?: boolean;
  readonly tail?: ReactNode;
}) {
  return (
    <span {...props} className={styles.nextFact}>
      {children}
      {(tail !== undefined || separated) && (
        <span className={styles.nextFactTail}>
          {tail}
          {separated && <span aria-hidden="true">·</span>}
        </span>
      )}
    </span>
  );
}
/**
 * C-701: where CardActionDock renders: the first child of the detail, so the
 * dock sticks to the top of the page or drawer body while it scrolls.
 */
export const CardActionDockSlot = forwardRef<HTMLDivElement>((_props, ref) => (
  <div ref={ref} className={styles.dockSlot} />
));
CardActionDockSlot.displayName = "CardActionDockSlot";
/**
 * C-701: a 48px bar with the card (page) or the panel title (drawer) and the
 * page's main action, shown once “下一步” has scrolled away. It takes no room
 * in the flow; the tabs and anchors move below it.
 */
export function CardActionDock({
  title,
  children,
}: {
  readonly title: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section aria-label="主操作" className={styles.dock}>
      <div className={styles.dockTitle}>{title}</div>
      <div className={styles.dockActions}>{children}</div>
    </section>
  );
}
/** Below DetailNextStep: forms that a panel action opens in place. */
export function DetailNextStepForms(
  props: Omit<ComponentProps<"div">, "className">,
) {
  return (
    <div {...props} className={cn(styles.nextForms, "card-primary-panels")} />
  );
}

/**
 * C-702: a titled block of a detail (16/24, 600), e.g. 运行环境, 执行记录.
 * `count` follows the title in the muted colour, as “（3）”.
 */
export function DetailSection({
  title,
  count,
  children,
}: {
  readonly title: ReactNode;
  readonly count?: number | undefined;
  readonly children: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={styles.section}>
      <h2 id={id} className={styles.sectionTitle}>
        {title}
        {count !== undefined && (
          <span className={styles.muted}>（{count}）</span>
        )}
      </h2>
      {children}
    </section>
  );
}

/**
 * C-702: a folded section (命令行): a 28px toggle with a turning chevron,
 * the title and a muted count; the content renders only while open.
 */
export function DetailDisclosure({
  title,
  count,
  defaultOpen = false,
  children,
}: {
  readonly title: string;
  readonly count?: number | undefined;
  readonly defaultOpen?: boolean;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <section aria-label={title} className={styles.section}>
      <button
        type="button"
        className={styles.disclosure}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        <ChevronRightIcon aria-hidden="true" />
        {title}
        {count !== undefined && (
          <span className={styles.muted}>（{count}）</span>
        )}
      </button>
      <div id={id} hidden={!open} className={styles.disclosureBody}>
        {open && children}
      </div>
    </section>
  );
}

/**
 * C-702: label/value facts of a detail (13/20, 80px muted labels). `columns`
 * 2 puts two pairs on a line in a wide detail; under 760px it is one.
 */
export function DetailFacts({
  columns = 1,
  children,
}: {
  readonly columns?: 1 | 2;
  readonly children: ReactNode;
}) {
  return (
    <dl className={styles.facts} data-columns={columns}>
      {children}
    </dl>
  );
}
/**
 * One fact. `code` sets the value in the 12px monospace face; `truncate`
 * keeps it on one line with the full value on hover; `actions` (a 28px icon
 * button) follow the value.
 */
export function DetailFact({
  label,
  code = false,
  truncate,
  actions,
  children,
}: {
  readonly label: ReactNode;
  readonly code?: boolean;
  /** The full text, shown on hover, of a value cut to one line. */
  readonly truncate?: string | undefined;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className={styles.fact}>
      <dt>{label}</dt>
      <dd data-code={code || undefined}>
        {truncate === undefined ? (
          children
        ) : (
          <span className={styles.truncate} title={truncate}>
            {children}
          </span>
        )}
        {actions}
      </dd>
    </div>
  );
}
/** Muted text inside a fact value or a panel line (e.g. 推理强度 high). */
export function DetailMuted(props: Omit<ComponentProps<"span">, "className">) {
  return <span {...props} className={styles.muted} />;
}

/** C-702: a bordered list of records, one line each (执行记录, 签收). */
export function DetailHistoryList(
  props: Omit<ComponentProps<"ol">, "className">,
) {
  return <ol data-ui="detail-history" {...props} className={styles.history} />;
}
/**
 * One record: identity and status first, the summary filling the line (one
 * line, cut with an ellipsis) and the time at the right edge. Under 760px
 * the summary moves to a second line.
 */
export function DetailHistoryItem({
  lead,
  time,
  children,
}: {
  readonly lead: ReactNode;
  readonly time?: ReactNode;
  readonly children?: ReactNode;
}) {
  return (
    <li className={styles.historyItem}>
      <span className={styles.historyLead}>{lead}</span>
      <span className={styles.historySummary}>{children}</span>
      {time !== undefined && <span className={styles.historyTime}>{time}</span>}
    </li>
  );
}
/** One-line text of a record; the caller adds the hover with the full text. */
export const detailHistoryTextClassName = styles.historyText;

/**
 * C-702: copyable commands, one per line: the name, the command (12px
 * monospace, one line, full text on hover) and a 28px copy button.
 */
export function DetailCommandList(
  props: Omit<ComponentProps<"ul">, "className">,
) {
  return <ul {...props} className={styles.commands} />;
}
export function DetailCommand({
  label,
  command,
  action,
}: {
  readonly label: ReactNode;
  readonly command: string;
  readonly action: ReactNode;
}) {
  return (
    <li className={styles.command}>
      <span className={styles.commandLabel}>{label}</span>
      <code className={styles.commandCode} title={command}>
        {command}
      </code>
      {action}
    </li>
  );
}
