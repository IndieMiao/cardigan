import { type ComponentProps, forwardRef, type ReactNode } from "react";
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
    {actions && <div className={styles.nextActions}>{actions}</div>}
  </section>
));
DetailNextStep.displayName = "DetailNextStep";
/** One 13/20 muted fact line inside DetailNextStep. */
export function DetailNextStepLine(
  props: Omit<ComponentProps<"div">, "className">,
) {
  return <div {...props} className={styles.nextLine} />;
}
/** Below DetailNextStep: forms that a panel action opens in place. */
export function DetailNextStepForms(
  props: Omit<ComponentProps<"div">, "className">,
) {
  return (
    <div {...props} className={cn(styles.nextForms, "card-primary-panels")} />
  );
}
