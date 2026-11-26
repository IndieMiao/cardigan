import {
  type ComponentProps,
  Fragment,
  forwardRef,
  type ReactNode,
} from "react";
import { cn } from "../../lib/utils.js";
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
 * C-699: the overview: a main column and a 280px facts column beside it. In a
 * drawer and at ≤760px one column, the facts below a 1px rule.
 */
export function CardOverviewGrid({
  facts,
  factsLabel,
  children,
}: {
  readonly facts?: ReactNode;
  readonly factsLabel?: string;
  readonly children?: ReactNode;
}) {
  return (
    <div className={styles.overview}>
      <div className={styles.overviewMain}>{children}</div>
      {facts && (
        <aside aria-label={factsLabel} className={styles.overviewFacts}>
          {facts}
        </aside>
      )}
    </div>
  );
}

export interface DetailFact {
  readonly key: string;
  readonly label: ReactNode;
  readonly value: ReactNode;
}
/**
 * C-699: label–value pairs, 13/20 with a 64px muted label. Two pairs a row in
 * a drawer, one at ≤760px.
 */
export function DetailFacts({
  facts,
}: {
  readonly facts: readonly DetailFact[];
}) {
  return (
    <dl className={styles.facts}>
      {facts.map((fact) => (
        <Fragment key={fact.key}>
          <dt>{fact.label}</dt>
          <dd>{fact.value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

/** Items of one fact value that wrap as a group, e.g. a work item and its verdict. */
export function DetailFactGroup(
  props: Omit<ComponentProps<"span">, "className">,
) {
  return <span {...props} className={styles.factGroup} />;
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
