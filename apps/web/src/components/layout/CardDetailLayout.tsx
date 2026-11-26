import {
  type ComponentProps,
  forwardRef,
  type ReactNode,
  type Ref,
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
    /** C-697: names the button group; it can then take focus (tabIndex -1). */
    readonly actionsLabel?: string;
    readonly actionsRef?: Ref<HTMLDivElement>;
    /** C-697: a full-width area under body and buttons (e.g. 合并详情). */
    readonly more?: ReactNode;
    readonly children?: ReactNode;
    readonly "aria-label"?: string;
  }
>(
  (
    {
      title,
      mine = false,
      actions,
      actionsLabel,
      actionsRef,
      more,
      children,
      ...props
    },
    ref,
  ) => (
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
        <div
          ref={actionsRef}
          className={styles.nextActions}
          data-next-actions
          {...(actionsLabel
            ? { role: "group", "aria-label": actionsLabel, tabIndex: -1 }
            : {})}
        >
          {actions}
        </div>
      )}
      {more}
    </section>
  ),
);
DetailNextStep.displayName = "DetailNextStep";
/** One 13/20 muted fact line inside DetailNextStep; `danger` for must-fix. */
export function DetailNextStepLine({
  tone,
  ...props
}: Omit<ComponentProps<"div">, "className"> & {
  readonly tone?: "danger";
}) {
  return <div {...props} data-tone={tone} className={styles.nextLine} />;
}
/**
 * C-697: label/value rows inside DetailNextStep (改了什么、影响、风险). Each
 * row is a `<div>` holding one `<dt>` and one `<dd>`; labels muted, 13/20.
 */
export function DetailNextStepFacts(
  props: Omit<ComponentProps<"dl">, "className">,
) {
  return <dl {...props} className={styles.nextFacts} />;
}
/** C-697: the area a panel toggle opens, full width under a 1px divider. */
export function DetailNextStepMore(
  props: Omit<ComponentProps<"div">, "className">,
) {
  return <div {...props} className={styles.nextMore} />;
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
